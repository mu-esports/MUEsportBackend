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

/** ผู้ใช้ไม่ต้องการการเคลื่อนไหว (ตั้งค่าของระบบหรือเบราว์เซอร์) */
export const reducedMotion = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches

type ViewTransitionDocument = Document & { startViewTransition?(update: () => void): { finished: Promise<void> } }

const REVEAL_VARS = ['--theme-x', '--theme-y', '--theme-r']
// รอบล่าสุดของการสลับ และธีมที่ผู้ใช้ต้องการล่าสุด: กดซ้ำระหว่างอนิเมชัน รอบเก่าถูกเบราว์เซอร์ยกเลิกและ “จบ” ก่อนรอบใหม่
let switchRun = 0
let wantedTheme: Theme | null = null

/**
 * สลับธีมจากการกดของผู้ใช้: ธีมใหม่แผ่ออกเป็นวงจากจุดที่กด (กฎอยู่ที่ .theme-switching ใน src/motion.css)
 * ส่วนที่เคลื่อนไหวเป็นภาพของหน้าที่เบราว์เซอร์จัดการเอง (ค่าธีมถูกตั้งในเฟรมถัดไป หลังเบราว์เซอร์เก็บภาพธีมเดิม) หน้าไม่ถูกสร้างใหม่และไม่มีคำขอข้อมูล
 * โหมดลดการเคลื่อนไหว หรือเบราว์เซอร์ที่ไม่รองรับ: เปลี่ยนทันที
 * กดซ้ำระหว่างอนิเมชัน: ธีมสุดท้ายเป็นของการกดล่าสุดเสมอ และเฉพาะรอบล่าสุดเท่านั้นที่ล้าง class กับตำแหน่งวงเมื่อจบ
 */
export function switchTheme(theme: Theme, origin?: Element | null) {
  const root = document.documentElement
  const view = document as ViewTransitionDocument
  const run = ++switchRun
  wantedTheme = theme
  const done = () => {
    // รอบเก่าที่จบทีหลัง: สถานะบนหน้าเป็นของรอบใหม่แล้ว ห้ามแตะ
    if (run !== switchRun) return
    root.classList.remove('theme-switching')
    for (const name of REVEAL_VARS) root.style.removeProperty(name)
  }
  if (reducedMotion() || typeof view.startViewTransition !== 'function') {
    applyTheme(theme)
    return done()
  }
  const box = origin?.getBoundingClientRect()
  const x = box ? box.left + box.width / 2 : window.innerWidth / 2
  const y = box ? box.top + box.height / 2 : 0
  root.style.setProperty('--theme-x', `${x}px`)
  root.style.setProperty('--theme-y', `${y}px`)
  root.style.setProperty('--theme-r', `${Math.ceil(Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y)))}px`)
  root.classList.add('theme-switching')
  try {
    // ใช้ค่าที่ต้องการล่าสุด: callback ของรอบเก่าที่ถูกเรียกช้าจะไม่ย้อนธีมกลับ
    view.startViewTransition(() => applyTheme(wantedTheme ?? theme)).finished.then(done, done)
  } catch {
    applyTheme(theme)
    done()
  }
}

export function saveTheme(theme: Theme) {
  try {
    localStorage.setItem(THEME_KEY, theme)
  } catch {
    // เก็บไม่ได้: ธีมยังเปลี่ยนในหน้านี้ แต่จะกลับเป็นค่าเริ่มต้นเมื่อโหลดใหม่
  }
}
