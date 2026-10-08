import { useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { Gamepad2, LoaderCircle, LogIn, ShieldX, TriangleAlert } from 'lucide-react'
import { loginMember } from '../auth/member-password'
import { useAuth } from '../auth/AuthProvider'
import { PasswordField } from '../components/PasswordField'
import { Field, fieldAria } from '../components/ui'
import { CLUB_NAME } from '../config'
import { messageOf } from '../data/errors'
import { useMemberSurface } from '../member/surface'

const ERRORS: Record<string, string> = {
  not_configured: 'เว็บไซต์ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google',
  state_invalid: 'ขั้นตอนเข้าสู่ระบบไม่ถูกต้องหรือเริ่มจากเบราว์เซอร์อื่น เริ่มเข้าสู่ระบบใหม่อีกครั้ง',
  state_used: 'ลิงก์เข้าสู่ระบบนี้ถูกใช้ไปแล้ว เริ่มเข้าสู่ระบบใหม่อีกครั้ง',
  state_expired: 'ใช้เวลาเข้าสู่ระบบนานเกินไป เริ่มเข้าสู่ระบบใหม่อีกครั้ง',
  google_denied: 'ยกเลิกการเข้าสู่ระบบที่ Google แล้ว ยังไม่ได้เข้าสู่ระบบ',
  google_failed: 'ตรวจบัญชีกับ Google ไม่สำเร็จ ลองเข้าสู่ระบบอีกครั้ง',
}

/** รับเฉพาะ path ภายในเว็บ (server ตรวจซ้ำอีกชั้น) */
const safeReturn = (value: string | null) =>
  value && value.startsWith('/') && !value.startsWith('//') && !value.includes('\\') && !value.startsWith('/login') ? value : '/'
const isMemberPath = (path: string) => path === '/member' || path.startsWith('/member/') || path.startsWith('/member?')

/** โครงหน้าเข้าสู่ระบบ: สว่าง เรียบ ฟอร์มเป็นจุดหลัก ใช้ร่วมกับหน้าแจ้งว่าไม่มีสิทธิ์ */
function LoginShell({ children }: { children: ReactNode }) {
  useMemberSurface()
  return (
    <div className="login-page">
      <main className="login-main" id="main">
        <p className="login-brand">
          <span className="m-logo" aria-hidden="true">
            <Gamepad2 size={24} />
          </span>
          <span className="login-brand-name">{CLUB_NAME}</span>
        </p>
        {children}
      </main>
    </div>
  )
}

export function LoginPage() {
  const { status, user, member, authConfigured, reload, refresh } = useAuth()
  const [params] = useSearchParams()
  const returnPath = safeReturn(params.get('return'))
  const errorCode = params.get('error')
  const googleError = errorCode ? (ERRORS[errorCode] ?? 'เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้ง') : ''

  const [studentId, setStudentId] = useState('')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ studentId?: string; password?: string }>({})
  const [submitError, setSubmitError] = useState('')
  const [busy, setBusy] = useState(false)
  const studentRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)

  useEffect(() => {
    document.title = `เข้าสู่ระบบ · ${CLUB_NAME}`
  }, [])

  // เข้าสู่ระบบแล้ว: สมาชิกไปหน้าสมาชิก ทีมงานไปหลังบ้าน ไม่พาข้ามฝั่งตามค่า return ที่ส่งมา
  if (status === 'ready' && member) return <Navigate to={member.mustChangePassword ? '/member/password' : isMemberPath(returnPath) ? returnPath : '/member'} replace />
  if (status === 'ready' && user) return <Navigate to={isMemberPath(returnPath) ? '/' : returnPath} replace />

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const found = { studentId: studentId.trim() ? undefined : 'กรอกรหัสนักศึกษา', password: password ? undefined : 'กรอกรหัสผ่าน' }
    setFieldErrors(found)
    setSubmitError('')
    if (found.studentId) return studentRef.current?.focus()
    if (found.password) return passwordRef.current?.focus()
    setBusy(true)
    try {
      await loginMember(studentId.trim(), password)
      // อ่าน session ที่ server เพิ่งออกให้ แล้วหน้านี้จะพาไปหน้าสมาชิกเอง
      await refresh()
    } catch (failure) {
      // ค่าที่กรอกยังอยู่ครบ ให้แก้แล้วลองใหม่ได้ทันที
      setSubmitError(messageOf(failure, 'เข้าสู่ระบบไม่สำเร็จ ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง'))
      setBusy(false)
      passwordRef.current?.focus()
    }
  }

  return (
    <LoginShell>
      <h1 className="login-title">เข้าสู่ระบบ</h1>
      <p className="login-welcome">ยินดีต้อนรับ ดูกิจกรรมและไฟล์ของชมรมได้ที่นี่</p>

      {/* แสดงเฉพาะเมื่อ server ยืนยันว่าไม่มี session แล้วจริง */}
      {params.get('loggedOut') && !googleError && status === 'anonymous' && <p className="notice">ออกจากระบบแล้ว</p>}

      <section className="login-card" aria-labelledby="member-login-title">
        <h2 id="member-login-title">สำหรับสมาชิก</h2>
        <form onSubmit={submit} noValidate className="form">
          {submitError && (
            <p className="form-alert" role="alert">
              {submitError}
            </p>
          )}
          <Field label="รหัสนักศึกษา" htmlFor="login-student-id" error={fieldErrors.studentId} hint="กรอกได้ทั้งแบบมี u นำหน้าและตัวเลขล้วน เช่น u6501234 หรือ 6501234 (รหัสตัวอย่าง)">
            <input
              id="login-student-id"
              placeholder="u6501234 หรือ 6501234"
              ref={studentRef}
              type="text"
              inputMode="text"
              value={studentId}
              onChange={(e) => {
                setStudentId(e.target.value)
                if (fieldErrors.studentId) setFieldErrors((f) => ({ ...f, studentId: undefined }))
              }}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              aria-describedby="login-student-id-hint"
              {...fieldAria('login-student-id', fieldErrors.studentId)}
            />
          </Field>
          <PasswordField
            id="login-password"
            label="รหัสผ่าน"
            value={password}
            onChange={(value) => {
              setPassword(value)
              if (fieldErrors.password) setFieldErrors((f) => ({ ...f, password: undefined }))
            }}
            error={fieldErrors.password}
            autoComplete="current-password"
            inputRef={passwordRef}
          />
          <button type="submit" className="button button-primary button-large" aria-disabled={busy || status === 'loading'}>
            {busy ? <LoaderCircle aria-hidden="true" size={18} className="spin" /> : <LogIn aria-hidden="true" size={18} />}
            {busy ? 'กำลังเข้าสู่ระบบ…' : 'เข้าสู่ระบบ'}
          </button>
        </form>
        <p className="login-forgot">ลืมรหัสผ่าน? ติดต่อทีมงานของชมรมเพื่อตั้งรหัสผ่านใหม่</p>
      </section>

      <section className="login-staff" aria-labelledby="staff-login-title">
        <h2 id="staff-login-title">สำหรับทีมงาน</h2>
        <p className="login-staff-note">ทีมงานใช้บัญชี Google ที่ผู้ดูแลเพิ่มสิทธิ์ไว้ สมาชิกไม่ต้องมีหรือเชื่อมบัญชี Google</p>
        {googleError && (
          <p className="form-alert" role="alert">
            {googleError}
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
                <strong>ทีมงานยังเข้าสู่ระบบไม่ได้</strong>
              </p>
              <p>
                เว็บไซต์นี้ยังไม่ได้ตั้งค่า <code>GOOGLE_CLIENT_ID</code> และ <code>GOOGLE_CLIENT_SECRET</code> ผู้ดูแลระบบต้องตั้งค่าตามขั้นตอนใน
                README ก่อน
              </p>
            </div>
          </div>
        ) : (
          <a className="button button-large" href={`/auth/login?return=${encodeURIComponent(isMemberPath(returnPath) ? '/' : returnPath)}`}>
            <LogIn aria-hidden="true" size={18} />
            เข้าสู่ระบบด้วย Google
          </a>
        )}
      </section>
    </LoginShell>
  )
}

export function AccessDeniedPage() {
  useEffect(() => {
    document.title = `ไม่มีสิทธิ์เข้าใช้งาน · ${CLUB_NAME}`
  }, [])

  return (
    <LoginShell>
      <section className="login-card">
        <h1 className="auth-denied-title">
          <ShieldX aria-hidden="true" size={24} />
          ไม่มีสิทธิ์เข้าใช้งาน
        </h1>
        <p>เข้าสู่ระบบกับ Google สำเร็จ แต่บัญชีนี้ยังไม่ได้รับสิทธิ์ใช้ระบบหลังบ้าน หรือถูกถอนสิทธิ์แล้ว จึงยังไม่ได้เข้าสู่ระบบของเว็บนี้</p>
        <p className="muted">
          ทีมงาน: ให้ผู้ดูแลเพิ่มอีเมลของบัญชีนี้ที่หน้า “ทีมงาน” ก่อน หรือเข้าสู่ระบบด้วยบัญชีที่ได้รับสิทธิ์แล้ว สมาชิก: ใช้รหัสนักศึกษาและรหัสผ่านที่หน้าเข้าสู่ระบบ
          ไม่ต้องใช้บัญชี Google
        </p>
        <Link className="button button-primary button-large" to="/login">
          เข้าสู่ระบบด้วยบัญชีอื่น
        </Link>
      </section>
    </LoginShell>
  )
}
