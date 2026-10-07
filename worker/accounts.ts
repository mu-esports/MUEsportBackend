import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { burnVerification, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, normalizePassword, passwordLength, verifyPassword } from './password'
import { audit, clearSessionCookie, deleteSession, newMemberSession, requireMember, requireMemberMutation, requireMutation, requireOwnSessionMutation } from './session'
import { updateMemberRow } from './sheets'
import type { SheetConfig } from './sheets'
import { loadResource } from './sync'
import { clearAfterSuccess, clearLoginId, reserveAttempt } from './throttle'
import type { Reservation } from './throttle'
import { bangkokToday, expectedVersion, invalid, text } from './validation'

/**
 * บัญชีเข้าสู่ระบบของสมาชิก (รหัสนักศึกษา + รหัสผ่าน)
 * - ตัวตนของบัญชีคือ member ID ที่เสถียร: เปลี่ยนชื่อ ชื่อเล่น รหัสนักศึกษา หรือเรียงชีตใหม่ ไม่ทำให้บัญชีย้ายไปเป็นของสมาชิกคนอื่น
 * - login_id คือรหัสนักศึกษา ณ ตอนที่ผู้ดูแลเปิดบัญชี รหัสในทะเบียนที่เปลี่ยนภายหลัง (จากเว็บหรือจากชีต) ไม่เปลี่ยน login_id เอง
 *   ผู้ดูแลต้องยืนยันก่อน และระหว่างนั้นสมาชิกยังเข้าสู่ระบบด้วยรหัสเดิม
 * - เปิดบัญชี ตั้ง/รีเซ็ตรหัสผ่าน ปิดบัญชี และยืนยันการเปลี่ยนรหัสเข้าสู่ระบบ ทำได้เฉพาะผู้ดูแล (ทีมงานที่เข้าสู่ระบบด้วย Google และมีสิทธิ์ admin)
 *   บทบาทในทะเบียนสมาชิกไม่เกี่ยวข้อง
 * - รหัสผ่านอยู่ใน D1 เป็นผลของ Argon2id เท่านั้น ไม่มีคำตอบใดของ API ส่ง hash หรือรหัสผ่านกลับ และไม่มีการเขียนลง Google
 */
export interface MemberAccountRow {
  id: string
  name: string
  nickname: string
  role: string
  status: string
  contact: string
  note: string
  added_at: string
  version: number
  created_at: string
  updated_at: string
  source: string
  source_state: string
  student_id: string
  student_id_issue: string
  student_id_claimed: string
  account_login_id: string | null
  account_status: 'active' | 'disabled' | null
  account_must_change: number | null
  account_password_set_at: string | null
  account_last_login_at: string | null
}

// เลือกเฉพาะคอลัมน์สถานะของบัญชี ไม่ดึง password_hash ออกมากับรายชื่อสมาชิก
export const MEMBER_WITH_ACCOUNT = `
  SELECT m.*, a.login_id AS account_login_id, a.status AS account_status, a.must_change_password AS account_must_change,
         a.password_set_at AS account_password_set_at, a.last_login_at AS account_last_login_at
    FROM members m LEFT JOIN member_accounts a ON a.member_id = m.id`

export type AccountState = 'none' | 'must_change' | 'active' | 'disabled'

export function accountSummary(row: MemberAccountRow) {
  const state: AccountState = !row.account_status ? 'none' : row.account_status === 'disabled' ? 'disabled' : row.account_must_change === 1 ? 'must_change' : 'active'
  // เหตุผลที่ยังเปิดบัญชีหรือตั้งรหัสผ่านไม่ได้ (null = ทำได้)
  let blocked: null | 'suspended' | 'no_student_id' | 'student_id_conflict' = null
  if (row.status !== 'active') blocked = 'suspended'
  else if (state === 'none' && !row.student_id) blocked = row.student_id_issue ? 'student_id_conflict' : 'no_student_id'
  else if (state === 'none' && row.student_id_issue) blocked = 'student_id_conflict'
  return {
    state,
    /** รหัสนักศึกษาที่บัญชีใช้เข้าสู่ระบบ */
    loginId: row.account_login_id,
    /** รหัสนักศึกษาในทะเบียนไม่ตรงกับรหัสที่บัญชีใช้อยู่: รอผู้ดูแลยืนยันก่อนเปลี่ยน */
    loginMismatch: row.account_login_id !== null && row.account_login_id.toLowerCase() !== row.student_id.toLowerCase(),
    passwordSetAt: row.account_password_set_at,
    lastLoginAt: row.account_last_login_at,
    blocked,
  }
}

const getMember = (env: AppEnv, id: string) => env.DB.prepare(`${MEMBER_WITH_ACCOUNT} WHERE m.id = ?`).bind(id).first<MemberAccountRow>()

const memberNotFound = () => new HttpError(404, 'not_found', 'ไม่พบสมาชิกนี้ อาจถูกลบหรือลิงก์ไม่ถูกต้อง')
const noAccount = () => new HttpError(404, 'no_account', 'สมาชิกนี้ยังไม่ได้เปิดบัญชี')

/** ตรวจรหัสผ่านที่ตั้งใหม่: ความยาว และต้องไม่ใช่รหัสนักศึกษาของตัวเอง ไม่บังคับรูปแบบตัวอักษร */
function newPassword(body: Record<string, unknown>, field: string, label: string, forbidden: string[]): string {
  const raw = body[field]
  if (typeof raw !== 'string' || raw === '') throw invalid(`กรอก${label}`, field)
  const length = passwordLength(raw)
  if (length < MIN_PASSWORD_LENGTH) throw invalid(`${label}ต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`, field)
  if (length > MAX_PASSWORD_LENGTH) throw invalid(`${label}ยาวได้ไม่เกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`, field)
  const value = normalizePassword(raw).trim().toLowerCase()
  if (forbidden.some((item) => item && item.trim().toLowerCase() === value)) throw invalid(`${label}ต้องไม่ใช่รหัสนักศึกษา`, field)
  return raw
}

// ---------- ผู้ดูแล: เปิดบัญชี ตั้ง/รีเซ็ตรหัสผ่าน ปิดบัญชี ยืนยันรหัสเข้าสู่ระบบ ----------

const revokeSessions = (env: AppEnv, memberId: string) => env.DB.prepare('DELETE FROM member_sessions WHERE member_id = ?').bind(memberId)

/**
 * POST /api/members/:id/account/password — เปิดบัญชี (ครั้งแรก) หรือรีเซ็ตรหัสผ่าน/เปิดบัญชีที่ปิดไว้อีกครั้ง
 * รหัสที่ตั้งเป็นรหัสชั่วคราวเสมอ: สมาชิกต้องเปลี่ยนเองก่อนใช้งาน และ session เดิมทั้งหมดของสมาชิกถูกยกเลิก
 */
async function setPassword(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request, 4096)
  const member = await getMember(ctx.env, memberId)
  if (!member) throw memberNotFound()
  if (member.status !== 'active') {
    throw new HttpError(409, 'member_suspended', 'สมาชิกนี้ถูกพักการใช้งาน จึงยังเปิดบัญชีหรือตั้งรหัสผ่านไม่ได้ เปิดใช้งานสมาชิกก่อน')
  }
  const loginId = member.account_login_id ?? member.student_id
  if (!member.account_login_id) {
    if (member.student_id_issue) {
      throw new HttpError(409, 'student_id_conflict', 'รหัสนักศึกษาของสมาชิกนี้ในชีตซ้ำกับคนอื่นหรือผิดรูปแบบ จึงยังเปิดบัญชีไม่ได้ แก้รหัสในชีตให้ถูกต้องและไม่ซ้ำก่อน')
    }
    if (!member.student_id) {
      throw new HttpError(409, 'student_id_required', 'สมาชิกนี้ยังไม่มีรหัสนักศึกษา จึงเปิดบัญชีไม่ได้ กรอกรหัสนักศึกษาในข้อมูลสมาชิกก่อน')
    }
  }
  // ผู้ดูแลต้องยืนยันรหัสนักศึกษาที่เห็นในกล่องตั้งรหัส: ถ้าเปลี่ยนไประหว่างนั้น จะไม่ตั้งรหัสให้ตัวตนที่ไม่ได้ตรวจ
  if (typeof body.studentId !== 'string' || body.studentId.trim().toLowerCase() !== loginId.toLowerCase()) {
    throw new HttpError(409, 'student_id_changed', 'รหัสนักศึกษาของสมาชิกนี้ไม่ตรงกับที่แสดงในกล่องนี้แล้ว ยังไม่ได้ตั้งรหัสผ่าน ปิดกล่องนี้แล้วเปิดใหม่เพื่อตรวจข้อมูลล่าสุด')
  }
  const password = newPassword(body, 'password', 'รหัสผ่านชั่วคราว', [loginId, member.student_id])

  if (!member.account_login_id) {
    const holder = await ctx.env.DB.prepare('SELECT m.name FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE a.login_id = ?').bind(loginId).first<{ name: string }>()
    if (holder) {
      throw new HttpError(409, 'login_id_taken', `รหัสนักศึกษานี้ยังเป็นรหัสเข้าสู่ระบบของบัญชีสมาชิกอีกคน (${holder.name}) จึงเปิดบัญชีไม่ได้ ยืนยันการเปลี่ยนรหัสเข้าสู่ระบบหรือปิดบัญชีของสมาชิกคนนั้นก่อน`)
    }
  }

  const hash = hashPassword(password)
  const now = nowIso()
  const action = !member.account_login_id ? 'member_account.opened' : member.account_status === 'disabled' ? 'member_account.reopened' : 'member_account.password_reset'
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO member_accounts (member_id, login_id, password_hash, status, must_change_password, password_set_at, password_set_by, created_by, created_at, updated_at)
         VALUES (?, ?, ?, 'active', 1, ?, ?, ?, ?, ?)
         ON CONFLICT (member_id) DO UPDATE SET password_hash = excluded.password_hash, status = 'active', must_change_password = 1,
           password_set_at = excluded.password_set_at, password_set_by = excluded.password_set_by, disabled_at = NULL, updated_at = excluded.updated_at`,
      ).bind(memberId, loginId, hash, now, session.user.id, session.user.id, now, now),
      revokeSessions(ctx.env, memberId),
      await clearLoginId(ctx.env, loginId),
    ])
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new HttpError(409, 'login_id_taken', 'รหัสนักศึกษานี้เพิ่งถูกใช้เปิดบัญชีของสมาชิกอีกคน ยังไม่ได้เปิดบัญชีนี้ โหลดรายการใหม่เพื่อตรวจ')
    }
    throw error
  }
  // บันทึกเฉพาะว่าใครทำอะไรกับบัญชีใด ไม่มีรหัสผ่านหรือ hash
  await audit(ctx.env, session.user.id, action, memberId)
  return json({ account: accountSummary((await getMember(ctx.env, memberId))!) }, action === 'member_account.opened' ? 201 : 200)
}

/** POST /api/members/:id/account/disable — ปิดบัญชี: เข้าสู่ระบบไม่ได้ และ session ที่มีอยู่ถูกยกเลิกทันที ข้อมูลสมาชิกไม่ถูกลบ */
async function disableAccount(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const member = await getMember(ctx.env, memberId)
  if (!member) throw memberNotFound()
  if (!member.account_login_id) throw noAccount()
  const now = nowIso()
  const results = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE member_accounts SET status = 'disabled', disabled_at = ?, updated_at = ? WHERE member_id = ? AND status = 'active'`).bind(now, now, memberId),
    revokeSessions(ctx.env, memberId),
  ])
  if (results[0].meta.changes === 1) await audit(ctx.env, session.user.id, 'member_account.disabled', memberId)
  return json({ account: accountSummary((await getMember(ctx.env, memberId))!) })
}

/**
 * POST /api/members/:id/account/login-id — ผู้ดูแลยืนยันให้บัญชีใช้รหัสนักศึกษาปัจจุบันในทะเบียนเป็นรหัสเข้าสู่ระบบ
 * ใช้เมื่อรหัสนักศึกษาถูกแก้หลังเปิดบัญชี (จากเว็บหรือจากชีต) บัญชียังเป็นของสมาชิกคนเดิม เปลี่ยนเฉพาะรหัสที่ใช้เข้าสู่ระบบ
 */
async function confirmLoginId(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request)
  const member = await getMember(ctx.env, memberId)
  if (!member) throw memberNotFound()
  if (!member.account_login_id) throw noAccount()
  if (member.student_id_issue || !member.student_id) {
    throw new HttpError(409, 'student_id_conflict', 'รหัสนักศึกษาในทะเบียนของสมาชิกนี้ยังว่าง ซ้ำ หรือผิดรูปแบบ จึงเปลี่ยนรหัสเข้าสู่ระบบไม่ได้ แก้รหัสในทะเบียนให้ถูกต้องก่อน')
  }
  // ผู้ดูแลยืนยันค่าที่เห็นบนหน้าจอ: ถ้าทะเบียนเปลี่ยนอีกครั้งระหว่างนั้นจะไม่ใช้ค่าที่ยังไม่ได้ตรวจ
  if (typeof body.studentId !== 'string' || body.studentId.trim() !== member.student_id) {
    throw new HttpError(409, 'student_id_changed', 'รหัสนักศึกษาในทะเบียนไม่ตรงกับที่แสดงแล้ว ยังไม่ได้เปลี่ยนรหัสเข้าสู่ระบบ โหลดรายการใหม่เพื่อตรวจ')
  }
  if (member.account_login_id === member.student_id) return json({ account: accountSummary(member) })
  try {
    await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE member_accounts SET login_id = ?, updated_at = ? WHERE member_id = ?').bind(member.student_id, nowIso(), memberId),
      // สมาชิกต้องเข้าสู่ระบบใหม่ด้วยรหัสนักศึกษาใหม่
      revokeSessions(ctx.env, memberId),
    ])
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new HttpError(409, 'login_id_taken', 'รหัสนักศึกษานี้ยังเป็นรหัสเข้าสู่ระบบของบัญชีสมาชิกอีกคน ยังไม่ได้เปลี่ยน ตรวจบัญชีของสมาชิกคนนั้นก่อน')
    }
    throw error
  }
  await audit(ctx.env, session.user.id, 'member_account.login_id_changed', memberId)
  return json({ account: accountSummary((await getMember(ctx.env, memberId))!) })
}

export async function handleMemberAccount(ctx: Ctx, memberId: string, action: string): Promise<Response | null> {
  if (ctx.request.method !== 'POST') return null
  if (action === 'password') return setPassword(ctx, memberId)
  if (action === 'disable') return disableAccount(ctx, memberId)
  if (action === 'login-id') return confirmLoginId(ctx, memberId)
  return null
}

// ---------- สมาชิก: เข้าสู่ระบบ ----------

const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'รหัสนักศึกษาหรือรหัสผ่านไม่ถูกต้อง ถ้าลืมรหัสผ่านให้ติดต่อทีมงานเพื่อตั้งรหัสใหม่')

async function tooMany(env: AppEnv, reserved: Extract<Reservation, { allowed: false }>): Promise<HttpError> {
  // บันทึกว่ามีการพักเกิดขึ้น โดยไม่ระบุรหัสนักศึกษาหรือ IP
  if (reserved.newlyLocked) await audit(env, null, 'member.login_locked')
  const minutes = Math.max(1, Math.ceil(reserved.retryAfterSeconds / 60))
  return new HttpError(429, 'too_many_attempts', `ลองเข้าสู่ระบบหลายครั้งเกินไป รอประมาณ ${minutes} นาทีแล้วลองใหม่ ถ้าลืมรหัสผ่านให้ติดต่อทีมงานเพื่อตั้งรหัสใหม่`, {
    retryAfterSeconds: reserved.retryAfterSeconds,
  })
}

interface LoginRow {
  member_id: string
  login_id: string
  password_hash: string
  status: string
  must_change_password: number
  member_status: string
}

/**
 * POST /auth/member/login — เข้าสู่ระบบด้วยรหัสนักศึกษาและรหัสผ่าน
 * - คำตอบเมื่อไม่สำเร็จเหมือนกันทั้งกรณีไม่มีบัญชีและรหัสผ่านผิด และใช้เวลาคำนวณเท่ากัน
 * - จำกัดจำนวนครั้งก่อนคำนวณ hash เสมอ
 * - สำเร็จ: ออก session ใหม่ทุกครั้ง และยกเลิก session เดิมที่เบราว์เซอร์นี้ถืออยู่ (ถ้ามี)
 */
export async function memberLogin(ctx: Ctx): Promise<Response> {
  const { env, request } = ctx
  if (request.headers.get('Origin') !== ctx.url.origin) throw new HttpError(403, 'bad_origin', 'คำขอนี้ไม่ได้มาจากหน้าเว็บของระบบ')
  const body = await readJson(request, 4096)
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  const password = typeof body.password === 'string' ? body.password : ''
  if (!studentId) throw invalid('กรอกรหัสนักศึกษา', 'studentId')
  if (!password) throw invalid('กรอกรหัสผ่าน', 'password')
  // ค่าที่ยาวเกินขอบเขตไม่มีทางตรงกับบัญชีใด: ตอบเหมือนรหัสผิดโดยไม่เสียแรงคำนวณ
  if (studentId.length > 64 || passwordLength(password) > MAX_PASSWORD_LENGTH) throw invalidCredentials()

  const reserved = await reserveAttempt(env, studentId, request)
  if (!reserved.allowed) throw await tooMany(env, reserved)

  const row = await env.DB.prepare(
    `SELECT a.member_id, a.login_id, a.password_hash, a.status, a.must_change_password, m.status AS member_status
       FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE a.login_id = ?`,
  )
    .bind(studentId)
    .first<LoginRow>()
  if (!row) {
    burnVerification(password)
    throw invalidCredentials()
  }
  const checked = verifyPassword(password, row.password_hash)
  if (!checked.ok) throw invalidCredentials()
  // บอกสถานะบัญชีเฉพาะกับผู้ที่พิสูจน์แล้วว่ารู้รหัสผ่าน
  if (row.status !== 'active' || row.member_status !== 'active') {
    throw new HttpError(403, 'account_disabled', 'บัญชีนี้ถูกปิดหรือสมาชิกถูกพักการใช้งาน จึงเข้าสู่ระบบไม่ได้ ติดต่อทีมงาน')
  }

  const now = nowIso()
  const fresh = await newMemberSession(env, row.member_id, ctx.url)
  const statements = [
    fresh.insert,
    env.DB.prepare('UPDATE member_accounts SET last_login_at = ?, updated_at = ? WHERE member_id = ?').bind(now, now, row.member_id),
    env.DB.prepare('DELETE FROM member_sessions WHERE expires_at <= ?').bind(now),
  ]
  // ค่า Argon2id ที่เก็บไว้อ่อนกว่าค่าปัจจุบัน: คำนวณใหม่ด้วยค่าปัจจุบันตอนที่รู้รหัสผ่านจริง
  if (checked.needsRehash) statements.push(env.DB.prepare('UPDATE member_accounts SET password_hash = ? WHERE member_id = ?').bind(hashPassword(password), row.member_id))
  await env.DB.batch(statements)
  if (ctx.session) await deleteSession(env, ctx.session)
  await clearAfterSuccess(env, studentId, request)
  return json({ ok: true, mustChangePassword: row.must_change_password === 1 }, 200, { 'Set-Cookie': fresh.cookie })
}

/** POST /auth/logout — ออกจากระบบของ session นี้ (ทีมงานหรือสมาชิก) ไม่กระทบการเชื่อม Google ของชมรม */
export async function logout(ctx: Ctx): Promise<Response> {
  const session = await requireOwnSessionMutation(ctx)
  await deleteSession(ctx.env, session)
  return json({ ok: true }, 200, { 'Set-Cookie': clearSessionCookie(ctx.url) })
}

// ---------- สมาชิก: ข้อมูลตนเอง ----------
//
// ทุกเส้นทางในส่วนนี้อ่านและเขียนเฉพาะแถวของ member ID ที่ผูกกับ session เท่านั้น ไม่รับรหัสสมาชิกจากคำขอ จึงไม่มีทางระบุเป็นคนอื่นได้

interface SelfRow extends MemberAccountRow {
  account_password_set_by: string | null
}

const getSelf = (env: AppEnv, id: string) =>
  env.DB.prepare(`SELECT m.*, a.login_id AS account_login_id, a.status AS account_status, a.must_change_password AS account_must_change,
                         a.password_set_at AS account_password_set_at, a.last_login_at AS account_last_login_at, a.password_set_by AS account_password_set_by
                    FROM members m JOIN member_accounts a ON a.member_id = m.id WHERE m.id = ?`).bind(id).first<SelfRow>()

/** ช่องทางติดต่อของสมาชิกที่เป็นสำเนาจากชีต แก้ได้เมื่อเว็บเขียนชีตได้และชีตมีคอลัมน์ช่องทางติดต่อ */
async function contactEditable(env: AppEnv, row: MemberAccountRow): Promise<boolean> {
  if (row.source !== 'sheets') return true
  const sheet = await loadResource(env, 'sheets')
  if (!sheet) return true
  return row.source_state !== 'missing' && sheet.access === 'write' && !!(sheet.config as unknown as SheetConfig).columns?.contact
}

/** สิ่งที่สมาชิกเห็นเกี่ยวกับตัวเอง: ไม่มีหมายเหตุของทีมงาน บทบาท แหล่งข้อมูล หรือข้อมูลของสมาชิกคนอื่น */
const selfView = async (env: AppEnv, row: SelfRow) => ({
  name: row.name,
  nickname: row.nickname,
  studentId: row.student_id,
  /** รหัสที่ใช้เข้าสู่ระบบ (ต่างจากรหัสในทะเบียนได้ชั่วคราวระหว่างรอผู้ดูแลยืนยัน) */
  loginId: row.account_login_id,
  status: row.status,
  contact: row.contact,
  version: row.version,
  contactEditable: await contactEditable(env, row),
  passwordChangedAt: row.account_password_set_by === null ? row.account_password_set_at : null,
})

async function me(ctx: Ctx): Promise<Response> {
  const session = requireMember(ctx)
  const row = await getSelf(ctx.env, session.member.id)
  if (!row) throw new HttpError(401, 'unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว')
  return json({ member: await selfView(ctx.env, row) })
}

const contactLocked = () =>
  new HttpError(409, 'contact_not_editable', 'ตอนนี้แก้ช่องทางติดต่อจากหน้านี้ไม่ได้ ยังไม่ได้บันทึก ติดต่อทีมงานให้แก้ให้')

/** PATCH /api/member/me — สมาชิกแก้ได้เฉพาะช่องทางติดต่อของตัวเอง ชื่อ รหัสนักศึกษา บทบาท และสถานะแก้ได้โดยทีมงานเท่านั้น */
async function updateMe(ctx: Ctx): Promise<Response> {
  const session = await requireMemberMutation(ctx)
  const body = await readJson(ctx.request, 4096)
  const contact = text(body, 'contact', 'ช่องทางติดต่อ', 200)
  const version = expectedVersion(body)
  const id = session.member.id
  const current = await getSelf(ctx.env, id)
  if (!current) throw new HttpError(401, 'unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว')
  const stale = () => new HttpError(409, 'version_conflict', 'ข้อมูลของคุณถูกแก้ไขจากที่อื่นหลังจากที่เปิดหน้านี้ ยังไม่ได้บันทึก โหลดข้อมูลล่าสุดแล้วลองอีกครั้ง')

  const sheet = current.source === 'sheets' ? await loadResource(ctx.env, 'sheets') : null
  if (sheet) {
    if (!(await contactEditable(ctx.env, current))) throw contactLocked()
    try {
      // สำเนาจากชีต: เขียนเฉพาะช่องช่องทางติดต่อของแถวตัวเองลงชีต (แหล่งหลัก) ด้วยขั้นตอนเดียวกับที่ทีมงานแก้
      await updateMemberRow(ctx.env, sheet, id, { contact }, version)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
      // ข้อผิดพลาดของฝั่งทีมงานอาจมีข้อมูลทั้งแถว (รวมหมายเหตุ) จึงไม่ส่งต่อให้สมาชิกตรง ๆ
      if (error.code === 'version_conflict') throw stale()
      if (['source_read_only', 'column_not_mapped', 'source_missing', 'source_row_invalid', 'cell_is_formula', 'not_found'].includes(error.code)) throw contactLocked()
      throw new HttpError(error.status, error.code, 'บันทึกช่องทางติดต่อไม่สำเร็จ ลองอีกครั้งในอีกสักครู่ ถ้ายังไม่ได้ให้ติดต่อทีมงาน')
    }
  } else {
    const result = await ctx.env.DB.prepare('UPDATE members SET contact = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?')
      .bind(contact, `member:${id}`, nowIso(), id, version)
      .run()
    if (result.meta.changes !== 1) throw stale()
  }
  // บันทึกว่าสมาชิกแก้ข้อมูลตนเอง โดยไม่เก็บช่องทางติดต่อ
  await audit(ctx.env, null, 'member.self_contact_updated', id)
  return json({ member: await selfView(ctx.env, (await getSelf(ctx.env, id))!) })
}

/**
 * POST /api/member/password — สมาชิกเปลี่ยนรหัสผ่านของตัวเอง (รวมถึงการเปลี่ยนรหัสชั่วคราวครั้งแรก)
 * สำเร็จแล้ว session เดิมทั้งหมดของบัญชีถูกยกเลิก และเบราว์เซอร์นี้ได้ session ใหม่
 */
async function changePassword(ctx: Ctx): Promise<Response> {
  const session = await requireMemberMutation(ctx, { allowPasswordChange: true })
  const body = await readJson(ctx.request, 4096)
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  if (!current) throw invalid('กรอกรหัสผ่านปัจจุบัน', 'currentPassword')
  const id = session.member.id
  const account = await ctx.env.DB.prepare('SELECT a.login_id, a.password_hash, m.student_id FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE a.member_id = ?')
    .bind(id)
    .first<{ login_id: string; password_hash: string; student_id: string }>()
  if (!account) throw new HttpError(401, 'unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว')
  const next = newPassword(body, 'newPassword', 'รหัสผ่านใหม่', [account.login_id, account.student_id])
  if (normalizePassword(next) === normalizePassword(current)) throw invalid('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน', 'newPassword')

  // การเดารหัสผ่านปัจจุบันผ่าน session ที่ถูกขโมยถูกจำกัดด้วยตัวนับเดียวกับการเข้าสู่ระบบ
  const reserved = await reserveAttempt(ctx.env, account.login_id, ctx.request)
  if (!reserved.allowed) throw await tooMany(ctx.env, reserved)
  if (passwordLength(current) > MAX_PASSWORD_LENGTH || !verifyPassword(current, account.password_hash).ok) {
    throw new HttpError(403, 'wrong_password', 'รหัสผ่านปัจจุบันไม่ถูกต้อง ยังไม่ได้เปลี่ยนรหัสผ่าน', { field: 'currentPassword' })
  }

  const hash = hashPassword(next)
  const now = nowIso()
  const fresh = await newMemberSession(ctx.env, id, ctx.url)
  await ctx.env.DB.batch([
    ctx.env.DB.prepare('UPDATE member_accounts SET password_hash = ?, must_change_password = 0, password_set_at = ?, password_set_by = NULL, updated_at = ? WHERE member_id = ?').bind(hash, now, now, id),
    revokeSessions(ctx.env, id),
    fresh.insert,
  ])
  await clearAfterSuccess(ctx.env, account.login_id, ctx.request)
  await audit(ctx.env, null, 'member_account.password_changed', id)
  return json({ ok: true, csrfToken: fresh.csrfToken }, 200, { 'Set-Cookie': fresh.cookie })
}

// ---------- สมาชิก: กิจกรรมของชมรม (อ่านอย่างเดียว) ----------

interface EventRow {
  id: string
  title: string
  all_day: number
  start_at: string
  end_at: string
  location: string
  description: string
}

/** กำหนดการที่ยังไม่จบ และที่จบไปไม่เกิน 30 วัน เฉพาะข้อมูลที่ใช้แสดง ไม่มีข้อมูลการแก้ไขหรือลิงก์จัดการ */
async function events(ctx: Ctx): Promise<Response> {
  requireMember(ctx)
  const since = new Date(Date.parse(`${bangkokToday()}T00:00:00Z`) - 30 * 24 * 60 * 60 * 1000).toISOString().slice(0, 10)
  const { results } = await ctx.env.DB.prepare(
    `SELECT id, title, all_day, start_at, end_at, location, description FROM events WHERE source_state = 'ok' AND end_at >= ? ORDER BY start_at, title LIMIT 400`,
  )
    .bind(`${since}T00:00`)
    .all<EventRow>()
  return json({
    events: results.map((row) => ({
      id: row.id, title: row.title, allDay: row.all_day === 1, start: row.start_at, end: row.end_at, location: row.location, description: row.description,
    })),
  })
}

export async function handleMemberSelf(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length !== 1) return null
  if (parts[0] === 'me' && method === 'GET') return me(ctx)
  if (parts[0] === 'me' && method === 'PATCH') return updateMe(ctx)
  if (parts[0] === 'password' && method === 'POST') return changePassword(ctx)
  if (parts[0] === 'events' && method === 'GET') return events(ctx)
  return null
}
