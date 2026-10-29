-- Conferências estruturais que rodam com `supabase test db`.
-- O comportamento das contas, disputas e RLS por usuário está em tests/security.test.ts
-- e usa a mesma migração, executada com `npm test`.

begin;
select plan(7);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.consumption_entries'::regclass),
  'lançamentos têm RLS ligado'
);

select ok(
  (select relrowsecurity from pg_class where oid = 'public.divergence_reports'::regclass),
  'denúncias têm RLS ligado'
);

select ok(
  not exists (
    select 1
    from information_schema.role_table_grants
    where table_schema = 'public'
      and table_name = 'consumption_entries'
      and grantee in ('anon', 'authenticated')
      and privilege_type in ('INSERT', 'UPDATE', 'DELETE', 'TRUNCATE')
  ),
  'o navegador não recebe escrita direta nos lançamentos'
);

select has_function(
  'public',
  'record_consumption',
  array['uuid', 'uuid', 'integer', 'uuid', 'text'],
  'o lançamento é uma função do servidor e não aceita preço do cliente'
);

select has_function(
  'public',
  'get_round_bundle',
  array['uuid'],
  'o extrato oficial é calculado no banco'
);

select ok(
  exists (
    select 1
    from pg_indexes
    where schemaname = 'public'
      and indexname = 'consumption_idempotency'
      and indexdef ilike '%unique%'
  ),
  'a chave de idempotência é única'
);

select ok(
  exists (
    select 1
    from pg_trigger
    where tgname = 'consumption_entries_permanent'
      and tgrelid = 'public.consumption_entries'::regclass
  ),
  'há trava contra apagar lançamento'
);

select * from finish();
rollback;
