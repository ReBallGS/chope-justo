import { FormEvent, useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { api } from '../lib/api'
import { formatCents, formatWhen } from '../lib/money'
import { roundStatusLabel } from '../lib/labels'
import type { MyRound } from '../lib/types'

export function HomePage() {
  const { configured, ready, session, profile, refreshProfile } = useAuth()
  const [rounds, setRounds] = useState<MyRound[]>([])
  const [name, setName] = useState('')
  const [error, setError] = useState('')

  useEffect(() => {
    if (!session) return
    api.myRounds().then(setRounds).catch((err: unknown) => {
      setError(err instanceof Error ? err.message : 'Não foi possível carregar suas rodadas.')
    })
  }, [session])

  async function saveName(event: FormEvent) {
    event.preventDefault()
    setError('')
    try {
      await api.updateDisplayName(name)
      await refreshProfile()
      setName('')
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Não foi possível salvar o nome.')
    }
  }

  if (!ready) return <p>Carregando…</p>

  return (
    <section className="stack">
      <p className="eyebrow">Conta da mesa</p>
      <h1>Cada pessoa paga o que consumiu.</h1>
      <p className="lede">Anote o chope, confirme o que é seu e feche sem dividir a conta no olho.</p>

      {!configured && (
        <div className="card stack">
          <h2>Falta configurar o Supabase</h2>
          <p>
            Copie <code>.env.example</code> para <code>.env</code> e preencha a URL e a chave anon.
            Não use a chave service_role.
          </p>
        </div>
      )}

      {configured && !session && (
        <Link className="launch-card primary" to="/entrar">
          <strong>Entrar para começar</strong>
          <span>Sua conta. O grupo vê o nome, não o e-mail.</span>
        </Link>
      )}

      {session && (
        <>
          <div className="launch">
            <Link className="launch-card primary" to="/nova">
              <strong>Abrir uma mesa</strong>
              <span>Depois é só mandar o link</span>
            </Link>
            <Link className="launch-card" to="/codigo">
              <strong>Entrar numa mesa</strong>
              <span>Com o código ou o convite</span>
            </Link>
          </div>
          <details className="card fold">
            <summary>Você aparece como {profile?.display_name ?? 'Participante'}</summary>
            <form className="stack" onSubmit={(event) => void saveName(event)}>
              <p className="muted">O e-mail não aparece para o grupo.</p>
              <label className="field">
                <span>Nome na mesa</span>
                <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={40} required />
              </label>
              <button type="submit">Salvar nome</button>
            </form>
          </details>
          <div className="stack">
            <h2>Suas mesas</h2>
            {rounds.length === 0 && <p className="muted">Nenhuma mesa ainda. Abra uma ou entre com um convite.</p>}
            {rounds.map((round) => (
              <Link className="card spread round-link" key={round.id} to={`/r/${round.id}`}>
                <span>
                  <strong>{round.name}</strong>
                  <br />
                  <span className="muted">{formatWhen(round.starts_at)}</span>
                </span>
                <span>
                  <strong className="money">{formatCents(round.unit_price_cents)}</strong>
                  <br />
                  <span className="pill">{roundStatusLabel[round.status]}</span>
                </span>
              </Link>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
