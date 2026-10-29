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
      <h1>Criar rodada</h1>
      <p className="lede">
        As outras pessoas entram com o código e a própria conta. Ninguém é colocado na mesa no lugar de outra pessoa.
      </p>
      <form className="card stack" onSubmit={(event) => void onSubmit(event)}>
        <label className="field">
          <span>Bar ou grupo</span>
          <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={80} required />
        </label>
        <label className="field">
          <span>Preço de cada chope</span>
          <input inputMode="decimal" placeholder="12,50" value={price} onChange={(event) => setPrice(event.target.value)} required />
        </label>
        <label className="field">
          <span>Volume em ml, se quiser anotar</span>
          <input inputMode="numeric" value={volume} onChange={(event) => setVolume(event.target.value)} />
        </label>
        <label className="field">
          <span>Data e hora</span>
          <input type="datetime-local" value={startsAt} onChange={(event) => setStartsAt(event.target.value)} required />
        </label>
        <label className="field">
          <span>Horas de revisão antes do fechamento definitivo</span>
          <input type="number" min={0} max={72} value={reviewHours} onChange={(event) => setReviewHours(Number(event.target.value))} />
        </label>
        <p className="muted">Zero permite fechar assim que todo mundo confirmar. Um valor maior impede um fechamento apressado.</p>
        <label className="row">
          <input type="checkbox" checked={canRecord} onChange={(event) => setCanRecord(event.target.checked)} />
          <span>Eu também posso registrar chope para outras pessoas. O lançamento fica pendente até a pessoa confirmar.</span>
        </label>
        {error && <p className="error">{error}</p>}
        <button className="primary big-action" type="submit" disabled={busy}>
          {busy ? 'Criando…' : 'Criar rodada'}
        </button>
      </form>
    </section>
  )
}
