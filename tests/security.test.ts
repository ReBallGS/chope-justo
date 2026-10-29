import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { PGlite } from '@electric-sql/pglite'
import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

type Json = Record<string, unknown>
type Snapshot = {
  grand_cents: number
  confirmed_cents: number
  pending_cents: number
  disputed_cents: number
  adjustment_cents: number
  blockers: string[]
  entries: Array<{
    id: string
    status: string
    amount_cents: number
    original_quantity: number
    consumer_id: string
  }>
  participants: Array<{
    user_id: string
    total_cents: number
    confirmed_cents: number
    pending_cents: number
    adjustment_cents: number
  }>
  adjustments: unknown[]
  round: { id: string; status: string; unit_price_cents: number }
}

let db: PGlite

function asJson<T>(value: unknown): T {
  if (typeof value === 'string') return JSON.parse(value) as T
  return value as T
}

async function rows(sql: string, params: unknown[] = []) {
  const result = await db.query<Json>(sql, params)
  return result.rows
}

async function call<T>(sql: string, params: unknown[] = []): Promise<T> {
  const result = await rows(sql, params)
  const first = result[0]
  const value = first[Object.keys(first)[0]]
  return asJson<T>(value)
}

async function resetRole() {
  await db.exec('reset role')
}

async function setUser(id: string | null) {
  await resetRole()
  if (!id) {
    await db.exec(`select set_config('request.jwt.claim.sub', '', false)`)
    await db.exec(`select set_config('request.jwt.claims', '', false)`)
    await db.exec('set role anon')
    return
  }
  await db.exec(`select set_config('request.jwt.claim.sub', '${id}', false)`)
  await db.exec(
    `select set_config('request.jwt.claims', '{"sub":"${id}","role":"authenticated"}', false)`,
  )
  await db.exec('set role authenticated')
}

async function createUser(name: string) {
  const id = crypto.randomUUID()
  await resetRole()
  await db.query(
    `insert into auth.users (id, email, raw_user_meta_data) values ($1, $2, $3::jsonb)`,
    [id, `${name}.${id.slice(0, 8)}@example.com`, JSON.stringify({ display_name: name })],
  )
  return id
}

async function createRound(organizer: string, price = 1000, canRecord = false) {
  await setUser(organizer)
  return call<{ id: string; access_code: string }>(
    `select public.create_round($1, $2, null, now(), 0, $3) as result`,
    ['Bar do teste', price, canRecord],
  )
}

async function join(user: string, code: string) {
  await setUser(user)
  return call<{ id: string }>(`select public.join_round($1) as result`, [code])
}

async function record(user: string, roundId: string, consumerId: string, quantity = 1, origin = 'self') {
  await setUser(user)
  return call<{ entry_id: string; idempotent: boolean; status?: string }>(
    `select public.record_consumption($1, $2, $3, $4, $5) as result`,
    [roundId, consumerId, quantity, crypto.randomUUID(), origin],
  )
}

async function bundle(user: string, roundId: string) {
  await setUser(user)
  return call<Snapshot>(`select public.get_round_bundle($1) as result`, [roundId])
}

async function countEntries(entryId?: string) {
  await resetRole()
  const result = await rows(
    entryId
      ? `select count(*)::int as n, max(quantity)::int as quantity from public.consumption_entries where id = $1`
      : `select count(*)::int as n, 0 as quantity from public.consumption_entries`,
    entryId ? [entryId] : [],
  )
  return result[0] as { n: number; quantity: number }
}

beforeAll(async () => {
  db = new PGlite()
  await db.exec(`
    create schema if not exists auth;
    create table auth.users (
      id uuid primary key,
      email text,
      raw_user_meta_data jsonb not null default '{}'::jsonb,
      raw_app_meta_data jsonb not null default '{}'::jsonb,
      created_at timestamptz not null default now()
    );
    create or replace function auth.uid()
    returns uuid
    language sql
    stable
    as $$
      select coalesce(
        nullif(current_setting('request.jwt.claim.sub', true), ''),
        (nullif(current_setting('request.jwt.claims', true), '')::jsonb ->> 'sub')
      )::uuid
    $$;
    do $$ begin create role anon nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role authenticated nologin; exception when duplicate_object then null; end $$;
    do $$ begin create role service_role nologin; exception when duplicate_object then null; end $$;
  `)
  const dir = resolve('supabase/migrations')
  for (const file of [
    '20261029120000_schema.sql',
    '20261029120100_functions.sql',
    '20261029120200_functions_governance.sql',
  ]) {
    await db.exec(readFileSync(resolve(dir, file), 'utf8'))
  }
}, 120000)

beforeEach(async () => {
  await resetRole()
})

describe('políticas e funções do Chope Justo', () => {
  it('1. um participante não altera o consumo de outra pessoa sem autorização', async () => {
    const ana = await createUser('Ana')
    const bruno = await createUser('Bruno')
    const round = await createRound(ana, 1000, false)
    await join(bruno, round.access_code)
    const own = await record(ana, round.id, ana, 1)

    await setUser(bruno)
    await expect(
      db.query(`update public.consumption_entries set quantity = 9 where id = $1`, [own.entry_id]),
    ).rejects.toThrow()
    await expect(
      db.query(`select public.record_consumption($1, $2, 1, $3, 'authorized_peer')`, [
        round.id,
        ana,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(/não está autorizado/i)
    await expect(
      db.query(`select public.confirm_entry($1)`, [own.entry_id]),
    ).rejects.toThrow(/quem consumiu/i)

    await setUser(bruno)
    const proposal = await call<{ pending: boolean }>(
      `select public.propose_correction($1, 'void', null, null, null, $2) as result`,
      [own.entry_id, 'Bruno acha que o lançamento está errado'],
    )
    expect(proposal.pending).toBe(true)
    const after = await bundle(ana, round.id)
    expect(after.grand_cents).toBe(1000)
    expect(after.entries[0].original_quantity).toBe(1)
    const stored = await countEntries(own.entry_id)
    expect(stored.quantity).toBe(1)
  })

  it('2. um organizador não apaga um lançamento, nem com papel de dono do banco', async () => {
    const ana = await createUser('Ana')
    const round = await createRound(ana)
    const entry = await record(ana, round.id, ana, 1)

    await setUser(ana)
    await expect(
      db.query(`delete from public.consumption_entries where id = $1`, [entry.entry_id]),
    ).rejects.toThrow()

    await resetRole()
    await expect(
      db.query(`delete from public.consumption_entries where id = $1`, [entry.entry_id]),
    ).rejects.toThrow(/permanente/i)
    await expect(
      db.query(`delete from public.audit_events where round_id = $1`, [round.id]),
    ).rejects.toThrow(/permanente/i)

    const stored = await countEntries(entry.entry_id)
    expect(stored.n).toBe(1)
    const audit = await rows(
      `select count(*)::int as n from public.audit_events where round_id = $1 and action = 'consumption_recorded'`,
      [round.id],
    )
    expect(audit[0].n).toBe(1)
  })

  it('3. alguém de fora não consulta nem modifica a rodada', async () => {
    const ana = await createUser('Ana')
    const fora = await createUser('Fora')
    const round = await createRound(ana)
    await record(ana, round.id, ana, 1)

    await setUser(fora)
    expect(await rows(`select id from public.rounds where id = $1`, [round.id])).toHaveLength(0)
    expect(await rows(`select id from public.consumption_entries where round_id = $1`, [round.id])).toHaveLength(0)
    expect(await rows(`select id from public.profiles where id = $1`, [ana])).toHaveLength(0)
    await expect(db.query(`select public.get_round_bundle($1)`, [round.id])).rejects.toThrow(/não participa/i)
    await expect(
      db.query(`select public.record_consumption($1, $2, 1, $3, 'self')`, [
        round.id,
        fora,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(/não participa/i)
  })

  it('4. o mesmo lançamento não é processado duas vezes', async () => {
    const ana = await createUser('Ana')
    const round = await createRound(ana)
    const key = crypto.randomUUID()
    await setUser(ana)
    const first = await call<{ entry_id: string; idempotent: boolean }>(
      `select public.record_consumption($1, $2, 2, $3, 'self') as result`,
      [round.id, ana, key],
    )
    const second = await call<{ entry_id: string; idempotent: boolean }>(
      `select public.record_consumption($1, $2, 2, $3, 'self') as result`,
      [round.id, ana, key],
    )
    expect(second.entry_id).toBe(first.entry_id)
    expect(second.idempotent).toBe(true)
    await resetRole()
    const count = await rows(
      `select count(*)::int as n from public.consumption_entries where round_id = $1`,
      [round.id],
    )
    expect(count[0].n).toBe(1)
    const index = await rows(
      `select indexdef from pg_indexes where schemaname = 'public' and indexname = 'consumption_idempotency'`,
    )
    expect(String(index[0].indexdef)).toMatch(/UNIQUE/i)
  })

  it('5. lançamento contestado não entra como confirmado', async () => {
    const ana = await createUser('Ana')
    const round = await createRound(ana)
    const entry = await record(ana, round.id, ana, 1)
    await setUser(ana)
    await db.query(`select public.open_dispute($1, $2)`, [entry.entry_id, 'Não reconheço este chope'])
    const snap = await bundle(ana, round.id)
    expect(snap.entries[0].status).toBe('disputed')
    expect(snap.confirmed_cents).toBe(0)
    expect(snap.disputed_cents).toBe(1000)
    expect(snap.grand_cents).toBe(0)
  })

  it('6. uma correção preserva o lançamento original', async () => {
    const ana = await createUser('Ana')
    const round = await createRound(ana)
    const entry = await record(ana, round.id, ana, 1)
    await setUser(ana)
    await db.query(
      `select public.propose_correction($1, 'void', null, null, null, $2)`,
      [entry.entry_id, 'Eu não bebi este chope'],
    )
    const stored = await countEntries(entry.entry_id)
    expect(stored.quantity).toBe(1)
    const snap = await bundle(ana, round.id)
    expect(snap.entries[0].status).toBe('void')
    expect(snap.entries[0].original_quantity).toBe(1)
    expect(snap.grand_cents).toBe(0)
    await resetRole()
    const audit = await rows(
      `select action from public.audit_events where entity_id = $1 and action = 'consumption_recorded'`,
      [entry.entry_id],
    )
    expect(audit).toHaveLength(1)
  })

  it('7. uma denúncia não altera a dívida', async () => {
    const ana = await createUser('Ana')
    const bruno = await createUser('Bruno')
    const round = await createRound(ana)
    await join(bruno, round.access_code)
    const entry = await record(ana, round.id, ana, 2)
    const before = await bundle(ana, round.id)
    await resetRole()
    const correctionsBefore = await rows(`select count(*)::int as n from public.corrections`)

    await setUser(bruno)
    await db.query(
      `select public.report_divergence($1, $2, 'wrong_quantity', $3)`,
      [round.id, entry.entry_id, 'Vi só um chope'],
    )
    const after = await bundle(ana, round.id)
    expect(after.grand_cents).toBe(before.grand_cents)
    expect(after.confirmed_cents).toBe(2000)
    await resetRole()
    const correctionsAfter = await rows(`select count(*)::int as n from public.corrections`)
    expect(correctionsAfter[0].n).toBe(correctionsBefore[0].n)
  })

  it('8. chamadas repetidas e a trava da rodada não duplicam cobrança', async () => {
    const ana = await createUser('Ana')
    const round = await createRound(ana, 1000)
    const first = await record(ana, round.id, ana, 1)
    const second = await record(ana, round.id, ana, 1)
    expect(second.entry_id).not.toBe(first.entry_id)
    const snap = await bundle(ana, round.id)
    expect(snap.confirmed_cents).toBe(2000)
    expect(snap.participants.reduce((sum, person) => sum + person.confirmed_cents, 0)).toBe(2000)
    await resetRole()
    const lock = await rows(
      `select proname from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and proname = '_lock_round'`,
    )
    expect(lock).toHaveLength(1)
  })

  it('9. preço e quantidade são validados no servidor', async () => {
    const ana = await createUser('Ana')
    const round = await createRound(ana, 1800)
    await setUser(ana)
    await expect(
      db.query(`select public.record_consumption($1, $2, 0, $3, 'self')`, [
        round.id,
        ana,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(/quantidade/i)
    await expect(
      db.query(`select public.record_consumption($1, $2, 11, $3, 'self')`, [
        round.id,
        ana,
        crypto.randomUUID(),
      ]),
    ).rejects.toThrow(/quantidade/i)
    await expect(
      db.query(`select public.change_unit_price($1, 0, $2)`, [round.id, 'Preço inválido']),
    ).rejects.toThrow(/preço/i)

    const args = await rows(
      `select pg_get_function_identity_arguments(p.oid) as args
       from pg_proc p
       join pg_namespace n on n.oid = p.pronamespace
       where n.nspname = 'public' and p.proname = 'record_consumption'`,
    )
    expect(String(args[0].args).toLowerCase()).not.toContain('price')

    const entry = await record(ana, round.id, ana, 1)
    await setUser(ana)
    await db.query(
      `select public.change_unit_price($1, 2200, $2)`,
      [round.id, 'O bar reajustou o chope'],
    )
    const next = await record(ana, round.id, ana, 1)
    await resetRole()
    const prices = await rows(
      `select id, unit_price_cents from public.consumption_entries where id in ($1, $2)`,
      [entry.entry_id, next.entry_id],
    )
    const byId = new Map(prices.map((row) => [row.id, row.unit_price_cents]))
    expect(byId.get(entry.entry_id)).toBe(1800)
    expect(byId.get(next.entry_id)).toBe(2200)
  })

  it('10. um usuário não se concede permissão de organizador nem de anotador', async () => {
    const ana = await createUser('Ana')
    const bruno = await createUser('Bruno')
    const round = await createRound(ana, 1000, false)
    await join(bruno, round.access_code)
    await setUser(bruno)
    await expect(
      db.query(`select public.set_participant_role($1, $2, 'organizer')`, [round.id, bruno]),
    ).rejects.toThrow(/própria permissão/i)
    await expect(
      db.query(`select public.set_recorder_permission($1, $2, true)`, [round.id, bruno]),
    ).rejects.toThrow(/própria permissão/i)
    await expect(
      db.query(`update public.round_participants set role = 'organizer' where user_id = $1`, [bruno]),
    ).rejects.toThrow()

    const snap = await bundle(bruno, round.id)
    expect(snap.participants.find((person) => person.user_id === bruno)?.total_cents).toBe(0)
    await resetRole()
    const role = await rows(
      `select role, can_record_for_others from public.round_participants where user_id = $1`,
      [bruno],
    )
    expect(role[0].role).toBe('participant')
    expect(role[0].can_record_for_others).toBe(false)
  })

  it('11. o fechamento não distribui a diferença da conta', async () => {
    const ana = await createUser('Ana')
    const bruno = await createUser('Bruno')
    const round = await createRound(ana, 1000, true)
    await join(bruno, round.access_code)
    await record(ana, round.id, ana, 2)
    await record(ana, round.id, bruno, 1, 'waiter')

    await setUser(ana)
    await db.query(`select public.start_review($1)`, [round.id])
    await expect(
      db.query(`select public.propose_closing($1, 'final', 3500, $2)`, [
        round.id,
        'Ainda há item pendente',
      ]),
    ).rejects.toThrow(/divergências/i)

    const provisional = await call<{ closing_id: string; allocated: boolean }>(
      `select public.propose_closing($1, 'provisional', 3500, $2) as result`,
      [round.id, 'Conta do bar maior, sem rateio'],
    )
    expect(provisional.allocated).toBe(false)
    const withService = await call<{
      allocated: boolean
      service_cents: number
      payable_cents: number
      difference_cents: number
    }>(
      `select public.propose_closing($1, 'provisional', 3500, $2, true) as result`,
      [round.id, 'Dez por cento só sobre o confirmado'],
    )
    expect(withService.allocated).toBe(false)
    expect(withService.service_cents).toBe(200)
    expect(withService.payable_cents).toBe(2200)
    expect(withService.difference_cents).toBe(1300)
    const unchanged = await bundle(ana, round.id)
    expect(unchanged.participants.map((person) => person.total_cents).sort((a, b) => a - b)).toEqual([0, 2000])
    await setUser(ana)
    await db.query(`select public.acknowledge_closing($1, 'accept')`, [provisional.closing_id])
    await setUser(bruno)
    await db.query(`select public.acknowledge_closing($1, 'accept')`, [provisional.closing_id])

    const snap = await bundle(ana, round.id)
    expect(snap.round.status).toBe('provisionally_closed')
    expect(snap.confirmed_cents).toBe(2000)
    expect(snap.pending_cents).toBe(1000)
    expect(snap.participants.reduce((sum, person) => sum + person.total_cents, 0)).toBe(2000)
    expect(snap.adjustments).toHaveLength(0)
    expect(snap.participants.every((person) => person.total_cents !== 1750)).toBe(true)

    await setUser(bruno)
    const pending = snap.entries.find((entry) => entry.status === 'pending')
    await db.query(`select public.confirm_entry($1)`, [pending!.id])

    await setUser(ana)
    const finalProposal = await call<{ closing_id: string; difference_cents: number; allocated: boolean }>(
      `select public.propose_closing($1, 'final', 3500, $2) as result`,
      [round.id, 'O bar cobrou um item que ninguém confirmou'],
    )
    expect(finalProposal.allocated).toBe(false)
    expect(finalProposal.difference_cents).toBe(500)
    await setUser(ana)
    await db.query(`select public.acknowledge_closing($1, 'accept')`, [finalProposal.closing_id])
    await setUser(bruno)
    await db.query(`select public.acknowledge_closing($1, 'accept')`, [finalProposal.closing_id])

    const closed = await bundle(ana, round.id)
    expect(closed.round.status).toBe('closed')
    const totals = closed.participants.map((person) => person.total_cents).sort((a, b) => a - b)
    expect(totals).toEqual([1000, 2000])
    expect(closed.grand_cents).toBe(3000)
    expect(closed.adjustments).toHaveLength(0)
  })

  it('o convite mostra quem já está na mesa sem abrir a conta', async () => {
    const ana = await createUser('Ana')
    const round = await createRound(ana, 1800)
    await setUser(null)
    const preview = await call<{ name: string; members: string[]; unit_price_cents: number }>(
      `select public.preview_round($1) as result`,
      [round.access_code],
    )
    expect(preview.name).toBe('Bar do teste')
    expect(preview.members).toEqual(['Ana'])
    expect(preview.unit_price_cents).toBe(1800)
    await expect(db.query(`select public.join_round($1)`, [round.access_code])).rejects.toThrow()
    await expect(db.query(`select public.get_round_bundle($1)`, [round.id])).rejects.toThrow()
  })

  it('12. totais individuais e geral permanecem consistentes', async () => {
    const ana = await createUser('Ana')
    const bruno = await createUser('Bruno')
    const caio = await createUser('Caio')
    const round = await createRound(ana, 1000, true)
    await join(bruno, round.access_code)
    await join(caio, round.access_code)
    await record(ana, round.id, ana, 2)
    const brunoEntry = await record(bruno, round.id, bruno, 1)
    await record(ana, round.id, caio, 1, 'authorized_peer')
    await setUser(caio)
    await db.query(`select public.open_dispute($1, $2)`, [brunoEntry.entry_id, 'Este chope não foi do Bruno'])

    await setUser(ana)
    await db.query(
      `select public.propose_adjustment($1, 'discount', -500, $2, $3)`,
      [round.id, ana, 'Ana pagou uma rodada por fora'],
    )

    const snap = await bundle(ana, round.id)
    const people = snap.participants.reduce((sum, person) => sum + person.total_cents, 0)
    const confirmed = snap.participants.reduce((sum, person) => sum + person.confirmed_cents, 0)
    expect(people).toBe(snap.grand_cents)
    expect(confirmed).toBe(snap.confirmed_cents)
    expect(snap.grand_cents).toBe(snap.confirmed_cents + snap.adjustment_cents)
    expect(snap.confirmed_cents).toBe(2000)
    expect(snap.pending_cents).toBe(1000)
    expect(snap.disputed_cents).toBe(1000)
    expect(snap.adjustment_cents).toBe(-500)
    expect(snap.grand_cents).toBe(1500)
    expect(snap.entries.find((entry) => entry.id === brunoEntry.entry_id)?.status).toBe('disputed')
  })
})
