import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'
import type { RouteObject } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { RequireAuth } from './auth/RequireAuth'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/Toast'
import { StoreProvider } from './data/store'
import { IS_DEMO } from './mode'
import { CalendarPage } from './pages/Calendar'
import { DocumentEditorPage } from './pages/DocumentEditor'
import { DocumentsPage } from './pages/Documents'
import { AccessDeniedPage, LoginPage } from './pages/Login'
import { MembersPage } from './pages/Members'
import { OverviewPage } from './pages/Overview'
import { SourcesPage } from './pages/Sources'
import { TeamPage } from './pages/Team'

const sharedPages: RouteObject[] = [
  { index: true, element: <OverviewPage /> },
  { path: 'members', element: <MembersPage /> },
  { path: 'calendar', element: <CalendarPage /> },
  { path: 'sources', element: <SourcesPage /> },
]

/** โหมดใช้งานจริง: ต้องเข้าสู่ระบบก่อน ข้อมูลมาจากระบบกลาง */
const liveRoutes: RouteObject[] = [
  {
    element: (
      <AuthProvider>
        <ToastProvider>
          <Outlet />
        </ToastProvider>
      </AuthProvider>
    ),
    children: [
      { path: 'login', element: <LoginPage /> },
      { path: 'access-denied', element: <AccessDeniedPage /> },
      {
        element: (
          <RequireAuth>
            <StoreProvider>
              <Layout />
            </StoreProvider>
          </RequireAuth>
        ),
        children: [
          ...sharedPages,
          { path: 'documents', element: <DocumentsPage /> },
          { path: 'documents/new', element: <DocumentEditorPage /> },
          { path: 'documents/:id', element: <DocumentEditorPage /> },
          { path: 'team', element: <TeamPage /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]

/** โหมดข้อมูลตัวอย่าง: ไม่มีการเข้าสู่ระบบ ไม่มีเอกสารและทีมงาน เพราะไม่ได้ต่อกับระบบกลางหรือ Google */
const demoRoutes: RouteObject[] = [
  {
    element: (
      <ToastProvider>
        <StoreProvider>
          <Layout />
        </StoreProvider>
      </ToastProvider>
    ),
    children: [...sharedPages, { path: '*', element: <Navigate to="/" replace /> }],
  },
]

export const router = createBrowserRouter(IS_DEMO ? demoRoutes : liveRoutes)
