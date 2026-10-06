import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, onUnauthorized, setCsrfToken } from '../api/client'
import { AppError } from '../data/errors'

export interface AuthUser {
  id: string
  email: string
  name: string
  role: 'staff' | 'admin'
}

type Status =
  | 'loading'
  | 'error'
  /** ยังไม่ได้เข้าสู่ระบบ */
  | 'anonymous'
  | 'ready'
  /** เคยเข้าสู่ระบบแล้ว แต่ server แจ้งว่าเซสชันใช้ไม่ได้ หน้าที่เปิดอยู่ยังอยู่ครบเพื่อไม่ให้งานที่ยังไม่บันทึกหาย */
  | 'expired'

interface Auth {
  status: Status
  user: AuthUser | null
  isAdmin: boolean
  /** เว็บไซต์ตั้งค่า Google client สำหรับเข้าสู่ระบบแล้วหรือยัง */
  authConfigured: boolean
  reload(): void
  /** ตรวจหลังผู้ใช้เข้าสู่ระบบใหม่ในแท็บอื่น คืน true เมื่อกลับมาทำงานต่อได้ */
  recheck(): Promise<boolean>
  /**
   * ออกจากระบบ: ไปหน้าเข้าสู่ระบบเฉพาะเมื่อยืนยันได้ว่า session ถูกยกเลิกที่ server แล้ว
   * ถ้าไม่สำเร็จหรือยืนยันไม่ได้จะ throw AppError (ข้อความไทย) และไม่แตะงานที่ยังไม่บันทึก
   */
  logout(): Promise<void>
}

interface SessionResponse {
  authConfigured: boolean
  user: AuthUser | null
  csrfToken: string | null
}

// นอก AuthProvider (โหมดข้อมูลตัวอย่าง) ไม่มีผู้ใช้และไม่มีการเข้าสู่ระบบ
const NO_AUTH: Auth = {
  status: 'ready',
  user: null,
  isAdmin: false,
  authConfigured: false,
  reload: () => undefined,
  recheck: async () => true,
  logout: async () => undefined,
}

const AuthContext = createContext<Auth>(NO_AUTH)

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [authConfigured, setAuthConfigured] = useState(true)
  const userRef = useRef<AuthUser | null>(null)

  const apply = useCallback((session: SessionResponse) => {
    setCsrfToken(session.csrfToken)
    setAuthConfigured(session.authConfigured)
    userRef.current = session.user
    setUser(session.user)
    setStatus(session.user ? 'ready' : 'anonymous')
  }, [])

  const reload = useCallback(() => {
    setStatus('loading')
    api<SessionResponse>('/api/session').then(apply, () => setStatus('error'))
  }, [apply])

  useEffect(reload, [reload])

  // API ตอบ 401 ระหว่างใช้งาน: เก็บหน้าปัจจุบันไว้ แล้วแจ้งให้เข้าสู่ระบบใหม่
  useEffect(() => {
    onUnauthorized(() => setStatus((current) => (current === 'ready' ? 'expired' : current)))
    return () => onUnauthorized(null)
  }, [])

  const recheck = useCallback(async () => {
    const session = await api<SessionResponse>('/api/session')
    if (!session.user) return false
    if (userRef.current && session.user.id !== userRef.current.id) {
      // เข้าสู่ระบบใหม่เป็นคนละบัญชี: โหลดหน้าใหม่ทั้งหมด งานที่ยังไม่บันทึกของบัญชีเดิมจะไม่ถูกส่งต่อ
      window.dispatchEvent(new Event('mu:discard-drafts'))
      window.location.assign('/')
      return false
    }
    apply(session)
    return true
  }, [apply])

  const logout = useCallback(async () => {
    try {
      await api('/auth/logout', { method: 'POST', quiet401: true })
    } catch (failure) {
      // คำตอบอาจหายทั้งที่ server ยกเลิก session ไปแล้ว หรือ session หมดอายุไปก่อน: ถาม server ว่าตอนนี้ยังมี session อยู่หรือไม่
      let session: SessionResponse
      try {
        session = await api<SessionResponse>('/api/session')
      } catch {
        throw new AppError(
          'logout_unconfirmed',
          0,
          'ยืนยันไม่ได้ว่าออกจากระบบแล้วหรือยัง เพราะเชื่อมต่อระบบกลางไม่ได้ ตรวจอินเทอร์เน็ตแล้วกดออกจากระบบอีกครั้ง',
        )
      }
      if (session.user) {
        // ยังอยู่ในระบบ: ใช้ CSRF token ล่าสุดสำหรับการลองใหม่ และไม่ทิ้งงานที่ยังไม่บันทึก
        setCsrfToken(session.csrfToken)
        const reason = failure instanceof AppError && failure.status !== 0 ? 'ระบบกลางตอบกลับผิดพลาด' : 'เชื่อมต่อระบบกลางไม่ได้'
        throw new AppError('logout_failed', 0, `ออกจากระบบไม่สำเร็จ (${reason}) ตอนนี้ยังอยู่ในระบบ กดออกจากระบบอีกครั้ง`)
      }
    }
    // ยืนยันแล้วว่าไม่มี session: จึงล้างสถานะของหน้านี้และไปหน้าเข้าสู่ระบบ
    setCsrfToken(null)
    window.dispatchEvent(new Event('mu:discard-drafts'))
    window.location.assign('/login?loggedOut=1')
  }, [])

  const value = useMemo<Auth>(
    () => ({ status, user, isAdmin: user?.role === 'admin', authConfigured, reload, recheck, logout }),
    [status, user, authConfigured, reload, recheck, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
