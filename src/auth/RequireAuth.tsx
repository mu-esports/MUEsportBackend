import { createContext, useContext, useEffect, useState } from 'react'
import type { ReactNode } from 'react'
import { Navigate, useLocation } from 'react-router-dom'
import { LoaderCircle, TriangleAlert } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { useAuth } from './AuthProvider'

/** ครอบทุกหน้าที่ต้องเข้าสู่ระบบ สิทธิ์จริงตรวจที่ server ทุกคำขอ ส่วนนี้ดูแลเฉพาะสิ่งที่ผู้ใช้เห็น */
export function RequireAuth({ children }: { children: ReactNode }) {
  const { status, reload } = useAuth()
  const location = useLocation()

  if (status === 'loading') {
    return (
      <div className="auth-screen" role="status">
        <LoaderCircle aria-hidden="true" size={28} className="spin" />
        <p>กำลังตรวจการเข้าสู่ระบบ…</p>
      </div>
    )
  }
  if (status === 'error') {
    return (
      <div className="auth-screen" role="alert">
        <TriangleAlert aria-hidden="true" size={28} />
        <p className="empty-state-title">เชื่อมต่อระบบกลางไม่ได้</p>
        <p className="empty-state-text">ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง</p>
        <button type="button" className="button button-primary" onClick={reload}>
          ลองอีกครั้ง
        </button>
      </div>
    )
  }
  if (status === 'anonymous') {
    const target = location.pathname + location.search
    return <Navigate to={target === '/' ? '/login' : `/login?return=${encodeURIComponent(target)}`} replace />
  }
  return <SessionExpired active={status === 'expired'}>{children}</SessionExpired>
}

// แถบแจ้งเซสชันหมดอายุถูกวางโดย Layout ในส่วนที่เกาะด้านบนร่วมกับหัวเว็บ จึงไม่ซ้อนทับกันทั้งก่อนและหลังเลื่อนหน้า
const SessionNoticeContext = createContext<ReactNode>(null)
export const useSessionNotice = () => useContext(SessionNoticeContext)

/**
 * เซสชันหมดอายุระหว่างใช้งาน: หน้าที่เปิดอยู่ไม่ถูกปิด งานที่ยังไม่บันทึกจึงยังอยู่ในหน่วยความจำ
 * ผู้ใช้เข้าสู่ระบบใหม่ในแท็บอื่นแล้วกลับมาทำต่อได้ ถ้าเป็นคนละบัญชี หน้าจะโหลดใหม่และงานค้างของบัญชีเดิมถูกทิ้ง
 */
function SessionExpired({ active, children }: { active: boolean; children: ReactNode }) {
  const { recheck } = useAuth()
  const [closed, setClosed] = useState(false)

  // หมดอายุรอบใหม่: เปิด dialog ให้เห็นอีกครั้ง
  useEffect(() => {
    if (!active) setClosed(false)
  }, [active])

  // กลับมาที่แท็บนี้หลังเข้าสู่ระบบในแท็บอื่น: ตรวจให้อัตโนมัติ
  useEffect(() => {
    if (!active) return
    const onVisible = () => {
      if (document.visibilityState === 'visible') recheck().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [active, recheck])

  const banner = active ? (
    <div className="session-banner" role="alert">
      <TriangleAlert aria-hidden="true" size={18} />
      <span>เซสชันหมดอายุ การบันทึกจะไม่สำเร็จจนกว่าจะเข้าสู่ระบบอีกครั้ง</span>
      <button type="button" className="button button-small" onClick={() => setClosed(false)}>
        เข้าสู่ระบบอีกครั้ง
      </button>
    </div>
  ) : null

  return (
    <SessionNoticeContext.Provider value={banner}>
      {children}
      {active && !closed && <ExpiredDialog onClose={() => setClosed(true)} />}
    </SessionNoticeContext.Provider>
  )
}

function ExpiredDialog({ onClose }: { onClose(): void }) {
  const { recheck } = useAuth()
  const [checking, setChecking] = useState(false)
  const [message, setMessage] = useState('')

  const check = async () => {
    setChecking(true)
    setMessage('')
    try {
      if (!(await recheck())) setMessage('ยังไม่พบการเข้าสู่ระบบ เข้าสู่ระบบในแท็บใหม่ให้เสร็จก่อน แล้วกดอีกครั้ง')
    } catch {
      setMessage('เชื่อมต่อระบบกลางไม่ได้ ลองอีกครั้ง')
    } finally {
      setChecking(false)
    }
  }

  return (
        <Dialog
          title="เซสชันหมดอายุ"
          size="sm"
          onRequestClose={onClose}
          footer={
            <>
              <button type="button" className="button" onClick={onClose}>
                ปิดไว้ก่อน
              </button>
              <button type="button" className="button button-primary" onClick={check} disabled={checking}>
                {checking ? 'กำลังตรวจ…' : 'เข้าสู่ระบบแล้ว ทำงานต่อ'}
              </button>
            </>
          }
        >
          <div className="confirm-body">
            <p>สิ่งที่กรอกไว้ในหน้านี้ยังอยู่ครบ แต่ยังไม่ได้บันทึก และจะหายถ้าปิดหรือโหลดหน้านี้ใหม่</p>
            <ol className="numbered">
              <li>
                <a href="/auth/login" target="_blank" rel="noopener" data-autofocus>
                  เข้าสู่ระบบในแท็บใหม่
                </a>{' '}
                ด้วยบัญชีเดิม
              </li>
              <li>กลับมาที่แท็บนี้ แล้วกด “เข้าสู่ระบบแล้ว ทำงานต่อ”</li>
              <li>กดบันทึกอีกครั้ง</li>
            </ol>
            <p className="field-hint">ถ้าเข้าสู่ระบบด้วยบัญชีอื่น หน้านี้จะโหลดใหม่และไม่ส่งสิ่งที่กรอกไว้ไปยังบัญชีนั้น</p>
            {message && (
              <p className="form-alert" role="alert">
                {message}
              </p>
            )}
          </div>
        </Dialog>
  )
}
