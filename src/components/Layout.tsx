import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation } from 'react-router-dom'
import { FlaskConical, Gamepad2, LogOut, Menu, RotateCcw, TriangleAlert, X } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { useSessionNotice } from '../auth/RequireAuth'
import { APP_NAME } from '../config'
import { useStore } from '../data/store'
import { IS_DEMO } from '../mode'
import { ConfirmDialog } from './Dialog'
import { focusOrigin } from './focusOrigin'
import { inNav, NAV, useNavItems } from './nav'
import type { NavItem } from './nav'
import { ThemeSwitch } from './ThemeSwitch'
import { useToast } from './Toast'

const ROLE_NAMES = { staff: 'ทีมงาน', admin: 'ผู้ดูแลระบบ' } as const

// ต้องตรงกับ breakpoint ใน styles.css ที่สลับ sidebar เป็นเมนูเปิดปิด
const DESKTOP_QUERY = '(min-width: 1024px)'

function NavList({ onNavigate }: { onNavigate?(): void }) {
  const items = useNavItems()
  const { pathname } = useLocation()
  const link = (item: NavItem) => {
    const Icon = item.icon
    const current = inNav(item, pathname)
    return (
      <li key={item.to}>
        {/* หน้าปัจจุบันรวม path ที่อยู่ใต้เมนูนี้ (เช่น ลิงก์เอกสารเดิมอยู่ใต้ไฟล์ชมรม) */}
        <NavLink to={item.to} end={item.to === '/'} className={current ? 'nav-link active' : 'nav-link'} aria-current={current ? 'page' : undefined} onClick={onNavigate}>
          <span className="nav-icon">
            <Icon aria-hidden="true" size={20} />
          </span>
          <span className="nav-label">{item.label}</span>
        </NavLink>
      </li>
    )
  }
  const daily = items.filter((item) => item.group !== 'setup')
  const setup = items.filter((item) => item.group === 'setup')
  return (
    <>
      <ul className="nav-list">{daily.map(link)}</ul>
      {/* เครื่องมือตั้งค่าแยกจากเมนูที่ใช้งานประจำ */}
      {setup.length > 0 && (
        <>
          <p className="nav-group" id="nav-setup-title">
            ตั้งค่า
          </p>
          <ul className="nav-list" aria-labelledby="nav-setup-title">
            {setup.map(link)}
          </ul>
        </>
      )}
    </>
  )
}

/**
 * เมนูบนมือถือเป็น modal dialog: เนื้อหาด้านหลังไม่รับ focus หรือการกด และเลื่อนไม่ได้ขณะเปิด
 * เมื่อปิด focus กลับไปที่ปุ่มเปิดเมนู (ผู้เรียกย้าย focus ต่อเองได้เมื่อเปลี่ยนหน้า)
 */
function MobileMenu({ onClose, onNavigate, leaving }: { onClose(): void; onNavigate(): void; leaving: Leaving }) {
  const ref = useRef<HTMLDialogElement>(null)
  const close = useRef(onClose)
  close.current = onClose
  const { modalOpened } = useToast()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = focusOrigin()
    const root = document.documentElement
    const previousOverflow = root.style.overflow
    const modalClosed = modalOpened()
    dialog.showModal()
    root.style.overflow = 'hidden'
    // เริ่มที่หน้าปัจจุบัน เพื่อให้รู้ว่าอยู่ตรงไหนของเมนู
    const current = dialog.querySelector<HTMLElement>('[aria-current="page"]')
    ;(current ?? dialog.querySelector<HTMLElement>('a'))?.focus()
    return () => {
      dialog.close()
      modalClosed()
      root.style.overflow = previousOverflow
      if (opener?.isConnected) opener.focus()
    }
  }, [modalOpened])

  return (
    <dialog
      ref={ref}
      className="mobile-menu"
      aria-label="เมนูหลัก"
      onCancel={(e) => {
        e.preventDefault()
        close.current()
      }}
      onClose={() => {
        if (!ref.current?.open) close.current()
      }}
      onMouseDown={(e) => {
        if (e.target !== ref.current) return
        // กดพื้นที่นอกแผงเมนู: กันไม่ให้การกดย้าย focus ไปที่หน้าเว็บ เพื่อให้ focus กลับไปที่ปุ่มเปิดเมนูได้
        e.preventDefault()
        close.current()
      }}
      onKeyDown={(e) => {
        // วน Tab อยู่ภายในเมนู ไม่ออกไปที่แถบของเบราว์เซอร์
        if (e.key !== 'Tab' || !ref.current) return
        const items = Array.from(ref.current.querySelectorAll<HTMLElement>('a[href], button'))
        const first = items[0]
        const last = items[items.length - 1]
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault()
          last.focus()
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault()
          first.focus()
        }
      }}
    >
      <div className="mobile-menu-panel">
        <div className="mobile-menu-head">
          <span className="brand-name">{APP_NAME}</span>
          <button type="button" className="icon-button" aria-label="ปิดเมนู" onClick={onClose}>
            <X aria-hidden="true" size={22} />
          </button>
        </div>
        <nav aria-label="เมนูหลัก">
          <NavList onNavigate={onNavigate} />
        </nav>
        <AccountBlock placement="menu" leaving={leaving} />
      </div>
    </dialog>
  )
}

/**
 * บัญชีที่เข้าสู่ระบบอยู่และปุ่มออกจากระบบ (ไม่มีในโหมดข้อมูลตัวอย่าง)
 * จอกว้างอยู่บนหัวเว็บ จอแคบอยู่ในเมนู จึงมีชุดที่มองเห็นและใช้งานได้ชุดเดียวต่อรูปแบบหน้าจอ
 */
function AccountBlock({ placement, leaving }: { placement: 'bar' | 'menu'; leaving: Leaving }) {
  const { user } = useAuth()
  if (!user) return null
  const { error } = leaving

  return (
    <div className={`account account-${placement}`}>
      <div className="account-text">
        <p className="account-name">{user.name || user.email}</p>
        <p className="account-meta">{user.email}</p>
        <p className="account-meta">สิทธิ์: {ROLE_NAMES[user.role]}</p>
      </div>
      {/* ในเมนู ข้อความอยู่ในแผงเมนูเอง บนหัวเว็บ ข้อความอยู่ในแถบเหนือเนื้อหา (LogoutAlert) เพื่อไม่ลอยทับปุ่มของหน้า */}
      {error && placement === 'menu' && (
        <p className="form-alert account-error" role="alert">
          {error}
        </p>
      )}
      <LeaveButton leaving={leaving} />
    </div>
  )
}

/**
 * สถานะการออกจากระบบอยู่ที่ Layout ที่เดียว จึงคงอยู่เมื่อปุ่มบัญชีสลับระหว่างหัวเว็บกับเมนูตามขนาดจอ
 * ข้อความผิดพลาดไม่หายเอง และยังแสดงอยู่ระหว่างลองใหม่ จนกว่าจะได้ผลครั้งถัดไป
 */
function useLeaving() {
  const { logout } = useAuth()
  const [pending, setPending] = useState(false)
  const [error, setError] = useState('')

  const leave = async () => {
    if (pending) return
    setPending(true)
    try {
      await logout()
      // สำเร็จ: หน้ากำลังเปลี่ยนไปหน้าเข้าสู่ระบบ คงสถานะกำลังออกไว้
    } catch (failure) {
      setError(failure instanceof Error && failure.message ? failure.message : 'ออกจากระบบไม่สำเร็จ ลองอีกครั้ง')
      setPending(false)
    }
  }
  return { pending, error, leave }
}

type Leaving = ReturnType<typeof useLeaving>

function LeaveButton({ leaving: { pending, error, leave } }: { leaving: Leaving }) {
  return (
    // ใช้ aria-disabled แทน disabled เพื่อให้ focus อยู่ที่ปุ่มระหว่างรอและหลังล้มเหลว
    <button type="button" className="button button-small" aria-disabled={pending} onClick={() => void leave()}>
      <LogOut aria-hidden="true" size={16} className={pending ? 'spin' : undefined} />
      {pending ? 'กำลังออกจากระบบ…' : error ? 'ออกจากระบบอีกครั้ง' : 'ออกจากระบบ'}
    </button>
  )
}

/**
 * ข้อผิดพลาดของการออกจากระบบ เป็นแถบในแนวเนื้อหา (เนื้อหาหน้าถูกดันลง ไม่ถูกทับ)
 * จอกว้าง: ปุ่มลองใหม่คือปุ่มบนหัวเว็บ จอแคบ: ปุ่มบนหัวเว็บอยู่ในเมนู แถบนี้จึงมีปุ่มลองใหม่ของตัวเอง (ซ่อนบนจอกว้างด้วย CSS)
 */
function LogoutAlert({ leaving }: { leaving: Leaving }) {
  return (
    <div className="logout-alert" role="alert">
      <TriangleAlert aria-hidden="true" size={18} />
      <p>{leaving.error}</p>
      <LeaveButton leaving={leaving} />
    </div>
  )
}

/** จอแคบ: หัวเว็บแสดงเพียงอักษรย่อของบัญชี รายละเอียดและปุ่มออกจากระบบอยู่ในเมนู */
function AccountInitial() {
  const { user } = useAuth()
  if (!user) return null
  const name = user.name || user.email
  return (
    <span className="topbar-initial">
      <span aria-hidden="true">{Array.from(name.trim())[0]?.toUpperCase() ?? '?'}</span>
      <span className="visually-hidden">เข้าสู่ระบบเป็น {name}</span>
    </span>
  )
}

export function Layout() {
  const [menuOpen, setMenuOpen] = useState(false)
  const [confirmReset, setConfirmReset] = useState(false)
  const [resetting, setResetting] = useState(false)
  const { resetSampleData } = useStore()
  const toast = useToast()
  const { pathname } = useLocation()
  const previousPath = useRef(pathname)
  const focusHeading = useRef(false)
  const leaving = useLeaving()
  const sessionNotice = useSessionNotice()
  const stickyRef = useRef<HTMLDivElement>(null)

  // ส่วนที่เกาะด้านบน (แถบเซสชัน + หัวเว็บ) สูงไม่คงที่: ข้อความขึ้นหลายบรรทัดได้และเปลี่ยนตามขนาดจอ
  // จึงวัดความสูงจริงให้ CSS ใช้เว้นระยะของเมนูซ้ายและจุดที่เลื่อนหรือ focus ไปถึง
  useEffect(() => {
    const sticky = stickyRef.current
    if (!sticky) return
    const root = document.documentElement
    const apply = () => root.style.setProperty('--sticky-height', `${Math.ceil(sticky.getBoundingClientRect().height)}px`)
    apply()
    const observer = new ResizeObserver(apply)
    observer.observe(sticky)
    return () => {
      observer.disconnect()
      root.style.removeProperty('--sticky-height')
    }
  }, [])

  useEffect(() => {
    const current = NAV.find((n) => inNav(n, pathname))
    document.title = current ? `${current.label} · ${APP_NAME}` : APP_NAME
  }, [pathname])

  // เปลี่ยนหน้า: ปิดเมนู เลื่อนขึ้นบนสุด และย้าย focus ไปที่หัวข้อของหน้าปลายทาง
  useEffect(() => {
    if (previousPath.current === pathname) return
    previousPath.current = pathname
    focusHeading.current = true
    setMenuOpen(false)
    window.scrollTo(0, 0)
  }, [pathname])

  // ทำหลังเมนูปิดแล้วเท่านั้น เพราะตอนปิดเมนูจะคืน focus ไปที่ปุ่มเปิดเมนูก่อน
  useEffect(() => {
    if (menuOpen || !focusHeading.current) return
    focusHeading.current = false
    document.querySelector<HTMLElement>('#main h1')?.focus()
  })

  // ขยายจอเป็น desktop ขณะเมนูเปิด: ปิดเมนูเพื่อไม่ให้ focus trap และ scroll lock ค้าง
  useEffect(() => {
    if (!menuOpen) return
    const desktop = window.matchMedia(DESKTOP_QUERY)
    const onChange = () => desktop.matches && setMenuOpen(false)
    desktop.addEventListener('change', onChange)
    return () => desktop.removeEventListener('change', onChange)
  }, [menuOpen])

  const reset = async () => {
    setResetting(true)
    try {
      await resetSampleData()
      setConfirmReset(false)
      toast.success('รีเซ็ตข้อมูลตัวอย่างแล้ว')
    } catch {
      setConfirmReset(false)
      toast.error('รีเซ็ตข้อมูลตัวอย่างไม่สำเร็จ ตรวจว่าเบราว์เซอร์อนุญาตให้เก็บข้อมูล แล้วลองอีกครั้ง')
    } finally {
      setResetting(false)
    }
  }

  return (
    <div className="app">
      <a className="skip-link" href="#main">
        ข้ามไปยังเนื้อหา
      </a>

      <div className="sticky-top" ref={stickyRef}>
      {sessionNotice}
      <header className="topbar">
        <div className="topbar-inner">
          <button
            type="button"
            className="icon-button topbar-menu"
            aria-label="เปิดเมนู"
            aria-haspopup="dialog"
            aria-expanded={menuOpen}
            onClick={() => setMenuOpen(true)}
          >
            <Menu aria-hidden="true" size={24} />
          </button>
          <span className="topbar-brand">
            <span className="brand-mark">
              <Gamepad2 aria-hidden="true" size={22} />
            </span>
            <span className="brand-name">{APP_NAME}</span>
          </span>
          <div className="topbar-side">
            <ThemeSwitch />
            {IS_DEMO ? (
              <span className="topbar-mode">
                <FlaskConical aria-hidden="true" size={16} />
                โหมดตัวอย่าง
              </span>
            ) : (
              <>
                <AccountBlock placement="bar" leaving={leaving} />
                <AccountInitial />
              </>
            )}
          </div>
        </div>
      </header>
      </div>

      {menuOpen && (
        <MobileMenu
          leaving={leaving}
          onClose={() => setMenuOpen(false)}
          onNavigate={() => {
            // รวมกรณีเลือกหน้าที่เปิดอยู่แล้ว ซึ่ง path ไม่เปลี่ยน
            focusHeading.current = true
            setMenuOpen(false)
          }}
        />
      )}

      <div className="shell">
        <aside className="sidebar">
          <nav aria-label="เมนูหลัก">
            <NavList />
          </nav>
        </aside>

        <div className="content">
          {IS_DEMO && (
            <div className="sample-banner">
              <span className="sample-banner-text">
                <FlaskConical aria-hidden="true" size={16} />
                <strong>ข้อมูลตัวอย่าง</strong>
                <span>โหมดตัวอย่าง ไม่ได้เชื่อมกับข้อมูลจริง เก็บไว้ในเบราว์เซอร์นี้เท่านั้น</span>
              </span>
              <button type="button" className="button button-small" onClick={() => setConfirmReset(true)}>
                <RotateCcw aria-hidden="true" size={14} />
                รีเซ็ตข้อมูลตัวอย่าง
              </button>
            </div>
          )}
          {/* ขณะเมนูเปิด ข้อความอยู่ในเมนูแล้ว จึงไม่แสดงซ้ำหลังฉากของเมนู */}
          {leaving.error && !menuOpen && <LogoutAlert leaving={leaving} />}
          <main id="main" className="panel" tabIndex={-1}>
            <Outlet />
          </main>
        </div>
      </div>

      {confirmReset && (
        <ConfirmDialog
          title="รีเซ็ตข้อมูลตัวอย่าง?"
          confirmLabel="รีเซ็ตข้อมูล"
          tone="danger"
          busy={resetting}
          onConfirm={reset}
          onCancel={() => setConfirmReset(false)}
        >
          <p>
            สมาชิกและกำหนดการที่เพิ่มหรือแก้ไขไว้ในเบราว์เซอร์นี้จะถูกแทนที่ด้วยข้อมูลตัวอย่างชุดเริ่มต้น
            และย้อนกลับไม่ได้
          </p>
        </ConfirmDialog>
      )}
    </div>
  )
}
