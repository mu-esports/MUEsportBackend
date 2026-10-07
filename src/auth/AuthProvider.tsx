import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api, onUnauthorized, setCsrfToken } from '../api/client'
import { AppError } from '../data/errors'

/** ทีมงานที่เข้าสู่ระบบด้วย Google */
export interface AuthUser {
  id: string
  email: string
  name: string
  role: 'staff' | 'admin'
}

/** สมาชิกที่เข้าสู่ระบบด้วยรหัสนักศึกษาและรหัสผ่าน ไม่มีสิทธิ์หลังบ้าน */
export interface AuthMember {
  id: string
  name: string
  nickname: string
  studentId: string
  /** ยังใช้รหัสผ่านชั่วคราว: เปิดได้เฉพาะหน้าเปลี่ยนรหัสผ่าน (server บังคับเช่นกัน) */
  mustChangePassword: boolean
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
  /** มีค่าเมื่อ session เป็นของทีมงาน */
  user: AuthUser | null
  /** มีค่าเมื่อ session เป็นของสมาชิก (มีได้อย่างใดอย่างหนึ่งกับ user) */
  member: AuthMember | null
  isAdmin: boolean
  /** เว็บไซต์ตั้งค่า Google client สำหรับเข้าสู่ระบบแล้วหรือยัง */
  authConfigured: boolean
  reload(): void
  /** ตรวจหลังผู้ใช้เข้าสู่ระบบใหม่ในแท็บอื่น คืน true เมื่อกลับมาทำงานต่อได้ */
  recheck(): Promise<boolean>
  /** อ่าน session ล่าสุดจาก server เงียบ ๆ (เช่น หลังเข้าสู่ระบบหรือเปลี่ยนรหัสผ่านสำเร็จ) */
  refresh(): Promise<void>
  /**
   * ออกจากระบบ: ไปหน้าเข้าสู่ระบบเฉพาะเมื่อยืนยันได้ว่า session ถูกยกเลิกที่ server แล้ว
   * ถ้าไม่สำเร็จหรือยืนยันไม่ได้จะ throw AppError (ข้อความไทย) และไม่แตะงานที่ยังไม่บันทึก
   */
  logout(): Promise<void>
}

interface SessionResponse {
  authConfigured: boolean
  user: AuthUser | null
  member: AuthMember | null
  csrfToken: string | null
}

// นอก AuthProvider (โหมดข้อมูลตัวอย่าง) ไม่มีผู้ใช้และไม่มีการเข้าสู่ระบบ
const NO_AUTH: Auth = {
  status: 'ready',
  user: null,
  member: null,
  isAdmin: false,
  authConfigured: false,
  reload: () => undefined,
  recheck: async () => true,
  refresh: async () => undefined,
  logout: async () => undefined,
}

const AuthContext = createContext<Auth>(NO_AUTH)

/** ตัวตนของ session: ใช้ตรวจว่าเข้าสู่ระบบใหม่เป็นคนเดิมหรือไม่ */
const principalOf = (session: Pick<SessionResponse, 'user' | 'member'>) =>
  session.user ? `staff:${session.user.id}` : session.member ? `member:${session.member.id}` : null

export function AuthProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<Status>('loading')
  const [user, setUser] = useState<AuthUser | null>(null)
  const [member, setMember] = useState<AuthMember | null>(null)
  const [authConfigured, setAuthConfigured] = useState(true)
  const principal = useRef<string | null>(null)

  const apply = useCallback((session: SessionResponse) => {
    setCsrfToken(session.csrfToken)
    setAuthConfigured(session.authConfigured)
    principal.current = principalOf(session)
    setUser(session.user)
    setMember(session.user ? null : session.member)
    setStatus(principal.current ? 'ready' : 'anonymous')
  }, [])

  const reload = useCallback(() => {
    setStatus('loading')
    api<SessionResponse>('/api/session').then(apply, () => setStatus('error'))
  }, [apply])

  useEffect(reload, [reload])

  const refresh = useCallback(async () => apply(await api<SessionResponse>('/api/session')), [apply])

  // API ตอบ 401 ระหว่างใช้งาน: เก็บหน้าปัจจุบันไว้ แล้วแจ้งให้เข้าสู่ระบบใหม่
  useEffect(() => {
    onUnauthorized(() => setStatus((current) => (current === 'ready' ? 'expired' : current)))
    return () => onUnauthorized(null)
  }, [])

  const recheck = useCallback(async () => {
    const session = await api<SessionResponse>('/api/session')
    const next = principalOf(session)
    if (!next) return false
    if (principal.current && next !== principal.current) {
      // เข้าสู่ระบบใหม่เป็นคนละบัญชี: โหลดหน้าใหม่ทั้งหมด งานที่ยังไม่บันทึกของบัญชีเดิมจะไม่ถูกส่งต่อ
      window.dispatchEvent(new Event('mu:discard-drafts'))
      window.location.assign(session.member ? '/member' : '/')
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
      if (principalOf(session)) {
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
    () => ({ status, user, member, isAdmin: user?.role === 'admin', authConfigured, reload, recheck, refresh, logout }),
    [status, user, member, authConfigured, reload, recheck, refresh, logout],
  )
  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>
}

export const useAuth = () => useContext(AuthContext)
