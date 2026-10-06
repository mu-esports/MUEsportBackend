import { useEffect } from 'react'
import type { ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { Gamepad2, LoaderCircle, LogIn, ShieldX, TriangleAlert } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { ThemeSwitch } from '../components/ThemeSwitch'
import { APP_NAME, APP_TAGLINE } from '../config'

const ERRORS: Record<string, string> = {
  not_configured: 'เว็บไซต์ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google',
  state_invalid: 'ขั้นตอนเข้าสู่ระบบไม่ถูกต้องหรือเริ่มจากเบราว์เซอร์อื่น เริ่มเข้าสู่ระบบใหม่อีกครั้ง',
  state_used: 'ลิงก์เข้าสู่ระบบนี้ถูกใช้ไปแล้ว เริ่มเข้าสู่ระบบใหม่อีกครั้ง',
  state_expired: 'ใช้เวลาเข้าสู่ระบบนานเกินไป เริ่มเข้าสู่ระบบใหม่อีกครั้ง',
  google_denied: 'ยกเลิกการเข้าสู่ระบบที่ Google แล้ว ยังไม่ได้เข้าสู่ระบบ',
  google_failed: 'ตรวจบัญชีกับ Google ไม่สำเร็จ ลองเข้าสู่ระบบอีกครั้ง',
}

/** รับเฉพาะ path ภายในเว็บ (server ตรวจซ้ำอีกชั้น) */
const safeReturn = (value: string | null) => (value && value.startsWith('/') && !value.startsWith('//') ? value : '/')

function AuthCard({ children }: { children: ReactNode }) {
  return (
    <div className="app">
      <header className="topbar">
        <div className="topbar-inner">
          <span className="topbar-brand">
            <span className="brand-mark">
              <Gamepad2 aria-hidden="true" size={22} />
            </span>
            <span className="brand-name">{APP_NAME}</span>
          </span>
          <div className="topbar-side">
            <ThemeSwitch />
          </div>
        </div>
      </header>
      <main className="auth-page" id="main">
        <div className="auth-shell">
          <div className="auth-hero">
            <span className="auth-shape auth-shape-1" aria-hidden="true" />
            <span className="auth-shape auth-shape-2" aria-hidden="true" />
            <span className="auth-shape auth-shape-3" aria-hidden="true" />
            <p className="auth-hero-title">{APP_NAME}</p>
            <p>{APP_TAGLINE}ของชมรม เปิดให้เฉพาะทีมงานที่ได้รับอนุญาต ใช้ดูแลสมาชิก กำหนดการ และเอกสารของชมรม</p>
          </div>
          <div className="auth-card">{children}</div>
        </div>
      </main>
    </div>
  )
}

export function LoginPage() {
  const { status, authConfigured, reload } = useAuth()
  const [params] = useSearchParams()
  const returnPath = safeReturn(params.get('return'))
  const errorCode = params.get('error')
  const error = errorCode ? (ERRORS[errorCode] ?? 'เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้ง') : ''

  useEffect(() => {
    document.title = `เข้าสู่ระบบ · ${APP_NAME}`
  }, [])

  if (status === 'ready') return <Navigate to={returnPath} replace />

  return (
    <AuthCard>
      <h1>เข้าสู่ระบบ</h1>
      <p className="muted">สำหรับทีมงานที่ผู้ดูแลเพิ่มสิทธิ์ไว้แล้ว ใช้บัญชี Google ของตัวเอง</p>

      {/* แสดงเฉพาะเมื่อ server ยืนยันว่าไม่มี session แล้วจริง */}
      {params.get('loggedOut') && !error && status === 'anonymous' && <p className="notice">ออกจากระบบแล้ว</p>}
      {error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}

      {status === 'loading' ? (
        <p className="auth-inline" role="status">
          <LoaderCircle aria-hidden="true" size={20} className="spin" />
          กำลังตรวจการเข้าสู่ระบบ…
        </p>
      ) : status === 'error' ? (
        <div className="auth-inline-block" role="alert">
          <p>
            <TriangleAlert aria-hidden="true" size={18} /> เชื่อมต่อระบบกลางไม่ได้
          </p>
          <button type="button" className="button" onClick={reload}>
            ลองอีกครั้ง
          </button>
        </div>
      ) : !authConfigured ? (
        <div className="notice notice-warning" role="status">
          <TriangleAlert aria-hidden="true" size={18} />
          <div>
            <p>
              <strong>ยังเข้าสู่ระบบไม่ได้</strong>
            </p>
            <p>
              เว็บไซต์นี้ยังไม่ได้ตั้งค่า <code>GOOGLE_CLIENT_ID</code> และ <code>GOOGLE_CLIENT_SECRET</code> ผู้ดูแลระบบต้องตั้งค่าตามขั้นตอนใน
              README ก่อน
            </p>
          </div>
        </div>
      ) : (
        <a className="button button-primary button-large" href={`/auth/login?return=${encodeURIComponent(returnPath)}`}>
          <LogIn aria-hidden="true" size={18} />
          เข้าสู่ระบบด้วย Google
        </a>
      )}
    </AuthCard>
  )
}

export function AccessDeniedPage() {
  useEffect(() => {
    document.title = `ไม่มีสิทธิ์เข้าใช้งาน · ${APP_NAME}`
  }, [])

  return (
    <AuthCard>
      <h1 className="auth-denied-title">
        <ShieldX aria-hidden="true" size={24} />
        ไม่มีสิทธิ์เข้าใช้งาน
      </h1>
      <p>
        เข้าสู่ระบบกับ Google สำเร็จ แต่บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้ระบบหลังบ้าน หรือถูกถอนสิทธิ์แล้ว จึงยังไม่ได้เข้าสู่ระบบของเว็บนี้
      </p>
      <p className="muted">ให้ผู้ดูแลเพิ่มอีเมลของบัญชีนี้ที่หน้า “ทีมงาน” ก่อน หรือเข้าสู่ระบบด้วยบัญชีที่ได้รับสิทธิ์แล้ว</p>
      <Link className="button button-primary button-large" to="/login">
        เข้าสู่ระบบด้วยบัญชีอื่น
      </Link>
    </AuthCard>
  )
}
