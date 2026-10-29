import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { pendingKey } from './AuthPage'
import { api } from '../lib/api'
import { formatCents, formatWhen, normalizeAccessCode } from '../lib/money'
import { roundStatusLabel } from '../lib/labels'
import type { RoundPreview } from '../lib/types'

export function JoinPage() {
  const params = useParams()
  const navigate = useNavigate()
  const { session, ready, configured } = useAuth()
  const initial = params.code && params.code !== 'codigo' ? params.code : ''
  const [code, setCode] = useState(initial)
  const [preview, setPreview] = useState<RoundPreview>(null)
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    if (!initial) return
    setCode(initial)
  }, [initial])

  useEffect(() => {
    if (!session || !initial || !configured) return
    let cancelled = false
    api.previewRound(normalizeAccessCode(initial))
      .then((found) => {
        if (cancelled) return
        setPreview(found)
        if (!found) setError('Código não encontrado.')
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Não foi possível buscar a rodada.')
      })
    return () => {
      cancelled = true
    }
  }, [configured, initial, session])

  async function lookUp(event?: FormEvent) {
    event?.preventDefault()
    if (!configured) {
      setError('Configure o Supabase antes de entrar numa rodada.')
      return
    }
    if (!session) {
      sessionStorage.setItem(pendingKey, normalizeAccessCode(code))
      navigate('/entrar')
      return
    }
    setBusy(true)
    setError('')
    try {
      const found = await api.previewRound(normalizeAccessCode(code))
      setPreview(found)
      if (!found) setError('Código não encontrado.')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível buscar a rodada.')
    } finally {
      setBusy(false)
    }
  }

  async function join() {
    setBusy(true)
    setError('')
    try {
      const result = await api.joinRound(normalizeAccessCode(code))
      navigate(`/r/${result.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível entrar.')
    } finally {
      setBusy(false)
    }
  }

  if (!ready) return <p>Carregando…</p>

  return (
    <section className="stack">
      <h1>Entrar na rodada</h1>
      <p className="lede">Use o código ou o QR de quem criou a mesa. A entrada vale para a sua conta, não para a de outra pessoa.</p>
      <form className="card stack" onSubmit={(event) => void lookUp(event)}>
        <label className="field">
          <span>Código</span>
          <input value={code} onChange={(event) => setCode(event.target.value)} autoCapitalize="none" autoCorrect="off" required />
        </label>
        <button className="primary" type="submit" disabled={busy}>Ver rodada</button>
      </form>
      {preview && (
        <div className="card stack">
          <h2>{preview.name}</h2>
          <p>{formatWhen(preview.starts_at)} · {formatCents(preview.unit_price_cents)}</p>
          {preview.volume_ml && <p className="muted">{preview.volume_ml} ml</p>}
          <p className="pill">{roundStatusLabel[preview.status]}</p>
          <button className="primary" type="button" disabled={busy || preview.status === 'closed'} onClick={() => void join()}>
            Entrar com a minha conta
          </button>
        </div>
      )}
      {error && <p className="error">{error}</p>}
      <Link to="/">Voltar</Link>
    </section>
  )
}
