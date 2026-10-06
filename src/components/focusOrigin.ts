// องค์ประกอบที่ควรได้ focus กลับเมื่อปิด dialog หรือเมนู
// Safari/WebKit ไม่ย้าย focus ไปที่ปุ่มเมื่อคลิกหรือแตะ จึงจำปุ่มที่ถูกกดล่าสุดไว้ใช้แทนเมื่อ activeElement ไม่ใช่ปุ่มนั้น
let lastPressed: HTMLElement | null = null

if (typeof document !== 'undefined') {
  document.addEventListener(
    'pointerdown',
    (event) => {
      const target = event.target instanceof Element ? event.target.closest<HTMLElement>('button, a[href], [tabindex]') : null
      lastPressed = target
    },
    true,
  )
}

export function focusOrigin(): HTMLElement | null {
  const active = document.activeElement
  if (active instanceof HTMLElement && active !== document.body) return active
  return lastPressed
}
