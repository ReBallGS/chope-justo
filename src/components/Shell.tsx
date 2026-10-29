import { Link, Navigate, Outlet, useLocation } from 'react-router-dom'
import { useAuth } from '../auth/AuthProvider'
import { Logo } from './Logo'
import type { ReactNode } from 'react'

export function Shell() {
  const { session, signOut, configured } = useAuth()
  return (
    <div className="app">
      <header className="topbar wrap">
        <Link className="brand" to="/" aria-label="Chope Justo, início">
          <Logo />
        </Link>
        {session ? (
          <button className="ghost" type="button" onClick={() => void signOut()}>Sair</button>
        ) : configured ? (
          <Link className="button ghost" to="/entrar">Entrar</Link>
        ) : null}
      </header>
      <div className="wrap">
        <Outlet />
      </div>
    </div>
  )
}

export function RequireAuth({ children }: { children: ReactNode }) {
  const { ready, session, configured } = useAuth()
  const location = useLocation()
  if (!ready) return <p>Carregando…</p>
  if (!configured) return <Navigate to="/" replace />
  if (!session) return <Navigate to="/entrar" replace state={{ from: location.pathname }} />
  return children
}
