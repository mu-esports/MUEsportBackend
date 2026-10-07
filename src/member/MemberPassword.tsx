import { useEffect } from 'react'
import { Navigate, useNavigate } from 'react-router-dom'
import { Gamepad2, KeyRound } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { useToast } from '../components/Toast'
import { CLUB_NAME } from '../config'
import { LeavingProvider, LogoutButton } from './MemberLayout'
import { PasswordForm } from './PasswordForm'
import { useMemberSurface } from './surface'

/**
 * หน้าเปลี่ยนรหัสผ่านชั่วคราว (ครั้งแรกหลังทีมงานตั้งหรือรีเซ็ตรหัสให้)
 * ไม่มีเมนูไปหน้าอื่น: ทำได้เพียงเปลี่ยนรหัสผ่านหรือออกจากระบบ และ server ปฏิเสธ API อื่นทั้งหมดจนกว่าจะเปลี่ยนสำเร็จ
 */
export function MemberPasswordPage() {
  useMemberSurface()
  const { member } = useAuth()
  const navigate = useNavigate()
  const toast = useToast()

  useEffect(() => {
    document.title = `ตั้งรหัสผ่านใหม่ · ${CLUB_NAME}`
  }, [])

  if (!member) return null
  // เปลี่ยนรหัสแล้ว: หน้านี้ไม่มีอะไรให้ทำ การเปลี่ยนรหัสครั้งถัดไปอยู่ในหน้าบัญชี
  if (!member.mustChangePassword) return <Navigate to="/member" replace />

  return (
    <div className="login-page">
      <LeavingProvider>
        <main className="login-main" id="main">
          <p className="login-brand">
            <span className="m-logo" aria-hidden="true">
              <Gamepad2 size={24} />
            </span>
            <span className="login-brand-name">{CLUB_NAME}</span>
          </p>
          <h1 className="login-title" tabIndex={-1}>
            ตั้งรหัสผ่านใหม่
          </h1>
          <p className="login-welcome">
            สวัสดี {member.nickname || member.name} (รหัสนักศึกษา {member.studentId}) รหัสผ่านที่ทีมงานให้เป็นรหัสชั่วคราว ตั้งรหัสผ่านของตัวเองก่อนเริ่มใช้งาน
          </p>
          <section className="login-card" aria-labelledby="first-password-title">
            <h2 id="first-password-title">
              <KeyRound aria-hidden="true" size={20} />
              เปลี่ยนรหัสผ่านชั่วคราว
            </h2>
            <PasswordForm
              currentLabel="รหัสผ่านชั่วคราว"
              submitLabel="บันทึกรหัสผ่านใหม่"
              studentId={member.studentId}
              onChanged={() => {
                toast.success('ตั้งรหัสผ่านใหม่แล้ว')
                navigate('/member', { replace: true })
              }}
            />
          </section>
          <div className="login-staff">
            <p className="login-staff-note">ยังไม่พร้อมตั้งรหัสตอนนี้ ออกจากระบบแล้วกลับมาใหม่ได้ รหัสชั่วคราวยังใช้ได้จนกว่าจะเปลี่ยน</p>
            <LogoutButton />
          </div>
        </main>
      </LeavingProvider>
    </div>
  )
}
