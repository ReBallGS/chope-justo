-- Chope Justo
-- Registros financeiros são permanentes. Correção vira um evento novo.
-- O navegador não recebe permissão de insert/update/delete nessas tabelas.
-- Funções security definer, mais adiante, fazem a escrita e conferem auth.uid().
-- auth.users e auth.uid() vêm do Supabase. O teste local cria os dois antes desta migração.

grant usage on schema public to anon, authenticated, service_role;
grant usage on schema auth to anon, authenticated, service_role;
grant execute on function auth.uid() to anon, authenticated, service_role;

-- ---------------------------------------------------------------------------
-- Tabelas
-- ---------------------------------------------------------------------------

create table public.profiles (
  id uuid primary key references auth.users (id) on delete restrict,
  display_name text not null,
  created_at timestamptz not null default now(),
  constraint profiles_name_length check (char_length(display_name) between 2 and 40),
  constraint profiles_name_plain check (display_name !~ '[[:cntrl:]<>]')
);

create table public.rounds (
  id uuid primary key default gen_random_uuid(),
  name text not null,
  unit_price_cents integer not null,
  volume_ml integer,
  starts_at timestamptz not null default now(),
  access_code text not null unique,
  status text not null default 'open',
  review_hours integer not null default 0,
  review_started_at timestamptz,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint rounds_name_length check (char_length(name) between 2 and 80),
  constraint rounds_name_plain check (name !~ '[[:cntrl:]<>]'),
  constraint rounds_price check (unit_price_cents between 1 and 200000),
  constraint rounds_volume check (volume_ml is null or volume_ml between 1 and 5000),
  constraint rounds_status check (status in ('open', 'review', 'provisionally_closed', 'closed')),
  constraint rounds_review_hours check (review_hours between 0 and 72),
  constraint rounds_access_code check (access_code ~ '^[a-f0-9]{20}$')
);

create table public.round_participants (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  role text not null,
  can_record_for_others boolean not null default false,
  joined_at timestamptz not null default now(),
  constraint round_participants_role check (role in ('organizer', 'participant')),
  constraint round_participants_unique unique (round_id, user_id)
);

create table public.consumption_entries (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  consumer_id uuid not null references public.profiles (id) on delete restrict,
  recorded_by uuid not null references public.profiles (id) on delete restrict,
  origin text not null,
  quantity integer not null,
  unit_price_cents integer not null,
  idempotency_key uuid not null,
  created_at timestamptz not null default now(),
  constraint consumption_origin check (origin in ('self', 'waiter', 'authorized_peer')),
  constraint consumption_quantity check (quantity between 1 and 10),
  constraint consumption_price check (unit_price_cents between 1 and 200000),
  constraint consumption_origin_self check (
    (origin = 'self' and consumer_id = recorded_by)
    or (origin <> 'self' and consumer_id <> recorded_by)
  ),
  constraint consumption_idempotency unique (recorded_by, idempotency_key)
);

create table public.entry_confirmations (
  entry_id uuid primary key references public.consumption_entries (id) on delete restrict,
  actor_id uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.disputes (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  entry_id uuid not null references public.consumption_entries (id) on delete restrict,
  opened_by uuid not null references public.profiles (id) on delete restrict,
  explanation text,
  created_at timestamptz not null default now(),
  constraint disputes_explanation check (
    explanation is null or char_length(explanation) between 1 and 500
  ),
  constraint disputes_one_per_person unique (entry_id, opened_by)
);

create table public.dispute_resolutions (
  dispute_id uuid primary key references public.disputes (id) on delete restrict,
  decision text not null,
  justification text not null,
  decided_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint dispute_resolutions_decision check (
    decision in ('withdrawn', 'upheld_original', 'void_entry', 'adjusted')
  ),
  constraint dispute_resolutions_justification check (char_length(justification) between 8 and 500)
);

create table public.dispute_acceptances (
  dispute_id uuid primary key references public.disputes (id) on delete restrict,
  accepted_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.corrections (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  entry_id uuid not null references public.consumption_entries (id) on delete restrict,
  correction_type text not null,
  new_quantity integer,
  new_consumer_id uuid references public.profiles (id) on delete restrict,
  new_unit_price_cents integer,
  justification text not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint corrections_type check (
    correction_type in ('void', 'courtesy', 'quantity_adjust', 'price_adjust', 'consumer_change')
  ),
  constraint corrections_justification check (char_length(justification) between 8 and 500),
  constraint corrections_quantity check (new_quantity is null or new_quantity between 1 and 10),
  constraint corrections_price check (
    new_unit_price_cents is null or new_unit_price_cents between 1 and 200000
  )
);

create table public.correction_acceptances (
  correction_id uuid not null references public.corrections (id) on delete restrict,
  accepted_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (correction_id, accepted_by)
);

create table public.correction_withdrawals (
  correction_id uuid primary key references public.corrections (id) on delete restrict,
  withdrawn_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.divergence_reports (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  entry_id uuid references public.consumption_entries (id) on delete restrict,
  category text not null,
  description text,
  reported_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint reports_category check (
    category in (
      'unregistered_consumption',
      'wrong_person',
      'duplicate',
      'not_consumed',
      'wrong_quantity'
    )
  ),
  constraint reports_description check (
    description is null or char_length(description) between 1 and 500
  )
);

create table public.report_resolutions (
  report_id uuid primary key references public.divergence_reports (id) on delete restrict,
  outcome text not null,
  note text not null,
  decided_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint report_resolutions_outcome check (outcome in ('dismissed', 'action_taken')),
  constraint report_resolutions_note check (char_length(note) between 8 and 500)
);

create table public.round_adjustments (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  adjustment_type text not null,
  amount_cents integer not null,
  applies_to uuid not null references public.profiles (id) on delete restrict,
  justification text not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint adjustments_type check (
    adjustment_type in ('discount', 'courtesy', 'rounding', 'price_difference', 'cancellation')
  ),
  constraint adjustments_amount check (amount_cents <> 0 and amount_cents between -500000 and 500000),
  constraint adjustments_justification check (char_length(justification) between 8 and 500)
);

create table public.adjustment_acceptances (
  adjustment_id uuid primary key references public.round_adjustments (id) on delete restrict,
  accepted_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.adjustment_withdrawals (
  adjustment_id uuid primary key references public.round_adjustments (id) on delete restrict,
  withdrawn_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now()
);

create table public.audit_events (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  actor_id uuid not null references public.profiles (id) on delete restrict,
  action text not null,
  entity_type text not null,
  entity_id uuid,
  payload jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint audit_action_length check (char_length(action) between 1 and 80),
  constraint audit_entity_length check (char_length(entity_type) between 1 and 40)
);

create table public.round_closings (
  id uuid primary key default gen_random_uuid(),
  round_id uuid not null references public.rounds (id) on delete restrict,
  closing_type text not null,
  confirmed_cents integer not null,
  pending_cents integer not null,
  disputed_cents integer not null,
  grand_cents integer not null,
  service_cents integer not null default 0,
  include_service boolean not null default false,
  venue_bill_cents integer,
  difference_cents integer,
  explanation text,
  snapshot jsonb not null,
  created_by uuid not null references public.profiles (id) on delete restrict,
  created_at timestamptz not null default now(),
  constraint closings_type check (closing_type in ('provisional', 'final')),
  constraint closings_buckets check (
    confirmed_cents >= 0 and pending_cents >= 0 and disputed_cents >= 0
  ),
  constraint closings_service check (service_cents >= 0),
  constraint closings_venue check (venue_bill_cents is null or venue_bill_cents >= 0),
  constraint closings_explanation check (
    explanation is null or char_length(explanation) between 8 and 500
  )
);

create table public.closing_acknowledgements (
  id uuid primary key default gen_random_uuid(),
  closing_id uuid not null references public.round_closings (id) on delete restrict,
  user_id uuid not null references public.profiles (id) on delete restrict,
  decision text not null,
  created_at timestamptz not null default now(),
  constraint closing_ack_decision check (decision in ('accept', 'reject'))
);

create table public.rate_limit_events (
  id bigint generated always as identity primary key,
  user_id uuid not null references public.profiles (id) on delete restrict,
  action text not null,
  created_at timestamptz not null default now()
);

create index round_participants_user_idx on public.round_participants (user_id, round_id);
create index consumption_round_idx on public.consumption_entries (round_id, created_at desc);
create index consumption_consumer_idx on public.consumption_entries (consumer_id);
create index disputes_entry_idx on public.disputes (entry_id);
create index corrections_entry_idx on public.corrections (entry_id);
create index reports_round_idx on public.divergence_reports (round_id, created_at desc);
create index reports_reporter_idx on public.divergence_reports (reported_by, round_id, created_at desc);
create index adjustments_round_idx on public.round_adjustments (round_id, applies_to);
create index audit_round_idx on public.audit_events (round_id, created_at desc);
create index closings_round_idx on public.round_closings (round_id, created_at desc);
create index closing_ack_idx on public.closing_acknowledgements (closing_id, user_id, created_at desc);
create index rate_limit_idx on public.rate_limit_events (user_id, action, created_at desc);

-- ---------------------------------------------------------------------------
-- Perfil criado junto com a conta. O nome público não é o e-mail.
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_name text;
begin
  v_name := trim(coalesce(new.raw_user_meta_data ->> 'display_name', ''));
  v_name := regexp_replace(v_name, '[[:cntrl:]<>]', '', 'g');
  if char_length(v_name) < 2 then
    v_name := 'Participante';
  end if;
  if char_length(v_name) > 40 then
    v_name := left(v_name, 40);
  end if;

  insert into public.profiles (id, display_name)
  values (new.id, v_name)
  on conflict (id) do nothing;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Travas. Usuário da aplicação não escreve direto.
-- As funções security definer rodam como postgres. No Supabase hospedado
-- esse papel não é superusuário, mas é o dono do schema e ignora RLS.
-- Lançamento, auditoria e confirmação não mudam nem somem, nem para o dono.
-- ---------------------------------------------------------------------------

create or replace function public.is_trusted_writer()
returns boolean
language sql
stable
as $$
  select current_user in ('postgres', 'supabase_admin')
    or exists (
      select 1 from pg_catalog.pg_roles
      where rolname = current_user and rolsuper
    );
$$;

create or replace function public.block_untrusted_insert()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if not public.is_trusted_writer() then
    raise exception 'Inclusão direta não é permitida.';
  end if;
  return new;
end;
$$;

create or replace function public.block_permanent_change()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  raise exception 'Este registro é permanente e não pode ser alterado nem apagado.';
end;
$$;

create or replace function public.block_untrusted_update()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_new jsonb;
  v_old jsonb;
begin
  if tg_op = 'DELETE' then
    raise exception 'Este registro não pode ser apagado.';
  end if;
  v_new := to_jsonb(new);
  v_old := to_jsonb(old);
  if not public.is_trusted_writer() then
    raise exception 'Alteração direta não é permitida.';
  end if;
  if tg_table_name = 'rounds' then
    if v_new ->> 'id' is distinct from v_old ->> 'id'
      or v_new ->> 'access_code' is distinct from v_old ->> 'access_code'
      or v_new ->> 'created_by' is distinct from v_old ->> 'created_by'
      or v_new ->> 'created_at' is distinct from v_old ->> 'created_at' then
      raise exception 'A identidade da rodada não pode mudar.';
    end if;
  elsif tg_table_name = 'round_participants' then
    if v_new ->> 'id' is distinct from v_old ->> 'id'
      or v_new ->> 'round_id' is distinct from v_old ->> 'round_id'
      or v_new ->> 'user_id' is distinct from v_old ->> 'user_id'
      or v_new ->> 'joined_at' is distinct from v_old ->> 'joined_at' then
      raise exception 'A participação não pode ser reatribuída.';
    end if;
  elsif tg_table_name = 'profiles' then
    if v_new ->> 'id' is distinct from v_old ->> 'id'
      or v_new ->> 'created_at' is distinct from v_old ->> 'created_at' then
      raise exception 'O perfil não pode ser reatribuído.';
    end if;
  end if;
  return new;
end;
$$;

create or replace function public.require_self_participant()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.user_id is distinct from auth.uid() then
    raise exception 'Cada pessoa entra com a própria conta.';
  end if;
  return new;
end;
$$;

create or replace function public.require_self_actor()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_row jsonb := to_jsonb(new);
  v_actor uuid;
begin
  v_actor := (
    case tg_table_name
      when 'entry_confirmations' then v_row ->> 'actor_id'
      when 'disputes' then v_row ->> 'opened_by'
      when 'dispute_resolutions' then v_row ->> 'decided_by'
      when 'dispute_acceptances' then v_row ->> 'accepted_by'
      when 'corrections' then v_row ->> 'created_by'
      when 'correction_acceptances' then v_row ->> 'accepted_by'
      when 'correction_withdrawals' then v_row ->> 'withdrawn_by'
      when 'divergence_reports' then v_row ->> 'reported_by'
      when 'report_resolutions' then v_row ->> 'decided_by'
      when 'round_adjustments' then v_row ->> 'created_by'
      when 'adjustment_acceptances' then v_row ->> 'accepted_by'
      when 'adjustment_withdrawals' then v_row ->> 'withdrawn_by'
      when 'audit_events' then v_row ->> 'actor_id'
      when 'round_closings' then v_row ->> 'created_by'
      when 'closing_acknowledgements' then v_row ->> 'user_id'
      when 'rate_limit_events' then v_row ->> 'user_id'
      else null
    end
  )::uuid;

  if v_actor is null or v_actor is distinct from auth.uid() then
    raise exception 'A autoria do registro não confere com a conta autenticada.';
  end if;
  return new;
end;
$$;

create or replace function public.require_consumer_confirmation()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_consumer uuid;
begin
  select consumer_id into v_consumer
  from public.consumption_entries
  where id = new.entry_id;

  if v_consumer is null or v_consumer is distinct from new.actor_id then
    raise exception 'Só quem consumiu pode confirmar este lançamento.';
  end if;
  return new;
end;
$$;

do $$
declare
  t text;
  permanent text[] := array[
    'consumption_entries',
    'entry_confirmations',
    'disputes',
    'dispute_resolutions',
    'dispute_acceptances',
    'corrections',
    'correction_acceptances',
    'correction_withdrawals',
    'divergence_reports',
    'report_resolutions',
    'round_adjustments',
    'adjustment_acceptances',
    'adjustment_withdrawals',
    'audit_events',
    'round_closings',
    'closing_acknowledgements',
    'rate_limit_events'
  ];
  actor_tables text[] := array[
    'entry_confirmations',
    'disputes',
    'dispute_resolutions',
    'dispute_acceptances',
    'corrections',
    'correction_acceptances',
    'correction_withdrawals',
    'divergence_reports',
    'report_resolutions',
    'round_adjustments',
    'adjustment_acceptances',
    'adjustment_withdrawals',
    'audit_events',
    'round_closings',
    'closing_acknowledgements',
    'rate_limit_events'
  ];
begin
  foreach t in array permanent loop
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.block_untrusted_insert()',
      t || '_trusted_insert',
      t
    );
    execute format(
      'create trigger %I before update or delete on public.%I for each row execute function public.block_permanent_change()',
      t || '_permanent',
      t
    );
  end loop;

  foreach t in array actor_tables loop
    execute format(
      'create trigger %I before insert on public.%I for each row execute function public.require_self_actor()',
      t || '_self_actor',
      t
    );
  end loop;
end;
$$;

create trigger rounds_trusted_insert
  before insert on public.rounds
  for each row execute function public.block_untrusted_insert();

create trigger rounds_trusted_update
  before update or delete on public.rounds
  for each row execute function public.block_untrusted_update();

create trigger participants_trusted_insert
  before insert on public.round_participants
  for each row execute function public.block_untrusted_insert();

create trigger participants_self
  before insert on public.round_participants
  for each row execute function public.require_self_participant();

create trigger participants_trusted_update
  before update or delete on public.round_participants
  for each row execute function public.block_untrusted_update();

create trigger profiles_trusted_insert
  before insert on public.profiles
  for each row execute function public.block_untrusted_insert();

create trigger profiles_trusted_update
  before update or delete on public.profiles
  for each row execute function public.block_untrusted_update();

create trigger confirmations_consumer
  before insert on public.entry_confirmations
  for each row execute function public.require_consumer_confirmation();

-- Funções usadas pelas políticas. Elas leem a participação sem reaplicar RLS,
-- senão a política entra em recursão.
create or replace function public.is_round_member(p_round_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.round_participants
    where round_id = p_round_id and user_id = auth.uid()
  );
$$;

create or replace function public.shares_round_with(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select p_user_id = auth.uid() or exists (
    select 1
    from public.round_participants me
    join public.round_participants them on them.round_id = me.round_id
    where me.user_id = auth.uid() and them.user_id = p_user_id
  );
$$;

create or replace function public.can_see_entry(p_entry_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_round_member((
    select round_id from public.consumption_entries where id = p_entry_id
  ));
$$;

create or replace function public.can_see_dispute(p_dispute_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_round_member((
    select round_id from public.disputes where id = p_dispute_id
  ));
$$;

create or replace function public.can_see_correction(p_correction_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_round_member((
    select round_id from public.corrections where id = p_correction_id
  ));
$$;

create or replace function public.can_see_adjustment(p_adjustment_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_round_member((
    select round_id from public.round_adjustments where id = p_adjustment_id
  ));
$$;

create or replace function public.can_see_closing(p_closing_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.is_round_member((
    select round_id from public.round_closings where id = p_closing_id
  ));
$$;

-- ---------------------------------------------------------------------------
-- RLS. Sem política de escrita: o papel authenticated não grava direto.
-- ---------------------------------------------------------------------------

alter table public.profiles enable row level security;
alter table public.profiles force row level security;
alter table public.rounds enable row level security;
alter table public.rounds force row level security;
alter table public.round_participants enable row level security;
alter table public.round_participants force row level security;
alter table public.consumption_entries enable row level security;
alter table public.consumption_entries force row level security;
alter table public.entry_confirmations enable row level security;
alter table public.entry_confirmations force row level security;
alter table public.disputes enable row level security;
alter table public.disputes force row level security;
alter table public.dispute_resolutions enable row level security;
alter table public.dispute_resolutions force row level security;
alter table public.dispute_acceptances enable row level security;
alter table public.dispute_acceptances force row level security;
alter table public.corrections enable row level security;
alter table public.corrections force row level security;
alter table public.correction_acceptances enable row level security;
alter table public.correction_acceptances force row level security;
alter table public.correction_withdrawals enable row level security;
alter table public.correction_withdrawals force row level security;
alter table public.divergence_reports enable row level security;
alter table public.divergence_reports force row level security;
alter table public.report_resolutions enable row level security;
alter table public.report_resolutions force row level security;
alter table public.round_adjustments enable row level security;
alter table public.round_adjustments force row level security;
alter table public.adjustment_acceptances enable row level security;
alter table public.adjustment_acceptances force row level security;
alter table public.adjustment_withdrawals enable row level security;
alter table public.adjustment_withdrawals force row level security;
alter table public.audit_events enable row level security;
alter table public.audit_events force row level security;
alter table public.round_closings enable row level security;
alter table public.round_closings force row level security;
alter table public.closing_acknowledgements enable row level security;
alter table public.closing_acknowledgements force row level security;
alter table public.rate_limit_events enable row level security;
alter table public.rate_limit_events force row level security;

create policy profiles_select on public.profiles
  for select to authenticated
  using (public.shares_round_with(id));

create policy rounds_select on public.rounds
  for select to authenticated
  using (public.is_round_member(id));

create policy participants_select on public.round_participants
  for select to authenticated
  using (public.is_round_member(round_id));

create policy entries_select on public.consumption_entries
  for select to authenticated
  using (public.is_round_member(round_id));

create policy confirmations_select on public.entry_confirmations
  for select to authenticated
  using (public.can_see_entry(entry_id));

create policy disputes_select on public.disputes
  for select to authenticated
  using (public.is_round_member(round_id));

create policy dispute_resolutions_select on public.dispute_resolutions
  for select to authenticated
  using (public.can_see_dispute(dispute_id));

create policy dispute_acceptances_select on public.dispute_acceptances
  for select to authenticated
  using (public.can_see_dispute(dispute_id));

create policy corrections_select on public.corrections
  for select to authenticated
  using (public.is_round_member(round_id));

create policy correction_acceptances_select on public.correction_acceptances
  for select to authenticated
  using (public.can_see_correction(correction_id));

create policy correction_withdrawals_select on public.correction_withdrawals
  for select to authenticated
  using (public.can_see_correction(correction_id));

create policy adjustments_select on public.round_adjustments
  for select to authenticated
  using (public.is_round_member(round_id));

create policy adjustment_acceptances_select on public.adjustment_acceptances
  for select to authenticated
  using (public.can_see_adjustment(adjustment_id));

create policy adjustment_withdrawals_select on public.adjustment_withdrawals
  for select to authenticated
  using (public.can_see_adjustment(adjustment_id));

create policy audit_select on public.audit_events
  for select to authenticated
  using (public.is_round_member(round_id));

create policy closings_select on public.round_closings
  for select to authenticated
  using (public.is_round_member(round_id));

create policy closing_ack_select on public.closing_acknowledgements
  for select to authenticated
  using (public.can_see_closing(closing_id));

-- Denúncias e limite de frequência não têm política de leitura.
-- O detalhe sai só pela função, já filtrado.

revoke all on all tables in schema public from public, anon, authenticated;
grant select on
  public.profiles,
  public.rounds,
  public.round_participants,
  public.consumption_entries,
  public.entry_confirmations,
  public.disputes,
  public.dispute_resolutions,
  public.dispute_acceptances,
  public.corrections,
  public.correction_acceptances,
  public.correction_withdrawals,
  public.round_adjustments,
  public.adjustment_acceptances,
  public.adjustment_withdrawals,
  public.audit_events,
  public.round_closings,
  public.closing_acknowledgements
to authenticated;

alter table public.rounds replica identity full;

do $$
declare
  t text;
begin
  foreach t in array array[
    'rounds',
    'round_participants',
    'consumption_entries',
    'entry_confirmations',
    'disputes',
    'dispute_resolutions',
    'corrections',
    'audit_events',
    'round_closings'
  ]
  loop
    begin
      execute format('alter publication supabase_realtime add table public.%I', t);
    exception
      when undefined_object or duplicate_object then
        null;
    end;
  end loop;
end;
$$;
