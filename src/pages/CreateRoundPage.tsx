import { FormEvent, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../lib/api'
import { parseReaisToCents } from '../lib/money'

export function CreateRoundPage() {
  const navigate = useNavigate()
  const [name, setName] = useState('')
  const [price, setPrice] = useState('')
  const [volume, setVolume] = useState('')
  const [startsAt, setStartsAt] = useState(() => {
    const date = new Date()
    date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
    return date.toISOString().slice(0, 16)
  })
  const [reviewHours, setReviewHours] = useState(0)
  const [canRecord, setCanRecord] = useState(false)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    const cents = parseReaisToCents(price)
    if (cents == null) {
      setError('Informe um preço entre R$ 0,01 e R$ 2.000,00.')
      return
    }
    const volumeMl = volume.trim() ? Number(volume) : null
    if (volumeMl != null && (!Number.isInteger(volumeMl) || volumeMl < 1 || volumeMl > 5000)) {
      setError('O volume precisa estar entre 1 e 5000 ml.')
      return
    }
    setBusy(true)
    setError('')
    try {
      const created = await api.createRound({
        name,
        unitPriceCents: cents,
        volumeMl,
        startsAt: new Date(startsAt).toISOString(),
        reviewHours,
        creatorCanRecord: canRecord,
      })
      navigate(`/r/${created.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível criar a rodada.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stack">
      <p className="eyebrow">Nova mesa</p>
      <h1>Abrir a conta</h1>
      <p className="lede">Cada pessoa entra com a própria conta. Ninguém é colocado na mesa no lugar de outra.</p>
      <form className="card stack" onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          <span>Nome da mesa</span>
          <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} placeholder="Galeto de sexta" required />
        </label>
        <label className="field">
          <span>Preço de cada chope</span>
          <input inputMode="decimal" placeholder="12,50" value={price} onChange={(event) => setPrice(event.target.value)} required />
        </label>
        <details className="fold">
          <summary>Mais opções</summary>
          <div className="stack">
            <label className="field">
              <span>Volume em ml</span>
              <input inputMode="numeric" placeholder="300" value={volume} onChange={(event) => setVolume(event.target.value)} />
            </label>
            <label className="field">
              <span>Data e hora</span>
              <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
            </label>
            <label className="field">
              <span>Horas de revisão antes de fechar de vez</span>
              <input type="number" min={0} max={72} value={reviewHours} onChange={(event) => setReviewHours(Number(event.target.value))} />
            </label>
            <p className="muted">Zero deixa fechar assim que todo mundo confirmar.</p>
            <label className="check">
              <input type="checkbox" checked={canRecord} onChange={(event) => setCanRecord(event.target.checked)} />
              <span>Posso anotar chope para outras pessoas. Fica pendente até elas confirmarem.</span>
            </label>
          </div>
        </details>
        {error && <p className="error">{error}</p>}
        <button className="primary big-action" type="submit" disabled={busy}>
          {busy ? 'Abrindo…' : 'Abrir a mesa'}
        </button>
      </form>
    </section>
  )
}
