import { FormEvent, useCallback, useEffect, useState } from 'react'
import { useParams } from 'react-router-dom'
import QRCode from 'qrcode'
import { api } from '../lib/api'
import {
  adjustmentLabel,
  auditText,
  categoryLabel,
  correctionLabel,
  decisionLabel,
  originLabel,
  reportCategories,
  roundStatusLabel,
  statusLabel,
} from '../lib/labels'
import { formatAccessCode, formatCents, formatWhen, joinUrl, parseReaisToCents, serviceShareCents, VENUE_MAX, whatsAppShareUrl } from '../lib/money'
import { enqueueOutbox, isOfflineError, outboxFor, removeOutbox, type OutboxItem } from '../lib/outbox'
import { supabase } from '../lib/supabase'
import type { EntryView, ReportCategory, RoundBundle } from '../lib/types'

type Tab = 'registrar' | 'extrato' | 'divergencias' | 'fechamento' | 'historico'

export function RoundPage() {
  const { id = '' } = useParams()
  const [bundle, setBundle] = useState<RoundBundle | null>(null)
  const [tab, setTab] = useState<Tab>('registrar')
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [qr, setQr] = useState('')
  const [showQr, setShowQr] = useState(false)
  const [outbox, setOutbox] = useState<OutboxItem[]>([])
  const [unseen, setUnseen] = useState(0)

  const refresh = useCallback(async () => {
    const next = await api.bundle(id)
    setBundle(next)
    setOutbox(outboxFor(id))
    return next
  }, [id])

  useEffect(() => {
    let alive = true
    setLoading(true)
    refresh()
      .catch((err: unknown) => {
        if (alive) setError(err instanceof Error ? err.message : 'Não foi possível abrir a rodada.')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [refresh])

  useEffect(() => {
    if (!bundle) return
    const key = `chope-seen-${bundle.round.id}`
    const seen = new Set<string>(JSON.parse(sessionStorage.getItem(key) || '[]') as string[])
    setUnseen(bundle.entries.filter((entry) => !seen.has(entry.id) && entry.recorded_by !== bundle.me.user_id).length)
  }, [bundle])

  useEffect(() => {
    if (!showQr || !bundle) return
    let cancelled = false
    QRCode.toDataURL(joinUrl(bundle.round.access_code), { margin: 1, width: 280 })
      .then((url) => {
        if (!cancelled) setQr(url)
      })
      .catch(() => {
        if (!cancelled) setError('Não foi possível gerar o QR Code.')
      })
    return () => {
      cancelled = true
    }
  }, [bundle, showQr])

  useEffect(() => {
    const client = supabase
    if (!client || !id) return
    const channel = client
      .channel(`round-${id}`)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'audit_events', filter: `round_id=eq.${id}` }, () => {
        void refresh().catch(() => undefined)
      })
      .subscribe()
    return () => {
      void client.removeChannel(channel)
    }
  }, [id, refresh])

  async function run(task: () => Promise<unknown>) {
    setBusy(true)
    setError('')
    setNotice('')
    try {
      await task()
      await refresh()
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível concluir.')
    } finally {
      setBusy(false)
    }
  }

  async function flushOutbox() {
    const items = outboxFor(id)
    for (const item of items) {
      try {
        await api.record(item)
        removeOutbox(item.idempotencyKey)
      } catch (err) {
        if (isOfflineError(err)) return
        removeOutbox(item.idempotencyKey)
        setError(err instanceof Error ? err.message : 'Um lançamento deste aparelho foi recusado.')
      }
    }
    if (items.length) await refresh()
    setOutbox(outboxFor(id))
  }

  useEffect(() => {
    if (!id) return
    void flushOutbox()
    const onOnline = () => void flushOutbox()
    window.addEventListener('online', onOnline)
    return () => window.removeEventListener('online', onOnline)
    // A fila é reenviada ao abrir a rodada e quando a rede volta.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [id])

  function markSeen() {
    if (!bundle) return
    sessionStorage.setItem(`chope-seen-${bundle.round.id}`, JSON.stringify(bundle.entries.map((entry) => entry.id)))
    setUnseen(0)
    setTab('extrato')
  }

  async function copySummary() {
    if (!bundle) return
    const lines = [
      `Chope Justo — ${bundle.round.name}`,
      `Preço atual: ${formatCents(bundle.round.unit_price_cents)}`,
      ...bundle.participants.map(
        (person) =>
          `${person.display_name}: ${person.confirmed_quantity} confirmado(s), a pagar ${formatCents(person.total_cents)}`,
      ),
      `Total confirmado: ${formatCents(bundle.grand_cents)}`,
      `Aguardando confirmação: ${formatCents(bundle.pending_cents)}`,
      `Em divergência: ${formatCents(bundle.disputed_cents)}`,
      'Pendências e divergências não entram no total a pagar.',
      'A diferença da conta do bar não é dividida automaticamente.',
    ]
    await navigator.clipboard.writeText(lines.join('\n'))
    setNotice('Resumo copiado.')
  }

  if (loading) return <p>Carregando a mesa…</p>
  if (!bundle) return <p className="error">{error || 'Mesa indisponível.'}</p>

  const mine = bundle.participants.find((person) => person.user_id === bundle.me.user_id)
  const tabs: Array<{ id: Tab; label: string; hint: string }> = [
    { id: 'registrar', label: 'Chope', hint: 'Registrar chope' },
    { id: 'extrato', label: 'Conta', hint: 'Extrato da mesa' },
    { id: 'divergencias', label: 'Avisos', hint: 'Divergências' },
    { id: 'fechamento', label: 'Fechar', hint: 'Fechamento' },
    { id: 'historico', label: 'Histórico', hint: 'Histórico da mesa' },
  ]

  return (
    <section className="stack round-page">
      <div className="spread">
        <div>
          <p className="eyebrow">{roundStatusLabel[bundle.round.status]}</p>
          <h1>{bundle.round.name}</h1>
          <p className="hero-money">{formatCents(mine?.total_cents ?? 0)}</p>
          <p className="muted">
            sua conta agora · {formatCents(bundle.round.unit_price_cents)} cada
            {bundle.round.volume_ml ? ` · ${bundle.round.volume_ml} ml` : ''}
          </p>
        </div>
        <button className="ghost" type="button" onClick={() => void refresh()}>Atualizar</button>
      </div>
      <div className="card stack">
        <a className="button primary" href={whatsAppShareUrl(bundle.round.name, bundle.round.access_code)} target="_blank" rel="noreferrer">
          Chamar no WhatsApp
        </a>
        <button type="button" onClick={() => void navigator.clipboard.writeText(joinUrl(bundle.round.access_code)).then(() => setNotice('Link da mesa copiado.'))}>
          Copiar link
        </button>
        <details className="fold" onToggle={(event) => setShowQr(event.currentTarget.open)}>
          <summary>QR e código</summary>
          <div className="stack">
            <code className="access">{formatAccessCode(bundle.round.access_code)}</code>
            {showQr && qr && <img className="qr" src={qr} alt="QR Code para entrar nesta mesa" />}
          </div>
        </details>
      </div>
      {unseen > 0 && (
        <div className="banner row">
          <span>Há {unseen} lançamento{unseen > 1 ? 's' : ''} novo{unseen > 1 ? 's' : ''} para conferir.</span>
          <button type="button" onClick={markSeen}>Ver extrato</button>
        </div>
      )}
      {notice && <p>{notice}</p>}
      {error && <p className="error">{error}</p>}
      <nav className="dock" role="tablist" aria-label="Seções da mesa">
        {tabs.map((item) => (
          <button key={item.id} type="button" role="tab" aria-label={item.hint} aria-selected={tab === item.id} onClick={() => setTab(item.id)}>
            {item.label}
          </button>
        ))}
      </nav>
      {tab === 'registrar' && (
        <RegisterPanel bundle={bundle} busy={busy} outbox={outbox} run={run} onQueued={() => setOutbox(outboxFor(id))} />
      )}
      {tab === 'extrato' && <Statement bundle={bundle} busy={busy} run={run} />}
      {tab === 'divergencias' && <Reports bundle={bundle} busy={busy} run={run} />}
      {tab === 'fechamento' && <Closing bundle={bundle} busy={busy} run={run} onCopy={() => void copySummary()} />}
      {tab === 'historico' && <Audit bundle={bundle} />}
    </section>
  )
}

function RegisterPanel({
  bundle,
  busy,
  outbox,
  run,
  onQueued,
}: {
  bundle: RoundBundle
  busy: boolean
  outbox: OutboxItem[]
  run: (task: () => Promise<unknown>) => Promise<void>
  onQueued: () => void
}) {
  const [consumerId, setConsumerId] = useState(bundle.me.user_id)
  const [quantity, setQuantity] = useState(1)
  const [origin, setOrigin] = useState<'waiter' | 'authorized_peer'>('authorized_peer')
  const closed = bundle.round.status !== 'open'

  async function register() {
    const item: OutboxItem = {
      idempotencyKey: crypto.randomUUID(),
      roundId: bundle.round.id,
      consumerId,
      quantity,
      origin: consumerId === bundle.me.user_id ? 'self' : origin,
      createdAt: new Date().toISOString(),
    }
    if (!navigator.onLine) {
      enqueueOutbox(item)
      onQueued()
      return
    }
    await run(async () => {
      try {
        await api.record(item)
      } catch (err) {
        if (isOfflineError(err)) {
          enqueueOutbox(item)
          onQueued()
          return
        }
        throw err
      }
    })
  }

  return (
    <div className="card stack">
      <h2>Registrar chope</h2>
      <p className="muted">
        O seu próprio chope já entra confirmado. O chope de outra pessoa fica aguardando a confirmação dela.
        O preço usado é o da rodada, não um valor digitado neste celular.
      </p>
      {bundle.me.can_record_for_others && (
        <>
          <label className="field">
            <span>Quem consumiu</span>
            <select value={consumerId} onChange={(event) => setConsumerId(event.target.value)}>
              {bundle.participants.map((person) => (
                <option key={person.user_id} value={person.user_id}>{person.display_name}</option>
              ))}
            </select>
          </label>
          {consumerId !== bundle.me.user_id && (
            <label className="field">
              <span>Quem está anotando</span>
              <select value={origin} onChange={(event) => setOrigin(event.target.value as 'waiter' | 'authorized_peer')}>
                <option value="authorized_peer">Outro participante</option>
                <option value="waiter">Quem está na função de anotar os pedidos</option>
              </select>
            </label>
          )}
        </>
      )}
      <div className="stepper">
        <button type="button" onClick={() => setQuantity((value) => Math.max(1, value - 1))} aria-label="Diminuir quantidade">−</button>
        <strong>{quantity}</strong>
        <button type="button" onClick={() => setQuantity((value) => Math.min(10, value + 1))} aria-label="Aumentar quantidade">+</button>
      </div>
      <button className="primary big-action" type="button" disabled={busy || closed} onClick={() => void register()}>
        {closed ? 'Mesa fechada para novos chopes' : `Anotar ${quantity} chope${quantity > 1 ? 's' : ''}`}
      </button>
      {outbox.length > 0 && (
        <div className="outbox">
          <strong>Sincronização pendente neste aparelho</strong>
          <p>Estes lançamentos ainda não foram aceitos pelo servidor. Eles não entram na conta.</p>
          {outbox.map((item) => (
            <p key={item.idempotencyKey}>{item.quantity} chope(s) · {formatWhen(item.createdAt)}</p>
          ))}
        </div>
      )}
    </div>
  )
}

function Statement({
  bundle,
  busy,
  run,
}: {
  bundle: RoundBundle
  busy: boolean
  run: (task: () => Promise<unknown>) => Promise<void>
}) {
  const mine = bundle.participants.find((person) => person.user_id === bundle.me.user_id)
  return (
    <div className="stack">
      <div className="card">
        <h2>Seu extrato</h2>
        <p className="money">{formatCents(mine?.total_cents ?? 0)}</p>
        <p className="muted">
          {mine?.confirmed_quantity ?? 0} chope(s) confirmado(s). Totais calculados no servidor.
          Pendências e divergências ficam de fora deste valor.
        </p>
      </div>
      <div className="card">
        <h2>Pessoas</h2>
        {bundle.participants.map((person) => (
          <div className="person" key={person.user_id}>
            <div>
              <strong>{person.display_name}</strong>
              <div className="muted">
                {person.role === 'organizer' ? 'Organiza a rodada' : 'Participante'}
                {person.can_record_for_others ? ' · pode anotar para o grupo' : ''}
              </div>
              {bundle.me.role === 'organizer' && person.user_id !== bundle.me.user_id && (
                <div className="row">
                  <button type="button" disabled={busy} onClick={() => void run(() => api.setRecorder(bundle.round.id, person.user_id, !person.can_record_for_others))}>
                    {person.can_record_for_others ? 'Tirar anotação' : 'Permitir anotar'}
                  </button>
                  <button type="button" disabled={busy} onClick={() => void run(() => api.setRole(bundle.round.id, person.user_id, person.role === 'organizer' ? 'participant' : 'organizer'))}>
                    {person.role === 'organizer' ? 'Deixar de organizar' : 'Também organizar'}
                  </button>
                </div>
              )}
            </div>
            <div>
              <div className="money">{formatCents(person.total_cents)}</div>
              <div className="muted">{person.confirmed_quantity} confirmado(s)</div>
            </div>
          </div>
        ))}
      </div>
      <div className="card">
        <h2>Lançamentos</h2>
        {bundle.entries.length === 0 && <p className="muted">Nenhum chope lançado ainda.</p>}
        {bundle.entries.map((entry) => (
          <EntryCard key={entry.id} entry={entry} bundle={bundle} busy={busy} run={run} />
        ))}
      </div>
    </div>
  )
}

function EntryCard({
  entry,
  bundle,
  busy,
  run,
}: {
  entry: EntryView
  bundle: RoundBundle
  busy: boolean
  run: (task: () => Promise<unknown>) => Promise<void>
}) {
  const [explanation, setExplanation] = useState('')
  const [justification, setJustification] = useState('')
  const [decisionNote, setDecisionNote] = useState('')
  const [correctionType, setCorrectionType] = useState('void')
  const [quantity, setQuantity] = useState(entry.original_quantity)
  const [price, setPrice] = useState('')
  const [newConsumer, setNewConsumer] = useState('')
  const isConsumer = entry.consumer_id === bundle.me.user_id
  const pendingDecision = entry.dispute_history.find((item) => item.decision && item.decision !== 'withdrawn' && !item.accepted_at)

  async function sendCorrection(event: FormEvent) {
    event.preventDefault()
    const priceCents = correctionType === 'price_adjust' ? parseReaisToCents(price) : null
    await run(async () => {
      if (correctionType === 'price_adjust' && priceCents == null) {
        throw new Error('Informe o preço corrigido.')
      }
      await api.proposeCorrection({
        entryId: entry.id,
        type: correctionType,
        quantity: correctionType === 'quantity_adjust' ? quantity : null,
        consumerId: correctionType === 'consumer_change' ? newConsumer : null,
        priceCents,
        justification,
      })
    })
  }

  return (
    <article className="entry">
      <div className="spread">
        <div>
          <strong>{entry.consumer_name}</strong>
          <div className="muted">
            {entry.original_quantity} × {formatCents(entry.original_unit_price_cents)} · {originLabel[entry.origin]}
          </div>
          <div className="muted">Anotado por {entry.recorded_by_name} · {formatWhen(entry.created_at)}</div>
        </div>
        <div>
          <span className={`pill ${entry.status}`}>{statusLabel[entry.status]}</span>
          <div className="money">{formatCents(entry.amount_cents)}</div>
        </div>
      </div>
      {entry.status === 'pending' && isConsumer && (
        <button className="primary" type="button" disabled={busy} onClick={() => void run(() => api.confirm(entry.id))}>
          Confirmar que eu consumi
        </button>
      )}
      {entry.open_dispute && (
        <p>Divergência aberta por {entry.open_dispute.opened_by_name}. {entry.open_dispute.explanation}</p>
      )}
      {pendingDecision && isConsumer && (
        <div className="stack">
          <p>Há uma decisão registrada: {decisionLabel[pendingDecision.decision ?? ''] ?? pendingDecision.decision}. Ela só vale se você aceitar.</p>
          <button className="primary" type="button" disabled={busy} onClick={() => void run(() => api.acceptDispute(pendingDecision.id))}>
            Aceitar o desfecho
          </button>
        </div>
      )}
      {entry.open_dispute && bundle.me.role === 'organizer' && !pendingDecision && (
        <form className="stack" onSubmit={(event) => {
          event.preventDefault()
          const decision = (event.currentTarget.elements.namedItem('decision') as HTMLSelectElement).value
          void run(() => api.decideDispute(entry.open_dispute!.id, decision, decisionNote))
        }}>
          <label className="field">
            <span>Registrar decisão, sem mudar a conta agora</span>
            <select name="decision" defaultValue="upheld_original">
              <option value="upheld_original">Manter o lançamento</option>
              <option value="void_entry">Propor anulação</option>
            </select>
          </label>
          <label className="field">
            <span>Justificativa</span>
            <textarea value={decisionNote} onChange={(event) => setDecisionNote(event.target.value)} minLength={8} required />
          </label>
          <button type="submit" disabled={busy}>Registrar decisão</button>
        </form>
      )}
      {entry.open_dispute && entry.open_dispute.opened_by === bundle.me.user_id && !pendingDecision && (
        <button type="button" disabled={busy} onClick={() => void run(() => api.withdrawDispute(entry.open_dispute!.id))}>
          Retirar contestação
        </button>
      )}
      {entry.pending_correction && (
        <div className="banner stack">
          <strong>Correção aguardando aceite</strong>
          <p>{correctionLabel[entry.pending_correction.correction_type]} · {entry.pending_correction.justification}</p>
          <p className="muted">Proposta por {entry.pending_correction.created_by_name}. O valor original continua valendo até o aceite.</p>
          {entry.pending_correction.required_acceptors.includes(bundle.me.user_id) && (
            <button className="primary" type="button" disabled={busy} onClick={() => void run(() => api.acceptCorrection(entry.pending_correction!.id))}>
              Aceitar correção
            </button>
          )}
          {(entry.pending_correction.created_by === bundle.me.user_id || entry.pending_correction.required_acceptors.includes(bundle.me.user_id)) && (
            <button type="button" disabled={busy} onClick={() => void run(() => api.withdrawCorrection(entry.pending_correction!.id))}>
              {entry.pending_correction.created_by === bundle.me.user_id ? 'Retirar proposta' : 'Recusar correção'}
            </button>
          )}
        </div>
      )}
      {entry.status !== 'void' && entry.status !== 'courtesy' && bundle.round.status !== 'closed' && (
        <details>
          <summary>Contestar ou pedir correção</summary>
          <form className="stack" onSubmit={(event) => {
            event.preventDefault()
            void run(() => api.openDispute(entry.id, explanation))
          }}>
            <label className="field">
              <span>O que divergiu, se quiser explicar</span>
              <textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} />
            </label>
            <button className="warn" type="submit" disabled={busy}>Contestar lançamento</button>
          </form>
          <form className="stack" onSubmit={(event) => void sendCorrection(event)}>
            <label className="field">
              <span>Correção</span>
              <select value={correctionType} onChange={(event) => setCorrectionType(event.target.value)}>
                {Object.entries(correctionLabel).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </label>
            {correctionType === 'quantity_adjust' && (
              <label className="field">
                <span>Nova quantidade</span>
                <input type="number" min={1} max={10} value={quantity} onChange={(event) => setQuantity(Number(event.target.value))} />
              </label>
            )}
            {correctionType === 'price_adjust' && (
              <label className="field">
                <span>Novo preço</span>
                <input value={price} onChange={(event) => setPrice(event.target.value)} />
              </label>
            )}
            {correctionType === 'consumer_change' && (
              <label className="field">
                <span>Outra pessoa</span>
                <select value={newConsumer} onChange={(event) => setNewConsumer(event.target.value)} required>
                  <option value="">Escolher</option>
                  {bundle.participants.filter((person) => person.user_id !== entry.consumer_id).map((person) => (
                    <option key={person.user_id} value={person.user_id}>{person.display_name}</option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>Justificativa</span>
              <textarea value={justification} onChange={(event) => setJustification(event.target.value)} minLength={8} required />
            </label>
            <button type="submit" disabled={busy}>Pedir correção</button>
          </form>
        </details>
      )}
      {entry.dispute_history.length > 0 && (
        <details>
          <summary>Histórico desta divergência</summary>
          {entry.dispute_history.map((item) => (
            <p key={item.id}>
              {item.opened_by_name} contestou. {item.explanation}
              {item.decision ? ` Desfecho: ${decisionLabel[item.decision] ?? item.decision}. ${item.justification ?? ''}` : ' Ainda sem desfecho aceito.'}
            </p>
          ))}
        </details>
      )}
    </article>
  )
}

function Reports({
  bundle,
  busy,
  run,
}: {
  bundle: RoundBundle
  busy: boolean
  run: (task: () => Promise<unknown>) => Promise<void>
}) {
  const [category, setCategory] = useState<ReportCategory>('unregistered_consumption')
  const [entryId, setEntryId] = useState('')
  const [description, setDescription] = useState('')
  const [notes, setNotes] = useState<Record<string, string>>({})

  async function submit(event: FormEvent) {
    event.preventDefault()
    await run(() =>
      api.report({
        roundId: bundle.round.id,
        entryId: category === 'unregistered_consumption' ? null : entryId,
        category,
        description,
      }),
    )
    setDescription('')
  }

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Reportar divergência</h2>
        <p className="muted">
          A denúncia não muda o valor de ninguém. Ela abre uma ocorrência para ser verificada.
          O grupo vê quantas estão abertas; o relato fica com quem organiza, com quem reportou e, se houver, com a pessoa do lançamento.
        </p>
        <p>{bundle.report_counts.open} aberta(s) · {bundle.report_counts.resolved} verificada(s)</p>
        {bundle.round.status !== 'closed' && (
          <form className="stack" onSubmit={(event) => void submit(event)}>
            <label className="field">
              <span>Categoria</span>
              <select value={category} onChange={(event) => setCategory(event.target.value as ReportCategory)}>
                {reportCategories.map((item) => (
                  <option key={item.id} value={item.id}>{item.label}</option>
                ))}
              </select>
            </label>
            {category !== 'unregistered_consumption' && (
              <label className="field">
                <span>Lançamento</span>
                <select value={entryId} onChange={(event) => setEntryId(event.target.value)} required>
                  <option value="">Escolher</option>
                  {bundle.entries.map((entry) => (
                    <option key={entry.id} value={entry.id}>
                      {entry.consumer_name} · {formatWhen(entry.created_at)} · {formatCents(entry.amount_cents)}
                    </option>
                  ))}
                </select>
              </label>
            )}
            <label className="field">
              <span>Descrição, se quiser</span>
              <textarea value={description} onChange={(event) => setDescription(event.target.value)} />
            </label>
            <button className="primary" type="submit" disabled={busy}>Reportar divergência</button>
          </form>
        )}
      </div>
      <div className="card stack">
        {bundle.reports.length === 0 && <p className="muted">Nenhum relato visível para você, além da contagem acima.</p>}
        {bundle.reports.map((report) => (
          <article key={report.id} className="entry">
            <strong>{categoryLabel[report.category]}</strong>
            <p>{report.description}</p>
            <p className="muted">
              {report.redacted ? 'Relato sobre um lançamento seu, sem identificar quem reportou.' : report.reporter_name ? `Reportado por ${report.reporter_name}` : 'Reportado por você'}
              {' · '}{report.status === 'open' ? 'Aberta' : report.status === 'dismissed' ? 'Verificada, sem mudança' : 'Verificada, com providência'}
            </p>
            {report.resolution_note && <p>Nota: {report.resolution_note}</p>}
            {bundle.me.role === 'organizer' && report.status === 'open' && bundle.round.status !== 'closed' && (
              <form className="stack" onSubmit={(event) => {
                event.preventDefault()
                const outcome = (event.currentTarget.elements.namedItem('outcome') as HTMLSelectElement).value
                void run(() => api.resolveReport(report.id, outcome, notes[report.id] ?? ''))
              }}>
                <select name="outcome" defaultValue="action_taken">
                  <option value="action_taken">Providência anotada</option>
                  <option value="dismissed">Nada a alterar</option>
                </select>
                <textarea value={notes[report.id] ?? ''} onChange={(event) => setNotes({ ...notes, [report.id]: event.target.value })} minLength={8} required />
                <button type="submit" disabled={busy}>Registrar verificação</button>
              </form>
            )}
          </article>
        ))}
      </div>
    </div>
  )
}

function Closing({
  bundle,
  busy,
  run,
  onCopy,
}: {
  bundle: RoundBundle
  busy: boolean
  run: (task: () => Promise<unknown>) => Promise<void>
  onCopy: () => void
}) {
  const [venue, setVenue] = useState('')
  const [explanation, setExplanation] = useState('')
  const [adjustType, setAdjustType] = useState('discount')
  const [adjustValue, setAdjustValue] = useState('')
  const [adjustPerson, setAdjustPerson] = useState(bundle.me.user_id)
  const [adjustNote, setAdjustNote] = useState('')
  const [price, setPrice] = useState('')
  const [priceNote, setPriceNote] = useState('')
  const [includeService, setIncludeService] = useState(false)
  const venueCents = venue.trim() ? parseReaisToCents(venue, { allowZero: true, maxCents: VENUE_MAX }) : null
  const servicePreview = includeService
    ? bundle.participants.reduce((sum, person) => sum + serviceShareCents(person.total_cents), 0)
    : 0

  return (
    <div className="stack">
      <div className="card stack">
        <h2>Conta</h2>
        <div className="totals">
          <div className="total-box"><span>Confirmado</span><strong>{formatCents(bundle.grand_cents)}</strong></div>
          <div className="total-box"><span>Aguardando</span><strong>{formatCents(bundle.pending_cents)}</strong></div>
          <div className="total-box"><span>Em divergência</span><strong>{formatCents(bundle.disputed_cents)}</strong></div>
          <div className="total-box"><span>Ajustes aceitos</span><strong>{formatCents(bundle.adjustment_cents)}</strong></div>
        </div>
        <p className="muted">A diferença para a conta do bar não é distribuída entre as pessoas.</p>
        {bundle.blockers.length > 0 && (
          <ul>
            {bundle.blockers.map((item) => <li key={item}>{item}</li>)}
          </ul>
        )}
        <button type="button" onClick={onCopy}>Copiar resumo</button>
      </div>
      {bundle.round.status !== 'closed' && (
        <form className="card stack" onSubmit={(event) => event.preventDefault()}>
          <h2>Revisão e fechamento</h2>
          <label className="field">
            <span>Conta informada pelo estabelecimento</span>
            <input inputMode="decimal" placeholder="0,00" value={venue} onChange={(event) => setVenue(event.target.value)} />
          </label>
          <label className="check">
            <input type="checkbox" checked={includeService} onChange={(event) => setIncludeService(event.target.checked)} />
            <span>Incluir 10% de serviço</span>
          </label>
          {includeService && (
            <div className="stack">
              <p>10% sobre o que cada pessoa já tem confirmado: {formatCents(servicePreview)}. Total com serviço: {formatCents(bundle.grand_cents + servicePreview)}.</p>
              <ul>
                {bundle.participants.map((person) => {
                  const service = serviceShareCents(person.total_cents)
                  return (
                    <li key={person.user_id}>
                      {person.display_name}: {formatCents(person.total_cents)} + {formatCents(service)} = {formatCents(person.total_cents + service)}
                    </li>
                  )
                })}
              </ul>
              <p className="muted">O percentual sai da conta de cada um. O que sobrar da conta do bar continua sem rateio.</p>
            </div>
          )}
          <label className="field">
            <span>Explicação, se houver diferença ou item em aberto</span>
            <textarea value={explanation} onChange={(event) => setExplanation(event.target.value)} />
          </label>
          <div className="row">
            {bundle.round.status !== 'review' && (
              <button type="button" disabled={busy} onClick={() => void run(() => api.startReview(bundle.round.id))}>Iniciar revisão</button>
            )}
            {bundle.round.status !== 'open' && (
              <button type="button" disabled={busy} onClick={() => void run(() => api.resumeRound(bundle.round.id))}>Voltar a lançar chopes</button>
            )}
          </div>
          <button type="button" disabled={busy} onClick={() => void run(() => api.proposeClosing({
            roundId: bundle.round.id,
            type: 'provisional',
            venueCents,
            explanation,
            includeService,
          }))}>
            Propor fechamento provisório
          </button>
          <button className="primary" type="button" disabled={busy} onClick={() => void run(() => api.proposeClosing({
            roundId: bundle.round.id,
            type: 'final',
            venueCents,
            explanation,
            includeService,
          }))}>
            Propor fechamento definitivo
          </button>
        </form>
      )}
      {bundle.closings.map((closing) => {
        const latest = new Map<string, (typeof closing.acknowledgements)[number]>()
        closing.acknowledgements.forEach((ack) => latest.set(ack.user_id, ack))
        const mine = latest.get(bundle.me.user_id)
        return (
          <article className="card stack" key={closing.id}>
            <h3>{closing.closing_type === 'final' ? 'Proposta definitiva' : 'Proposta provisória'}</h3>
            <p>Total confirmado {formatCents(closing.grand_cents)}
              {closing.include_service ? ` · 10% ${formatCents(closing.service_cents)} · a pagar ${formatCents(closing.payable_cents)}` : ''}
              {closing.venue_bill_cents != null ? ` · conta do bar ${formatCents(closing.venue_bill_cents)}` : ''}
              {closing.difference_cents != null ? ` · diferença ${formatCents(closing.difference_cents)} sem rateio` : ''}
            </p>
            {closing.include_service && closing.service_shares.length > 0 && (
              <ul>
                {closing.service_shares.map((share) => (
                  <li key={share.user_id}>
                    {share.display_name}: {formatCents(share.total_cents)} + 10% {formatCents(share.service_cents)} = {formatCents(share.payable_cents)}
                  </li>
                ))}
              </ul>
            )}
            {closing.explanation && <p>{closing.explanation}</p>}
            <ul>
              {bundle.participants.map((person) => (
                <li key={person.user_id}>
                  {person.display_name}: {latest.get(person.user_id)?.decision === 'accept' ? 'aceitou' : latest.get(person.user_id)?.decision === 'reject' ? 'recusou' : 'ainda não respondeu'}
                </li>
              ))}
            </ul>
            {bundle.round.status !== 'closed' && (
              <div className="row">
                <button className="primary" type="button" disabled={busy || mine?.decision === 'accept'} onClick={() => void run(() => api.acknowledge(closing.id, 'accept'))}>
                  Aceitar esta proposta
                </button>
                <button type="button" disabled={busy} onClick={() => void run(() => api.acknowledge(closing.id, 'reject'))}>Recusar</button>
              </div>
            )}
          </article>
        )
      })}
      {bundle.round.status !== 'closed' && (
        <form className="card stack" onSubmit={(event) => {
          event.preventDefault()
          const amount = parseReaisToCents(adjustValue, { maxCents: VENUE_MAX })
          void run(async () => {
            if (amount == null) throw new Error('Informe o valor do ajuste.')
            const negative = adjustType === 'discount' || adjustType === 'courtesy' || adjustType === 'cancellation'
            await api.proposeAdjustment({
              roundId: bundle.round.id,
              type: adjustType,
              amountCents: negative ? -Math.abs(amount) : amount,
              appliesTo: adjustPerson,
              justification: adjustNote,
            })
          })
        }}>
          <h2>Ajuste com nome e justificativa</h2>
          <p className="muted">Desconto, cortesia e cancelamento valem só para a pessoa escolhida, e só depois do aceite dela.</p>
          <label className="field">
            <span>Tipo</span>
            <select value={adjustType} onChange={(event) => setAdjustType(event.target.value)}>
              {Object.entries(adjustmentLabel).map(([value, label]) => <option key={value} value={value}>{label}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Valor</span>
            <input value={adjustValue} onChange={(event) => setAdjustValue(event.target.value)} required />
          </label>
          <label className="field">
            <span>Pessoa</span>
            <select value={adjustPerson} onChange={(event) => setAdjustPerson(event.target.value)}>
              {bundle.participants.map((person) => <option key={person.user_id} value={person.user_id}>{person.display_name}</option>)}
            </select>
          </label>
          <label className="field">
            <span>Justificativa</span>
            <textarea value={adjustNote} onChange={(event) => setAdjustNote(event.target.value)} minLength={8} required />
          </label>
          <button type="submit" disabled={busy}>Propor ajuste</button>
        </form>
      )}
      {bundle.adjustments.filter((item) => item.status !== 'withdrawn').map((item) => (
        <article className="card" key={item.id}>
          <strong>{adjustmentLabel[item.adjustment_type] ?? item.adjustment_type}</strong>
          <p>{item.applies_to_name}: {formatCents(item.amount_cents)} · {item.status === 'accepted' ? 'aceito' : 'aguardando aceite'}</p>
          <p>{item.justification}</p>
          {item.status === 'pending' && item.applies_to === bundle.me.user_id && (
            <button type="button" disabled={busy} onClick={() => void run(() => api.acceptAdjustment(item.id))}>Aceitar ajuste</button>
          )}
          {item.status === 'pending' && (item.created_by === bundle.me.user_id || item.applies_to === bundle.me.user_id) && (
            <button type="button" disabled={busy} onClick={() => void run(() => api.withdrawAdjustment(item.id))}>Encerrar proposta</button>
          )}
        </article>
      ))}
      {bundle.me.role === 'organizer' && bundle.round.status === 'open' && (
        <form className="card stack" onSubmit={(event) => {
          event.preventDefault()
          const cents = parseReaisToCents(price)
          void run(async () => {
            if (cents == null) throw new Error('Informe o novo preço.')
            await api.changePrice(bundle.round.id, cents, priceNote)
          })
        }}>
          <h2>Preço dos próximos chopes</h2>
          <p className="muted">O que já foi lançado permanece com o preço da hora.</p>
          <input value={price} onChange={(event) => setPrice(event.target.value)} placeholder="Novo preço" />
          <textarea value={priceNote} onChange={(event) => setPriceNote(event.target.value)} minLength={8} required />
          <button type="submit" disabled={busy}>Alterar preço</button>
        </form>
      )}
    </div>
  )
}

function Audit({ bundle }: { bundle: RoundBundle }) {
  return (
    <div className="card">
      <h2>Histórico</h2>
      <p className="muted">Os registros entram e permanecem. Correção não apaga o fato anterior.</p>
      {bundle.audit.length === 0 && <p>Nenhum evento ainda.</p>}
      {bundle.audit.map((event) => (
        <article className="entry" key={event.id}>
          <strong>{auditText(event.action)}</strong>
          <div className="muted">{event.actor_name} · {formatWhen(event.created_at)}</div>
        </article>
      ))}
    </div>
  )
}
