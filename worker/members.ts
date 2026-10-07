import { accountSummary, handleMemberAccount, MEMBER_WITH_ACCOUNT } from './accounts'
import type { MemberAccountRow } from './accounts'
import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { requireMutation, requireUser } from './session'
import { appendMember, updateMemberRow } from './sheets'
import type { SheetConfig } from './sheets'
import { loadResource } from './sync'
import type { SyncResource } from './sync'
import {
  bangkokToday, expectedVersion, findIdempotent, hashPayload, idempotencyInsert, idempotencyKey, oneOf, studentIdField, text, versionConflict,
} from './validation'

const ROLES = ['member', 'staff', 'admin'] as const
const STATUSES = ['active', 'suspended'] as const

type MemberRow = MemberAccountRow

const toMember = (row: MemberRow) => ({
  id: row.id,
  name: row.name,
  nickname: row.nickname,
  // รหัสนักศึกษาที่ทะเบียนใช้จริง ('' = ยังไม่ได้กรอก) เก็บเป็นข้อความ คงเลขศูนย์นำหน้า
  studentId: row.student_id,
  // ค่าที่ชีตระบุแต่ระบบยังไม่ใช้ เพราะซ้ำหรือผิดรูปแบบ (null = ไม่มีปัญหา)
  studentIdIssue: row.student_id_issue ? { code: row.student_id_issue, claimed: row.student_id_claimed } : null,
  role: row.role,
  status: row.status,
  contact: row.contact,
  note: row.note,
  addedAt: row.added_at,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // sheets = สำเนาจากชีตที่เชื่อม, local = อยู่เฉพาะในเว็บ; sourceState missing = ไม่พบแถวในชีตแล้ว
  source: row.source,
  sourceState: row.source_state,
  // สถานะบัญชีเข้าสู่ระบบของสมาชิก ไม่มี hash, salt หรือรหัสผ่านในคำตอบใด
  account: accountSummary(row),
})

function parseInput(body: Record<string, unknown>) {
  return {
    name: text(body, 'name', 'ชื่อสมาชิก', 100, true),
    nickname: text(body, 'nickname', 'ชื่อเล่น', 40, true),
    studentId: studentIdField(body),
    // role ตรงนี้เป็นข้อมูลประกอบของสมาชิกชมรม ไม่เกี่ยวกับสิทธิ์เข้าสู่ระบบ
    role: oneOf(body, 'role', 'บทบาท', ROLES),
    status: oneOf(body, 'status', 'สถานะ', STATUSES),
    contact: text(body, 'contact', 'ช่องทางติดต่อ', 200),
    note: text(body, 'note', 'หมายเหตุ', 2000),
  }
}

const getMember = (env: AppEnv, id: string) => env.DB.prepare(`${MEMBER_WITH_ACCOUNT} WHERE m.id = ?`).bind(id).first<MemberRow>()

async function list(ctx: Ctx): Promise<Response> {
  requireUser(ctx)
  const { results } = await ctx.env.DB.prepare(`${MEMBER_WITH_ACCOUNT} ORDER BY m.added_at DESC, m.name`).all<MemberRow>()
  return json({ members: results.map(toMember) })
}

export type MemberInput = ReturnType<typeof parseInput>

// ---------- รหัสนักศึกษา ----------

const studentIdTaken = (name?: string) =>
  new HttpError(409, 'student_id_taken', `รหัสนักศึกษานี้มีสมาชิกคนอื่นใช้อยู่แล้ว${name ? ` (${name})` : ''} ยังไม่ได้บันทึก ตรวจรหัสให้ถูกต้องก่อนบันทึกอีกครั้ง`, { field: 'studentId' })

const isStudentIdConflict = (error: unknown) => error instanceof Error && /UNIQUE constraint failed/i.test(error.message) && /student_id/i.test(error.message)

/** รหัสนักศึกษาต้องไม่ซ้ำกับสมาชิกคนอื่น (ไม่สนตัวพิมพ์เล็กใหญ่) ตรวจก่อนเขียนทุกครั้ง และฐานข้อมูลมี unique index กันซ้ำอีกชั้น */
async function ensureStudentIdFree(env: AppEnv, studentId: string, exceptId = ''): Promise<void> {
  if (!studentId) return
  const other = await env.DB.prepare('SELECT name FROM members WHERE student_id = ? COLLATE NOCASE AND id <> ? LIMIT 1').bind(studentId, exceptId).first<{ name: string }>()
  if (other) throw studentIdTaken(other.name)
}

const studentIdColumn = (sheet: SyncResource) => (sheet.config as unknown as SheetConfig).columns?.studentId

/**
 * ชีตที่เชื่อมยังไม่มีคอลัมน์รหัสนักศึกษา: รหัสนักศึกษาเก็บในเว็บเท่านั้น (ที่มา = web)
 * เมื่อผู้ดูแลจับคู่คอลัมน์ภายหลัง ค่าที่กรอกในเว็บจะถูกเขียนลงช่องที่ว่างของแถวนั้นให้ ไม่ถูกล้างทิ้ง
 */
async function setWebStudentId(env: AppEnv, userId: string, id: string, studentId: string): Promise<void> {
  try {
    await env.DB.prepare(
      `UPDATE members SET student_id = ?, student_id_origin = 'web', student_id_issue = '', student_id_claimed = '', version = version + 1, updated_by = ?, updated_at = ? WHERE id = ?`,
    )
      .bind(studentId, userId, nowIso(), id)
      .run()
  } catch (error) {
    if (isStudentIdConflict(error)) throw studentIdTaken()
    throw error
  }
}

/** หลังเขียนลงชีตที่มีคอลัมน์รหัสนักศึกษา: ค่าที่ทะเบียนใช้จริงต้องตรงกับที่ขอ ไม่เช่นนั้นแปลว่าชีตมีรหัสนี้ซ้ำอยู่ */
function assertStudentIdApplied(row: MemberRow, wanted: string): void {
  if (row.student_id.toLowerCase() === wanted.toLowerCase()) return
  throw new HttpError(
    409,
    'student_id_conflict',
    'บันทึกลงชีตแล้ว แต่รหัสนักศึกษานี้ซ้ำกับแถวอื่นในชีตหรือกับสมาชิกคนอื่น ระบบจึงยังไม่ใช้ค่านี้ ตรวจรายการที่ต้องแก้ในแถบสถานะของ Google Sheets',
    { field: 'studentId' },
  )
}

/**
 * เพิ่มสมาชิกเมื่อเชื่อมชีตแล้ว: จองรหัสกับ key ก่อน แล้วต่อแถวในชีตด้วยรหัสนั้น
 * คำขอเดิมที่ลองใหม่ใช้รหัสเดิม จึงไม่เกิดแถวซ้ำแม้คำตอบของ Google ครั้งก่อนจะหายไป
 */
async function createInSheet(env: AppEnv, sheet: SyncResource, userId: string, key: string, operation: string, input: MemberInput): Promise<{ row: MemberRow; replayed: boolean }> {
  const payloadHash = await hashPayload(input)
  let id = await findIdempotent(env, userId, key, operation, payloadHash)
  if (id) {
    const existing = await getMember(env, id)
    if (existing) return { row: existing, replayed: true }
  } else {
    await ensureStudentIdFree(env, input.studentId)
    id = crypto.randomUUID()
    await idempotencyInsert(env, userId, key, operation, payloadHash, id).run().catch(() => undefined)
    id = (await findIdempotent(env, userId, key, operation, payloadHash)) ?? id
  }
  await appendMember(env, sheet, id, input)
  if (input.studentId && !studentIdColumn(sheet)) await setWebStudentId(env, userId, id, input.studentId)
  const row = await getMember(env, id)
  if (!row) throw new HttpError(502, 'saved_unverified', 'Google Sheets รับแถวใหม่แล้ว แต่ระบบยังอ่านกลับมาแสดงไม่ได้ กด “อัปเดตจาก Google” เพื่อตรวจ')
  if (input.studentId) assertStudentIdApplied(row, input.studentId)
  return { row, replayed: false }
}

/** เพิ่มสมาชิกหนึ่งคน: ลงชีตที่เชื่อมไว้ (แหล่งหลัก) หรือลง D1 เมื่อยังไม่ได้เชื่อม ใช้ทั้งจากฟอร์มเพิ่มสมาชิกและจากคำตอบ Google Forms */
export async function createMember(env: AppEnv, userId: string, key: string, operation: string, input: MemberInput): Promise<{ row: MemberRow; replayed: boolean }> {
  const sheet = await loadResource(env, 'sheets')
  if (sheet) return createInSheet(env, sheet, userId, key, operation, input)
  const payloadHash = await hashPayload(input)
  const replay = async () => {
    const existingId = await findIdempotent(env, userId, key, operation, payloadHash)
    const row = existingId ? await getMember(env, existingId) : null
    return row ? { row, replayed: true } : null
  }
  const replayed = await replay()
  if (replayed) return replayed
  await ensureStudentIdFree(env, input.studentId)

  const id = crypto.randomUUID()
  const now = nowIso()
  try {
    // key และรายการถูกบันทึกพร้อมกัน: ถ้าคำขอซ้ำมาถึงพร้อมกัน จะมีเพียงคำขอเดียวที่สร้างได้
    await env.DB.batch([
      idempotencyInsert(env, userId, key, operation, payloadHash, id),
      env.DB.prepare(
        `INSERT INTO members (id, name, nickname, role, status, contact, note, added_at, version, created_by, updated_by, created_at, updated_at, student_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
      ).bind(id, input.name, input.nickname, input.role, input.status, input.contact, input.note, bangkokToday(), userId, userId, now, now, input.studentId),
    ])
  } catch (error) {
    const again = await replay()
    if (again) return again
    if (isStudentIdConflict(error)) throw studentIdTaken()
    throw error
  }
  return { row: (await getMember(env, id))!, replayed: false }
}

/**
 * สร้างสมาชิกด้วยรหัสที่จองไว้ล่วงหน้า (ใช้กับการนำเข้าคำตอบ Google Forms ซึ่งจองรหัสร่วมกันทุกผู้ใช้)
 * ทำซ้ำได้จากผู้ใช้คนใดก็ได้: ถ้ารหัสนี้มีอยู่แล้วในชีตหรือใน D1 จะไม่สร้างเพิ่ม และคืนรายการเดิม
 * คำตอบฟอร์มไม่มีช่องรหัสนักศึกษา: ทีมงานกรอกเพิ่มได้จากฟอร์มแก้สมาชิกภายหลัง
 */
export async function createMemberWithId(env: AppEnv, actorId: string, id: string, input: Omit<MemberInput, 'studentId'>): Promise<MemberRow> {
  const sheet = await loadResource(env, 'sheets')
  if (sheet) {
    // appendMember อ่านชีตก่อนภายใต้ lock: ถ้าแถวของรหัสนี้อยู่ในชีตแล้ว (เช่น คำขอก่อนหน้าเขียนสำเร็จแต่คำตอบหาย) จะไม่ต่อแถวซ้ำ
    await appendMember(env, sheet, id, { ...input, studentId: '' })
  } else {
    const now = nowIso()
    await env.DB.prepare(
      `INSERT INTO members (id, name, nickname, role, status, contact, note, added_at, version, created_by, updated_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT (id) DO NOTHING`,
    )
      .bind(id, input.name, input.nickname, input.role, input.status, input.contact, input.note, bangkokToday(), actorId, actorId, now, now)
      .run()
  }
  const row = await getMember(env, id)
  if (!row) throw new HttpError(502, 'saved_unverified', 'Google Sheets รับแถวใหม่แล้ว แต่ระบบยังอ่านกลับมาแสดงไม่ได้ กด “อัปเดตจาก Google” เพื่อตรวจ แล้วลองอีกครั้ง (ระบบจะไม่เพิ่มซ้ำ)')
  return row
}

async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx)
  const key = idempotencyKey(ctx.request)
  const input = parseInput(await readJson(ctx.request))
  const { row, replayed } = await createMember(ctx.env, session.user.id, key, 'member.create', input)
  return json({ member: toMember(row), ...(replayed ? { replayed: true } : {}) }, replayed ? 200 : 201)
}

async function notFoundOrConflict(env: AppEnv, id: string): Promise<never> {
  const current = await getMember(env, id)
  if (!current) throw new HttpError(404, 'not_found', 'ไม่พบสมาชิกนี้ อาจถูกลบหรือลิงก์ไม่ถูกต้อง')
  throw versionConflict(toMember(current))
}

/** ชีตที่เป็นแหล่งหลักของสมาชิกคนนี้ (null = ข้อมูลเฉพาะในเว็บ) */
async function sheetOf(env: AppEnv, current: MemberRow | null): Promise<SyncResource | null> {
  if (!current || current.source !== 'sheets') return null
  return loadResource(env, 'sheets')
}

async function update(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const input = parseInput(body)
  const version = expectedVersion(body)
  const current = await getMember(ctx.env, id)
  if (!current) throw new HttpError(404, 'not_found', 'ไม่พบสมาชิกนี้ อาจถูกลบหรือลิงก์ไม่ถูกต้อง')
  // เขียนรหัสนักศึกษาเฉพาะเมื่อผู้ใช้เปลี่ยนค่าจากที่ทะเบียนใช้อยู่จริง: การแก้ฟิลด์อื่นจะไม่ไปทับค่าที่ชีตระบุไว้และยังเป็นปัญหาค้างอยู่
  const studentIdChanged = input.studentId !== current.student_id
  if (studentIdChanged) await ensureStudentIdFree(ctx.env, input.studentId, id)

  const sheet = await sheetOf(ctx.env, current)
  if (sheet) {
    const { studentId, ...rest } = input
    const mapped = !!studentIdColumn(sheet)
    // สำเนาจากชีตที่เชื่อมอยู่: เขียนไปที่ชีต (แหล่งหลัก) แล้วให้สำเนาใน D1 ตามผลที่อ่านกลับ
    await updateMemberRow(ctx.env, sheet, id, mapped && studentIdChanged ? input : rest, version)
    if (studentIdChanged && !mapped) await setWebStudentId(ctx.env, session.user.id, id, studentId)
    const saved = (await getMember(ctx.env, id))!
    if (studentIdChanged && mapped) assertStudentIdApplied(saved, studentId)
    return json({ member: toMember(saved) })
  }

  // แก้เฉพาะแถวนี้ และเฉพาะเมื่อยังเป็นรุ่นที่ผู้ใช้เห็น จึงไม่ทับการแก้ของคนอื่น
  let result
  try {
    result = await ctx.env.DB.prepare(
      `UPDATE members SET name = ?, nickname = ?, role = ?, status = ?, contact = ?, note = ?, student_id = ?,
              student_id_origin = CASE WHEN ? = 1 THEN 'web' ELSE student_id_origin END,
              student_id_issue = CASE WHEN ? = 1 THEN '' ELSE student_id_issue END,
              student_id_claimed = CASE WHEN ? = 1 THEN '' ELSE student_id_claimed END,
              version = version + 1, updated_by = ?, updated_at = ?
        WHERE id = ? AND version = ?`,
    )
      .bind(
        input.name, input.nickname, input.role, input.status, input.contact, input.note, studentIdChanged ? input.studentId : current.student_id,
        studentIdChanged ? 1 : 0, studentIdChanged ? 1 : 0, studentIdChanged ? 1 : 0, session.user.id, nowIso(), id, version,
      )
      .run()
  } catch (error) {
    if (isStudentIdConflict(error)) throw studentIdTaken()
    throw error
  }
  // นับว่า "ไม่ได้แก้" เมื่อไม่มีแถวใดเปลี่ยนเลย: จำนวนแถวที่เปลี่ยนอาจรวมแถว session ที่ trigger ลบเมื่อสถานะเป็นพักการใช้งาน
  if (result.meta.changes < 1) await notFoundOrConflict(ctx.env, id)
  return json({ member: toMember((await getMember(ctx.env, id))!) })
}

async function setStatus(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const status = oneOf(body, 'status', 'สถานะ', STATUSES)
  const version = expectedVersion(body)
  const sheet = await sheetOf(ctx.env, await getMember(ctx.env, id))
  if (sheet) {
    await updateMemberRow(ctx.env, sheet, id, { status }, version)
    return json({ member: toMember((await getMember(ctx.env, id))!) })
  }
  // การพักสมาชิกยกเลิก session ของบัญชีสมาชิกคนนั้นในคำสั่งเดียวกัน (trigger ของฐานข้อมูล ครอบคลุมทุกเส้นทางรวมถึงรอบซิงค์)
  const result = await ctx.env.DB.prepare(
    'UPDATE members SET status = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?',
  )
    .bind(status, session.user.id, nowIso(), id, version)
    .run()
  if (result.meta.changes < 1) await notFoundOrConflict(ctx.env, id)
  return json({ member: toMember((await getMember(ctx.env, id))!) })
}

export async function handleMembers(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0) {
    if (method === 'GET') return list(ctx)
    if (method === 'POST') return create(ctx)
  }
  if (parts.length === 1 && method === 'PATCH') return update(ctx, parts[0])
  if (parts.length === 2 && parts[1] === 'status' && method === 'POST') return setStatus(ctx, parts[0])
  if (parts.length === 3 && parts[1] === 'account') return handleMemberAccount(ctx, parts[0], parts[2])
  return null
}
