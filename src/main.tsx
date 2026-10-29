import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { createHashRouter, RouterProvider } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { RequireAuth, Shell } from './components/Shell'
import { AuthPage } from './pages/AuthPage'
import { CreateRoundPage } from './pages/CreateRoundPage'
import { HomePage } from './pages/HomePage'
import { JoinPage } from './pages/JoinPage'
import { RoundPage } from './pages/RoundPage'
import './styles.css'

const router = createHashRouter([
  {
    path: '/',
    element: (
      <AuthProvider>
        <Shell />
      </AuthProvider>
    ),
    children: [
      { index: true, element: <HomePage /> },
      { path: 'entrar', element: <AuthPage /> },
      { path: 'nova', element: <RequireAuth><CreateRoundPage /></RequireAuth> },
      { path: 'codigo', element: <JoinPage /> },
      { path: 'j/:code', element: <JoinPage /> },
      { path: 'r/:id', element: <RequireAuth><RoundPage /></RequireAuth> },
    ],
  },
])

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <RouterProvider router={router} />
  </StrictMode>,
)
