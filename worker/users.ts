import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { clubEmail } from './google'
import { HttpError, json, readJson } from './http'
import { audit, requireMutation, requireUser } from './session'
import { invalid, oneOf } from './validation'

const ROLES = ['staff', 'admin'] as const
const STATUSES = ['active', 'revoked'] as const

interface UserRow {
  id: string
  email: string
  name: string
  role: string
  status: string
  is_bootstrap: number
  google_sub: string | null
  created_at: string
  last_login_at: string | null
}

const toUser = (row: UserRow) => ({
  id: row.id,
  email: row.email,
  name: row.name,
  role: row.role,
  status: row.status,
  isClubAccount: row.is_bootstrap === 1,
  hasSignedIn: row.google_sub !== null,
  createdAt: row.created_at,
  lastLoginAt: row.last_login_at,
})

const getUser = (env: AppEnv, id: string) => env.DB.prepare('SELECT * FROM users WHERE id = ?').bind(id).first<UserRow>()

async function list(ctx: Ctx): Promise<Response> {
  requireUser(ctx, 'admin')
  const { results } = await ctx.env.DB.prepare('SELECT * FROM users ORDER BY is_bootstrap DESC, status, email').all<UserRow>()
  return json({ users: results.map(toUser) })
}

/** เพิ่มสิทธิ์ให้อีเมลที่ระบุ ผู้ใช้ต้องเข้าสู่ระบบด้วยบัญชี Google ที่ยืนยันอีเมลนี้เอง */
async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request)
  const email = typeof body.email === 'string' ? body.email.trim().toLowerCase() : ''
  if (!email) throw invalid('กรอกอีเมล', 'email')
  if (email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('รูปแบบอีเมลไม่ถูกต้อง', 'email')
  const role = oneOf(body, 'role', 'สิทธิ์', ROLES)
  if (email === clubEmail(ctx.env)) throw invalid('บัญชีชมรมเป็นผู้ดูแลอยู่แล้วโดยอัตโนมัติ ไม่ต้องเพิ่ม', 'email')

  const id = crypto.randomUUID()
  const now = nowIso()
  const result = await ctx.env.DB.prepare(
    `INSERT INTO users (id, email, role, status, created_by, created_at, updated_at) VALUES (?, ?, ?, 'active', ?, ?, ?)
     ON CONFLICT (email) DO NOTHING`,
  )
    .bind(id, email, role, session.user.id, now, now)
    .run()
  if (result.meta.changes !== 1) {
    throw new HttpError(409, 'user_exists', 'อีเมลนี้อยู่ในรายชื่อทีมงานแล้ว แก้สิทธิ์หรือคืนสิทธิ์ได้จากรายการเดิม', { field: 'email' })
  }
  await audit(ctx.env, session.user.id, 'user.added', id, role)
  return json({ user: toUser((await getUser(ctx.env, id))!) }, 201)
}

async function update(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx, 'admin')
  const body = await readJson(ctx.request)
  const target = await getUser(ctx.env, id)
  if (!target) throw new HttpError(404, 'not_found', 'ไม่พบบัญชีทีมงานนี้')
  if (target.is_bootstrap === 1) throw new HttpError(409, 'club_account_locked', 'บัญชีชมรมเป็นผู้ดูแลหลัก เปลี่ยนสิทธิ์หรือถอนสิทธิ์ไม่ได้')
  if (target.id === session.user.id) throw new HttpError(409, 'cannot_change_self', 'เปลี่ยนสิทธิ์ของบัญชีตัวเองไม่ได้ ให้ผู้ดูแลคนอื่นทำแทน')

  const role = body.role === undefined ? target.role : oneOf(body, 'role', 'สิทธิ์', ROLES)
  const status = body.status === undefined ? target.status : oneOf(body, 'status', 'สถานะ', STATUSES)
  const statements = [ctx.env.DB.prepare('UPDATE users SET role = ?, status = ?, updated_at = ? WHERE id = ?').bind(role, status, nowIso(), id)]
  // ถอนสิทธิ์หรือลดสิทธิ์: ยกเลิก session ที่มีอยู่ทันที
  if (status === 'revoked' || role !== target.role) statements.push(ctx.env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(id))
  await ctx.env.DB.batch(statements)
  await audit(ctx.env, session.user.id, 'user.updated', id, `${role}/${status}`)
  return json({ user: toUser((await getUser(ctx.env, id))!) })
}

export async function handleUsers(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0) {
    if (method === 'GET') return list(ctx)
    if (method === 'POST') return create(ctx)
  }
  if (parts.length === 1 && method === 'PATCH') return update(ctx, parts[0])
  return null
}
