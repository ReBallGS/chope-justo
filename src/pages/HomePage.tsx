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
      <p className="muted">Conta da mesa, à vista de todo mundo</p>
      <h1>Cada pessoa paga o que consumiu.</h1>
      <p className="lede">
        O Chope Justo registra cada chope, mostra quem lançou, pede confirmação quando outra pessoa anota
        e guarda o histórico. Ele não acusa ninguém e também não consegue ver um copo que ninguém registrou.
      </p>

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
        <div className="row">
          <Link className="button primary" to="/entrar">Entrar para começar</Link>
        </div>
      )}

      {session && (
        <>
          <div className="row">
            <Link className="button primary" to="/nova">Criar rodada</Link>
            <Link className="button" to="/codigo">Entrar com código</Link>
          </div>
          <form className="card stack" onSubmit={(event) => void saveName(event)}>
            <h2>Seu nome na mesa</h2>
            <p className="muted">Agora: {profile?.display_name ?? 'Participante'}. O e-mail não aparece para o grupo.</p>
            <label className="field">
              <span>Nome</span>
              <input value={name} onChange={(event) => setName(event.target.value)} minLength={2} maxLength={40} required />
            </label>
            <button type="submit">Salvar nome</button>
          </form>
          <div className="stack">
            <h2>Suas rodadas</h2>
            {rounds.length === 0 && <p className="muted">Nenhuma rodada ainda.</p>}
            {rounds.map((round) => (
              <Link className="card spread" key={round.id} to={`/r/${round.id}`}>
                <span>
                  <strong>{round.name}</strong>
                  <br />
                  <span className="muted">{formatWhen(round.starts_at)} · {formatCents(round.unit_price_cents)}</span>
                </span>
                <span className="pill">{roundStatusLabel[round.status]}</span>
              </Link>
            ))}
          </div>
        </>
      )}
      {error && <p className="error">{error}</p>}
    </section>
  )
}
