import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { requireMutation, requireUser } from './session'
import { appendMember, updateMemberRow } from './sheets'
import { loadResource } from './sync'
import {
  bangkokToday, expectedVersion, findIdempotent, hashPayload, idempotencyInsert, idempotencyKey, oneOf, text, versionConflict,
} from './validation'

const ROLES = ['member', 'staff', 'admin'] as const
const STATUSES = ['active', 'suspended'] as const

interface MemberRow {
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
}

const toMember = (row: MemberRow) => ({
  id: row.id,
  name: row.name,
  nickname: row.nickname,
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
})

function parseInput(body: Record<string, unknown>) {
  return {
    name: text(body, 'name', 'ชื่อสมาชิก', 100, true),
    nickname: text(body, 'nickname', 'ชื่อเล่น', 40, true),
    // role ตรงนี้เป็นข้อมูลประกอบของสมาชิกชมรม ไม่เกี่ยวกับสิทธิ์เข้าสู่ระบบ
    role: oneOf(body, 'role', 'บทบาท', ROLES),
    status: oneOf(body, 'status', 'สถานะ', STATUSES),
    contact: text(body, 'contact', 'ช่องทางติดต่อ', 200),
    note: text(body, 'note', 'หมายเหตุ', 2000),
  }
}

const getMember = (env: AppEnv, id: string) => env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<MemberRow>()

async function list(ctx: Ctx): Promise<Response> {
  requireUser(ctx)
  const { results } = await ctx.env.DB.prepare('SELECT * FROM members ORDER BY added_at DESC, name').all<MemberRow>()
  return json({ members: results.map(toMember) })
}

export type MemberInput = ReturnType<typeof parseInput>

/**
 * เพิ่มสมาชิกเมื่อเชื่อมชีตแล้ว: จองรหัสกับ key ก่อน แล้วต่อแถวในชีตด้วยรหัสนั้น
 * คำขอเดิมที่ลองใหม่ใช้รหัสเดิม จึงไม่เกิดแถวซ้ำแม้คำตอบของ Google ครั้งก่อนจะหายไป
 */
async function createInSheet(env: AppEnv, userId: string, key: string, operation: string, input: MemberInput): Promise<{ row: MemberRow; replayed: boolean }> {
  const sheet = (await loadResource(env, 'sheets'))!
  const payloadHash = await hashPayload(input)
  let id = await findIdempotent(env, userId, key, operation, payloadHash)
  if (id) {
    const existing = await getMember(env, id)
    if (existing) return { row: existing, replayed: true }
  } else {
    id = crypto.randomUUID()
    await idempotencyInsert(env, userId, key, operation, payloadHash, id).run().catch(() => undefined)
    id = (await findIdempotent(env, userId, key, operation, payloadHash)) ?? id
  }
  await appendMember(env, sheet, id, input)
  const row = await getMember(env, id)
  if (!row) throw new HttpError(502, 'saved_unverified', 'Google Sheets รับแถวใหม่แล้ว แต่ระบบยังอ่านกลับมาแสดงไม่ได้ กด “อัปเดตจาก Google” เพื่อตรวจ')
  return { row, replayed: false }
}

/** เพิ่มสมาชิกหนึ่งคน: ลงชีตที่เชื่อมไว้ (แหล่งหลัก) หรือลง D1 เมื่อยังไม่ได้เชื่อม ใช้ทั้งจากฟอร์มเพิ่มสมาชิกและจากคำตอบ Google Forms */
export async function createMember(env: AppEnv, userId: string, key: string, operation: string, input: MemberInput): Promise<{ row: MemberRow; replayed: boolean }> {
  if (await loadResource(env, 'sheets')) return createInSheet(env, userId, key, operation, input)
  const payloadHash = await hashPayload(input)
  const replay = async () => {
    const existingId = await findIdempotent(env, userId, key, operation, payloadHash)
    const row = existingId ? await getMember(env, existingId) : null
    return row ? { row, replayed: true } : null
  }
  const replayed = await replay()
  if (replayed) return replayed

  const id = crypto.randomUUID()
  const now = nowIso()
  try {
    // key และรายการถูกบันทึกพร้อมกัน: ถ้าคำขอซ้ำมาถึงพร้อมกัน จะมีเพียงคำขอเดียวที่สร้างได้
    await env.DB.batch([
      idempotencyInsert(env, userId, key, operation, payloadHash, id),
      env.DB.prepare(
        `INSERT INTO members (id, name, nickname, role, status, contact, note, added_at, version, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).bind(id, input.name, input.nickname, input.role, input.status, input.contact, input.note, bangkokToday(), userId, userId, now, now),
    ])
  } catch (error) {
    const again = await replay()
    if (again) return again
    throw error
  }
  return { row: (await getMember(env, id))!, replayed: false }
}

/**
 * สร้างสมาชิกด้วยรหัสที่จองไว้ล่วงหน้า (ใช้กับการนำเข้าคำตอบ Google Forms ซึ่งจองรหัสร่วมกันทุกผู้ใช้)
 * ทำซ้ำได้จากผู้ใช้คนใดก็ได้: ถ้ารหัสนี้มีอยู่แล้วในชีตหรือใน D1 จะไม่สร้างเพิ่ม และคืนรายการเดิม
 */
export async function createMemberWithId(env: AppEnv, actorId: string, id: string, input: MemberInput): Promise<MemberRow> {
  const sheet = await loadResource(env, 'sheets')
  if (sheet) {
    // appendMember อ่านชีตก่อนภายใต้ lock: ถ้าแถวของรหัสนี้อยู่ในชีตแล้ว (เช่น คำขอก่อนหน้าเขียนสำเร็จแต่คำตอบหาย) จะไม่ต่อแถวซ้ำ
    await appendMember(env, sheet, id, input)
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

/** สมาชิกที่เป็นสำเนาจากชีตที่เชื่อมอยู่: เขียนไปที่ชีต (แหล่งหลัก) แล้วให้สำเนาใน D1 ตามผลที่อ่านกลับ คืน false เมื่อเป็นข้อมูลเฉพาะในเว็บ */
async function viaSheet(env: AppEnv, id: string, changes: Partial<MemberInput>, version: number): Promise<boolean> {
  const current = await getMember(env, id)
  if (!current || current.source !== 'sheets') return false
  const sheet = await loadResource(env, 'sheets')
  if (!sheet) return false
  await updateMemberRow(env, sheet, id, changes, version)
  return true
}

async function update(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const input = parseInput(body)
  const version = expectedVersion(body)
  if (await viaSheet(ctx.env, id, input, version)) return json({ member: toMember((await getMember(ctx.env, id))!) })
  // แก้เฉพาะแถวนี้ และเฉพาะเมื่อยังเป็นรุ่นที่ผู้ใช้เห็น จึงไม่ทับการแก้ของคนอื่น
  const result = await ctx.env.DB.prepare(
    `UPDATE members SET name = ?, nickname = ?, role = ?, status = ?, contact = ?, note = ?,
            version = version + 1, updated_by = ?, updated_at = ?
      WHERE id = ? AND version = ?`,
  )
    .bind(input.name, input.nickname, input.role, input.status, input.contact, input.note, session.user.id, nowIso(), id, version)
    .run()
  if (result.meta.changes !== 1) await notFoundOrConflict(ctx.env, id)
  return json({ member: toMember((await getMember(ctx.env, id))!) })
}

async function setStatus(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const status = oneOf(body, 'status', 'สถานะ', STATUSES)
  const version = expectedVersion(body)
  if (await viaSheet(ctx.env, id, { status }, version)) return json({ member: toMember((await getMember(ctx.env, id))!) })
  const result = await ctx.env.DB.prepare(
    'UPDATE members SET status = ?, version = version + 1, updated_by = ?, updated_at = ? WHERE id = ? AND version = ?',
  )
    .bind(status, session.user.id, nowIso(), id, version)
    .run()
  if (result.meta.changes !== 1) await notFoundOrConflict(ctx.env, id)
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
  return null
}
