import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { audit, requireMutation, requireUser } from './session'
import { expectedVersion, invalid, oneOf, text, versionConflict } from './validation'

/**
 * โปรไฟล์นักกีฬา: ข้อมูลเพิ่มเติมของคนในทะเบียนสมาชิก (คนละหนึ่งโปรไฟล์) ผูกกับ member ID ที่เสถียร
 * - ชื่อ ชื่อเล่น รหัสนักศึกษา สถานะสมาชิก และรูป มาจากทะเบียนสมาชิกเสมอ ไม่เก็บซ้ำ จึงไม่มีบุคคลซ้ำสองชุด
 * - นักกีฬาไม่ใช่สิทธิ์ของระบบ: ไม่เกี่ยวกับบทบาททีมงาน และไม่เกี่ยวกับบัญชีเข้าสู่ระบบของสมาชิก
 *   เพิ่มหรือถอดโปรไฟล์นักกีฬาไม่สร้าง ไม่ลบ และไม่เปลี่ยนบัญชี รหัสผ่าน หรือ session ของคนนั้น
 * - ทีมงาน (staff/admin) จัดการได้ตามสิทธิ์จัดการทะเบียนเดิม สมาชิกเปิดไม่ได้
 * - ข้อมูลอยู่ในเว็บเท่านั้น การซิงค์ Google Sheets ไม่อ่านและไม่เขียนตารางนี้
 */
const STATUSES = ['active', 'inactive'] as const

interface AthleteRow {
  member_id: string
  game: string
  team: string
  position: string
  ign: string
  status: (typeof STATUSES)[number]
  note: string
  version: number
  created_at: string
  updated_at: string
  name: string
  nickname: string
  student_id: string
  member_status: string
  source_state: string
  photo_version: string | null
}

// ข้อมูลบุคคลอ่านจากทะเบียนสมาชิกทุกครั้ง และอ่านเฉพาะรุ่นของรูป ไม่อ่านตัวรูป
const ATHLETE_WITH_MEMBER = `
  SELECT t.member_id, t.game, t.team, t.position, t.ign, t.status, t.note, t.version, t.created_at, t.updated_at,
         m.name, m.nickname, m.student_id, m.status AS member_status, m.source_state, p.version AS photo_version
    FROM athletes t JOIN members m ON m.id = t.member_id LEFT JOIN member_photos p ON p.member_id = m.id`

const toAthlete = (row: AthleteRow) => ({
  /** รหัสสมาชิกในทะเบียน (ตัวตนของนักกีฬาคือคนในทะเบียนคนนี้) */
  memberId: row.member_id,
  name: row.name,
  nickname: row.nickname,
  studentId: row.student_id,
  memberStatus: row.member_status,
  /** missing = ไม่พบแถวของคนนี้ในชีตต้นฉบับแล้ว (ทะเบียนและโปรไฟล์นักกีฬายังเก็บไว้) */
  memberSourceState: row.source_state,
  photoVersion: row.photo_version,
  game: row.game,
  team: row.team,
  position: row.position,
  ign: row.ign,
  status: row.status,
  note: row.note,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
})

function parseInput(body: Record<string, unknown>) {
  return {
    game: text(body, 'game', 'เกม', 60, true),
    team: text(body, 'team', 'ทีม', 60),
    position: text(body, 'position', 'ตำแหน่ง', 60),
    ign: text(body, 'ign', 'ชื่อในเกม', 60),
    status: oneOf(body, 'status', 'สถานะนักกีฬา', STATUSES),
    note: text(body, 'note', 'หมายเหตุ', 2000),
  }
}

const getAthlete = (env: AppEnv, memberId: string) => env.DB.prepare(`${ATHLETE_WITH_MEMBER} WHERE t.member_id = ?`).bind(memberId).first<AthleteRow>()

const athleteNotFound = () => new HttpError(404, 'not_found', 'ไม่พบโปรไฟล์นักกีฬานี้ อาจถูกถอดออกแล้ว')

async function list(ctx: Ctx): Promise<Response> {
  requireUser(ctx)
  const { results } = await ctx.env.DB.prepare(`${ATHLETE_WITH_MEMBER} ORDER BY t.status, t.game COLLATE NOCASE, m.name`).all<AthleteRow>()
  return json({ athletes: results.map(toAthlete) })
}

/** POST /api/athletes — เพิ่มโปรไฟล์นักกีฬาให้คนที่อยู่ในทะเบียนสมาชิกแล้ว (ระบุด้วยรหัสสมาชิก ไม่จับคู่จากชื่อ) */
async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request, 16 * 1024)
  const memberId = body.memberId
  if (typeof memberId !== 'string' || !memberId || memberId.length > 64) throw invalid('เลือกสมาชิกที่จะเพิ่มเป็นนักกีฬา', 'memberId')
  const input = parseInput(body)
  const member = await ctx.env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(memberId).first<{ id: string }>()
  if (!member) throw new HttpError(404, 'member_not_found', 'ไม่พบสมาชิกนี้ในทะเบียน ยังไม่ได้เพิ่มนักกีฬา โหลดรายชื่อใหม่แล้วเลือกอีกครั้ง', { field: 'memberId' })
  const now = nowIso()
  const result = await ctx.env.DB.prepare(
    `INSERT INTO athletes (member_id, game, team, position, ign, status, note, version, created_by, updated_by, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?) ON CONFLICT (member_id) DO NOTHING`,
  )
    .bind(memberId, input.game, input.team, input.position, input.ign, input.status, input.note, session.user.id, session.user.id, now, now)
    .run()
  const row = (await getAthlete(ctx.env, memberId))!
  if (result.meta.changes < 1) {
    // คนนี้เป็นนักกีฬาอยู่แล้ว (รวมถึงคำขอเดิมที่ส่งซ้ำ): ไม่สร้างซ้ำและไม่เขียนทับ ส่งโปรไฟล์ปัจจุบันให้ตรวจ
    throw new HttpError(409, 'already_athlete', 'สมาชิกคนนี้เป็นนักกีฬาอยู่แล้ว ยังไม่ได้บันทึกสิ่งที่กรอก เปิดโปรไฟล์เดิมเพื่อแก้ไขแทน', { current: toAthlete(row), field: 'memberId' })
  }
  await audit(ctx.env, session.user.id, 'athlete.added', memberId)
  return json({ athlete: toAthlete(row) }, 201)
}

async function update(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request, 16 * 1024)
  const input = parseInput(body)
  const version = expectedVersion(body)
  const result = await ctx.env.DB.prepare(
    `UPDATE athletes SET game = ?, team = ?, position = ?, ign = ?, status = ?, note = ?, version = version + 1, updated_by = ?, updated_at = ?
      WHERE member_id = ? AND version = ?`,
  )
    .bind(input.game, input.team, input.position, input.ign, input.status, input.note, session.user.id, nowIso(), memberId, version)
    .run()
  const row = await getAthlete(ctx.env, memberId)
  if (!row) throw athleteNotFound()
  if (result.meta.changes < 1) throw versionConflict(toAthlete(row))
  await audit(ctx.env, session.user.id, 'athlete.updated', memberId)
  return json({ athlete: toAthlete(row) })
}

/**
 * POST /api/athletes/:memberId/remove — ถอดโปรไฟล์นักกีฬา (เลิกสถานะนักกีฬา)
 * ลบเฉพาะแถวโปรไฟล์นักกีฬา ทะเบียนสมาชิก รูป บัญชีเข้าสู่ระบบ และ session ของคนนั้นไม่ถูกแตะ ไม่มีโปรไฟล์อยู่แล้วก็ตอบสำเร็จ (เรียกซ้ำได้)
 */
async function remove(ctx: Ctx, memberId: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request, 1024)
  const version = expectedVersion(body)
  const result = await ctx.env.DB.prepare('DELETE FROM athletes WHERE member_id = ? AND version = ?').bind(memberId, version).run()
  if (result.meta.changes < 1) {
    const row = await getAthlete(ctx.env, memberId)
    if (!row) return json({ removed: false })
    throw versionConflict(toAthlete(row))
  }
  await audit(ctx.env, session.user.id, 'athlete.removed', memberId)
  return json({ removed: true })
}

export async function handleAthletes(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0) {
    if (method === 'GET') return list(ctx)
    if (method === 'POST') return create(ctx)
  }
  if (parts.length === 1 && method === 'PATCH') return update(ctx, parts[0])
  if (parts.length === 2 && parts[1] === 'remove' && method === 'POST') return remove(ctx, parts[0])
  return null
}
