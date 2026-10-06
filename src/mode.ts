/**
 * โหมดการทำงานของหน้าเว็บ
 * - live (ค่าเริ่มต้น): ใช้ข้อมูลกลางผ่าน API ของ Worker ต้องเข้าสู่ระบบ
 * - demo (`vite --mode demo`): ข้อมูลตัวอย่างใน localStorage ของเบราว์เซอร์ ใช้ตรวจ regression ของ UI เท่านั้น
 * สองโหมดใช้ repository แยกกัน และโหมด live ไม่มีการสลับไปใช้ข้อมูลตัวอย่างเมื่อระบบกลางหรือ Google ล้มเหลว
 */
export const IS_DEMO = import.meta.env.MODE === 'demo'
