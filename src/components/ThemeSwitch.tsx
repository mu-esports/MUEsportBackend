import { useRef, useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { saveTheme, storedTheme, switchTheme } from '../theme'
import type { Theme } from '../theme'

/** สวิตช์ธีมสว่าง/มืด เปลี่ยนเฉพาะการแสดงผล ไม่แตะข้อมูลหรือสถานะของหน้า */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  const dark = theme === 'dark'
  // ธีมที่เลือกล่าสุด: กดซ้ำก่อนที่หน้าจะวาดใหม่ก็ยังสลับจากค่าล่าสุดจริง ไม่ใช่ค่าที่ค้างจากการวาดครั้งก่อน
  const latest = useRef(theme)

  const toggle = (origin: Element) => {
    const next: Theme = latest.current === 'dark' ? 'light' : 'dark'
    latest.current = next
    setTheme(next)
    switchTheme(next, origin)
    saveTheme(next)
  }

  return (
    <button type="button" role="switch" aria-checked={dark} aria-label="ธีมมืด" className="theme-switch" onClick={(event) => toggle(event.currentTarget)}>
      <span className="theme-switch-track">
        <span className="theme-switch-icon">
          {dark ? <Moon aria-hidden="true" size={16} /> : <Sun aria-hidden="true" size={16} />}
        </span>
        <span className="theme-switch-knob" />
      </span>
    </button>
  )
}
