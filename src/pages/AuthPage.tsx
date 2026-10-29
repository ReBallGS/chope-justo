import { FormEvent, useEffect, useState } from 'react'
import { Link, useLocation, useNavigate } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { cleanError } from '../lib/api'
import { supabase } from '../lib/supabase'

const pendingKey = 'chope-justo-pending-code'

export function AuthPage() {
  const { session } = useAuth()
  const navigate = useNavigate()
  const location = useLocation()
  const [mode, setMode] = useState<'entrar' | 'criar'>('entrar')
  const [name, setName] = useState('')
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const [info, setInfo] = useState('')
  const [busy, setBusy] = useState(false)
  const from = (location.state as { from?: string } | null)?.from

  useEffect(() => {
    if (!session) return
    const pending = sessionStorage.getItem(pendingKey)
    if (pending) {
      sessionStorage.removeItem(pendingKey)
      navigate(`/j/${pending}`, { replace: true })
      return
    }
    navigate(from && from !== '/entrar' ? from : '/', { replace: true })
  }, [from, navigate, session])

  async function onSubmit(event: FormEvent) {
    event.preventDefault()
    if (!supabase) {
      setError('Configure o Supabase no arquivo .env antes de entrar.')
      return
    }
    setBusy(true)
    setError('')
    setInfo('')
    try {
      if (mode === 'criar') {
        const { data, error: signError } = await supabase.auth.signUp({
          email: email.trim(),
          password,
          options: { data: { display_name: name.trim() } },
        })
        if (signError) throw signError
        if (!data.session) {
          setInfo('Conta criada. Confirme o e-mail se o projeto pedir isso e depois entre.')
        }
      } else {
        const { error: signError } = await supabase.auth.signInWithPassword({
          email: email.trim(),
          password,
        })
        if (signError) throw signError
      }
    } catch (err) {
      const message = err instanceof Error ? cleanError(err.message) : 'Não foi possível entrar.'
      if (/invalid login/i.test(message)) setError('E-mail ou senha não conferem.')
      else if (/already registered/i.test(message)) setError('Já existe uma conta com este e-mail.')
      else setError(message)
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="stack">
      <h1>{mode === 'criar' ? 'Criar conta' : 'Entrar'}</h1>
      <p className="lede">Cada pessoa usa a própria conta. O nome que aparece para o grupo não é o seu e-mail.</p>
      <form className="card stack" onSubmit={(event) => void onSubmit(event)}>
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
        {error && <p className="error">{error}</p>}
        {info && <p>{info}</p>}
        <button className="primary" type="submit" disabled={busy}>
          {busy ? 'Aguarde…' : mode === 'criar' ? 'Criar conta' : 'Entrar'}
        </button>
        <button className="ghost" type="button" onClick={() => setMode(mode === 'criar' ? 'entrar' : 'criar')}>
          {mode === 'criar' ? 'Já tenho conta' : 'Criar uma conta'}
        </button>
      </form>
      <Link to="/">Voltar</Link>
    </section>
  )
}

export { pendingKey }
