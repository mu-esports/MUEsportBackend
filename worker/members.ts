import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { requireMutation, requireUser } from './session'
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

async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx)
  const key = idempotencyKey(ctx.request)
  const input = parseInput(await readJson(ctx.request))
  const payloadHash = await hashPayload(input)

  const replay = async () => {
    const existingId = await findIdempotent(ctx.env, session.user.id, key, 'member.create', payloadHash)
    const row = existingId ? await getMember(ctx.env, existingId) : null
    return row ? json({ member: toMember(row), replayed: true }) : null
  }
  const replayed = await replay()
  if (replayed) return replayed

  const id = crypto.randomUUID()
  const now = nowIso()
  try {
    // key และรายการถูกบันทึกพร้อมกัน: ถ้าคำขอซ้ำมาถึงพร้อมกัน จะมีเพียงคำขอเดียวที่สร้างได้
    await ctx.env.DB.batch([
      idempotencyInsert(ctx.env, session.user.id, key, 'member.create', payloadHash, id),
      ctx.env.DB.prepare(
        `INSERT INTO members (id, name, nickname, role, status, contact, note, added_at, version, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).bind(id, input.name, input.nickname, input.role, input.status, input.contact, input.note, bangkokToday(), session.user.id, session.user.id, now, now),
    ])
  } catch (error) {
    const again = await replay()
    if (again) return again
    throw error
  }
  return json({ member: toMember((await getMember(ctx.env, id))!) }, 201)
}

async function notFoundOrConflict(env: AppEnv, id: string): Promise<never> {
  const current = await getMember(env, id)
  if (!current) throw new HttpError(404, 'not_found', 'ไม่พบสมาชิกนี้ อาจถูกลบหรือลิงก์ไม่ถูกต้อง')
  throw versionConflict(toMember(current))
}

async function update(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const input = parseInput(body)
  const version = expectedVersion(body)
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
