import { sha256Hex } from './crypto'
import { nowIso } from './env'
import type { AppEnv } from './env'
import { HttpError } from './http'

export const invalid = (message: string, field?: string) => new HttpError(422, 'validation_failed', message, field ? { field } : {})

/** ข้อความที่ตัดช่องว่างหัวท้ายแล้ว ต้องเป็น string และยาวไม่เกินที่กำหนด */
export function text(body: Record<string, unknown>, field: string, label: string, max: number, required = false): string {
  const raw = body[field]
  if (raw === undefined || raw === null) {
    if (required) throw invalid(`กรอก${label}`, field)
    return ''
  }
  if (typeof raw !== 'string') throw invalid(`${label}ไม่ถูกต้อง`, field)
  const value = raw.trim()
  if (required && !value) throw invalid(`กรอก${label}`, field)
  if (value.length > max) throw invalid(`${label}ยาวได้ไม่เกิน ${max} ตัวอักษร`, field)
  return value
}

/**
 * รหัสนักศึกษา: เก็บเป็นข้อความตามที่กรอก (คงเลขศูนย์นำหน้า) ไม่กำหนดความยาวตายตัว
 * รับตัวเลข อักษรอังกฤษ และ - _ . ระหว่างตัวอักษร ยาว 1–32 ตัว ไม่มีช่องว่าง เทียบซ้ำโดยไม่สนตัวพิมพ์เล็กใหญ่
 */
export const STUDENT_ID_MAX = 32
const STUDENT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/
export const isStudentId = (value: string) => STUDENT_ID_PATTERN.test(value)
export const STUDENT_ID_RULE = 'ใช้ได้เฉพาะตัวเลข ตัวอักษรอังกฤษ และเครื่องหมาย - _ . คั่นกลาง ไม่มีช่องว่าง ยาวไม่เกิน 32 ตัวอักษร'

/** รหัสนักศึกษาจากฟอร์ม: ว่างได้ (ยังไม่ได้กรอก) ถ้ากรอกต้องถูกรูปแบบ */
export function studentIdField(body: Record<string, unknown>, field = 'studentId'): string {
  const raw = body[field]
  if (raw === undefined || raw === null) return ''
  if (typeof raw !== 'string') throw invalid('รหัสนักศึกษาไม่ถูกต้อง', field)
  const value = raw.trim()
  if (value && !isStudentId(value)) throw invalid(`รหัสนักศึกษา${STUDENT_ID_RULE}`, field)
  return value
}

export function oneOf<T extends string>(body: Record<string, unknown>, field: string, label: string, allowed: readonly T[]): T {
  const raw = body[field]
  if (typeof raw !== 'string' || !allowed.includes(raw as T)) throw invalid(`${label}ไม่ถูกต้อง`, field)
  return raw as T
}

export function expectedVersion(body: Record<string, unknown>): number {
  const raw = body.expectedVersion
  if (typeof raw !== 'number' || !Number.isInteger(raw) || raw < 1) {
    throw invalid('ไม่ได้ระบุรุ่นของข้อมูลที่กำลังแก้ไข โหลดหน้าใหม่แล้วลองอีกครั้ง', 'expectedVersion')
  }
  return raw
}

export const versionConflict = (current: unknown) =>
  new HttpError(
    409,
    'version_conflict',
    'ข้อมูลนี้ถูกแก้ไขจากที่อื่นหลังจากที่คุณเปิด ยังไม่ได้บันทึกสิ่งที่คุณแก้ โหลดค่าล่าสุดเพื่อตรวจก่อนบันทึกอีกครั้ง',
    { current },
  )

export function idempotencyKey(request: Request): string {
  const key = request.headers.get('Idempotency-Key') ?? ''
  if (!/^[A-Za-z0-9_-]{16,64}$/.test(key)) {
    throw new HttpError(400, 'idempotency_key_required', 'คำขอไม่ครบถ้วน โหลดหน้าใหม่แล้วลองอีกครั้ง')
  }
  return key
}

/**
 * ตรวจว่า key นี้เคยสร้างรายการไปแล้วหรือยัง
 * คืน resource id เดิมเมื่อเป็นคำขอเดียวกัน (retry) และปฏิเสธเมื่อ key เดิมถูกใช้กับข้อมูลอื่น
 */
export async function findIdempotent(env: AppEnv, userId: string, key: string, operation: string, payloadHash: string): Promise<string | null> {
  const row = await env.DB.prepare('SELECT operation, payload_hash, resource_id FROM idempotency_keys WHERE user_id = ? AND key = ?')
    .bind(userId, key)
    .first<{ operation: string; payload_hash: string; resource_id: string }>()
  if (!row) return null
  if (row.operation !== operation || row.payload_hash !== payloadHash) {
    throw new HttpError(422, 'idempotency_mismatch', 'คำขอนี้ซ้ำกับรายการก่อนหน้าแต่ข้อมูลไม่ตรงกัน โหลดหน้าใหม่แล้วลองอีกครั้ง')
  }
  return row.resource_id
}

export const idempotencyInsert = (env: AppEnv, userId: string, key: string, operation: string, payloadHash: string, resourceId: string) =>
  env.DB.prepare('INSERT INTO idempotency_keys (user_id, key, operation, payload_hash, resource_id, created_at) VALUES (?, ?, ?, ?, ?, ?)').bind(
    userId, key, operation, payloadHash, resourceId, nowIso(),
  )

export const hashPayload = (payload: unknown) => sha256Hex(JSON.stringify(payload))

/** วันที่ปัจจุบันตามเวลา Asia/Bangkok (UTC+7 ไม่มี DST) รูปแบบ YYYY-MM-DD */
export const bangkokToday = () => new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 10)
