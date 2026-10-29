-- Contestações, denúncias, correções e fechamento.
-- Nenhuma destas ações apaga o lançamento original.

create or replace function public.open_dispute(p_entry_id uuid, p_explanation text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.consumption_entries;
  v_id uuid := gen_random_uuid();
  v_text text;
  v_status text;
begin
  select * into e from public.consumption_entries where id = p_entry_id;
  if not found then
    raise exception 'Lançamento não encontrado.';
  end if;
  perform public._member(e.round_id);
  if (select status from public.rounds where id = e.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  v_status := public._project_entry(e.id) ->> 'status';
  if v_status in ('void', 'courtesy') then
    raise exception 'Este lançamento já não entra na conta.';
  end if;
  perform public._rate_limit('open_dispute', 30, interval '1 hour');
  v_text := public._optional_text(p_explanation, 500);

  begin
    insert into public.disputes (id, round_id, entry_id, opened_by, explanation)
    values (v_id, e.round_id, e.id, auth.uid(), v_text);
  exception
    when unique_violation then
      raise exception 'Você já contestou este lançamento.';
  end;

  perform public._audit(e.round_id, 'dispute_opened', 'dispute', v_id, jsonb_build_object(
    'entry_id', e.id,
    'explanation', v_text
  ));
  return jsonb_build_object('dispute_id', v_id);
end;
$$;

create or replace function public.withdraw_dispute(p_dispute_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.disputes;
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found then
    raise exception 'Contestação não encontrada.';
  end if;
  perform public._member(d.round_id);
  if d.opened_by is distinct from auth.uid() then
    raise exception 'Só quem abriu a contestação pode retirá-la.';
  end if;
  if exists (select 1 from public.dispute_resolutions r where r.dispute_id = d.id) then
    raise exception 'Esta contestação já tem uma decisão registrada.';
  end if;
  if (select status from public.rounds where id = d.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;

  insert into public.dispute_resolutions (dispute_id, decision, justification, decided_by)
  values (
    d.id,
    'withdrawn',
    'Retirada por quem abriu a contestação.',
    auth.uid()
  );
  perform public._audit(d.round_id, 'dispute_withdrawn', 'dispute', d.id, jsonb_build_object(
    'entry_id', d.entry_id
  ));
  return jsonb_build_object('dispute_id', d.id, 'decision', 'withdrawn');
end;
$$;

create or replace function public.record_dispute_decision(
  p_dispute_id uuid,
  p_decision text,
  p_justification text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.disputes;
  v_me public.round_participants;
  v_text text;
  v_before bigint;
  v_after bigint;
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found then
    raise exception 'Contestação não encontrada.';
  end if;
  v_me := public._member(d.round_id);
  if v_me.role <> 'organizer' then
    raise exception 'A decisão fica registrada por quem organiza e ainda precisa ser aceita por quem consumiu.';
  end if;
  if p_decision not in ('upheld_original', 'void_entry') then
    raise exception 'Decisão inválida.';
  end if;
  if exists (select 1 from public.dispute_resolutions r where r.dispute_id = d.id) then
    raise exception 'Esta contestação já tem uma decisão registrada.';
  end if;
  if (select status from public.rounds where id = d.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;

  v_text := public._plain(p_justification, 8, 500, 'A justificativa');
  v_before := (public._round_snapshot(d.round_id) ->> 'grand_cents')::bigint;
  perform public._lock_round(d.round_id);

  insert into public.dispute_resolutions (dispute_id, decision, justification, decided_by)
  values (d.id, p_decision, v_text, auth.uid());

  if p_decision = 'void_entry' and not exists (
    select 1
    from public.corrections c
    where c.entry_id = d.entry_id
      and c.correction_type = 'void'
      and not exists (select 1 from public.correction_withdrawals w where w.correction_id = c.id)
  ) then
    insert into public.corrections (
      round_id, entry_id, correction_type, justification, created_by
    ) values (
      d.round_id, d.entry_id, 'void', v_text, auth.uid()
    );
  end if;

  v_after := (public._round_snapshot(d.round_id) ->> 'grand_cents')::bigint;
  if v_after is distinct from v_before then
    raise exception 'Registrar uma decisão não pode alterar a conta.';
  end if;

  perform public._audit(d.round_id, 'dispute_decision_recorded', 'dispute', d.id, jsonb_build_object(
    'decision', p_decision,
    'entry_id', d.entry_id
  ));
  return jsonb_build_object('dispute_id', d.id, 'decision', p_decision, 'applied', false);
end;
$$;

create or replace function public.accept_dispute_outcome(p_dispute_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  d public.disputes;
  e public.consumption_entries;
  r public.dispute_resolutions;
  v_correction uuid;
begin
  select * into d from public.disputes where id = p_dispute_id;
  if not found then
    raise exception 'Contestação não encontrada.';
  end if;
  select * into e from public.consumption_entries where id = d.entry_id;
  perform public._member(d.round_id);
  if e.consumer_id is distinct from auth.uid() then
    raise exception 'Quem consumiu precisa aceitar o desfecho.';
  end if;
  if (select status from public.rounds where id = d.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  select * into r from public.dispute_resolutions where dispute_id = d.id;
  if not found then
    raise exception 'Ainda não há uma decisão registrada.';
  end if;
  if r.decision = 'withdrawn' then
    raise exception 'Esta contestação já foi retirada.';
  end if;

  perform public._lock_round(d.round_id);
  insert into public.dispute_acceptances (dispute_id, accepted_by)
  values (d.id, auth.uid())
  on conflict (dispute_id) do nothing;

  if r.decision = 'void_entry' then
    select c.id into v_correction
    from public.corrections c
    where c.entry_id = e.id
      and c.correction_type = 'void'
      and not exists (select 1 from public.correction_withdrawals w where w.correction_id = c.id)
    order by c.created_at desc
    limit 1;

    if v_correction is null then
      insert into public.corrections (round_id, entry_id, correction_type, justification, created_by)
      values (e.round_id, e.id, 'void', r.justification, auth.uid())
      returning id into v_correction;
    end if;

    insert into public.correction_acceptances (correction_id, accepted_by)
    values (v_correction, auth.uid())
    on conflict (correction_id, accepted_by) do nothing;
  end if;

  perform public._audit(d.round_id, 'dispute_accepted', 'dispute', d.id, jsonb_build_object(
    'decision', r.decision,
    'entry_id', e.id
  ));
  return jsonb_build_object('dispute_id', d.id, 'accepted', true);
end;
$$;

create or replace function public.propose_correction(
  p_entry_id uuid,
  p_type text,
  p_new_quantity integer,
  p_new_consumer_id uuid,
  p_new_unit_price_cents integer,
  p_justification text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  e public.consumption_entries;
  v_before jsonb;
  v_id uuid := gen_random_uuid();
  v_text text;
  v_after jsonb;
begin
  if p_type not in ('void', 'courtesy', 'quantity_adjust', 'price_adjust', 'consumer_change') then
    raise exception 'Tipo de correção inválido.';
  end if;
  select * into e from public.consumption_entries where id = p_entry_id;
  if not found then
    raise exception 'Lançamento não encontrado.';
  end if;
  perform public._member(e.round_id);
  if (select status from public.rounds where id = e.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  v_text := public._plain(p_justification, 8, 500, 'A justificativa');
  perform public._rate_limit('propose_correction', 30, interval '1 hour');
  perform public._lock_round(e.round_id);

  v_before := public._project_entry(e.id);
  if jsonb_typeof(v_before -> 'pending_correction') = 'object' then
    raise exception 'Já existe uma correção aguardando aceite neste lançamento.';
  end if;
  if v_before ->> 'status' in ('void', 'courtesy') then
    raise exception 'Este lançamento já não entra na conta.';
  end if;

  if p_type = 'quantity_adjust' and (p_new_quantity is null or p_new_quantity < 1 or p_new_quantity > 10) then
    raise exception 'A quantidade precisa estar entre 1 e 10.';
  end if;
  if p_type = 'price_adjust' and (
    p_new_unit_price_cents is null or p_new_unit_price_cents < 1 or p_new_unit_price_cents > 200000
  ) then
    raise exception 'Informe um preço entre R$ 0,01 e R$ 2.000,00.';
  end if;
  if p_type = 'consumer_change' then
    if p_new_consumer_id is null or p_new_consumer_id = e.consumer_id then
      raise exception 'Escolha outra pessoa da rodada.';
    end if;
    if not exists (
      select 1 from public.round_participants
      where round_id = e.round_id and user_id = p_new_consumer_id
    ) then
      raise exception 'Essa pessoa não está nesta rodada.';
    end if;
  end if;

  insert into public.corrections (
    id, round_id, entry_id, correction_type, new_quantity, new_consumer_id,
    new_unit_price_cents, justification, created_by
  ) values (
    v_id,
    e.round_id,
    e.id,
    p_type,
    case when p_type = 'quantity_adjust' then p_new_quantity else null end,
    case when p_type = 'consumer_change' then p_new_consumer_id else null end,
    case when p_type = 'price_adjust' then p_new_unit_price_cents else null end,
    v_text,
    auth.uid()
  );

  if p_type = 'consumer_change' and auth.uid() in (e.consumer_id, p_new_consumer_id) then
    insert into public.correction_acceptances (correction_id, accepted_by)
    values (v_id, auth.uid());
  elsif p_type <> 'consumer_change' and auth.uid() = e.consumer_id then
    insert into public.correction_acceptances (correction_id, accepted_by)
    values (v_id, auth.uid());
  end if;

  v_after := public._project_entry(e.id);
  if v_after ->> 'effect' in ('void', 'courtesy')
    and v_before ->> 'effect' is distinct from v_after ->> 'effect' then
    perform public._close_disputes(
      e.id,
      'void_entry',
      'Encerrada porque a correção do lançamento foi aceita.',
      null
    );
  elsif v_after ->> 'effect' = 'adjusted'
    and jsonb_typeof(v_after -> 'pending_correction') is distinct from 'object' then
    perform public._close_disputes(
      e.id,
      'adjusted',
      'Encerrada porque a correção do lançamento foi aceita.',
      auth.uid()
    );
  end if;

  perform public._audit(e.round_id, 'correction_proposed', 'correction', v_id, jsonb_build_object(
    'entry_id', e.id,
    'correction_type', p_type,
    'original_quantity', e.quantity,
    'original_unit_price_cents', e.unit_price_cents,
    'original_consumer_id', e.consumer_id
  ));

  return jsonb_build_object(
    'correction_id', v_id,
    'pending', jsonb_typeof(v_after -> 'pending_correction') = 'object'
  );
end;
$$;

create or replace function public.accept_correction(p_correction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.corrections;
  v_proj jsonb;
  v_required jsonb;
begin
  select * into c from public.corrections where id = p_correction_id;
  if not found then
    raise exception 'Correção não encontrada.';
  end if;
  perform public._member(c.round_id);
  if (select status from public.rounds where id = c.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  if exists (select 1 from public.correction_withdrawals w where w.correction_id = c.id) then
    raise exception 'Esta correção foi retirada.';
  end if;

  perform public._lock_round(c.round_id);
  v_proj := public._project_entry(c.entry_id);
  if (v_proj -> 'pending_correction' ->> 'id') is distinct from c.id::text then
    raise exception 'Esta correção não está mais aguardando aceite.';
  end if;
  v_required := v_proj -> 'pending_correction' -> 'required_acceptors';
  if not (v_required ? auth.uid()::text) then
    raise exception 'Só quem é afetado pela correção pode aceitá-la.';
  end if;

  insert into public.correction_acceptances (correction_id, accepted_by)
  values (c.id, auth.uid())
  on conflict (correction_id, accepted_by) do nothing;

  v_proj := public._project_entry(c.entry_id);
  if v_proj ->> 'effect' in ('void', 'courtesy') then
    perform public._close_disputes(
      c.entry_id,
      'void_entry',
      'Encerrada porque a correção do lançamento foi aceita.',
      null
    );
  elsif v_proj ->> 'effect' = 'adjusted'
    and jsonb_typeof(v_proj -> 'pending_correction') is distinct from 'object' then
    perform public._close_disputes(
      c.entry_id,
      'adjusted',
      'Encerrada porque a correção do lançamento foi aceita.',
      auth.uid()
    );
  end if;

  perform public._audit(c.round_id, 'correction_accepted', 'correction', c.id, jsonb_build_object(
    'entry_id', c.entry_id
  ));
  return jsonb_build_object('correction_id', c.id, 'accepted', true);
end;
$$;

create or replace function public.withdraw_correction(p_correction_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  c public.corrections;
  v_proj jsonb;
  v_required jsonb;
begin
  select * into c from public.corrections where id = p_correction_id;
  if not found then
    raise exception 'Correção não encontrada.';
  end if;
  perform public._member(c.round_id);
  if (select status from public.rounds where id = c.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  perform public._lock_round(c.round_id);
  v_proj := public._project_entry(c.entry_id);
  if (v_proj -> 'pending_correction' ->> 'id') is distinct from c.id::text then
    raise exception 'Correção já aceita permanece no histórico.';
  end if;
  v_required := coalesce(v_proj -> 'pending_correction' -> 'required_acceptors', '[]'::jsonb);
  if auth.uid() is distinct from c.created_by and not (v_required ? auth.uid()::text) then
    raise exception 'Só quem propôs ou quem é afetado pode encerrar esta proposta.';
  end if;

  insert into public.correction_withdrawals (correction_id, withdrawn_by)
  values (c.id, auth.uid());
  perform public._audit(c.round_id, 'correction_withdrawn', 'correction', c.id, jsonb_build_object(
    'entry_id', c.entry_id
  ));
  return jsonb_build_object('correction_id', c.id, 'withdrawn', true);
end;
$$;

create or replace function public.report_divergence(
  p_round_id uuid,
  p_entry_id uuid,
  p_category text,
  p_description text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_id uuid := gen_random_uuid();
  v_text text;
  v_before bigint;
  v_after bigint;
  v_count integer;
begin
  perform public._member(p_round_id);
  if (select status from public.rounds where id = p_round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  if p_category not in (
    'unregistered_consumption', 'wrong_person', 'duplicate', 'not_consumed', 'wrong_quantity'
  ) then
    raise exception 'Categoria inválida.';
  end if;
  if p_category = 'unregistered_consumption' and p_entry_id is not null then
    raise exception 'Consumo não registrado não aponta para um lançamento.';
  end if;
  if p_category <> 'unregistered_consumption' and p_entry_id is null then
    raise exception 'Esta denúncia precisa indicar o lançamento.';
  end if;
  if p_entry_id is not null and not exists (
    select 1 from public.consumption_entries
    where id = p_entry_id and round_id = p_round_id
  ) then
    raise exception 'Lançamento não encontrado nesta rodada.';
  end if;

  perform public._rate_limit('report_divergence', 8, interval '1 hour');
  select count(*) into v_count
  from public.divergence_reports
  where round_id = p_round_id and reported_by = auth.uid();
  if v_count >= 20 then
    raise exception 'Você atingiu o limite de denúncias nesta rodada.';
  end if;
  if exists (
    select 1 from public.divergence_reports
    where reported_by = auth.uid()
      and round_id = p_round_id
      and category = p_category
      and entry_id is not distinct from p_entry_id
      and created_at > now() - interval '1 day'
  ) then
    raise exception 'Você já registrou esta denúncia recentemente.';
  end if;

  v_text := public._optional_text(p_description, 500);
  v_before := (public._round_snapshot(p_round_id) ->> 'grand_cents')::bigint;

  insert into public.divergence_reports (id, round_id, entry_id, category, description, reported_by)
  values (v_id, p_round_id, p_entry_id, p_category, v_text, auth.uid());

  v_after := (public._round_snapshot(p_round_id) ->> 'grand_cents')::bigint;
  if v_after is distinct from v_before then
    raise exception 'Uma denúncia não pode alterar a conta.';
  end if;

  perform public._audit(p_round_id, 'divergence_reported', 'report', v_id, jsonb_build_object(
    'category', p_category,
    'entry_id', p_entry_id
  ));
  return jsonb_build_object('report_id', v_id);
end;
$$;

create or replace function public.resolve_report(
  p_report_id uuid,
  p_outcome text,
  p_note text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  r public.divergence_reports;
  v_me public.round_participants;
  v_text text;
  v_before bigint;
  v_after bigint;
begin
  select * into r from public.divergence_reports where id = p_report_id;
  if not found then
    raise exception 'Denúncia não encontrada.';
  end if;
  v_me := public._member(r.round_id);
  if v_me.role <> 'organizer' then
    raise exception 'Quem organiza registra o resultado da verificação.';
  end if;
  if p_outcome not in ('dismissed', 'action_taken') then
    raise exception 'Resultado inválido.';
  end if;
  if exists (select 1 from public.report_resolutions x where x.report_id = r.id) then
    raise exception 'Esta denúncia já foi verificada.';
  end if;
  if (select status from public.rounds where id = r.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  v_text := public._plain(p_note, 8, 500, 'A nota');
  v_before := (public._round_snapshot(r.round_id) ->> 'grand_cents')::bigint;

  insert into public.report_resolutions (report_id, outcome, note, decided_by)
  values (r.id, p_outcome, v_text, auth.uid());

  v_after := (public._round_snapshot(r.round_id) ->> 'grand_cents')::bigint;
  if v_after is distinct from v_before then
    raise exception 'Verificar uma denúncia não pode alterar a conta.';
  end if;

  perform public._audit(r.round_id, 'report_resolved', 'report', r.id, jsonb_build_object(
    'outcome', p_outcome
  ));
  return jsonb_build_object('report_id', r.id, 'outcome', p_outcome);
end;
$$;

create or replace function public.propose_adjustment(
  p_round_id uuid,
  p_type text,
  p_amount_cents integer,
  p_applies_to uuid,
  p_justification text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_price integer;
  v_id uuid := gen_random_uuid();
  v_text text;
begin
  if p_applies_to is null then
    raise exception 'Diga quem recebe este ajuste. A diferença da conta não é dividida automaticamente.';
  end if;
  if p_type not in ('discount', 'courtesy', 'rounding', 'price_difference', 'cancellation') then
    raise exception 'Tipo de ajuste inválido.';
  end if;
  perform public._member(p_round_id);
  if (select status from public.rounds where id = p_round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  if not exists (
    select 1 from public.round_participants
    where round_id = p_round_id and user_id = p_applies_to
  ) then
    raise exception 'Essa pessoa não está nesta rodada.';
  end if;
  if p_amount_cents is null or p_amount_cents = 0 then
    raise exception 'Informe o valor do ajuste.';
  end if;
  if p_type in ('discount', 'courtesy', 'cancellation') and p_amount_cents >= 0 then
    raise exception 'Este ajuste precisa reduzir o valor da pessoa indicada.';
  end if;
  if p_type = 'rounding' and abs(p_amount_cents) > 100 then
    raise exception 'Arredondamento não pode passar de R$ 1,00 e não serve para dividir a diferença da conta.';
  end if;

  select unit_price_cents into v_price from public.rounds where id = p_round_id;
  if abs(p_amount_cents) > least(500000, v_price * 30) then
    raise exception 'O valor do ajuste passa do limite permitido para uma rodada.';
  end if;
  if exists (
    select 1
    from public.round_adjustments a
    where a.round_id = p_round_id
      and a.applies_to = p_applies_to
      and not exists (select 1 from public.adjustment_acceptances ac where ac.adjustment_id = a.id)
      and not exists (select 1 from public.adjustment_withdrawals w where w.adjustment_id = a.id)
  ) then
    raise exception 'Já existe um ajuste aguardando aceite para esta pessoa.';
  end if;

  v_text := public._plain(p_justification, 8, 500, 'A justificativa');
  perform public._rate_limit('propose_adjustment', 20, interval '1 hour');
  perform public._lock_round(p_round_id);

  insert into public.round_adjustments (
    id, round_id, adjustment_type, amount_cents, applies_to, justification, created_by
  ) values (
    v_id, p_round_id, p_type, p_amount_cents, p_applies_to, v_text, auth.uid()
  );

  if p_applies_to = auth.uid() then
    insert into public.adjustment_acceptances (adjustment_id, accepted_by)
    values (v_id, auth.uid());
  end if;

  perform public._audit(p_round_id, 'adjustment_proposed', 'adjustment', v_id, jsonb_build_object(
    'adjustment_type', p_type,
    'amount_cents', p_amount_cents,
    'applies_to', p_applies_to
  ));
  return jsonb_build_object('adjustment_id', v_id, 'pending', p_applies_to is distinct from auth.uid());
end;
$$;

create or replace function public.accept_adjustment(p_adjustment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.round_adjustments;
begin
  select * into a from public.round_adjustments where id = p_adjustment_id;
  if not found then
    raise exception 'Ajuste não encontrado.';
  end if;
  perform public._member(a.round_id);
  if a.applies_to is distinct from auth.uid() then
    raise exception 'Só a pessoa afetada pode aceitar este ajuste.';
  end if;
  if (select status from public.rounds where id = a.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  if exists (select 1 from public.adjustment_withdrawals w where w.adjustment_id = a.id) then
    raise exception 'Este ajuste foi retirado.';
  end if;
  insert into public.adjustment_acceptances (adjustment_id, accepted_by)
  values (a.id, auth.uid())
  on conflict (adjustment_id) do nothing;
  perform public._audit(a.round_id, 'adjustment_accepted', 'adjustment', a.id, '{}'::jsonb);
  return jsonb_build_object('adjustment_id', a.id, 'accepted', true);
end;
$$;

create or replace function public.withdraw_adjustment(p_adjustment_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  a public.round_adjustments;
begin
  select * into a from public.round_adjustments where id = p_adjustment_id;
  if not found then
    raise exception 'Ajuste não encontrado.';
  end if;
  perform public._member(a.round_id);
  if exists (select 1 from public.adjustment_acceptances ac where ac.adjustment_id = a.id) then
    raise exception 'Ajuste já aceito permanece no histórico.';
  end if;
  if auth.uid() is distinct from a.created_by and auth.uid() is distinct from a.applies_to then
    raise exception 'Só quem propôs ou quem é afetado pode encerrar este ajuste.';
  end if;
  if (select status from public.rounds where id = a.round_id) = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  insert into public.adjustment_withdrawals (adjustment_id, withdrawn_by)
  values (a.id, auth.uid());
  perform public._audit(a.round_id, 'adjustment_withdrawn', 'adjustment', a.id, '{}'::jsonb);
  return jsonb_build_object('adjustment_id', a.id, 'withdrawn', true);
end;
$$;

create or replace function public.set_participant_role(
  p_round_id uuid,
  p_user_id uuid,
  p_role text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.round_participants;
  v_organizers integer;
begin
  v_me := public._member(p_round_id);
  if p_user_id = auth.uid() then
    raise exception 'Você não pode alterar a própria permissão.';
  end if;
  if v_me.role <> 'organizer' then
    raise exception 'Só quem organiza pode alterar permissões, e isso fica registrado.';
  end if;
  if p_role not in ('organizer', 'participant') then
    raise exception 'Papel inválido.';
  end if;
  if not exists (
    select 1 from public.round_participants
    where round_id = p_round_id and user_id = p_user_id
  ) then
    raise exception 'Essa pessoa não está nesta rodada.';
  end if;
  if p_role = 'participant' then
    select count(*) into v_organizers
    from public.round_participants
    where round_id = p_round_id and role = 'organizer' and user_id <> p_user_id;
    if v_organizers < 1 then
      raise exception 'A rodada precisa continuar com alguém organizando.';
    end if;
  end if;

  update public.round_participants
    set role = p_role
  where round_id = p_round_id and user_id = p_user_id;

  perform public._audit(p_round_id, 'role_changed', 'participant', p_user_id, jsonb_build_object(
    'role', p_role
  ));
  return jsonb_build_object('user_id', p_user_id, 'role', p_role);
end;
$$;

create or replace function public.set_recorder_permission(
  p_round_id uuid,
  p_user_id uuid,
  p_can_record boolean
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.round_participants;
begin
  v_me := public._member(p_round_id);
  if p_user_id = auth.uid() then
    raise exception 'Você não pode alterar a própria permissão.';
  end if;
  if v_me.role <> 'organizer' then
    raise exception 'Só quem organiza pode alterar permissões, e isso fica registrado.';
  end if;
  if not exists (
    select 1 from public.round_participants
    where round_id = p_round_id and user_id = p_user_id
  ) then
    raise exception 'Essa pessoa não está nesta rodada.';
  end if;

  update public.round_participants
    set can_record_for_others = coalesce(p_can_record, false)
  where round_id = p_round_id and user_id = p_user_id;

  perform public._audit(p_round_id, 'recorder_permission_changed', 'participant', p_user_id, jsonb_build_object(
    'can_record_for_others', coalesce(p_can_record, false)
  ));
  return jsonb_build_object('user_id', p_user_id, 'can_record_for_others', coalesce(p_can_record, false));
end;
$$;

create or replace function public.change_unit_price(
  p_round_id uuid,
  p_unit_price_cents integer,
  p_justification text
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.round_participants;
  v_old integer;
  v_text text;
begin
  v_me := public._member(p_round_id);
  if v_me.role <> 'organizer' then
    raise exception 'Só quem organiza pode propor outro preço, e os lançamentos antigos não mudam.';
  end if;
  if p_unit_price_cents is null or p_unit_price_cents < 1 or p_unit_price_cents > 200000 then
    raise exception 'Informe um preço entre R$ 0,01 e R$ 2.000,00.';
  end if;
  v_text := public._plain(p_justification, 8, 500, 'A justificativa');
  perform public._lock_round(p_round_id);
  select unit_price_cents into v_old from public.rounds where id = p_round_id for update;
  if (select status from public.rounds where id = p_round_id) <> 'open' then
    raise exception 'O preço só muda enquanto a rodada está aberta, e não altera o que já foi lançado.';
  end if;
  update public.rounds set unit_price_cents = p_unit_price_cents where id = p_round_id;
  perform public._audit(p_round_id, 'price_changed', 'round', p_round_id, jsonb_build_object(
    'old_unit_price_cents', v_old,
    'new_unit_price_cents', p_unit_price_cents
  ));
  return jsonb_build_object('unit_price_cents', p_unit_price_cents, 'previous_unit_price_cents', v_old);
end;
$$;

create or replace function public.start_review(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  perform public._member(p_round_id);
  perform public._rate_limit('start_review', 20, interval '1 hour');
  perform public._lock_round(p_round_id);
  select status into v_status from public.rounds where id = p_round_id for update;
  if v_status = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;
  if v_status = 'review' then
    raise exception 'A rodada já está em revisão.';
  end if;
  if v_status not in ('open', 'provisionally_closed') then
    raise exception 'Não é possível iniciar a revisão agora.';
  end if;
  update public.rounds
    set status = 'review',
        review_started_at = coalesce(review_started_at, now())
  where id = p_round_id;
  perform public._audit(p_round_id, 'review_started', 'round', p_round_id, '{}'::jsonb);
  return jsonb_build_object('status', 'review');
end;
$$;

create or replace function public.resume_round(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
begin
  perform public._member(p_round_id);
  perform public._rate_limit('resume_round', 20, interval '1 hour');
  perform public._lock_round(p_round_id);
  select status into v_status from public.rounds where id = p_round_id for update;
  if v_status = 'closed' then
    raise exception 'Rodada encerrada não reabre.';
  end if;
  if v_status = 'open' then
    raise exception 'A rodada já está aberta.';
  end if;
  update public.rounds set status = 'open' where id = p_round_id;
  perform public._audit(p_round_id, 'round_resumed', 'round', p_round_id, '{}'::jsonb);
  return jsonb_build_object('status', 'open');
end;
$$;

create or replace function public.propose_closing(
  p_round_id uuid,
  p_closing_type text,
  p_venue_bill_cents integer,
  p_explanation text,
  p_include_service boolean default false
)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_status text;
  v_review_started timestamptz;
  v_review_hours integer;
  v_snap jsonb;
  v_grand bigint;
  v_diff integer;
  v_text text;
  v_id uuid := gen_random_uuid();
  v_blockers integer;
  v_include boolean := coalesce(p_include_service, false);
  v_service bigint := 0;
  v_payable bigint;
  v_person jsonb;
  v_person_total bigint;
  v_person_service bigint;
  v_shares jsonb := '[]'::jsonb;
begin
  if p_closing_type not in ('provisional', 'final') then
    raise exception 'Tipo de fechamento inválido.';
  end if;
  perform public._member(p_round_id);
  perform public._rate_limit('propose_closing', 10, interval '1 hour');
  perform public._lock_round(p_round_id);

  select status, review_started_at, review_hours
    into v_status, v_review_started, v_review_hours
  from public.rounds
  where id = p_round_id
  for update;

  if v_status = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;

  v_snap := public._round_snapshot(p_round_id);
  v_grand := (v_snap ->> 'grand_cents')::bigint;
  v_blockers := jsonb_array_length(v_snap -> 'blockers');

  if p_venue_bill_cents is not null and (p_venue_bill_cents < 0 or p_venue_bill_cents > 10000000) then
    raise exception 'Valor da conta do estabelecimento inválido.';
  end if;

  if p_closing_type = 'final' then
    if v_status not in ('review', 'provisionally_closed') then
      raise exception 'Inicie a revisão antes do fechamento definitivo.';
    end if;
    if v_review_started is null
      or v_review_started + make_interval(hours => v_review_hours) > now() then
      raise exception 'O prazo de revisão ainda não terminou.';
    end if;
    if v_blockers > 0 then
      raise exception 'Ainda há divergências sem resolução. O fechamento definitivo não rateia essa diferença.';
    end if;
    if p_venue_bill_cents is null then
      raise exception 'Informe a conta do estabelecimento para comparar. A diferença não será dividida.';
    end if;
  end if;

  for v_person in
    select value
    from jsonb_array_elements(coalesce(v_snap -> 'participants', '[]'::jsonb))
  loop
    v_person_total := coalesce((v_person ->> 'total_cents')::bigint, 0);
    if v_include and v_person_total > 0 then
      v_person_service := (v_person_total + 5) / 10;
    else
      v_person_service := 0;
    end if;
    v_service := v_service + v_person_service;
    v_shares := v_shares || jsonb_build_array(jsonb_build_object(
      'user_id', v_person ->> 'user_id',
      'display_name', v_person ->> 'display_name',
      'total_cents', v_person_total,
      'service_cents', v_person_service,
      'payable_cents', v_person_total + v_person_service
    ));
  end loop;

  v_payable := v_grand + v_service;
  v_snap := v_snap || jsonb_build_object(
    'service_shares', v_shares,
    'service_cents', v_service,
    'include_service', v_include,
    'payable_cents', v_payable
  );

  if p_venue_bill_cents is not null then
    v_diff := (p_venue_bill_cents::bigint - v_payable)::integer;
  else
    v_diff := null;
  end if;

  if p_venue_bill_cents is not null and v_diff <> 0 then
    v_text := public._plain(p_explanation, 8, 500, 'A explicação da diferença');
  elsif p_closing_type = 'provisional' and v_blockers > 0 then
    v_text := public._plain(p_explanation, 8, 500, 'A explicação');
  else
    v_text := public._optional_text(p_explanation, 500);
  end if;

  insert into public.round_closings (
    id, round_id, closing_type, confirmed_cents, pending_cents, disputed_cents,
    grand_cents, service_cents, include_service, venue_bill_cents, difference_cents,
    explanation, snapshot, created_by
  ) values (
    v_id,
    p_round_id,
    p_closing_type,
    (v_snap ->> 'confirmed_cents')::integer,
    (v_snap ->> 'pending_cents')::integer,
    (v_snap ->> 'disputed_cents')::integer,
    v_grand::integer,
    v_service::integer,
    v_include,
    p_venue_bill_cents,
    v_diff,
    v_text,
    v_snap,
    auth.uid()
  );

  perform public._audit(p_round_id, 'closing_proposed', 'closing', v_id, jsonb_build_object(
    'closing_type', p_closing_type,
    'grand_cents', v_grand,
    'service_cents', v_service,
    'include_service', v_include,
    'payable_cents', v_payable,
    'venue_bill_cents', p_venue_bill_cents,
    'difference_cents', v_diff
  ));

  return jsonb_build_object(
    'closing_id', v_id,
    'grand_cents', v_grand,
    'service_cents', v_service,
    'payable_cents', v_payable,
    'difference_cents', v_diff,
    'allocated', false
  );
end;
$$;

create or replace function public.acknowledge_closing(p_closing_id uuid, p_decision text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  cl public.round_closings;
  v_round public.rounds;
  v_participants integer;
  v_accepts integer;
  v_snap jsonb;
  v_finalized boolean := false;
begin
  if p_decision not in ('accept', 'reject') then
    raise exception 'Decisão inválida.';
  end if;
  select * into cl from public.round_closings where id = p_closing_id;
  if not found then
    raise exception 'Fechamento não encontrado.';
  end if;
  perform public._member(cl.round_id);
  perform public._lock_round(cl.round_id);
  select * into v_round from public.rounds where id = cl.round_id for update;
  if v_round.status = 'closed' then
    raise exception 'A rodada já foi encerrada.';
  end if;

  insert into public.closing_acknowledgements (closing_id, user_id, decision)
  values (cl.id, auth.uid(), p_decision);

  select count(*) into v_participants
  from public.round_participants where round_id = cl.round_id;

  select count(*) into v_accepts
  from (
    select distinct on (user_id) user_id, decision
    from public.closing_acknowledgements
    where closing_id = cl.id
    order by user_id, created_at desc
  ) latest
  where decision = 'accept';

  if p_decision = 'accept' and v_accepts = v_participants then
    if cl.closing_type = 'final' then
      if v_round.status not in ('review', 'provisionally_closed') then
        raise exception 'A revisão precisa estar aberta para encerrar de vez.';
      end if;
      if v_round.review_started_at is null
        or v_round.review_started_at + make_interval(hours => v_round.review_hours) > now() then
        raise exception 'O prazo de revisão ainda não terminou.';
      end if;
      v_snap := public._round_snapshot(cl.round_id);
      if jsonb_array_length(v_snap -> 'blockers') > 0
        or (v_snap ->> 'grand_cents')::bigint is distinct from cl.grand_cents then
        raise exception 'A conta mudou desde a proposta. Faça uma nova proposta de fechamento.';
      end if;
      update public.rounds set status = 'closed' where id = cl.round_id;
      v_finalized := true;
    else
      update public.rounds set status = 'provisionally_closed' where id = cl.round_id;
      v_finalized := true;
    end if;
  end if;

  perform public._audit(cl.round_id, 'closing_acknowledged', 'closing', cl.id, jsonb_build_object(
    'decision', p_decision,
    'finalized', v_finalized
  ));
  return jsonb_build_object('finalized', v_finalized, 'decision', p_decision);
end;
$$;

create or replace function public.get_round_bundle(p_round_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_me public.round_participants;
  v_round public.rounds;
  v_snap jsonb;
  v_reports jsonb := '[]'::jsonb;
  v_report record;
  v_is_consumer boolean;
  v_outcome text;
  v_note text;
  v_resolved_at timestamptz;
  v_closings jsonb;
  v_audit jsonb;
begin
  v_me := public._member(p_round_id);
  select * into v_round from public.rounds where id = p_round_id;
  v_snap := public._round_snapshot(p_round_id);

  for v_report in
    select r.*, pr.display_name as reporter_name
    from public.divergence_reports r
    join public.profiles pr on pr.id = r.reported_by
    where r.round_id = p_round_id
    order by r.created_at desc
  loop
    v_outcome := null;
    v_note := null;
    v_resolved_at := null;
    select rr.outcome, rr.note, rr.created_at
      into v_outcome, v_note, v_resolved_at
    from public.report_resolutions rr
    where rr.report_id = v_report.id;

    v_is_consumer := v_report.entry_id is not null and exists (
      select 1 from public.consumption_entries e
      where e.id = v_report.entry_id and e.consumer_id = auth.uid()
    );

    if v_me.role = 'organizer' or v_report.reported_by = auth.uid() then
      v_reports := v_reports || jsonb_build_array(jsonb_build_object(
        'id', v_report.id,
        'category', v_report.category,
        'description', v_report.description,
        'entry_id', v_report.entry_id,
        'created_at', v_report.created_at,
        'reporter_name', v_report.reporter_name,
        'status', coalesce(v_outcome, 'open'),
        'resolution_note', v_note,
        'resolved_at', v_resolved_at,
        'redacted', false
      ));
    elsif v_is_consumer then
      v_reports := v_reports || jsonb_build_array(jsonb_build_object(
        'id', v_report.id,
        'category', v_report.category,
        'description', v_report.description,
        'entry_id', v_report.entry_id,
        'created_at', v_report.created_at,
        'reporter_name', null,
        'status', coalesce(v_outcome, 'open'),
        'resolution_note', v_note,
        'resolved_at', v_resolved_at,
        'redacted', true
      ));
    end if;
  end loop;

  select coalesce(jsonb_agg(cobj order by created_at), '[]'::jsonb)
    into v_closings
  from (
    select
      cl.created_at,
      jsonb_build_object(
        'id', cl.id,
        'closing_type', cl.closing_type,
        'confirmed_cents', cl.confirmed_cents,
        'pending_cents', cl.pending_cents,
        'disputed_cents', cl.disputed_cents,
        'grand_cents', cl.grand_cents,
        'service_cents', cl.service_cents,
        'include_service', cl.include_service,
        'payable_cents', cl.grand_cents + cl.service_cents,
        'service_shares', coalesce(cl.snapshot -> 'service_shares', '[]'::jsonb),
        'venue_bill_cents', cl.venue_bill_cents,
        'difference_cents', cl.difference_cents,
        'explanation', cl.explanation,
        'created_at', cl.created_at,
        'created_by_name', pr.display_name,
        'acknowledgements', (
          select coalesce(jsonb_agg(jsonb_build_object(
            'user_id', a.user_id,
            'display_name', ap.display_name,
            'decision', a.decision,
            'created_at', a.created_at
          ) order by a.created_at), '[]'::jsonb)
          from public.closing_acknowledgements a
          join public.profiles ap on ap.id = a.user_id
          where a.closing_id = cl.id
        )
      ) as cobj
    from public.round_closings cl
    join public.profiles pr on pr.id = cl.created_by
    where cl.round_id = p_round_id
  ) closings;

  select coalesce(jsonb_agg(item order by created_at desc), '[]'::jsonb)
    into v_audit
  from (
    select
      ae.created_at,
      jsonb_build_object(
        'id', ae.id,
        'action', ae.action,
        'entity_type', ae.entity_type,
        'entity_id', ae.entity_id,
        'actor_id', ae.actor_id,
        'actor_name', pr.display_name,
        'payload', ae.payload,
        'created_at', ae.created_at
      ) as item
    from public.audit_events ae
    join public.profiles pr on pr.id = ae.actor_id
    where ae.round_id = p_round_id
    order by ae.created_at desc
    limit 80
  ) audit_rows;

  return v_snap || jsonb_build_object(
    'round', jsonb_build_object(
      'id', v_round.id,
      'name', v_round.name,
      'unit_price_cents', v_round.unit_price_cents,
      'volume_ml', v_round.volume_ml,
      'starts_at', v_round.starts_at,
      'access_code', v_round.access_code,
      'status', v_round.status,
      'review_hours', v_round.review_hours,
      'review_started_at', v_round.review_started_at,
      'created_at', v_round.created_at
    ),
    'me', jsonb_build_object(
      'user_id', auth.uid(),
      'role', v_me.role,
      'can_record_for_others', v_me.can_record_for_others,
      'display_name', (select display_name from public.profiles where id = auth.uid())
    ),
    'reports', v_reports,
    'report_counts', jsonb_build_object(
      'open', v_snap -> 'open_report_count',
      'resolved', v_snap -> 'resolved_report_count'
    ),
    'closings', coalesce(v_closings, '[]'::jsonb),
    'audit', coalesce(v_audit, '[]'::jsonb)
  );
end;
$$;

revoke all on all functions in schema public from public, anon, authenticated;

grant execute on function public.update_display_name(text) to authenticated;
grant execute on function public.my_rounds() to authenticated;
grant execute on function public.create_round(text, integer, integer, timestamptz, integer, boolean) to authenticated;
grant execute on function public.preview_round(text) to anon, authenticated;
grant execute on function public.join_round(text) to authenticated;
grant execute on function public.record_consumption(uuid, uuid, integer, uuid, text) to authenticated;
grant execute on function public.confirm_entry(uuid) to authenticated;
grant execute on function public.open_dispute(uuid, text) to authenticated;
grant execute on function public.withdraw_dispute(uuid) to authenticated;
grant execute on function public.record_dispute_decision(uuid, text, text) to authenticated;
grant execute on function public.accept_dispute_outcome(uuid) to authenticated;
grant execute on function public.propose_correction(uuid, text, integer, uuid, integer, text) to authenticated;
grant execute on function public.accept_correction(uuid) to authenticated;
grant execute on function public.withdraw_correction(uuid) to authenticated;
grant execute on function public.report_divergence(uuid, uuid, text, text) to authenticated;
grant execute on function public.resolve_report(uuid, text, text) to authenticated;
grant execute on function public.propose_adjustment(uuid, text, integer, uuid, text) to authenticated;
grant execute on function public.accept_adjustment(uuid) to authenticated;
grant execute on function public.withdraw_adjustment(uuid) to authenticated;
grant execute on function public.set_participant_role(uuid, uuid, text) to authenticated;
grant execute on function public.set_recorder_permission(uuid, uuid, boolean) to authenticated;
grant execute on function public.change_unit_price(uuid, integer, text) to authenticated;
grant execute on function public.start_review(uuid) to authenticated;
grant execute on function public.resume_round(uuid) to authenticated;
grant execute on function public.propose_closing(uuid, text, integer, text, boolean) to authenticated;
grant execute on function public.acknowledge_closing(uuid, text) to authenticated;
grant execute on function public.get_round_bundle(uuid) to authenticated;
grant execute on function public.is_round_member(uuid) to authenticated;
grant execute on function public.shares_round_with(uuid) to authenticated;
grant execute on function public.can_see_entry(uuid) to authenticated;
grant execute on function public.can_see_dispute(uuid) to authenticated;
grant execute on function public.can_see_correction(uuid) to authenticated;
grant execute on function public.can_see_adjustment(uuid) to authenticated;
grant execute on function public.can_see_closing(uuid) to authenticated;

do $$
begin
  if exists (select 1 from pg_roles where rolname = 'supabase_auth_admin') then
    grant execute on function public.handle_new_user() to supabase_auth_admin;
  end if;
end;
$$;
