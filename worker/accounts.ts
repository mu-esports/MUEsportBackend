import { randomToken } from './crypto'
import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { burnVerification, hashPassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH, normalizePassword, passwordLength, verifyPassword } from './password'
import { audit, clearSessionCookie, deleteSession, newMemberSession, requireMember, requireMemberMutation, requireMutation, requireOwnSessionMutation, requireUser } from './session'
import { updateMemberRow } from './sheets'
import type { SheetConfig } from './sheets'
import { loadResource } from './sync'
import { clearAfterSuccess, clearLoginId, reserveAttempt, reserveChallenge } from './throttle'
import { dummyChallenge, readMaterial, storedPassword, storeMaterial, verifyMaterial, wrapLegacy } from './password-relief'
import type { Reservation } from './throttle'
import { bangkokToday, expectedVersion, invalid, text } from './validation'
import { normalizeStudentId, studentIdAliases, studentIdKey } from '../src/lib/student-id'
import { memberNews } from './news'
import { monthGrid } from '../src/lib/datetime'

/**
 * บัญชีเข้าสู่ระบบของสมาชิก (รหัสนักศึกษา + รหัสผ่าน)
 * - ตัวตนของบัญชีคือ member ID ที่เสถียร: เปลี่ยนชื่อ ชื่อเล่น รหัสนักศึกษา หรือเรียงชีตใหม่ ไม่ทำให้บัญชีย้ายไปเป็นของสมาชิกคนอื่น
 * - login_id คือรหัสนักศึกษา ณ ตอนที่ผู้ดูแลเปิดบัญชี รหัสในทะเบียนที่เปลี่ยนภายหลัง (จากเว็บหรือจากชีต) ไม่เปลี่ยน login_id เอง
 *   ผู้ดูแลต้องยืนยันก่อน และระหว่างนั้นสมาชิกยังเข้าสู่ระบบด้วยรหัสเดิม
 * - เปิดบัญชี ตั้ง/รีเซ็ตรหัสผ่าน ปิดบัญชี และยืนยันการเปลี่ยนรหัสเข้าสู่ระบบ ทำได้เฉพาะผู้ดูแล (ทีมงานที่เข้าสู่ระบบด้วย Google และมีสิทธิ์ admin)
 *   บทบาทในทะเบียนสมาชิกไม่เกี่ยวข้อง
 * - D1 เก็บ HMAC ของผล Argon2id ที่คำนวณฝั่ง client ไม่มี API ส่ง verifier/รหัสผ่านกลับ และไม่มีการเขียนลง Google
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
  /** รุ่นของบัญชี (ค่าสุ่ม เปลี่ยนเมื่อบัญชีถูกตั้งรหัสใหม่ ปิด เปลี่ยนรหัสเข้าสู่ระบบ หรือสร้างใหม่) */
  account_revision: string | null
  /** รุ่นของรูปโปรไฟล์ (null = ไม่มีรูป) ตัวรูปไม่ถูกอ่านมากับรายชื่อ */
  profile_email?: string | null
  profile_contacts?: string | null
  profile_version?: number | null
  photo_version: string | null
  /** โปรไฟล์นักกีฬาของคนนี้ (null = ไม่ได้เป็นนักกีฬา) */
  athlete_game: string | null
  athlete_status: 'active' | 'inactive' | null
}

// เลือกเฉพาะคอลัมน์สถานะของบัญชี ไม่ดึง password_hash ออกมากับรายชื่อสมาชิก และไม่ดึงข้อมูลรูป (เฉพาะรุ่นของรูป)
export const MEMBER_WITH_ACCOUNT = `
  SELECT m.*, a.login_id AS account_login_id, a.status AS account_status, a.must_change_password AS account_must_change,
         a.password_set_at AS account_password_set_at, a.last_login_at AS account_last_login_at, a.revision AS account_revision,
         pr.email AS profile_email, pr.contacts_json AS profile_contacts, pr.version AS profile_version, p.version AS photo_version, t.game AS athlete_game, t.status AS athlete_status
    FROM members m LEFT JOIN member_accounts a ON a.member_id = m.id
    LEFT JOIN member_photos p ON p.member_id = m.id
    LEFT JOIN athletes t ON t.member_id = m.id LEFT JOIN member_profiles pr ON pr.member_id=m.id`

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
    loginMismatch: row.account_login_id !== null && studentIdKey(row.account_login_id) !== studentIdKey(row.student_id),
    passwordSetAt: row.account_password_set_at,
    lastLoginAt: row.account_last_login_at,
    blocked,
    /** รุ่นของบัญชีที่กำลังแสดง: คำสั่งลบบัญชีต้องส่งค่านี้กลับมา (null = ยังไม่มีบัญชี) */
    revision: row.account_login_id === null ? null : (row.account_revision ?? ''),
  }
}

/** ค่ารุ่นใหม่ของบัญชี: สุ่มทุกครั้ง จึงไม่ซ้ำกับรุ่นของบัญชีเดิมที่ถูกลบไปแล้ว */
const newRevision = () => randomToken(12)

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
  const loginId = member.account_login_id ?? normalizeStudentId(member.student_id)
  const aliases = studentIdAliases(loginId)
  if (!member.account_login_id) {
    if (member.student_id_issue) {
      throw new HttpError(409, 'student_id_conflict', 'รหัสนักศึกษาของสมาชิกนี้ในชีตซ้ำกับคนอื่นหรือผิดรูปแบบ จึงยังเปิดบัญชีไม่ได้ แก้รหัสในชีตให้ถูกต้องและไม่ซ้ำก่อน')
    }
    if (!member.student_id) {
      throw new HttpError(409, 'student_id_required', 'สมาชิกนี้ยังไม่มีรหัสนักศึกษา จึงเปิดบัญชีไม่ได้ กรอกรหัสนักศึกษาในข้อมูลสมาชิกก่อน')
    }
  }
  // ผู้ดูแลต้องยืนยันรหัสนักศึกษาที่เห็นในกล่องตั้งรหัส: ถ้าเปลี่ยนไประหว่างนั้น จะไม่ตั้งรหัสให้ตัวตนที่ไม่ได้ตรวจ
  if (typeof body.studentId !== 'string' || studentIdKey(body.studentId) !== studentIdKey(loginId)) {
    throw new HttpError(409, 'student_id_changed', 'รหัสนักศึกษาของสมาชิกนี้ไม่ตรงกับที่แสดงในกล่องนี้แล้ว ยังไม่ได้ตั้งรหัสผ่าน ปิดกล่องนี้แล้วเปิดใหม่เพื่อตรวจข้อมูลล่าสุด')
  }
  const password = newPassword(body, 'password', 'รหัสผ่านชั่วคราว', [loginId, member.student_id])

  {
    const holder = await ctx.env.DB.prepare('SELECT m.name FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE a.login_id IN (?, ?) AND a.member_id <> ?').bind(...aliases, memberId).first<{ name: string }>()
    if (holder) {
      throw new HttpError(409, 'login_id_taken', `รหัสนักศึกษานี้ยังเป็นรหัสเข้าสู่ระบบของบัญชีสมาชิกอีกคน (${holder.name}) จึงเปิดบัญชีไม่ได้ ยืนยันการเปลี่ยนรหัสเข้าสู่ระบบหรือปิดบัญชีของสมาชิกคนนั้นก่อน`)
    }
  }

  const proof = readMaterial(body.passwordProof, true)
  if (!proof && ctx.env.PASSWORD_HASH_MODE !== 'server-test') throw invalid('เตรียมรหัสผ่านไม่สำเร็จ กรุณาปิดกล่องแล้วลองใหม่', 'password')
  const hash = proof ? await storeMaterial(ctx.env, memberId, proof) : hashPassword(password)
  const now = nowIso()
  const action = !member.account_login_id ? 'member_account.opened' : member.account_status === 'disabled' ? 'member_account.reopened' : 'member_account.password_reset'
  try {
    const results = await ctx.env.DB.batch([
      ctx.env.DB.prepare(
        `INSERT INTO member_accounts (member_id, login_id, password_hash, status, must_change_password, password_set_at, password_set_by, created_by, created_at, updated_at, revision)
         SELECT ?, ?, ?, 'active', 1, ?, ?, ?, ?, ?, ?
         WHERE NOT EXISTS (SELECT 1 FROM member_accounts WHERE login_id IN (?, ?) AND member_id <> ?)
         ON CONFLICT (member_id) DO UPDATE SET password_hash = excluded.password_hash, status = 'active', must_change_password = 1,
           password_set_at = excluded.password_set_at, password_set_by = excluded.password_set_by, disabled_at = NULL, updated_at = excluded.updated_at,
           revision = excluded.revision`,
      ).bind(memberId, loginId, hash, now, session.user.id, session.user.id, now, now, newRevision(), ...aliases, memberId),
      revokeSessions(ctx.env, memberId),
      await clearLoginId(ctx.env, loginId),
    ])
    if (results[0].meta.changes !== 1) throw new HttpError(409, 'login_id_taken', 'รหัสนักศึกษานี้เพิ่งถูกใช้เปิดบัญชีของสมาชิกอีกคน ยังไม่ได้เปิดบัญชีนี้ โหลดรายการใหม่เพื่อตรวจ')
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
    ctx.env.DB.prepare(`UPDATE member_accounts SET status = 'disabled', disabled_at = ?, updated_at = ?, revision = ? WHERE member_id = ? AND status = 'active'`).bind(now, now, newRevision(), memberId),
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
  if (typeof body.studentId !== 'string' || studentIdKey(body.studentId) !== studentIdKey(member.student_id)) {
    throw new HttpError(409, 'student_id_changed', 'รหัสนักศึกษาในทะเบียนไม่ตรงกับที่แสดงแล้ว ยังไม่ได้เปลี่ยนรหัสเข้าสู่ระบบ โหลดรายการใหม่เพื่อตรวจ')
  }
  if (studentIdKey(member.account_login_id) === studentIdKey(member.student_id)) return json({ account: accountSummary(member) })
  const nextLoginId = normalizeStudentId(member.student_id)
  const aliases = studentIdAliases(nextLoginId)
  try {
    const results = await ctx.env.DB.batch([
      ctx.env.DB.prepare('UPDATE member_accounts SET login_id = ?, updated_at = ?, revision = ? WHERE member_id = ? AND NOT EXISTS (SELECT 1 FROM member_accounts WHERE login_id IN (?, ?) AND member_id <> ?)').bind(nextLoginId, nowIso(), newRevision(), memberId, ...aliases, memberId),
      // สมาชิกต้องเข้าสู่ระบบใหม่ด้วยรหัสนักศึกษาใหม่
      revokeSessions(ctx.env, memberId),
    ])
    if (results[0].meta.changes !== 1) throw new HttpError(409, 'login_id_taken', 'รหัสนักศึกษานี้ยังเป็นรหัสเข้าสู่ระบบของบัญชีสมาชิกอีกคน ยังไม่ได้เปลี่ยน ตรวจบัญชีของสมาชิกคนนั้นก่อน')
  } catch (error) {
    if (error instanceof Error && /UNIQUE constraint failed/i.test(error.message)) {
      throw new HttpError(409, 'login_id_taken', 'รหัสนักศึกษานี้ยังเป็นรหัสเข้าสู่ระบบของบัญชีสมาชิกอีกคน ยังไม่ได้เปลี่ยน ตรวจบัญชีของสมาชิกคนนั้นก่อน')
    }
    throw error
  }
  await audit(ctx.env, session.user.id, 'member_account.login_id_changed', memberId)
  return json({ account: accountSummary((await getMember(ctx.env, memberId))!) })
}

/** GET /api/members/:id/account — สถานะล่าสุดของบัญชีเข้าสู่ระบบของสมาชิกหนึ่งคน ใช้ตรวจผลจริงหลังคำสั่งที่ยังไม่ได้คำตอบ */
async function accountStatus(ctx: Ctx, memberId: string): Promise<Response> {
  requireUser(ctx)
  const member = await getMember(ctx.env, memberId)
  if (!member) throw memberNotFound()
  return json({ account: accountSummary(member) })
}

/**
 * POST /api/members/:id/account/delete — ลบบัญชีเข้าสู่ระบบของสมาชิก (เฉพาะผู้ดูแล)
 * - ลบเฉพาะบัญชีของเว็บ (รหัสเข้าสู่ระบบ ตัวตรวจรหัสผ่าน และ session ของสมาชิกคนนี้ทั้งหมด) ในคำสั่งชุดเดียวที่สำเร็จหรือไม่สำเร็จพร้อมกัน
 *   ทะเบียนสมาชิก โปรไฟล์นักกีฬา รูปโปรไฟล์ ข้อมูลใน Google Sheets บัญชีของคนอื่น และ session ของทีมงานไม่ถูกแตะ
 * - ต้องส่งรุ่นของบัญชีที่เห็นตอนเปิดกล่องยืนยัน (expectedRevision): ถ้าบัญชีถูกตั้งรหัสใหม่ เปลี่ยนสถานะ หรือถูกลบแล้วเปิดใหม่ระหว่างนั้น จะไม่ลบและตอบ 409
 * - ไม่มีบัญชีอยู่แล้ว (เช่น คำขอก่อนหน้าสำเร็จแต่คำตอบหาย): ตอบสถานะปัจจุบันโดยไม่ทำอะไรเพิ่ม เรียกซ้ำได้อย่างปลอดภัย
 * - session เดิมถูกลบจริง จึงกลับมาใช้ไม่ได้แม้เปิดบัญชีใหม่ภายหลัง
 */
async function deleteAccount(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request, 1024)
  const expected = body.expectedRevision
  if (typeof expected !== 'string' || expected.length > 64) {
    throw invalid('ไม่ได้ระบุรุ่นของบัญชีที่จะลบ โหลดรายการใหม่แล้วลองอีกครั้ง', 'expectedRevision')
  }
  const member = await getMember(ctx.env, memberId)
  if (!member) throw memberNotFound()
  if (member.account_login_id === null) return json({ account: accountSummary(member), deleted: false })
  const changed = (current: MemberAccountRow) =>
    new HttpError(409, 'account_changed', 'บัญชีนี้ถูกตั้งรหัสผ่านใหม่หรือเปลี่ยนสถานะจากที่อื่นหลังจากที่เปิดกล่องนี้ ยังไม่ได้ลบบัญชี ตรวจสถานะล่าสุดก่อนยืนยันอีกครั้ง', {
      account: accountSummary(current),
    })
  if ((member.account_revision ?? '') !== expected) throw changed(member)

  const results = await ctx.env.DB.batch([
    // ลบ session ก่อน และเฉพาะเมื่อบัญชียังเป็นรุ่นที่ผู้ดูแลยืนยัน: ถ้ารุ่นเปลี่ยนไปแล้ว ทั้งสองคำสั่งไม่ลบอะไรเลย
    ctx.env.DB.prepare('DELETE FROM member_sessions WHERE member_id = ? AND EXISTS (SELECT 1 FROM member_accounts WHERE member_id = ? AND revision = ?)').bind(memberId, memberId, expected),
    ctx.env.DB.prepare('DELETE FROM member_accounts WHERE member_id = ? AND revision = ?').bind(memberId, expected),
  ])
  const after = (await getMember(ctx.env, memberId))!
  if (results[1].meta.changes < 1) {
    // บัญชีเปลี่ยนไประหว่างคำขอนี้: ถ้าถูกลบไปแล้วโดยคำขออื่นถือว่าไม่มีอะไรต้องทำ ถ้ายังอยู่ให้ผู้ดูแลตรวจใหม่
    if (after.account_login_id === null) return json({ account: accountSummary(after), deleted: false })
    throw changed(after)
  }
  // บันทึกว่าใครลบบัญชีของสมาชิกคนใด ไม่มีรหัสผ่าน ตัวตรวจรหัสผ่าน หรือรหัสนักศึกษา
  await audit(ctx.env, session.user.id, 'member_account.deleted', memberId)
  return json({ account: accountSummary(after), deleted: true })
}

export async function handleMemberAccount(ctx: Ctx, memberId: string, action: string | undefined): Promise<Response | null> {
  if (action === undefined) return ctx.request.method === 'GET' ? accountStatus(ctx, memberId) : null
  if (ctx.request.method !== 'POST') return null
  if (action === 'password') return setPassword(ctx, memberId)
  if (action === 'disable') return disableAccount(ctx, memberId)
  if (action === 'login-id') return confirmLoginId(ctx, memberId)
  if (action === 'delete') return deleteAccount(ctx, memberId)
  return null
}

// ---------- สมาชิก: เข้าสู่ระบบ ----------

const invalidCredentials = () =>
  new HttpError(401, 'invalid_credentials', 'รหัสนักศึกษาหรือรหัสผ่านไม่ถูกต้อง ถ้าลืมรหัสผ่านให้ติดต่อทีมงานเพื่อตั้งรหัสใหม่')

/** ช่วยแสดงคำแนะนำครั้งแรกเท่านั้น ไม่เปิดบัญชี ไม่ออก session และไม่ส่งข้อมูลส่วนตัวหรือรหัสผ่าน */
export async function memberActivation(ctx: Ctx): Promise<Response> {
  if (ctx.request.headers.get('Origin') !== ctx.url.origin) throw new HttpError(403, 'bad_origin', 'คำขอนี้ไม่ได้มาจากหน้าเว็บของระบบ')
  const body = await readJson(ctx.request, 512)
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  if (!studentId || studentId.length > 64) throw invalid('กรอกรหัสนักศึกษาให้ถูกต้อง', 'studentId')
  // ใช้โควตา metadata ร่วมกับ challenge โดยไม่กินจำนวนครั้งที่ลองรหัสผ่าน
  const allowed = await reserveChallenge(ctx.env, ctx.request)
  if (!allowed.allowed) throw await tooMany(ctx.env, allowed)
  const { results } = await ctx.env.DB.prepare(
    `SELECT a.status, a.must_change_password, a.last_login_at, m.status AS member_status
       FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE a.login_id IN (?, ?) LIMIT 2`,
  ).bind(...studentIdAliases(studentId)).all<{ status: string; must_change_password: number; last_login_at: string | null; member_status: string }>()
  const row = results.length === 1 ? results[0] : undefined
  return json({ firstTime: !!row && row.status === 'active' && row.member_status === 'active' && row.must_change_password === 1 && row.last_login_at === null })
}

/** Public metadata contains a salt and fixed work parameters, never a verifier or an existence flag. */
export async function memberChallenge(ctx: Ctx): Promise<Response> {
  if (ctx.request.headers.get('Origin') !== ctx.url.origin) throw new HttpError(403, 'bad_origin', 'คำขอนี้ไม่ได้มาจากหน้าเว็บของระบบ')
  const body = await readJson(ctx.request, 512)
  const studentId = typeof body.studentId === 'string' ? body.studentId.trim() : ''
  if (!studentId || studentId.length > 64) throw invalid('กรอกรหัสนักศึกษาให้ถูกต้อง', 'studentId')
  const allowed = await reserveChallenge(ctx.env, ctx.request)
  if (!allowed.allowed) throw await tooMany(ctx.env, allowed)
  const { results } = await ctx.env.DB.prepare('SELECT member_id, password_hash FROM member_accounts WHERE login_id IN (?, ?) LIMIT 2')
    .bind(...studentIdAliases(studentId)).all<{ member_id: string; password_hash: string }>()
  if (results.length === 1) {
    const row = results[0]
    const parsed = storedPassword(row.password_hash)
    if (parsed) {
      // Wrap old local accounts before exposing their salt; no CPU-heavy derivation on Workers.
      if (parsed.legacy) await wrapLegacy(ctx.env, row.member_id, row.password_hash)
      return json(parsed.challenge)
    }
  }
  return json(await dummyChallenge(ctx.env, studentId))
}

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
  const proof = readMaterial(body.passwordProof)
  const clientMode = ctx.env.PASSWORD_HASH_MODE !== 'server-test'
  if (!studentId) throw invalid('กรอกรหัสนักศึกษา', 'studentId')
  if (!proof && !password) throw invalid('กรอกรหัสผ่าน', 'password')
  if (!proof && clientMode) throw invalid('เตรียมการเข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่', 'password')
  // ค่าที่ยาวเกินขอบเขตไม่มีทางตรงกับบัญชีใด: ตอบเหมือนรหัสผิดโดยไม่เสียแรงคำนวณ
  if (studentId.length > 64 || passwordLength(password) > MAX_PASSWORD_LENGTH) throw invalidCredentials()

  const reserved = await reserveAttempt(env, studentId, request)
  if (!reserved.allowed) throw await tooMany(env, reserved)

  const { results: matches } = await env.DB.prepare(
    `SELECT a.member_id, a.login_id, a.password_hash, a.status, a.must_change_password, m.status AS member_status
       FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE a.login_id IN (?, ?) LIMIT 2`,
  )
    .bind(...studentIdAliases(studentId))
    .all<LoginRow>()
  // ข้อมูลเก่าที่มีทั้งสองรูปแบบอยู่คนละบัญชี: ไม่เลือกบัญชีจากรหัสผ่านหรือย้ายตัวตนเอง
  if (matches.length !== 1) {
    if (proof) await storeMaterial(env, 'unknown-account', proof)
    else burnVerification(password)
    throw invalidCredentials()
  }
  const row = matches[0]
  const checked = proof ? { ok: await verifyMaterial(env, row.member_id, row.password_hash, proof), needsRehash: false } : verifyPassword(password, row.password_hash)
  if (!checked.ok) throw invalidCredentials()
  // บอกสถานะบัญชีเฉพาะกับผู้ที่พิสูจน์แล้วว่ารู้รหัสผ่าน
  if (row.status !== 'active' || row.member_status !== 'active') {
    throw new HttpError(403, 'account_disabled', 'บัญชีนี้ถูกปิดหรือสมาชิกถูกพักการใช้งาน จึงเข้าสู่ระบบไม่ได้ ติดต่อทีมงาน')
  }
  if (proof && storedPassword(row.password_hash)?.legacy) row.password_hash = await wrapLegacy(env, row.member_id, row.password_hash)

  const now = nowIso()
  const fresh = await newMemberSession(env, row.member_id, ctx.url, row.password_hash)
  const statements = [
    fresh.insert,
    env.DB.prepare('UPDATE member_accounts SET last_login_at = ?, updated_at = ? WHERE member_id = ?').bind(now, now, row.member_id),
    env.DB.prepare('DELETE FROM member_sessions WHERE expires_at <= ?').bind(now),
  ]
  // ค่า Argon2id ที่เก็บไว้อ่อนกว่าค่าปัจจุบัน: คำนวณใหม่ด้วยค่าปัจจุบันตอนที่รู้รหัสผ่านจริง
  if (checked.needsRehash) statements.push(env.DB.prepare('UPDATE member_accounts SET password_hash = ? WHERE member_id = ?').bind(hashPassword(password), row.member_id))
  const legacyWork = storedPassword(row.password_hash)?.challenge
  if (proof && legacyWork && (legacyWork.m < 19456 || legacyWork.t < 2 || legacyWork.p !== 1)) {
    row.must_change_password = 1
    statements.push(env.DB.prepare('UPDATE member_accounts SET must_change_password = 1 WHERE member_id = ? AND password_hash = ?').bind(row.member_id, row.password_hash))
  }
  const written = await env.DB.batch(statements)
  if (written[0].meta.changes !== 1) throw invalidCredentials()
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
                         a.password_set_at AS account_password_set_at, a.last_login_at AS account_last_login_at, a.password_set_by AS account_password_set_by,
                         a.revision AS account_revision, pr.email AS profile_email, pr.contacts_json AS profile_contacts, pr.version AS profile_version, p.version AS photo_version, NULL AS athlete_game, NULL AS athlete_status
                    FROM members m JOIN member_accounts a ON a.member_id = m.id LEFT JOIN member_photos p ON p.member_id = m.id LEFT JOIN member_profiles pr ON pr.member_id=m.id WHERE m.id = ?`).bind(id).first<SelfRow>()

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
  email: row.profile_email ?? '',
  contacts: JSON.parse(row.profile_contacts ?? '[]'),
  profileVersion: row.profile_version ?? 1,
  version: row.version,
  contactEditable: await contactEditable(env, row),
  passwordChangedAt: row.account_password_set_by === null ? row.account_password_set_at : null,
  /** รุ่นของรูปโปรไฟล์ของตัวเอง (null = ไม่มีรูป) รูปอ่านได้จาก /api/members/<รหัสของตัวเอง>/photo เท่านั้น */
  photoVersion: row.photo_version,
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
 * POST /api/member/password/setup — ตั้งรหัสส่วนตัวจาก session หลังตรวจรหัสชั่วคราวแล้ว
 * POST /api/member/password — เส้นทางเดิมที่ตรวจรหัสปัจจุบัน เพื่อรองรับ client รุ่นก่อน
 * สำเร็จแล้ว session เดิมทั้งหมดของบัญชีถูกยกเลิก และเบราว์เซอร์นี้ได้ session ใหม่
 */
async function changePassword(ctx: Ctx, usingLogin = false): Promise<Response> {
  const session = await requireMemberMutation(ctx, { allowPasswordChange: true })
  const body = await readJson(ctx.request, 4096)
  const current = typeof body.currentPassword === 'string' ? body.currentPassword : ''
  if (!usingLogin && !current) throw invalid('กรอกรหัสผ่านปัจจุบัน', 'currentPassword')
  const id = session.member.id
  const account = await ctx.env.DB.prepare('SELECT a.login_id, a.password_hash, a.must_change_password, m.student_id FROM member_accounts a JOIN members m ON m.id = a.member_id WHERE a.member_id = ?')
    .bind(id)
    .first<{ login_id: string; password_hash: string; must_change_password: number; student_id: string }>()
  if (!account) throw new HttpError(401, 'unauthenticated', 'ยังไม่ได้เข้าสู่ระบบ หรือเซสชันหมดอายุแล้ว')
  if (account.must_change_password !== 1) throw new HttpError(403, 'admin_reset_required', 'ติดต่อผู้ดูแลเพื่อรับรหัสผ่านชั่วคราวก่อนเปลี่ยนรหัสผ่าน')
  if (usingLogin) {
    const age = Date.now() - Date.parse(session.authenticatedAt)
    if (!Number.isFinite(age) || age < 0 || age >= 15 * 60_000) {
      throw new HttpError(409, 'password_setup_expired', 'การยืนยันตัวตนสำหรับตั้งรหัสผ่านหมดอายุแล้ว ออกจากระบบแล้วเข้าสู่ระบบด้วยรหัสชั่วคราวอีกครั้ง')
    }
  }
  const next = newPassword(body, 'newPassword', 'รหัสผ่านใหม่', [account.login_id, account.student_id])
  if (!usingLogin && normalizePassword(next) === normalizePassword(current)) throw invalid('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านปัจจุบัน', 'newPassword')

  // การเดารหัสผ่านปัจจุบันผ่าน session ที่ถูกขโมยถูกจำกัดด้วยตัวนับเดียวกับการเข้าสู่ระบบ
  const reserved = await reserveAttempt(ctx.env, account.login_id, ctx.request)
  if (!reserved.allowed) throw await tooMany(ctx.env, reserved)
  const currentProof = readMaterial(usingLogin ? body.comparisonProof : body.currentProof)
  const nextProof = readMaterial(body.passwordProof, true)
  if ((!currentProof || !nextProof) && ctx.env.PASSWORD_HASH_MODE !== 'server-test') throw invalid('เตรียมรหัสผ่านไม่สำเร็จ กรุณาลองใหม่', 'newPassword')
  if (usingLogin && currentProof) {
    const expected = storedPassword(account.password_hash)?.challenge
    if (!expected || ['salt', 'm', 't', 'p'].some(key => currentProof[key as keyof typeof currentProof] !== expected[key as keyof typeof expected])) {
      throw new HttpError(409, 'password_changed', 'บัญชีมีการเปลี่ยนแปลงระหว่างบันทึก กรุณาเข้าสู่ระบบใหม่')
    }
  }
  const matches = currentProof ? await verifyMaterial(ctx.env, id, account.password_hash, currentProof) : verifyPassword(usingLogin ? next : current, account.password_hash).ok
  if (usingLogin && matches) throw invalid('รหัสผ่านใหม่ต้องไม่ซ้ำกับรหัสผ่านชั่วคราว', 'newPassword')
  if (!usingLogin && (passwordLength(current) > MAX_PASSWORD_LENGTH || !matches)) {
    throw new HttpError(403, 'wrong_password', 'รหัสผ่านปัจจุบันไม่ถูกต้อง ยังไม่ได้เปลี่ยนรหัสผ่าน', { field: 'currentPassword' })
  }

  const hash = nextProof ? await storeMaterial(ctx.env, id, nextProof) : hashPassword(next)
  const now = nowIso()
  const fresh = await newMemberSession(ctx.env, id, ctx.url, hash)
  const changed = await ctx.env.DB.batch([
    ctx.env.DB.prepare(`UPDATE member_accounts SET password_hash = ?, must_change_password = 0, password_set_at = ?, password_set_by = NULL, updated_at = ?, revision = ?
      WHERE member_id = ? AND password_hash = ? AND status = 'active' AND must_change_password = 1
        AND EXISTS (SELECT 1 FROM member_sessions WHERE member_id = ? AND token_hash = ? AND expires_at > ?)`)
      .bind(hash, now, now, newRevision(), id, account.password_hash, id, session.tokenHash, now),
    ctx.env.DB.prepare('DELETE FROM member_sessions WHERE member_id = ? AND EXISTS (SELECT 1 FROM member_accounts WHERE member_id = ? AND password_hash = ?)').bind(id, id, hash),
    fresh.insert,
  ])
  if (changed[0].meta.changes !== 1 || changed[2].meta.changes !== 1) throw new HttpError(409, 'password_changed', 'บัญชีมีการเปลี่ยนแปลงระหว่างบันทึก กรุณาเข้าสู่ระบบใหม่')
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

/** อ่านปฏิทินตามเดือน รวมช่องวันของเดือนข้างเคียงและกำหนดการหลายวัน ไม่มี metadata หลังบ้าน */
async function calendar(ctx: Ctx): Promise<Response> {
  requireMember(ctx)
  const month = ctx.url.searchParams.get('month') ?? bangkokToday().slice(0, 7)
  if (!/^[1-9]\d{3}-(0[1-9]|1[0-2])$/.test(month) || Number(month.slice(0, 4)) > 9998) throw invalid('เดือนปฏิทินไม่ถูกต้อง', 'month')
  const days = monthGrid(month)
  const { results } = await ctx.env.DB.prepare(`SELECT id, title, all_day, start_at, end_at, location, description FROM events
    WHERE source_state = 'ok' AND start_at <= ? AND end_at >= ? ORDER BY start_at, title, id LIMIT 501`)
    .bind(`${days[days.length - 1]}T23:59`, `${days[0]}T00:00`).all<EventRow>()
  return json({ month, truncated: results.length > 500, events: results.slice(0, 500).map((row) => ({ id: row.id, title: row.title, allDay: row.all_day === 1, start: row.start_at, end: row.end_at, location: row.location, description: row.description })) })
}

export async function handleMemberSelf(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 2 && parts[0] === 'password' && parts[1] === 'setup' && method === 'POST') return changePassword(ctx, true)
  if (parts.length !== 1) return null
  if (parts[0] === 'me' && method === 'GET') return me(ctx)
  if (parts[0] === 'me' && method === 'PATCH') return updateMe(ctx)
  if (parts[0] === 'password' && method === 'POST') return changePassword(ctx)
  if (parts[0] === 'events' && method === 'GET') return events(ctx)
  if (parts[0] === 'calendar' && method === 'GET') return calendar(ctx)
  if (parts[0] === 'news' && method === 'GET') return memberNews(ctx)
  return null
}
