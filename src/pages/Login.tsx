import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, Navigate, useSearchParams } from 'react-router-dom'
import { Gamepad2, Info, LoaderCircle, LogIn, ShieldX, TriangleAlert } from 'lucide-react'
import { loginMember } from '../auth/member-password'
import { useAuth } from '../auth/AuthProvider'
import { PasswordField } from '../components/PasswordField'
import { Field, fieldAria } from '../components/ui'
import { CLUB_NAME } from '../config'
import { messageOf } from '../data/errors'
import { GOOGLE_LOGIN_WORD, isGoogleLoginWord } from '../lib/student-id'
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

/** ตัวอักษรอังกฤษในชื่อผู้ใช้เป็นตัวเล็กเสมอ (รหัสนักศึกษาและคำเลือกช่องทางไม่สนตัวพิมพ์) ความยาวและตำแหน่งของตัวอักษรไม่เปลี่ยน */
const lowerAscii = (value: string) => value.replace(/[A-Z]/g, (letter) => letter.toLowerCase())

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

/**
 * หน้าเข้าสู่ระบบฟอร์มเดียว
 * - สมาชิก: ชื่อผู้ใช้คือรหัสนักศึกษา ตามด้วยรหัสผ่าน (ขั้นตอนและการตรวจเดิมของบัญชีสมาชิก)
 * - ทีมงาน: พิมพ์คำว่า google ในช่องชื่อผู้ใช้ ช่องรหัสผ่านหายไป แล้วกด “เข้าสู่ระบบ” เพื่อเริ่มขั้นตอน Google เดิมของ server (/auth/login)
 *   คำนี้เป็นเพียงตัวเลือกช่องทาง: สิทธิ์ของทีมงานยังมาจากบัญชี Google ที่ผู้ดูแลเพิ่มไว้และ server ตรวจเหมือนเดิม
 *   เส้นทางนี้ไม่ส่งรหัสผ่านและไม่เรียกเส้นทางเข้าสู่ระบบของสมาชิก
 */
export function LoginPage() {
  const { status, user, member, authConfigured, reload, refresh } = useAuth()
  const [params] = useSearchParams()
  const returnPath = safeReturn(params.get('return'))
  const errorCode = params.get('error')
  const googleError = errorCode ? (ERRORS[errorCode] ?? 'เข้าสู่ระบบไม่สำเร็จ ลองอีกครั้ง') : ''

  // กลับมาจากขั้นตอนของ Google ที่ไม่สำเร็จ: เติมคำเลือกช่องทางไว้ ให้ลองใหม่ได้ด้วยการกดปุ่มเดียว
  const [username, setUsername] = useState(googleError ? GOOGLE_LOGIN_WORD : '')
  const [password, setPassword] = useState('')
  const [fieldErrors, setFieldErrors] = useState<{ username?: string; password?: string }>({})
  const [submitError, setSubmitError] = useState('')
  const [busy, setBusy] = useState(false)
  // กำลังออกจากหน้านี้ไปหน้าของ Google: กันการกดซ้ำ
  const [leaving, setLeaving] = useState(false)
  const usernameRef = useRef<HTMLInputElement>(null)
  const passwordRef = useRef<HTMLInputElement>(null)
  const composing = useRef(false)
  const selection = useRef<[number | null, number | null] | null>(null)

  const viaGoogle = isGoogleLoginWord(username)

  useEffect(() => {
    document.title = `เข้าสู่ระบบ · ${CLUB_NAME}`
  }, [])

  // เลือกช่องทาง Google: ล้างรหัสผ่านที่พิมพ์ค้างไว้ทันที เมื่อกลับมาเป็นช่องทางสมาชิก ช่องรหัสผ่านจึงว่างเสมอ
  useEffect(() => {
    if (!viaGoogle) return
    setPassword('')
    setFieldErrors((errors) => (errors.password ? { ...errors, password: undefined } : errors))
  }, [viaGoogle])

  // การเปลี่ยนเป็นตัวเล็กทำให้เบราว์เซอร์ย้ายเคอร์เซอร์ไปท้ายช่อง: วางกลับตำแหน่งเดิม (ความยาวข้อความไม่เปลี่ยน)
  useLayoutEffect(() => {
    const input = usernameRef.current
    const saved = selection.current
    selection.current = null
    if (saved && input && document.activeElement === input) input.setSelectionRange(saved[0], saved[1])
  }, [username])

  // เข้าสู่ระบบแล้ว: สมาชิกไปหน้าสมาชิก ทีมงานไปหลังบ้าน ไม่พาข้ามฝั่งตามค่า return ที่ส่งมา
  if (status === 'ready' && member) return <Navigate to={member.mustChangePassword ? '/member/password' : isMemberPath(returnPath) ? returnPath : '/member'} replace />
  if (status === 'ready' && user) return <Navigate to={isMemberPath(returnPath) ? '/' : returnPath} replace />

  /** รับค่าจากช่องชื่อผู้ใช้ ระหว่างที่แป้นพิมพ์กำลังประกอบตัวอักษร (IME) ยังไม่แก้ข้อความ เพื่อไม่ให้การประกอบตัวอักษรถูกตัด */
  const takeUsername = (input: HTMLInputElement, normalize: boolean) => {
    const typed = input.value
    const next = normalize ? lowerAscii(typed) : typed
    if (next !== typed) selection.current = [input.selectionStart, input.selectionEnd]
    setUsername(next)
    if (fieldErrors.username) setFieldErrors((errors) => ({ ...errors, username: undefined }))
    if (submitError) setSubmitError('')
  }

  // ทีมงานเริ่มขั้นตอนของ Google ได้เมื่อรู้แล้วว่าเว็บไซต์ตั้งค่าไว้ (สถานะจาก server)
  const googleReady = status !== 'loading' && status !== 'error' && authConfigured

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy || leaving) return
    const name = lowerAscii(username.trim())
    const google = isGoogleLoginWord(name)
    const found = { username: name ? undefined : 'กรอกชื่อผู้ใช้', password: google || password ? undefined : 'กรอกรหัสผ่าน' }
    setFieldErrors(found)
    setSubmitError('')
    if (found.username) return usernameRef.current?.focus()

    if (google) {
      // ยังไม่รู้สถานะ หรือเว็บไซต์ยังไม่ได้ตั้งค่า: ข้อความในฟอร์มบอกเหตุผลอยู่แล้ว ไม่ออกจากหน้านี้
      if (!googleReady) return
      // ไปเริ่มที่ server ตามเดิม: ไม่มีรหัสผ่าน ไม่มีคำขอของบัญชีสมาชิก และชื่อผู้ใช้ไม่ถูกส่งไปใน URL
      setLeaving(true)
      window.location.assign(`/auth/login?return=${encodeURIComponent(isMemberPath(returnPath) ? '/' : returnPath)}`)
      return
    }

    if (found.password) return passwordRef.current?.focus()
    setBusy(true)
    try {
      await loginMember(name, password)
      // อ่าน session ที่ server เพิ่งออกให้ แล้วหน้านี้จะพาไปหน้าสมาชิกเอง
      await refresh()
    } catch (failure) {
      // ค่าที่กรอกยังอยู่ครบ ให้แก้แล้วลองใหม่ได้ทันที
      setSubmitError(messageOf(failure, 'เข้าสู่ระบบไม่สำเร็จ ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง'))
      setBusy(false)
      passwordRef.current?.focus()
    }
  }

  const alert = submitError || googleError
  const waiting = busy || leaving

  return (
    <LoginShell>
      <h1 className="login-title">เข้าสู่ระบบ</h1>
      <p className="login-welcome">ยินดีต้อนรับ ดูกิจกรรมและไฟล์ของชมรมได้ที่นี่</p>

      {/* แสดงเฉพาะเมื่อ server ยืนยันว่าไม่มี session แล้วจริง */}
      {params.get('loggedOut') && !googleError && status === 'anonymous' && <p className="notice">ออกจากระบบแล้ว</p>}

      <section className="login-card" aria-labelledby="login-context">
        <h2 id="login-context">{viaGoogle ? 'สำหรับทีมงาน' : 'สำหรับสมาชิก'}</h2>
        <form onSubmit={submit} noValidate className="form">
          {alert && (
            <p className="form-alert" role="alert">
              {alert}
            </p>
          )}
          <Field label="ชื่อผู้ใช้" htmlFor="login-username" error={fieldErrors.username}>
            <input
              id="login-username"
              className="login-username"
              placeholder="ชื่อผู้ใช้"
              ref={usernameRef}
              type="text"
              inputMode="text"
              value={username}
              onChange={(e) => takeUsername(e.target, !composing.current && !(e.nativeEvent as InputEvent).isComposing)}
              onCompositionStart={() => {
                composing.current = true
              }}
              onCompositionEnd={(e) => {
                composing.current = false
                takeUsername(e.currentTarget, true)
              }}
              autoComplete="username"
              autoCapitalize="none"
              autoCorrect="off"
              spellCheck={false}
              {...fieldAria('login-username', fieldErrors.username)}
            />
          </Field>

          {viaGoogle ? (
            // ช่องรหัสผ่านถูกเอาออกจากหน้า (ไม่เหลือในลำดับ Tab) และข้อความนี้ถูกอ่านให้ผู้ใช้โปรแกรมอ่านหน้าจอทราบว่าฟอร์มเปลี่ยน
            <div className="login-google" role="status">
              {status === 'loading' ? (
                <p className="auth-inline">
                  <LoaderCircle aria-hidden="true" size={20} className="spin" />
                  กำลังตรวจการเข้าสู่ระบบ…
                </p>
              ) : status === 'error' ? (
                <div className="auth-inline-block">
                  <p>
                    <TriangleAlert aria-hidden="true" size={18} /> เชื่อมต่อระบบกลางไม่ได้ จึงยังเข้าสู่ระบบด้วย Google ไม่ได้
                  </p>
                  <button type="button" className="button" onClick={reload}>
                    ลองอีกครั้ง
                  </button>
                </div>
              ) : !authConfigured ? (
                <div className="notice notice-warning">
                  <TriangleAlert aria-hidden="true" size={18} />
                  <div>
                    <p>
                      <strong>ทีมงานยังเข้าสู่ระบบไม่ได้</strong>
                    </p>
                    <p>เว็บไซต์นี้ยังไม่ได้ตั้งค่าการเข้าสู่ระบบด้วย Google ผู้ดูแลระบบต้องตั้งค่าตามคู่มือของระบบก่อน</p>
                  </div>
                </div>
              ) : (
                <p className="login-google-note">
                  <Info aria-hidden="true" size={18} />
                  <span>ทีมงานเข้าสู่ระบบด้วยบัญชี Google ที่ผู้ดูแลเพิ่มสิทธิ์ไว้ ไม่ต้องกรอกรหัสผ่าน กด “เข้าสู่ระบบ” เพื่อไปต่อที่ Google</span>
                </p>
              )}
            </div>
          ) : (
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
          )}

          <button type="submit" className="button button-primary button-large" aria-disabled={waiting || (viaGoogle ? !googleReady : status === 'loading')}>
            {waiting ? <LoaderCircle aria-hidden="true" size={18} className="spin" /> : <LogIn aria-hidden="true" size={18} />}
            {busy ? 'กำลังเข้าสู่ระบบ…' : leaving ? 'กำลังไปที่ Google…' : 'เข้าสู่ระบบ'}
          </button>
        </form>
        {!viaGoogle && <p className="login-forgot">ลืมรหัสผ่าน? ติดต่อทีมงานของชมรมเพื่อตั้งรหัสผ่านใหม่</p>}
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
          ทีมงาน: ให้ผู้ดูแลเพิ่มอีเมลของบัญชีนี้ที่หน้า “ทีมงาน” ก่อน หรือเข้าสู่ระบบด้วยบัญชี Google ที่ได้รับสิทธิ์แล้ว สมาชิก: ใช้รหัสนักศึกษาเป็นชื่อผู้ใช้
          พร้อมรหัสผ่านที่หน้าเข้าสู่ระบบ ไม่ต้องใช้บัญชี Google
        </p>
        <Link className="button button-primary button-large" to="/login">
          เข้าสู่ระบบด้วยบัญชีอื่น
        </Link>
      </section>
    </LoginShell>
  )
}
