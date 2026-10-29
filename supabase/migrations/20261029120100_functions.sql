-- Operações da rodada. O preço e os totais saem das tabelas, nunca do navegador.
-- Escrita só por estas funções. Elas rodam como dono do schema e conferem auth.uid().

create or replace function public._plain(p_value text, p_min integer, p_max integer, p_label text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := trim(coalesce(p_value, ''));
begin
  if v ~ '[[:cntrl:]<>]' then
    raise exception '% contém caracteres não permitidos.', p_label;
  end if;
  if char_length(v) < p_min or char_length(v) > p_max then
    raise exception '% precisa ter entre % e % caracteres.', p_label, p_min, p_max;
  end if;
  return v;
end;
$$;

create or replace function public._optional_text(p_value text, p_max integer)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := nullif(trim(coalesce(p_value, '')), '');
begin
  if v is null then
    return null;
  end if;
  if v ~ '[[:cntrl:]<>]' then
    raise exception 'O texto contém caracteres não permitidos.';
  end if;
  if char_length(v) > p_max then
    raise exception 'O texto pode ter no máximo % caracteres.', p_max;
  end if;
  return v;
end;
$$;

create or replace function public._member(p_round_id uuid)
returns public.round_participants
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v public.round_participants;
begin
  if auth.uid() is null then
    raise exception 'É preciso entrar na sua conta.';
  end if;
  select * into v
  from public.round_participants
  where round_id = p_round_id and user_id = auth.uid();
  if not found then
    raise exception 'Você não participa desta rodada.';
  end if;
  return v;
end;
$$;

create or replace function public._lock_round(p_round_id uuid)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  perform pg_advisory_xact_lock(hashtextextended(p_round_id::text, 0));
end;
$$;

create or replace function public._rate_limit(p_action text, p_max integer, p_window interval)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  v_count integer;
begin
  if auth.uid() is null then
    raise exception 'É preciso entrar na sua conta.';
  end if;
  insert into public.rate_limit_events (user_id, action)
  values (auth.uid(), p_action);
  select count(*) into v_count
  from public.rate_limit_events
  where user_id = auth.uid()
    and action = p_action
    and created_at > now() - p_window;
  if v_count > p_max then
    raise exception 'Muitas tentativas em pouco tempo. Espere um pouco e tente de novo.';
  end if;
end;
$$;

create or replace function public._audit(
  p_round_id uuid,
  p_action text,
  p_entity_type text,
  p_entity_id uuid,
  p_payload jsonb
)
returns void
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.audit_events (round_id, actor_id, action, entity_type, entity_id, payload)
  values (
    p_round_id,
    auth.uid(),
    p_action,
    p_entity_type,
    p_entity_id,
    coalesce(p_payload, '{}'::jsonb)
  );
end;
$$;

create or replace function public._new_access_code()
returns text
language plpgsql
volatile
security definer
set search_path = public
as $$
declare
  v_code text;
  i integer;
begin
  for i in 1..8 loop
    v_code := substr(
      replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', ''),
      1,
      20
    );
    if not exists (select 1 from public.rounds where access_code = v_code) then
      return v_code;
    end if;
  end loop;
  raise exception 'Não foi possível gerar um código. Tente de novo.';
end;
$$;

create or replace function public._normalize_code(p_code text)
returns text
language plpgsql
immutable
set search_path = public
as $$
declare
  v text := lower(regexp_replace(coalesce(p_code, ''), '[^a-fA-F0-9]', '', 'g'));
begin
  if v ~ '^[a-f0-9]{20}$' then
    return v;
  end if;
  return null;
end;
$$;

-- Projeção de um lançamento. O valor cobrável sai daqui, não da coluna original.
create or replace function public._project_entry(p_entry_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  e public.consumption_entries;
  c public.corrections;
  v_billable uuid;
  v_qty integer;
  v_price integer;
  v_effect text := 'none';
  v_needed uuid[];
  v_acceptors uuid[];
  v_pending uuid;
  v_pending_needed uuid[];
  v_confirmed boolean;
  v_open_dispute boolean;
  v_status text;
  v_amount integer;
  v_pending_json jsonb;
  v_history jsonb;
begin
  select * into e from public.consumption_entries where id = p_entry_id;
  if not found then
    raise exception 'Lançamento não encontrado.';
  end if;

  v_billable := e.consumer_id;
  v_qty := e.quantity;
  v_price := e.unit_price_cents;

  for c in
    select * from public.corrections
    where entry_id = e.id
    order by created_at, id
  loop
    if exists (
      select 1 from public.correction_withdrawals w where w.correction_id = c.id
    ) then
      continue;
    end if;

    if c.correction_type = 'consumer_change' and c.new_consumer_id is distinct from v_billable then
      v_needed := array[v_billable, c.new_consumer_id];
    else
      v_needed := array[v_billable];
    end if;

    select coalesce(array_agg(a.accepted_by), '{}'::uuid[])
      into v_acceptors
    from public.correction_acceptances a
    where a.correction_id = c.id;

    if not (v_needed <@ v_acceptors) then
      v_pending := c.id;
      v_pending_needed := v_needed;
      exit;
    end if;

    if c.correction_type = 'void' then
      v_effect := 'void';
      exit;
    elsif c.correction_type = 'courtesy' then
      v_effect := 'courtesy';
      exit;
    elsif c.correction_type = 'quantity_adjust' then
      v_qty := c.new_quantity;
      v_effect := 'adjusted';
    elsif c.correction_type = 'price_adjust' then
      v_price := c.new_unit_price_cents;
      v_effect := 'adjusted';
    elsif c.correction_type = 'consumer_change' then
      v_billable := c.new_consumer_id;
      v_effect := 'adjusted';
    end if;
  end loop;

  v_confirmed := exists (
    select 1 from public.entry_confirmations cf where cf.entry_id = e.id
  );
  v_open_dispute := exists (
    select 1
    from public.disputes d
    where d.entry_id = e.id
      and not exists (
        select 1
        from public.dispute_resolutions r
        where r.dispute_id = d.id
          and (
            r.decision = 'withdrawn'
            or exists (
              select 1 from public.dispute_acceptances da where da.dispute_id = d.id
            )
          )
      )
  );

  if v_effect = 'void' then
    v_status := 'void';
    v_amount := 0;
  elsif v_effect = 'courtesy' then
    v_status := 'courtesy';
    v_amount := 0;
  elsif v_open_dispute then
    v_status := 'disputed';
    v_amount := v_qty * v_price;
  elsif not v_confirmed then
    v_status := 'pending';
    v_amount := v_qty * v_price;
  else
    v_status := 'confirmed';
    v_amount := v_qty * v_price;
  end if;

  if v_pending is not null then
    select jsonb_build_object(
      'id', corr.id,
      'correction_type', corr.correction_type,
      'new_quantity', corr.new_quantity,
      'new_consumer_id', corr.new_consumer_id,
      'new_unit_price_cents', corr.new_unit_price_cents,
      'justification', corr.justification,
      'created_by', corr.created_by,
      'created_by_name', pr.display_name,
      'created_at', corr.created_at,
      'required_acceptors', coalesce((
        select jsonb_agg(distinct needed::text)
        from unnest(v_pending_needed) as needed
      ), '[]'::jsonb)
    )
    into v_pending_json
    from public.corrections corr
    join public.profiles pr on pr.id = corr.created_by
    where corr.id = v_pending;
  end if;

  select coalesce(jsonb_agg(item order by opened_at), '[]'::jsonb)
    into v_history
  from (
    select
      d.created_at as opened_at,
      jsonb_build_object(
        'id', d.id,
        'explanation', d.explanation,
        'opened_by', d.opened_by,
        'opened_by_name', op.display_name,
        'created_at', d.created_at,
        'decision', r.decision,
        'justification', r.justification,
        'decided_by_name', dp.display_name,
        'resolved_at', r.created_at,
        'accepted_at', da.created_at
      ) as item
    from public.disputes d
    join public.profiles op on op.id = d.opened_by
    left join public.dispute_resolutions r on r.dispute_id = d.id
    left join public.profiles dp on dp.id = r.decided_by
    left join public.dispute_acceptances da on da.dispute_id = d.id
    where d.entry_id = e.id
  ) hist;

  return jsonb_build_object(
    'id', e.id,
    'round_id', e.round_id,
    'consumer_id', e.consumer_id,
    'consumer_name', (select display_name from public.profiles where id = e.consumer_id),
    'recorded_by', e.recorded_by,
    'recorded_by_name', (select display_name from public.profiles where id = e.recorded_by),
    'origin', e.origin,
    'original_quantity', e.quantity,
    'original_unit_price_cents', e.unit_price_cents,
    'quantity', case when v_effect in ('void', 'courtesy') then e.quantity else v_qty end,
    'unit_price_cents', case when v_effect in ('void', 'courtesy') then e.unit_price_cents else v_price end,
    'billable_consumer_id', v_billable,
    'billable_consumer_name', (select display_name from public.profiles where id = v_billable),
    'amount_cents', v_amount,
    'status', v_status,
    'effect', v_effect,
    'created_at', e.created_at,
    'pending_correction', v_pending_json,
    'open_dispute', case
      when v_status = 'disputed' then (
        select jsonb_build_object(
          'id', d.id,
          'explanation', d.explanation,
          'opened_by', d.opened_by,
          'opened_by_name', p.display_name,
          'created_at', d.created_at
        )
        from public.disputes d
        join public.profiles p on p.id = d.opened_by
        where d.entry_id = e.id
          and not exists (
            select 1 from public.dispute_resolutions r
            where r.dispute_id = d.id
              and (
                r.decision = 'withdrawn'
                or exists (
                  select 1 from public.dispute_acceptances da where da.dispute_id = d.id
                )
              )
          )
        order by d.created_at
        limit 1
      )
      else null
    end,
    'dispute_history', v_history
  );
end;
$$;

create or replace function public._add_amount(p_map jsonb, p_user uuid, p_amount bigint)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
begin
  return jsonb_set(
    coalesce(p_map, '{}'::jsonb),
    array[p_user::text],
    to_jsonb(coalesce((p_map ->> p_user::text)::bigint, 0) + p_amount),
    true
  );
end;
$$;

create or replace function public._round_snapshot(p_round_id uuid)
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_entry_id uuid;
  v_proj jsonb;
  v_entries jsonb := '[]'::jsonb;
  v_adjustments jsonb := '[]'::jsonb;
  v_people jsonb := '[]'::jsonb;
  v_conf jsonb := '{}'::jsonb;
  v_pend jsonb := '{}'::jsonb;
  v_disp jsonb := '{}'::jsonb;
  v_qty jsonb := '{}'::jsonb;
  v_adj jsonb := '{}'::jsonb;
  v_confirmed bigint := 0;
  v_pending bigint := 0;
  v_disputed bigint := 0;
  v_adjustment bigint := 0;
  v_confirmed_qty bigint := 0;
  v_pending_corrections integer := 0;
  v_pending_adjustments integer := 0;
  v_person_confirmed bigint := 0;
  v_grand bigint := 0;
  v_blockers jsonb := '[]'::jsonb;
  v_open_reports integer := 0;
  v_resolved_reports integer := 0;
  v_adj_row record;
  v_person record;
  v_status text;
  v_amount bigint;
  v_consumer uuid;
begin
  if not exists (select 1 from public.rounds where id = p_round_id) then
    raise exception 'Rodada não encontrada.';
  end if;

  for v_entry_id in
    select id from public.consumption_entries
    where round_id = p_round_id
    order by created_at desc, id desc
  loop
    v_proj := public._project_entry(v_entry_id);
    v_entries := v_entries || jsonb_build_array(v_proj);
    v_status := v_proj ->> 'status';
    v_amount := (v_proj ->> 'amount_cents')::bigint;
    v_consumer := (v_proj ->> 'billable_consumer_id')::uuid;

    if v_status = 'confirmed' then
      v_confirmed := v_confirmed + v_amount;
      v_confirmed_qty := v_confirmed_qty + (v_proj ->> 'quantity')::bigint;
      v_conf := public._add_amount(v_conf, v_consumer, v_amount);
      v_qty := public._add_amount(v_qty, v_consumer, (v_proj ->> 'quantity')::bigint);
    elsif v_status = 'pending' then
      v_pending := v_pending + v_amount;
      v_pend := public._add_amount(v_pend, (v_proj ->> 'consumer_id')::uuid, v_amount);
    elsif v_status = 'disputed' then
      v_disputed := v_disputed + v_amount;
      v_disp := public._add_amount(v_disp, v_consumer, v_amount);
    end if;

    if jsonb_typeof(v_proj -> 'pending_correction') = 'object' then
      v_pending_corrections := v_pending_corrections + 1;
    end if;
  end loop;

  for v_adj_row in
    select a.*, ap.display_name as applies_name, cr.display_name as creator_name
    from public.round_adjustments a
    join public.profiles ap on ap.id = a.applies_to
    join public.profiles cr on cr.id = a.created_by
    where a.round_id = p_round_id
    order by a.created_at, a.id
  loop
    if exists (
      select 1 from public.adjustment_withdrawals w where w.adjustment_id = v_adj_row.id
    ) then
      v_status := 'withdrawn';
    elsif exists (
      select 1 from public.adjustment_acceptances ac where ac.adjustment_id = v_adj_row.id
    ) then
      v_status := 'accepted';
      v_adjustment := v_adjustment + v_adj_row.amount_cents;
      v_adj := public._add_amount(v_adj, v_adj_row.applies_to, v_adj_row.amount_cents);
    else
      v_status := 'pending';
      v_pending_adjustments := v_pending_adjustments + 1;
    end if;

    v_adjustments := v_adjustments || jsonb_build_array(jsonb_build_object(
      'id', v_adj_row.id,
      'adjustment_type', v_adj_row.adjustment_type,
      'amount_cents', v_adj_row.amount_cents,
      'applies_to', v_adj_row.applies_to,
      'applies_to_name', v_adj_row.applies_name,
      'justification', v_adj_row.justification,
      'created_by', v_adj_row.created_by,
      'created_by_name', v_adj_row.creator_name,
      'created_at', v_adj_row.created_at,
      'status', v_status
    ));
  end loop;

  for v_person in
    select rp.user_id, rp.role, rp.can_record_for_others, pr.display_name
    from public.round_participants rp
    join public.profiles pr on pr.id = rp.user_id
    where rp.round_id = p_round_id
    order by pr.display_name, rp.joined_at
  loop
    v_person_confirmed := coalesce((v_conf ->> v_person.user_id::text)::bigint, 0);
    v_people := v_people || jsonb_build_array(jsonb_build_object(
      'user_id', v_person.user_id,
      'display_name', v_person.display_name,
      'role', v_person.role,
      'can_record_for_others', v_person.can_record_for_others,
      'confirmed_cents', v_person_confirmed,
      'pending_cents', coalesce((v_pend ->> v_person.user_id::text)::bigint, 0),
      'disputed_cents', coalesce((v_disp ->> v_person.user_id::text)::bigint, 0),
      'adjustment_cents', coalesce((v_adj ->> v_person.user_id::text)::bigint, 0),
      'total_cents', v_person_confirmed + coalesce((v_adj ->> v_person.user_id::text)::bigint, 0),
      'confirmed_quantity', coalesce((v_qty ->> v_person.user_id::text)::bigint, 0)
    ));
    v_grand := v_grand + v_person_confirmed + coalesce((v_adj ->> v_person.user_id::text)::bigint, 0);
  end loop;

  if v_person_confirmed is not null and (
    select coalesce(sum((p ->> 'confirmed_cents')::bigint), 0)
    from jsonb_array_elements(v_people) p
  ) is distinct from v_confirmed then
    raise exception 'Os totais individuais não fecham com o total da rodada.';
  end if;

  select
    count(*) filter (
      where not exists (
        select 1 from public.report_resolutions rr where rr.report_id = r.id
      )
    ),
    count(*) filter (
      where exists (
        select 1 from public.report_resolutions rr where rr.report_id = r.id
      )
    )
  into v_open_reports, v_resolved_reports
  from public.divergence_reports r
  where r.round_id = p_round_id;

  if v_pending > 0 then
    v_blockers := v_blockers || jsonb_build_array('Há lançamentos aguardando confirmação.');
  end if;
  if v_disputed > 0 then
    v_blockers := v_blockers || jsonb_build_array('Há lançamentos em divergência.');
  end if;
  if v_pending_corrections > 0 then
    v_blockers := v_blockers || jsonb_build_array('Há correções aguardando aceite.');
  end if;
  if v_pending_adjustments > 0 then
    v_blockers := v_blockers || jsonb_build_array('Há descontos ou cortesias aguardando aceite.');
  end if;
  if v_open_reports > 0 then
    v_blockers := v_blockers || jsonb_build_array('Há denúncias ainda não verificadas.');
  end if;

  return jsonb_build_object(
    'math_version', 1,
    'confirmed_cents', v_confirmed,
    'pending_cents', v_pending,
    'disputed_cents', v_disputed,
    'adjustment_cents', v_adjustment,
    'grand_cents', v_grand,
    'confirmed_quantity', v_confirmed_qty,
    'blockers', v_blockers,
    'entries', v_entries,
    'participants', v_people,
    'adjustments', v_adjustments,
    'open_report_count', v_open_reports,
    'resolved_report_count', v_resolved_reports
  );
end;
$$;

create or replace function public._close_disputes(
  p_entry_id uuid,
  p_decision text,
  p_justification text,
  p_only_opened_by uuid
)
returns void
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.disputes;
  v_round uuid;
begin
  select round_id into v_round from public.consumption_entries where id = p_entry_id;
  for d in
    select * from public.disputes
    where entry_id = p_entry_id
      and (p_only_opened_by is null or opened_by = p_only_opened_by)
      and not exists (
        select 1 from public.dispute_resolutions r
        where r.dispute_id = disputes.id
          and (
            r.decision = 'withdrawn'
            or exists (
              select 1 from public.dispute_acceptances a where a.dispute_id = disputes.id
            )
          )
      )
  loop
    if not exists (select 1 from public.dispute_resolutions r where r.dispute_id = d.id) then
      insert into public.dispute_resolutions (dispute_id, decision, justification, decided_by)
      values (d.id, p_decision, p_justification, auth.uid());
    end if;
    insert into public.dispute_acceptances (dispute_id, accepted_by)
    values (d.id, auth.uid())
    on conflict (dispute_id) do nothing;
    perform public._audit(
      v_round,
      'dispute_settled',
      'dispute',
      d.id,
      jsonb_build_object('decision', p_decision, 'entry_id', p_entry_id)
    );
  end loop;
end;
$$;

create or replace function public.update_display_name(p_display_name text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'É preciso entrar na sua conta.';
  end if;
  perform public._rate_limit('update_display_name', 10, interval '1 hour');
  v_name := public._plain(p_display_name, 2, 40, 'O nome');
  update public.profiles set display_name = v_name where id = auth.uid();
  return jsonb_build_object('display_name', v_name);
end;
$$;

create or replace function public.my_rounds()
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
begin
  if auth.uid() is null then
    raise exception 'É preciso entrar na sua conta.';
  end if;
  return coalesce((
    select jsonb_agg(jsonb_build_object(
      'id', r.id,
      'name', r.name,
      'status', r.status,
      'starts_at', r.starts_at,
      'access_code', r.access_code,
      'unit_price_cents', r.unit_price_cents
    ) order by r.created_at desc)
    from public.rounds r
    join public.round_participants p on p.round_id = r.id and p.user_id = auth.uid()
  ), '[]'::jsonb);
end;
$$;

create or replace function public.create_round(
  p_name text,
  p_unit_price_cents integer,
  p_volume_ml integer,
  p_starts_at timestamptz,
  p_review_hours integer,
  p_creator_can_record_for_others boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
  v_code text;
  v_name text;
begin
  if auth.uid() is null then
    raise exception 'É preciso entrar na sua conta.';
  end if;
  perform public._rate_limit('create_round', 10, interval '1 hour');
  if p_unit_price_cents is null or p_unit_price_cents < 1 or p_unit_price_cents > 200000 then
    raise exception 'Informe um preço entre R$ 0,01 e R$ 2.000,00.';
  end if;
  if p_volume_ml is not null and (p_volume_ml < 1 or p_volume_ml > 5000) then
    raise exception 'O volume precisa estar entre 1 e 5000 ml.';
  end if;
  if p_review_hours is null or p_review_hours < 0 or p_review_hours > 72 then
    raise exception 'O prazo de revisão precisa estar entre 0 e 72 horas.';
  end if;
  if p_starts_at is null then
    raise exception 'Informe a data da rodada.';
  end if;

  v_name := public._plain(p_name, 2, 80, 'O nome');
  v_code := public._new_access_code();

  insert into public.rounds (
    id, name, unit_price_cents, volume_ml, starts_at, access_code, review_hours, created_by
  ) values (
    v_id, v_name, p_unit_price_cents, p_volume_ml, p_starts_at, v_code, p_review_hours, auth.uid()
  );

  insert into public.round_participants (round_id, user_id, role, can_record_for_others)
  values (v_id, auth.uid(), 'organizer', coalesce(p_creator_can_record_for_others, false));

  perform public._audit(v_id, 'round_created', 'round', v_id, jsonb_build_object(
    'name', v_name,
    'unit_price_cents', p_unit_price_cents,
    'volume_ml', p_volume_ml,
    'review_hours', p_review_hours,
    'creator_can_record_for_others', coalesce(p_creator_can_record_for_others, false)
  ));

  return jsonb_build_object('id', v_id, 'access_code', v_code, 'name', v_name);
end;
$$;

create or replace function public.preview_round(p_access_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public._normalize_code(p_access_code);
  v public.rounds;
begin
  perform public._rate_limit('preview_round', 30, interval '1 hour');
  if v_code is null then
    return null;
  end if;
  select * into v from public.rounds where access_code = v_code;
  if not found then
    return null;
  end if;
  return jsonb_build_object(
    'name', v.name,
    'starts_at', v.starts_at,
    'unit_price_cents', v.unit_price_cents,
    'volume_ml', v.volume_ml,
    'status', v.status
  );
end;
$$;

create or replace function public.join_round(p_access_code text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_code text := public._normalize_code(p_access_code);
  v public.rounds;
begin
  if auth.uid() is null then
    raise exception 'É preciso entrar na sua conta.';
  end if;
  perform public._rate_limit('join_round', 20, interval '1 hour');
  if v_code is null then
    raise exception 'Código não encontrado.';
  end if;

  select * into v from public.rounds where access_code = v_code;
  if not found then
    raise exception 'Código não encontrado.';
  end if;
  perform public._lock_round(v.id);
  select * into v from public.rounds where id = v.id for update;
  if v.status = 'closed' then
    raise exception 'Esta rodada já foi encerrada.';
  end if;

  if exists (
    select 1 from public.round_participants
    where round_id = v.id and user_id = auth.uid()
  ) then
    return jsonb_build_object('id', v.id, 'joined', true, 'already_member', true);
  end if;

  insert into public.round_participants (round_id, user_id, role, can_record_for_others)
  values (v.id, auth.uid(), 'participant', false);

  perform public._audit(v.id, 'member_joined', 'participant', auth.uid(), '{}'::jsonb);
  return jsonb_build_object('id', v.id, 'joined', true, 'already_member', false);
end;
$$;

create or replace function public.record_consumption(
  p_round_id uuid,
  p_consumer_id uuid,
  p_quantity integer,
  p_idempotency_key uuid,
  p_origin text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.round_participants;
  v_round public.rounds;
  v_existing uuid;
  v_existing_round uuid;
  v_existing_consumer uuid;
  v_existing_qty integer;
  v_origin text;
  v_id uuid;
begin
  v_me := public._member(p_round_id);
  if p_consumer_id is null or p_idempotency_key is null then
    raise exception 'Informe a pessoa e a chave do lançamento.';
  end if;
  if p_quantity is null or p_quantity < 1 or p_quantity > 10 then
    raise exception 'A quantidade precisa estar entre 1 e 10.';
  end if;

  select id, round_id, consumer_id, quantity
    into v_existing, v_existing_round, v_existing_consumer, v_existing_qty
  from public.consumption_entries
  where recorded_by = auth.uid() and idempotency_key = p_idempotency_key;

  if v_existing is not null then
    if v_existing_round is distinct from p_round_id
      or v_existing_consumer is distinct from p_consumer_id
      or v_existing_qty is distinct from p_quantity then
      raise exception 'Esta chave já foi usada em outro lançamento.';
    end if;
    return jsonb_build_object('entry_id', v_existing, 'idempotent', true);
  end if;

  perform public._rate_limit('record_consumption', 60, interval '10 minutes');
  perform public._lock_round(p_round_id);

  select * into v_round from public.rounds where id = p_round_id for update;
  if v_round.status <> 'open' then
    raise exception 'Esta rodada não está aberta para novos lançamentos.';
  end if;
  if not exists (
    select 1 from public.round_participants
    where round_id = p_round_id and user_id = p_consumer_id
  ) then
    raise exception 'Essa pessoa não está nesta rodada.';
  end if;

  if p_consumer_id = auth.uid() then
    v_origin := 'self';
  else
    if not v_me.can_record_for_others then
      raise exception 'Você não está autorizado a registrar o consumo de outra pessoa.';
    end if;
    v_origin := case when p_origin = 'waiter' then 'waiter' else 'authorized_peer' end;
  end if;

  begin
    insert into public.consumption_entries (
      round_id, consumer_id, recorded_by, origin, quantity, unit_price_cents, idempotency_key
    ) values (
      p_round_id, p_consumer_id, auth.uid(), v_origin, p_quantity, v_round.unit_price_cents, p_idempotency_key
    )
    returning id into v_id;
  exception
    when unique_violation then
      select id into v_id
      from public.consumption_entries
      where recorded_by = auth.uid()
        and idempotency_key = p_idempotency_key
        and round_id = p_round_id
        and consumer_id = p_consumer_id
        and quantity = p_quantity;
      if v_id is null then
        raise exception 'Esta chave já foi usada em outro lançamento.';
      end if;
      return jsonb_build_object('entry_id', v_id, 'idempotent', true);
  end;

  if v_origin = 'self' then
    insert into public.entry_confirmations (entry_id, actor_id)
    values (v_id, auth.uid());
  end if;

  perform public._audit(p_round_id, 'consumption_recorded', 'entry', v_id, jsonb_build_object(
    'consumer_id', p_consumer_id,
    'quantity', p_quantity,
    'unit_price_cents', v_round.unit_price_cents,
    'origin', v_origin
  ));

  return jsonb_build_object(
    'entry_id', v_id,
    'idempotent', false,
    'status', case when v_origin = 'self' then 'confirmed' else 'pending' end
  );
end;
$$;

create or replace function public.confirm_entry(p_entry_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.consumption_entries;
  v_round_status text;
begin
  select * into e from public.consumption_entries where id = p_entry_id;
  if not found then
    raise exception 'Lançamento não encontrado.';
  end if;
  perform public._member(e.round_id);
  if e.consumer_id is distinct from auth.uid() then
    raise exception 'Só quem consumiu pode confirmar este lançamento.';
  end if;

  select status into v_round_status from public.rounds where id = e.round_id;
  if v_round_status = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  if exists (select 1 from public.entry_confirmations where entry_id = e.id) then
    return jsonb_build_object('entry_id', e.id, 'idempotent', true);
  end if;
  if exists (
    select 1
    from public.corrections c
    join public.correction_acceptances a on a.correction_id = c.id
    where c.entry_id = e.id
      and c.correction_type in ('void', 'courtesy')
      and not exists (
        select 1 from public.correction_withdrawals w where w.correction_id = c.id
      )
  ) then
    raise exception 'Este lançamento já foi anulado ou virou cortesia.';
  end if;

  perform public._lock_round(e.round_id);
  insert into public.entry_confirmations (entry_id, actor_id)
  values (e.id, auth.uid());
  perform public._audit(e.round_id, 'consumption_confirmed', 'entry', e.id, '{}'::jsonb);
  return jsonb_build_object('entry_id', e.id, 'idempotent', false);
end;
$$;
