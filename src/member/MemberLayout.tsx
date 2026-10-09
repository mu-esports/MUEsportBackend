import { createContext, useContext, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { CalendarDays, ClipboardCheck, FolderOpen, Gamepad2, House, LogOut, TriangleAlert, UserRound } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { CLUB_NAME } from '../config'
import { useMemberSurface } from './surface'
import { ThemeSwitch } from '../components/ThemeSwitch'

interface NavItem {
  to: string
  label: string
  icon: LucideIcon
}

// เมนูสมาชิกไม่เปิดเผยเมนูจัดการของหลังบ้าน
export const MEMBER_NAV: NavItem[] = [
  { to: '/member', label: 'หน้าแรก', icon: House },
  { to: '/member/activities', label: 'กิจกรรม', icon: CalendarDays },
  { to: '/member/files', label: 'ไฟล์ชมรม', icon: FolderOpen },
  { to: '/member/tasks', label: 'ส่งงาน', icon: ClipboardCheck },
  { to: '/member/account', label: 'บัญชีของฉัน', icon: UserRound },
]

/** สถานะการออกจากระบบของหน้าสมาชิก: ไปหน้าเข้าสู่ระบบเมื่อ server ยืนยันแล้วเท่านั้น ถ้าไม่สำเร็จแสดงเหตุผลและกดซ้ำได้ */
function useLeaving() {
  const { logout } = useAuth()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')
  const leave = async () => {
    if (pending) return
    setPending(true)
    try {
      await logout()
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : 'ออกจากระบบไม่สำเร็จ ลองอีกครั้ง')
      setPending(false)
    }
  }
  return { pending, error, leave }
}

type Leaving = ReturnType<typeof useLeaving>
const LeavingContext = createContext<Leaving | null>(null)

export function LogoutButton({ compact = false }: { compact?: boolean }) {
  const leaving = useContext(LeavingContext)
  if (!leaving) return null
  const label = leaving.pending ? 'กำลังออกจากระบบ…' : leaving.error ? 'ออกจากระบบอีกครั้ง' : 'ออกจากระบบ'
  return (
    <button type="button" className={compact ? 'button button-small m-logout' : 'button'} aria-disabled={leaving.pending} onClick={() => void leaving.leave()}>
      <LogOut aria-hidden="true" size={compact ? 16 : 18} className={leaving.pending ? 'spin' : undefined} />
      <span className={compact ? 'm-logout-label' : undefined}>{label}</span>
    </button>
  )
}

/** ส่วนหัวของแต่ละหน้าสมาชิก: หัวข้อรับ focus เมื่อเปลี่ยนหน้า */
export function MemberPageHeader({ title, description, action }: { title: string; description?: string; action?: ReactNode }) {
  return (
    <header className="m-page-header">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        {description && <p>{description}</p>}
      </div>
      {action && <div className="m-page-action">{action}</div>}
    </header>
  )
}

/** ให้ส่วนของหน้าที่อยู่นอก MemberLayout (หน้าเปลี่ยนรหัสผ่านครั้งแรก) ใช้ปุ่มออกจากระบบชุดเดียวกัน */
export function LeavingProvider({ children }: { children: ReactNode }) {
  const leaving = useLeaving()
  return (
    <LeavingContext.Provider value={leaving}>
      {leaving.error && (
        <div className="m-alert" role="alert">
          <TriangleAlert aria-hidden="true" size={18} />
          <p>{leaving.error}</p>
        </div>
      )}
      {children}
    </LeavingContext.Provider>
  )
}

export function MemberLayout() {
  useMemberSurface()
  const { member } = useAuth()
  const { pathname } = useLocation()
  const previousPath = useRef(pathname)

  useEffect(() => {
    const current = [...MEMBER_NAV].reverse().find((item) => pathname === item.to || pathname.startsWith(`${item.to}/`))
    document.title = current ? `${current.label} · ${CLUB_NAME}` : CLUB_NAME
  }, [pathname])

  // เปลี่ยนหน้า: เลื่อนขึ้นบนสุด และย้าย focus ไปที่หัวข้อของหน้าปลายทาง
  useEffect(() => {
    if (previousPath.current === pathname) return
    previousPath.current = pathname
    window.scrollTo(0, 0)
    document.querySelector<HTMLElement>('#main h1')?.focus()
  }, [pathname])

  const links = (className: string) =>
    MEMBER_NAV.map(({ to, label, icon: Icon }) => (
      <NavLink key={to} to={to} end={to === '/member'} className={className}>
        <Icon aria-hidden="true" size={className === 'm-tab' ? 22 : 18} />
        <span>{label}</span>
      </NavLink>
    ))

  return (
    <div className="member-app">
      <a className="skip-link" href="#main">
        ข้ามไปยังเนื้อหา
      </a>
      <LeavingProvider>
        <header className="m-header">
          <div className="m-header-inner">
            <NavLink to="/member" end className="m-brand" aria-label={`${CLUB_NAME} หน้าแรก`}>
              <span className="m-logo" aria-hidden="true">
                <Gamepad2 size={22} />
              </span>
              <span className="m-brand-name">{CLUB_NAME}</span>
            </NavLink>
            <nav className="m-nav" aria-label="เมนูหลัก">
              {links('m-nav-link')}
            </nav>
            <div className="m-header-side">
              {member && <span className="m-user">{member.nickname || member.name}</span>}
              <ThemeSwitch /><LogoutButton compact />
            </div>
          </div>
        </header>
        <main id="main" className="m-main page-enter" tabIndex={-1} key={pathname}>
          <Outlet />
        </main>
      </LeavingProvider>
      {/* จอแคบ: เมนูอยู่ด้านล่าง เนื้อหาเว้นที่ให้เมนูและขอบจอ (safe area) จึงไม่ถูกบัง */}
      <nav className="m-tabbar" aria-label="เมนูหลัก">
        {links('m-tab')}
      </nav>
    </div>
  )
}
