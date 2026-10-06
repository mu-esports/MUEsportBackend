import { useState } from 'react'
import { Moon, Sun } from 'lucide-react'
import { applyTheme, saveTheme, storedTheme } from '../theme'
import type { Theme } from '../theme'

/** สวิตช์ธีมสว่าง/มืด เปลี่ยนเฉพาะการแสดงผล ไม่แตะข้อมูลหรือสถานะของหน้า */
export function ThemeSwitch() {
  const [theme, setTheme] = useState<Theme>(storedTheme)
  const dark = theme === 'dark'

  const toggle = () => {
    const next: Theme = dark ? 'light' : 'dark'
    setTheme(next)
    applyTheme(next)
    saveTheme(next)
  }

  return (
    <button type="button" role="switch" aria-checked={dark} aria-label="ธีมมืด" className="theme-switch" onClick={toggle}>
      <span className="theme-switch-track">
        <span className="theme-switch-icon">
          {dark ? <Moon aria-hidden="true" size={16} /> : <Sun aria-hidden="true" size={16} />}
        </span>
        <span className="theme-switch-knob" />
      </span>
    </button>
  )
}
