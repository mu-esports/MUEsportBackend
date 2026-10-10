// ใช้โดย scripts/ui-check-motion.mjs: กดสวิตช์ธีมซ้ำขณะที่อนิเมชันของรอบก่อนยังเล่นอยู่
// รอบเก่าที่ถูกแทนที่จะ “จบ” ก่อนรอบใหม่ จึงต้องไม่ล้างสถานะ (class และตำแหน่งวง) ของรอบใหม่

/**
 * กดสวิตช์ `presses` ครั้ง: ครั้งถัดไปกดเมื่ออนิเมชันของครั้งก่อนเริ่มเล่นแล้ว
 * ทุกเฟรมหลังการกดครั้งสุดท้ายที่ยังมีอนิเมชันของภาพหน้าเล่นอยู่ ต้องยังมี class theme-switching และตำแหน่งวงของรอบล่าสุด
 * @returns {Promise<{ start: string, theme: string, checked: string, stored: string, frames: number, lost: number, wrongOrigin: number, left: boolean, timedOut: boolean }>}
 */
export const rapidThemeSwitch = (page, presses) =>
  page.evaluate(
    (presses) =>
      new Promise((resolve) => {
        const root = document.documentElement
        const button = document.querySelector('.theme-switch')
        const start = root.dataset.theme
        const transitions = () => document.getAnimations().filter((a) => a.effect?.pseudoElement?.startsWith('::view-transition'))
        const box = button.getBoundingClientRect()
        const origin = `${box.left + box.width / 2}px`
        const began = performance.now()
        let pressed = 0
        let frames = 0
        let lost = 0
        let wrongOrigin = 0
        const press = () => {
          button.click()
          pressed++
        }
        press()
        const tick = () => {
          const running = transitions().length > 0
          const timedOut = performance.now() - began > 4000
          if (pressed < presses) {
            // รอให้อนิเมชันของรอบก่อนเริ่มเล่นจริง แล้วจึงกดซ้ำกลางทาง
            if (running) press()
          } else if (running) {
            frames++
            if (!root.classList.contains('theme-switching')) lost++
            if (root.style.getPropertyValue('--theme-x') !== origin) wrongOrigin++
          } else if (frames > 0 || timedOut) {
            return resolve({
              start, theme: root.dataset.theme, checked: button.getAttribute('aria-checked'), stored: localStorage.getItem('mu-esport-staff:theme:v1'),
              frames, lost, wrongOrigin, left: root.classList.contains('theme-switching') || root.style.getPropertyValue('--theme-x') !== '', timedOut,
            })
          }
          if (timedOut && pressed < presses) return resolve({ start, theme: root.dataset.theme, checked: '', stored: '', frames, lost, wrongOrigin, left: true, timedOut })
          requestAnimationFrame(tick)
        }
        requestAnimationFrame(tick)
      }),
    presses,
  )

/** ผลที่ถูกต้อง: ธีมสุดท้ายตรงกับจำนวนครั้งที่กด สถานะของรอบล่าสุดอยู่ครบจนจบ และไม่มีอะไรค้างหลังจบ */
export function rapidOk(result, presses) {
  const other = result.start === 'dark' ? 'light' : 'dark'
  const want = presses % 2 === 1 ? other : result.start
  return !result.timedOut && result.theme === want && result.checked === String(want === 'dark') && result.stored === want && result.frames > 0 && result.lost === 0 && result.wrongOrigin === 0 && !result.left
}
