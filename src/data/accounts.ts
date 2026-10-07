import { api } from '../api/client'
import type { MemberAccount } from './types'

/** จัดการบัญชีเข้าสู่ระบบของสมาชิก (เฉพาะผู้ดูแล server ตรวจสิทธิ์ทุกคำขอ) รหัสผ่านถูกส่งไปตั้งเท่านั้น ไม่มีเส้นทางอ่านกลับ */
const path = (memberId: string, action: string) => `/api/members/${encodeURIComponent(memberId)}/account/${action}`

export const accountsApi = {
  /** เปิดบัญชี รีเซ็ตรหัสผ่าน หรือเปิดบัญชีที่ปิดไว้อีกครั้ง studentId = รหัสที่ผู้ดูแลตรวจในกล่องตั้งรหัส */
  setPassword: (memberId: string, studentId: string, password: string) =>
    api<{ account: MemberAccount }>(path(memberId, 'password'), { method: 'POST', body: { studentId, password } }),
  disable: (memberId: string) => api<{ account: MemberAccount }>(path(memberId, 'disable'), { method: 'POST', body: {} }),
  /** ยืนยันให้บัญชีใช้รหัสนักศึกษาปัจจุบันในทะเบียนเป็นรหัสเข้าสู่ระบบ */
  confirmLoginId: (memberId: string, studentId: string) => api<{ account: MemberAccount }>(path(memberId, 'login-id'), { method: 'POST', body: { studentId } }),
}

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128

export const ACCOUNT_STATE_LABELS: Record<MemberAccount['state'], string> = {
  none: 'ยังไม่ได้เปิดบัญชี',
  must_change: 'ต้องเปลี่ยนรหัสผ่าน',
  active: 'เปิดใช้งาน',
  disabled: 'ปิดบัญชี',
}

// ตัวอักษรที่อ่านและพิมพ์ตามได้ไม่สับสน (ไม่มี 0/O, 1/l/I)
const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnpqrstuvwxyz23456789'

/** รหัสผ่านชั่วคราวแบบสุ่ม 16 ตัว แบ่งกลุ่มด้วยขีดให้อ่านง่าย สุ่มใหม่ทุกครั้ง จึงไม่ซ้ำกันระหว่างสมาชิก */
export function generatePassword(): string {
  const out: string[] = []
  // สุ่มทีละไบต์และทิ้งค่าที่ทำให้ตัวอักษรบางตัวออกบ่อยกว่า
  const limit = 256 - (256 % ALPHABET.length)
  while (out.length < 16) {
    for (const byte of crypto.getRandomValues(new Uint8Array(32))) {
      if (byte < limit && out.length < 16) out.push(ALPHABET[byte % ALPHABET.length])
    }
  }
  return [out.slice(0, 4), out.slice(4, 8), out.slice(8, 12), out.slice(12, 16)].map((group) => group.join('')).join('-')
}
