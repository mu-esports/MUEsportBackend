import { useEffect } from 'react'
import { applyTheme, storedTheme } from '../theme'

/**
 * หน้าเข้าสู่ระบบและหน้าของสมาชิกใช้พื้นผิวสว่างชุดเดียวเสมอ ไม่ตามธีมมืดที่ทีมงานเลือกไว้ในเบราว์เซอร์เดียวกัน
 * ตั้งที่ <html> เพื่อให้พื้นหลังของทั้งหน้า กล่องโต้ตอบ และข้อความแจ้งผลใช้ชุดสีเดียวกัน (ดู src/member/member.css)
 * ไม่แตะค่าธีมที่ทีมงานบันทึกไว้: ออกจากหน้ากลุ่มนี้แล้วหลังบ้านกลับไปใช้ธีมเดิม
 */
export function useMemberSurface() {
  useEffect(() => {
    const root = document.documentElement
    root.dataset.surface = 'member'
    applyTheme('light')
    return () => {
      delete root.dataset.surface
      applyTheme(storedTheme())
    }
  }, [])
}
