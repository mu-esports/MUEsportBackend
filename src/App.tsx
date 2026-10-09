import { createBrowserRouter, Navigate, Outlet } from 'react-router-dom'
import type { RouteObject } from 'react-router-dom'
import { AuthProvider } from './auth/AuthProvider'
import { RequireAuth, RequireMember } from './auth/RequireAuth'
import { Layout } from './components/Layout'
import { ToastProvider } from './components/Toast'
import { StoreProvider } from './data/store'
import { SyncProvider } from './data/sync'
import { MemberAccountPage } from './member/MemberAccount'
import { MemberActivitiesPage } from './member/MemberActivities'
import { MemberFilesPage, MemberFileViewPage } from './member/MemberFiles'
import { MemberHomePage } from './member/MemberHome'
import { MemberLayout } from './member/MemberLayout'
import { MemberPasswordPage } from './member/MemberPassword'
import { IS_DEMO } from './mode'
import { AthletesPage } from './pages/Athletes'
import { CalendarPage } from './pages/Calendar'
import { DocumentCreatePage } from './pages/DocumentCreate'
import { DocumentEditorPage } from './pages/DocumentEditor'
import { DocumentRedirectPage, FilesPage, FileViewPage } from './pages/Files'
import { FormsPage } from './pages/Forms'
import { AccessDeniedPage, LoginPage } from './pages/Login'
import { MembersPage } from './pages/Members'
import { NewsPage } from './pages/News'
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
      // ฝั่งสมาชิก (รหัสนักศึกษา + รหัสผ่าน): แยกเส้นทางและโครงหน้าจากหลังบ้านทั้งหมด ไม่โหลดข้อมูลหรือเมนูของทีมงาน
      {
        path: 'member/password',
        element: (
          <RequireMember>
            <MemberPasswordPage />
          </RequireMember>
        ),
      },
      {
        path: 'member',
        element: (
          <RequireMember>
            <MemberLayout />
          </RequireMember>
        ),
        children: [
          { index: true, element: <MemberHomePage /> },
          { path: 'activities', element: <MemberActivitiesPage /> },
          { path: 'files', element: <MemberFilesPage /> },
          { path: 'files/:id', element: <MemberFileViewPage /> },
          { path: 'account', element: <MemberAccountPage /> },
          { path: '*', element: <Navigate to="/member" replace /> },
        ],
      },
      {
        element: (
          <RequireAuth>
            <SyncProvider>
              <StoreProvider>
                <Layout />
              </StoreProvider>
            </SyncProvider>
          </RequireAuth>
        ),
        children: [
          ...sharedPages,
          { path: 'athletes', element: <AthletesPage /> },
          { path: 'news', element: <NewsPage /> },
          { path: 'files', element: <FilesPage /> },
          { path: 'files/:id', element: <FileViewPage /> },
          // หน้าเอกสารเดิมกลายเป็นหน้าไฟล์ชมรม ลิงก์เดิมของเอกสารแต่ละฉบับพาไปยังตัวอย่างของไฟล์นั้น
          { path: 'documents', element: <Navigate to="/files" replace /> },
          { path: 'documents/new', element: <DocumentCreatePage /> },
          { path: 'documents/:id', element: <DocumentRedirectPage /> },
          { path: 'documents/:id/edit', element: <DocumentEditorPage /> },
          { path: 'forms', element: <FormsPage /> },
          { path: 'team', element: <TeamPage /> },
          { path: '*', element: <Navigate to="/" replace /> },
        ],
      },
    ],
  },
]

/** โหมดข้อมูลตัวอย่าง: ไม่มีการเข้าสู่ระบบ ไม่มีไฟล์ชมรม บัญชีสมาชิก และทีมงาน เพราะไม่ได้ต่อกับระบบกลางหรือ Google */
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
