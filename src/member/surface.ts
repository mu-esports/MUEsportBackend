import { useEffect } from 'react'
import { applyTheme, storedTheme } from '../theme'

/**
 * หน้าเข้าสู่ระบบและหน้าของสมาชิกใช้ชุดสีสมาชิกตามธีมที่ผู้ใช้เลือกไว้
 * ตั้งที่ <html> เพื่อให้พื้นหลังของทั้งหน้า กล่องโต้ตอบ และข้อความแจ้งผลใช้ชุดสีเดียวกัน (ดู src/member/member.css)
 * ใช้ค่าธีมร่วมกับหลังบ้าน และคืนชุดสีหลังบ้านเมื่อออกจากหน้าสมาชิก
 */
export function useMemberSurface() {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.surface = 'member'
    applyTheme(storedTheme())
    return () => {
      delete root.dataset.surface
      applyTheme(storedTheme())
    }
  }, [])
}
