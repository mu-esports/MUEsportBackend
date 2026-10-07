import { sha256Hex } from './crypto'
import type { AppEnv } from './env'

/**
 * จำกัดการลองเข้าสู่ระบบของสมาชิกที่ server (ไม่อาศัยตัวนับในเบราว์เซอร์)
 * - นับตามรหัสนักศึกษาที่กรอก (ไม่ว่ารหัสนั้นจะมีบัญชีหรือไม่ จึงไม่บอกว่ารหัสใดมีอยู่) และตาม IP ของผู้ขอ
 * - นับก่อนตรวจรหัสผ่านเสมอ คำขอที่ยิงพร้อมกันหลายคำขอจึงผ่านได้ไม่เกินโควตา และคำขอที่ถูกพักไม่เสียแรงคำนวณ hash
 * - เกินโควตา: พัก (cooldown) และยืดเวลาพักเป็นสองเท่าทุกครั้งที่ถูกพักซ้ำ จนกว่าจะเข้าสู่ระบบสำเร็จหรือผู้ดูแลตั้งรหัสใหม่
 * - D1 เก็บเฉพาะ SHA-256 ของรหัสนักศึกษาและ IP ไม่เก็บค่าจริง
 */
const WINDOW_MS = 15 * 60_000
const BASE_LOCK_MS = 15 * 60_000
const MAX_LOCK_MS = 24 * 60 * 60_000
/** จำนวนครั้งที่ลองได้ต่อรหัสนักศึกษาหนึ่งรหัสในหนึ่งช่วงเวลา */
export const ID_ATTEMPTS = 5
/** จำนวนครั้งที่ลองผิดได้ต่อ IP ในหนึ่งช่วงเวลา (สูงกว่า เพราะสมาชิกหลายคนอาจใช้เครือข่ายเดียวกัน) */
export const IP_ATTEMPTS = 30

export const idKey = async (loginId: string) => `id:${await sha256Hex(`login-id:${loginId.trim().toLowerCase()}`)}`
export const ipKey = async (request: Request) => `ip:${await sha256Hex(`login-ip:${request.headers.get('CF-Connecting-IP') ?? 'unknown'}`)}`

interface Row {
  attempts: number
  locked_until: string | null
  strikes: number
}

export type Reservation = { allowed: true } | { allowed: false; retryAfterSeconds: number; newlyLocked: boolean }

async function reserveOne(env: AppEnv, key: string, limit: number, now: number): Promise<Reservation> {
  const stamp = new Date(now).toISOString()
  const windowStart = new Date(now - WINDOW_MS).toISOString()
  // เพิ่มตัวนับแบบ atomic: ช่วงเวลาเดิมหมดแล้วและไม่ได้ถูกพักอยู่ จึงเริ่มนับใหม่
  const row = await env.DB.prepare(
    `INSERT INTO login_throttle (key, attempts, window_started_at, locked_until, strikes, updated_at) VALUES (?1, 1, ?2, NULL, 0, ?2)
     ON CONFLICT (key) DO UPDATE SET
       attempts = CASE WHEN login_throttle.window_started_at <= ?3 AND (login_throttle.locked_until IS NULL OR login_throttle.locked_until <= ?2) THEN 1 ELSE login_throttle.attempts + 1 END,
       window_started_at = CASE WHEN login_throttle.window_started_at <= ?3 AND (login_throttle.locked_until IS NULL OR login_throttle.locked_until <= ?2) THEN ?2 ELSE login_throttle.window_started_at END,
       updated_at = ?2
     RETURNING attempts, locked_until, strikes`,
  )
    .bind(key, stamp, windowStart)
    .first<Row>()
  if (!row) return { allowed: true }
  if (row.locked_until && row.locked_until > stamp) {
    return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil((Date.parse(row.locked_until) - now) / 1000)), newlyLocked: false }
  }
  if (row.attempts <= limit) return { allowed: true }
  const lockMs = Math.min(MAX_LOCK_MS, BASE_LOCK_MS * 2 ** Math.min(row.strikes, 10))
  await env.DB.prepare('UPDATE login_throttle SET locked_until = ?, strikes = strikes + 1, attempts = 0, window_started_at = ?, updated_at = ? WHERE key = ?')
    .bind(new Date(now + lockMs).toISOString(), stamp, stamp, key)
    .run()
  return { allowed: false, retryAfterSeconds: Math.ceil(lockMs / 1000), newlyLocked: true }
}

/** จองสิทธิ์ลองหนึ่งครั้งทั้งตามรหัสนักศึกษาและตาม IP ต้องเรียกก่อนตรวจรหัสผ่านทุกครั้ง */
export async function reserveAttempt(env: AppEnv, loginId: string, request: Request, now = Date.now()): Promise<Reservation> {
  const byIp = await reserveOne(env, await ipKey(request), IP_ATTEMPTS, now)
  if (!byIp.allowed) return byIp
  return reserveOne(env, await idKey(loginId), ID_ATTEMPTS, now)
}

/** เข้าสู่ระบบสำเร็จ: ล้างตัวนับของรหัสนี้ และคืนสิทธิ์ที่จองไว้ของ IP (IP นับเฉพาะครั้งที่ไม่สำเร็จ) */
export async function clearAfterSuccess(env: AppEnv, loginId: string, request: Request): Promise<void> {
  const stale = new Date(Date.now() - 2 * MAX_LOCK_MS).toISOString()
  await env.DB.batch([
    env.DB.prepare('DELETE FROM login_throttle WHERE key = ?').bind(await idKey(loginId)),
    env.DB.prepare('UPDATE login_throttle SET attempts = MAX(attempts - 1, 0) WHERE key = ?').bind(await ipKey(request)),
    // เก็บกวาดแถวเก่าที่ไม่มีการใช้งานแล้ว
    env.DB.prepare('DELETE FROM login_throttle WHERE updated_at < ?').bind(stale),
  ])
}

/** ผู้ดูแลตั้งรหัสผ่านใหม่: ล้างการพักของรหัสนี้ เพื่อให้เจ้าของบัญชีเข้าได้ด้วยรหัสใหม่ทันที */
export const clearLoginId = async (env: AppEnv, loginId: string) => env.DB.prepare('DELETE FROM login_throttle WHERE key = ?').bind(await idKey(loginId))
