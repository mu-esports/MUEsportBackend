import { argon2id } from '@noble/hashes/argon2.js'

/**
 * การเก็บรหัสผ่านของบัญชีสมาชิก
 * - Argon2id ตามค่าขั้นต่ำที่ OWASP Password Storage Cheat Sheet แนะนำ: หน่วยความจำ 19 MiB (m=19456) วน 2 รอบ (t=2) ขนาน 1 (p=1)
 * - salt สุ่ม 16 ไบต์ต่อรหัสผ่านหนึ่งครั้งที่ตั้ง ผลลัพธ์ 32 ไบต์
 * - เก็บเป็นสตริงรูปแบบ PHC ($argon2id$v=19$m=…,t=…,p=…$salt$hash) จึงมี algorithm และ parameters กำกับทุกแถว
 *   ถ้าปรับค่าในอนาคต แถวเดิมยังตรวจได้ด้วยค่าที่บันทึกไว้ และถูกคำนวณใหม่ด้วยค่าปัจจุบันเมื่อสมาชิกเข้าสู่ระบบสำเร็จครั้งถัดไป
 * - ใช้ @noble/hashes (JavaScript ล้วน ผ่านการตรวจสอบจากภายนอก) เพราะ Web Crypto ของ Workers ไม่มี Argon2/scrypt/bcrypt
 *
 * ต้นทุน: การคำนวณหนึ่งครั้งใช้ CPU ราว 0.14 วินาทีใน workerd บนเครื่องพัฒนา (ดู README หัวข้อบัญชีสมาชิก)
 * ซึ่งเกินโควตา CPU 10 ms ต่อคำขอของ Workers Free ห้ามลดค่า m/t เพื่อให้ผ่านโควตา ให้ดูทางเลือกใน README แทน
 */
export const ARGON2_PARAMS = { m: 19456, t: 2, p: 1 } as const
const SALT_BYTES = 16
const HASH_BYTES = 32

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128

/** ขอบเขตของค่าที่ยอมคำนวณจากแถวที่เก็บไว้ กันค่าที่ผิดปกติใน D1 ทำให้ Worker ใช้หน่วยความจำหรือเวลามากเกิน */
const MAX_M = 65536
const MAX_T = 10
const MAX_P = 4

const encoder = new TextEncoder()

const toB64 = (bytes: Uint8Array) => {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/=+$/, '')
}

const fromB64 = (text: string) => {
  const binary = atob(text)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** รหัสผ่านถูกทำให้อยู่ในรูป Unicode เดียวกัน (NFC) ก่อนเสมอ เพื่อให้พิมพ์จากอุปกรณ์ต่างกันแล้วได้ค่าเดียวกัน ไม่ตัดช่องว่าง */
export const normalizePassword = (password: string) => password.normalize('NFC')

/** ความยาวนับเป็นตัวอักษร (code point) หลัง normalize */
export const passwordLength = (password: string) => Array.from(normalizePassword(password)).length

function derive(password: string, salt: Uint8Array, m: number, t: number, p: number, dkLen: number): Uint8Array {
  return argon2id(encoder.encode(normalizePassword(password)), salt, { m, t, p, dkLen })
}

export function hashPassword(password: string): string {
  const salt = crypto.getRandomValues(new Uint8Array(SALT_BYTES))
  const { m, t, p } = ARGON2_PARAMS
  return `$argon2id$v=19$m=${m},t=${t},p=${p}$${toB64(salt)}$${toB64(derive(password, salt, m, t, p, HASH_BYTES))}`
}

const PHC = /^\$argon2id\$v=19\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{11,86})\$([A-Za-z0-9+/]{22,86})$/

export interface VerifyResult {
  ok: boolean
  /** รหัสผ่านถูกต้อง แต่แถวนี้ใช้ค่าที่อ่อนกว่าค่าปัจจุบัน ควรคำนวณใหม่แล้วบันทึกทับ */
  needsRehash: boolean
}

/** ตรวจรหัสผ่านกับค่าที่เก็บไว้ เทียบผลแบบไม่ให้เวลาที่ใช้บอกตำแหน่งที่ต่างกัน */
export function verifyPassword(password: string, stored: string): VerifyResult {
  const match = PHC.exec(stored)
  if (!match) return { ok: false, needsRehash: false }
  const [m, t, p] = [Number(match[1]), Number(match[2]), Number(match[3])]
  if (m < 8 || m > MAX_M || t < 1 || t > MAX_T || p < 1 || p > MAX_P) return { ok: false, needsRehash: false }
  let salt: Uint8Array
  let expected: Uint8Array
  try {
    salt = fromB64(match[4])
    expected = fromB64(match[5])
  } catch {
    return { ok: false, needsRehash: false }
  }
  const actual = derive(password, salt, m, t, p, expected.length)
  let diff = 0
  for (let i = 0; i < expected.length; i++) diff |= expected[i] ^ actual[i]
  const ok = diff === 0
  const current = ARGON2_PARAMS
  return { ok, needsRehash: ok && (m < current.m || t < current.t || p !== current.p || expected.length < HASH_BYTES) }
}

// ค่าที่ใช้ตรวจเมื่อไม่พบบัญชี เพื่อให้คำขอที่รหัสนักศึกษาไม่มีในระบบใช้เวลาเท่ากับคำขอที่รหัสผ่านผิด
// เป็นผลของรหัสผ่านสุ่มที่ไม่มีใครรู้และไม่มีบัญชีใดใช้
const DUMMY_HASH = '$argon2id$v=19$m=19456,t=2,p=1$98siCoV9r6yZiHXoh04xSw$GRHI3kFi9EfXhGI3IhJhrKSPH7JGLfmjVyC7gw569/M'

export function burnVerification(password: string): void {
  verifyPassword(password, DUMMY_HASH)
}
