// ธีมสว่าง/มืด จำเฉพาะอุปกรณ์นี้ แยก key จากข้อมูลสมาชิก กำหนดการ และ session
export const THEME_KEY = 'mu-esport-staff:theme:v1'

export type Theme = 'light' | 'dark'

/** ค่าเริ่มต้นเป็นธีมสว่าง แม้เบราว์เซอร์ไม่อนุญาตให้เก็บข้อมูล */
export function storedTheme(): Theme {
  try {
    return localStorage.getItem(THEME_KEY) === 'dark' ? 'dark' : 'light'
  } catch {
    return 'light'
  }
}

export function applyTheme(theme: Theme) {
  document.documentElement.dataset.theme = theme
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // เก็บไม่ได้: ธีมยังเปลี่ยนในหน้านี้ แต่จะกลับเป็นค่าเริ่มต้นเมื่อโหลดใหม่
  }
}
