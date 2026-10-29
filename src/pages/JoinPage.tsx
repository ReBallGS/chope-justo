import { FormEvent, useEffect, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { pendingKey } from './AuthPage'
import { api, cleanError } from '../lib/api'
import { formatCents, formatWhen, normalizeAccessCode } from '../lib/money'
import { roundStatusLabel } from '../lib/labels'
import { supabase } from '../lib/supabase'
import type { RoundPreview } from '../lib/types'

export function JoinPage() {
  const params = useParams()
  const navigate = useNavigate()
  const { session, ready, configured } = useAuth()
  const initial = params.code && params.code !== 'codigo' ? normalizeAccessCode(params.code) : ''
  const [code, setCode] = useState(initial)
  const [preview, setPreview] = useState<RoundPreview>(null)
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const [mode, setMode] = useState<'criar' | 'entrar'>('criar')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')

  useEffect(() => {
    if (!initial || !ready || !configured) return
    let cancelled = false
    api.previewRound(initial)
      .then((found) => {
        if (cancelled) return
        setPreview(found)
        if (!found) setError('Código não encontrado.')
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : 'Não foi possível buscar a mesa.')
      })
    return () => {
      cancelled = true
    }
  }, [configured, initial, ready])

  useEffect(() => {
    if (!session || !initial || !preview || preview.status === 'closed') return
    let cancelled = false
    setBusy(true)
    api.joinRound(initial)
      .then((result) => {
        if (!cancelled) navigate(`/r/${result.id}`, { replace: true })
      })
      .catch((err: unknown) => {
        if (!cancelled) {
          setBusy(false)
          setError(err instanceof Error ? err.message : 'Não foi possível entrar na mesa.')
        }
      })
    return () => {
      cancelled = true
    }
  }, [initial, navigate, preview, session])

  async function lookUp(event?: FormEvent) {
    event?.preventDefault()
    if (!configured) {
      setError('Configure o Supabase antes de entrar numa mesa.')
      return
    }
    const normalized = normalizeAccessCode(code)
    if (!session) {
      sessionStorage.setItem(pendingKey, normalized)
      navigate(`/j/${normalized}`)
      return
    }
    setBusy(true)
    setError('')
    try {
      const found = await api.previewRound(normalized)
      setPreview(found)
      if (!found) {
        setError('Código não encontrado.')
        return
      }
      if (found.status === 'closed') return
      const result = await api.joinRound(normalized)
      navigate(`/r/${result.id}`)
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível entrar.')
    } finally {
      setBusy(false)
    }
  }

  async function createAndJoin(event: FormEvent) {
    event.preventDefault()
    if (!supabase) {
      setError('Configure o Supabase antes de entrar numa mesa.')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    sessionStorage.setItem(pendingKey, initial)
    try {
      if (mode === 'criar') {
        const { data, error: signError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: name.trim() } },
        })
        if (signError) throw signError
        if (!data.session) {
          setInfo('Conta criada. Confirme o e-mail se o projeto pedir isso e depois entre por este mesmo link.')
          setBusy(false)
        }
      } else {
        const { error: signError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (signError) throw signError
      }
    } catch (err) {
      setBusy(false)
      const message = err instanceof Error ? cleanError(err.message) : 'Não foi possível entrar.'
      if (/invalid login/i.test(message)) setError('E-mail ou senha não conferem.')
      else if (/already registered/i.test(message)) setError('Já existe uma conta com este e-mail. Entre com ela.')
      else setError(message)
    }
  }

  if (!ready) return <p>Carregando…</p>

  if (!initial) {
    return (
      <section className="stack">
        <h1>Entrar na mesa</h1>
        <p className="lede">Use o código de quem criou a mesa. Quem ainda não tem conta cria a dela neste mesmo link.</p>
        <form className="card stack" onSubmit={(event) => void lookUp(event)}>
          <label className="field">
            <span>Código</span>
            <input value={code} onChange={(event) => setCode(event.target.value)} autoCapitalize="none" autoCorrect="off" required />
          </label>
          <button className="primary big-action" type="submit" disabled={busy}>Entrar na mesa</button>
        </form>
        {error && <p className="error">{error}</p>}
        <Link to="/">Voltar</Link>
      </section>
    )
  }

  return (
    <section className="stack">
      <h1>{preview?.name ?? 'Entrar na mesa'}</h1>
      {preview && (
        <div className="card stack">
          <p>{formatWhen(preview.starts_at)} · {formatCents(preview.unit_price_cents)} cada</p>
          {preview.volume_ml && <p className="muted">{preview.volume_ml} ml</p>}
          <p className="pill">{roundStatusLabel[preview.status]}</p>
          <div>
            <p className="muted">Quem já está nesta mesa</p>
            {preview.members.length > 0 ? (
              <ul>
                {preview.members.map((member, index) => <li key={`${member}-${index}`}>{member}</li>)}
              </ul>
            ) : (
              <p>Ainda só quem abriu a mesa.</p>
            )}
          </div>
        </div>
      )}
      {preview && preview.status === 'closed' && <p>Esta mesa já foi encerrada.</p>}
      {preview && preview.status !== 'closed' && !session && (
        <form className="card stack" onSubmit={(event) => void createAndJoin(event)}>
          <h2>{mode === 'criar' ? 'Criar conta e entrar' : 'Entrar na minha conta'}</h2>
          <p className="lede">A conta é sua. O nome que o grupo vê não é o seu e-mail, e você já cai nesta mesa.</p>
          {mode === 'criar' && (
            <label className="field">
              <span>Nome no grupo</span>
              <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={40} required />
            </label>
          )}
          <label className="field">
            <span>E-mail</span>
            <input type="email" autoComplete="email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          </label>
          <label className="field">
            <span>Senha</span>
            <input type="password" autoComplete={mode === 'criar' ? 'new-password' : 'current-password'} minLength={6} value={password} onChange={(event) => setPassword(event.target.value)} required />
          </label>
          <button className="primary big-action" type="submit" disabled={busy}>
            {busy ? 'Aguarde…' : mode === 'criar' ? 'Criar conta e entrar na mesa' : 'Entrar na mesa'}
          </button>
          <button className="ghost" type="button" onClick={() => setMode(mode === 'criar' ? 'entrar' : 'criar')}>
            {mode === 'criar' ? 'Já tenho conta' : 'Criar uma conta'}
          </button>
        </form>
      )}
      {session && preview && preview.status !== 'closed' && <p>Entrando na mesa…</p>}
      {info && <p>{info}</p>}
      {error && <p className="error">{error}</p>}
      <Link to="/">Voltar</Link>
    </section>
  )
}
