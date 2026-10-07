import { nowIso } from './env'
import type { AppEnv, Ctx } from './env'
import { HttpError, json, readJson } from './http'
import { createEvent, toApiEvent, updateEvent } from './gcal'
import { requireMutation, requireUser } from './session'
import { loadResource } from './sync'
import { expectedVersion, findIdempotent, hashPayload, idempotencyInsert, idempotencyKey, invalid, text, versionConflict } from './validation'

type EventRow = Parameters<typeof toApiEvent>[0]
const toEvent = toApiEvent

const LOCAL_DATETIME = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/

/** เวลาท้องถิ่น Asia/Bangkok รูปแบบ YYYY-MM-DDTHH:mm และต้องเป็นวันเวลาที่มีจริง */
function localDateTime(body: Record<string, unknown>, field: string, label: string): string {
  const raw = body[field]
  const match = typeof raw === 'string' ? LOCAL_DATETIME.exec(raw) : null
  if (!match) throw invalid(`${label}ไม่ถูกต้อง`, field)
  const [, y, m, d, hh, mm] = match.map(Number)
  const date = new Date(Date.UTC(y, m - 1, d, hh, mm))
  const real = date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d && hh < 24 && mm < 60
  if (!real) throw invalid(`${label}ไม่ถูกต้อง`, field)
  return raw as string
}

function parseInput(body: Record<string, unknown>) {
  if (typeof body.allDay !== 'boolean') throw invalid('ระบุว่าเป็นกำหนดการทั้งวันหรือไม่', 'allDay')
  const input = {
    title: text(body, 'title', 'ชื่อกำหนดการ', 120, true),
    allDay: body.allDay,
    start: localDateTime(body, 'start', 'วันเวลาเริ่ม'),
    end: localDateTime(body, 'end', 'วันเวลาสิ้นสุด'),
    location: text(body, 'location', 'สถานที่หรือลิงก์', 500),
    description: text(body, 'description', 'รายละเอียด', 4000),
  }
  if (input.end.slice(0, 10) < input.start.slice(0, 10)) throw invalid('วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่ม', 'end')
  if (input.allDay) {
    if (!input.start.endsWith('T00:00') || !input.end.endsWith('T23:59')) throw invalid('เวลาของกำหนดการทั้งวันไม่ถูกต้อง', 'start')
  } else if (input.end <= input.start) {
    throw invalid('เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม', 'end')
  }
  return input
}

const getEvent = (env: AppEnv, id: string) => env.DB.prepare('SELECT * FROM events WHERE id = ?').bind(id).first<EventRow>()

async function list(ctx: Ctx): Promise<Response> {
  requireUser(ctx)
  // รายการที่ถูกยกเลิกหรือลบใน Google ไม่แสดง (แถวยังเก็บไว้)
  const { results } = await ctx.env.DB.prepare(`SELECT * FROM events WHERE source_state = 'ok' ORDER BY start_at, title`).all<EventRow>()
  return json({ events: results.map(toEvent) })
}

async function create(ctx: Ctx): Promise<Response> {
  const session = await requireMutation(ctx)
  const key = idempotencyKey(ctx.request)
  const input = parseInput(await readJson(ctx.request))
  const payloadHash = await hashPayload(input)

  const replay = async () => {
    const existingId = await findIdempotent(ctx.env, session.user.id, key, 'event.create', payloadHash)
    const row = existingId ? await getEvent(ctx.env, existingId) : null
    return row ? json({ event: toEvent(row), replayed: true }) : null
  }
  const replayed = await replay()
  if (replayed) return replayed

  const calendar = await loadResource(ctx.env, 'calendar')
  if (calendar) {
    // เชื่อมปฏิทินแล้ว: จอง id กับ key ก่อน แล้วสร้างที่ Google ด้วย event ID ที่ได้จาก id นั้น คำขอเดิมที่ลองใหม่จึงไม่สร้างรายการซ้ำ
    let localId = await findIdempotent(ctx.env, session.user.id, key, 'event.create', payloadHash)
    if (!localId) {
      localId = crypto.randomUUID()
      await idempotencyInsert(ctx.env, session.user.id, key, 'event.create', payloadHash, localId).run().catch(() => undefined)
      localId = (await findIdempotent(ctx.env, session.user.id, key, 'event.create', payloadHash)) ?? localId
    }
    const result = await createEvent(ctx.env, calendar, localId, input)
    return json({ event: toEvent(result.row), verified: result.verified }, 201)
  }

  const id = crypto.randomUUID()
  const now = nowIso()
  try {
    await ctx.env.DB.batch([
      idempotencyInsert(ctx.env, session.user.id, key, 'event.create', payloadHash, id),
      ctx.env.DB.prepare(
        `INSERT INTO events (id, title, all_day, start_at, end_at, location, description, version, created_by, updated_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?)`,
      ).bind(id, input.title, input.allDay ? 1 : 0, input.start, input.end, input.location, input.description, session.user.id, session.user.id, now, now),
    ])
  } catch (error) {
    const again = await replay()
    if (again) return again
    throw error
  }
  return json({ event: toEvent((await getEvent(ctx.env, id))!) }, 201)
}

async function update(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request)
  const input = parseInput(body)
  const version = expectedVersion(body)
  const existing = await getEvent(ctx.env, id)
  if (existing?.source === 'calendar') {
    const calendar = await loadResource(ctx.env, 'calendar')
    if (calendar && calendar.resourceId === existing.google_calendar_id) {
      const saved = await updateEvent(ctx.env, calendar, existing, input, version)
      return json({ event: toEvent(saved.row), verified: saved.verified })
    }
  }
  const result = await ctx.env.DB.prepare(
    `UPDATE events SET title = ?, all_day = ?, start_at = ?, end_at = ?, location = ?, description = ?,
            version = version + 1, updated_by = ?, updated_at = ?
      WHERE id = ? AND version = ?`,
  )
    .bind(input.title, input.allDay ? 1 : 0, input.start, input.end, input.location, input.description, session.user.id, nowIso(), id, version)
    .run()
  if (result.meta.changes !== 1) {
    const current = await getEvent(ctx.env, id)
    if (!current) throw new HttpError(404, 'not_found', 'ไม่พบกำหนดการนี้ อาจถูกลบหรือลิงก์ไม่ถูกต้อง')
    throw versionConflict(toEvent(current))
  }
  return json({ event: toEvent((await getEvent(ctx.env, id))!) })
}

export async function handleEvents(ctx: Ctx, parts: string[]): Promise<Response | null> {
  const method = ctx.request.method
  if (parts.length === 0) {
    if (method === 'GET') return list(ctx)
    if (method === 'POST') return create(ctx)
  }
  if (parts.length === 1 && method === 'PATCH') return update(ctx, parts[0])
  return null
}
