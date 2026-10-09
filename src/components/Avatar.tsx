import { useState } from 'react'
import { UserRound } from 'lucide-react'
import { photoUrl } from '../data/photos'

interface Props {
  /** รหัสสมาชิกในทะเบียน (รูปเป็นของบุคคล ใช้ร่วมกันทุกหน้า) */
  memberId: string
  /** รุ่นของรูป (null/ไม่มี = ยังไม่มีรูป) */
  version?: string | null
  /** ชื่อที่ใช้ทำตัวอักษรแทนรูป (ชื่อเล่นหรือชื่อ) */
  name: string
  size?: 'sm' | 'md' | 'lg' | 'xl'
  /** รูปที่ยังไม่ได้บันทึก (ตัวอย่างก่อนบันทึก) ใช้แทนรูปปัจจุบัน */
  previewUrl?: string
  /** ข้อความแทนรูปเมื่อรูปเป็นเนื้อหาหลักของส่วนนั้น ปกติชื่ออยู่ข้างรูปแล้วจึงไม่ต้องใส่ */
  label?: string
}

// สระนำหน้าของภาษาไทย (เ แ โ ใ ไ): ตัวอักษรแทนรูปใช้พยัญชนะตัวถัดไป
const LEADING_VOWEL = /^[เ-ไ]$/

function initialOf(name: string): string {
  const letters = Array.from(name.trim())
  if (letters.length === 0) return ''
  return (LEADING_VOWEL.test(letters[0]) && letters[1] ? letters[1] : letters[0]).toUpperCase()
}

/**
 * รูปโปรไฟล์ขนาดคงที่ (ไม่ทำให้หน้าเลื่อนตอนรูปโหลด) ไม่มีรูปหรือโหลดไม่ได้: แสดงตัวอักษรแรกของชื่อ หรือไอคอนบุคคล
 * รูปโหลดจาก API ที่ตรวจ session ทุกครั้ง และโหลดเมื่อใกล้ถึงจอ (lazy) เพื่อไม่ขอรูปของทั้งรายการพร้อมกัน
 */
export function Avatar({ memberId, version, name, size = 'md', previewUrl, label }: Props) {
  // รุ่นของรูปที่โหลดไม่สำเร็จ: รูปรุ่นใหม่จะถูกลองโหลดใหม่เอง
  const [failed, setFailed] = useState<string | null>(null)
  const source = previewUrl ?? (version && failed !== version ? photoUrl(memberId, version) : null)
  const initial = initialOf(name)
  return (
    <span className={`avatar avatar-${size}`} {...(label ? { role: 'img', 'aria-label': label } : { 'aria-hidden': true })}>
      {source ? (
        <img src={source} alt="" loading={previewUrl ? undefined : 'lazy'} decoding="async" draggable={false} onError={() => !previewUrl && version && setFailed(version)} />
      ) : initial ? (
        <span className="avatar-initial">{initial}</span>
      ) : (
        <UserRound aria-hidden="true" />
      )}
    </span>
  )
}
