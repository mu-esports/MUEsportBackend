import { nowIso } from './env'
import type { AppEnv } from './env'
import { HttpError } from './http'
import {
  batchAll, bumpDataVersion, CursorInvalid, GoogleApiError, isUnknownOutcome, jsonInit, makeGapi, outcomeUnknown, patchResource, registerSyncer,
  requireWritable, toHttpError,
} from './sync'
import type { Gapi, SyncResource } from './sync'
import { versionConflict } from './validation'

/**
 * Google Calendar ↔ ปฏิทินชมรม
 * - จับคู่ด้วย calendar ID + event ID ของ Google เท่านั้น ไม่ใช้ชื่อหรือวันที่เป็นตัวตน
 * - ใช้ incremental sync (sync token) ตามเอกสารของ Google: รอบแรกดึงทั้งหมดแบบแบ่งหน้า รอบถัดไปดึงเฉพาะที่เปลี่ยน
 *   token หมดอายุ (410) → ดึงใหม่ทั้งชุดเฉพาะปฏิทินนี้ ไม่แตะข้อมูลอื่น
 * - กำหนดการซ้ำ: เก็บตัวตนของ series แยก แล้วให้ Google กระจายรายการย่อย (รวมข้อยกเว้น) ในช่วงเวลาที่กำหนด
 *   เว็บไม่แก้ series หรือรายการย่อย ให้เปิด Google Calendar แทน
 * - การเขียนจากเว็บส่งเฉพาะฟิลด์ที่เปลี่ยน พร้อม If-Match (etag) และ sendUpdates=none จึงไม่ทับการแก้ของคนอื่น ไม่แตะแขก และไม่ส่งอีเมลเชิญ
 */
export const CAL_API = 'https://www.googleapis.com/calendar/v3'
const TZ = 'Asia/Bangkok'
const TZ_OFFSET_MS = 7 * 60 * 60 * 1000
const DAY_MS = 24 * 60 * 60 * 1000
/** รอบดึงทั้งชุดเริ่มจากย้อนหลังเท่านี้ */
const FULL_SYNC_PAST_DAYS = 400
const INSTANCE_PAST_DAYS = 180
const INSTANCE_FUTURE_DAYS = 400
const REEXPAND_AFTER_MS = 12 * 60 * 60 * 1000
const MAX_PAGES = 4
const MAX_SERIES_PER_RUN = 6

export const calendarUrl = (calendarId: string) => `https://calendar.google.com/calendar/embed?src=${encodeURIComponent(calendarId)}&ctz=${encodeURIComponent(TZ)}`
const eventsUrl = (calendarId: string) => `${CAL_API}/calendars/${encodeURIComponent(calendarId)}/events`

type GEvent = Record<string, any>

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * DAY_MS).toISOString().slice(0, 10)

/** เวลาใด ๆ (มี offset) → เวลาท้องถิ่น Asia/Bangkok รูปแบบ YYYY-MM-DDTHH:mm */
export function toBangkok(dateTime: string): string | null {
  const ms = Date.parse(dateTime)
  if (Number.isNaN(ms)) return null
  return new Date(ms + TZ_OFFSET_MS).toISOString().slice(0, 16)
}

export interface LocalTimes {
  allDay: boolean
  start: string
  end: string
}

/** แปลงเวลาของ Google เป็นรูปแบบของระบบ: ทั้งวันของ Google ใช้วันสิ้นสุดแบบไม่รวม (exclusive) จึงลบหนึ่งวัน */
export function fromGoogleTimes(item: GEvent): LocalTimes | null {
  const s = item.start ?? {}
  const e = item.end ?? {}
  if (typeof s.date === 'string') {
    const last = typeof e.date === 'string' && e.date > s.date ? addDays(e.date, -1) : s.date
    return { allDay: true, start: `${s.date}T00:00`, end: `${last}T23:59` }
  }
  if (typeof s.dateTime === 'string') {
    const start = toBangkok(s.dateTime)
    const end = typeof e.dateTime === 'string' ? toBangkok(e.dateTime) : start
    if (!start || !end) return null
    return { allDay: false, start, end: end < start ? start : end }
  }
  return null
}

export function toGoogleTimes(t: LocalTimes): { start: Record<string, string>; end: Record<string, string> } {
  if (t.allDay) return { start: { date: t.start.slice(0, 10) }, end: { date: addDays(t.end.slice(0, 10), 1) } }
  return { start: { dateTime: `${t.start}:00+07:00`, timeZone: TZ }, end: { dateTime: `${t.end}:00+07:00`, timeZone: TZ } }
}

export interface EventInput extends LocalTimes {
  title: string
  location: string
  description: string
}

interface EventRow {
  id: string
  title: string
  all_day: number
  start_at: string
  end_at: string
  location: string
  description: string
  version: number
  created_at: string
  updated_at: string
  source: string
  google_calendar_id: string | null
  google_event_id: string | null
  etag: string | null
  recurring_event_id: string | null
  source_state: string
  html_link: string | null
  editable: number
  edit_note: string
}

export const toApiEvent = (row: EventRow) => ({
  id: row.id,
  title: row.title,
  allDay: row.all_day === 1,
  start: row.start_at,
  end: row.end_at,
  location: row.location,
  description: row.description,
  version: row.version,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  // calendar = สำเนาจาก Google Calendar ที่เชื่อม, local = อยู่เฉพาะในเว็บ
  source: row.source,
  recurring: row.recurring_event_id !== null,
  editable: row.editable === 1,
  editNote: row.edit_note,
  googleUrl: row.html_link,
})

const SPECIAL_TYPES = new Set(['birthday', 'outOfOffice', 'focusTime', 'workingLocation', 'fromGmail'])

function editability(item: GEvent): { editable: number; note: string } {
  if (item.recurringEventId || item.recurrence) return { editable: 0, note: 'เป็นกำหนดการซ้ำ การแก้ครั้งเดียวหรือทั้งชุดต้องทำใน Google Calendar เพื่อไม่ให้ชุดกำหนดการเสียหาย' }
  if (item.eventType && SPECIAL_TYPES.has(item.eventType)) return { editable: 0, note: 'เป็นรายการชนิดพิเศษของ Google Calendar แก้ได้ใน Google Calendar เท่านั้น' }
  if (item.organizer && item.organizer.self === false) return { editable: 0, note: 'ปฏิทินนี้ไม่ใช่ผู้จัดของกำหนดการนี้ (ได้รับเชิญมา) แก้ได้จากผู้จัดใน Google Calendar' }
  if (item.locked) return { editable: 0, note: 'กำหนดการนี้ถูกล็อกใน Google Calendar' }
  return { editable: 1, note: '' }
}

const SYNC_USER = 'google-sync'

/** คำสั่งบันทึกกำหนดการหนึ่งรายการจาก Google ลงสำเนา (ตัดสินด้วย etag ว่าเปลี่ยนหรือไม่) */
function upsertStatement(env: AppEnv, calendarId: string, item: GEvent, runId: string, localId?: string): D1PreparedStatement | null {
  const times = fromGoogleTimes(item)
  if (!times || typeof item.id !== 'string') return null
  const { editable, note } = editability(item)
  const now = nowIso()
  const title = typeof item.summary === 'string' && item.summary.trim() ? item.summary.trim() : '(ไม่มีชื่อ)'
  return env.DB.prepare(
    `INSERT INTO events (id, title, all_day, start_at, end_at, location, description, version, created_by, updated_by, created_at, updated_at,
                         source, google_calendar_id, google_event_id, etag, recurring_event_id, source_state, html_link, editable, edit_note, seen_run)
     VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, 'calendar', ?, ?, ?, ?, 'ok', ?, ?, ?, ?)
     ON CONFLICT (google_calendar_id, google_event_id) WHERE google_event_id IS NOT NULL DO UPDATE SET
       title = excluded.title, all_day = excluded.all_day, start_at = excluded.start_at, end_at = excluded.end_at,
       location = excluded.location, description = excluded.description,
       version = events.version + (events.etag IS NOT excluded.etag OR events.source_state != 'ok'),
       updated_at = CASE WHEN events.etag IS NOT excluded.etag THEN excluded.updated_at ELSE events.updated_at END,
       source = 'calendar', etag = excluded.etag, recurring_event_id = excluded.recurring_event_id, source_state = 'ok',
       html_link = excluded.html_link, editable = excluded.editable, edit_note = excluded.edit_note, seen_run = excluded.seen_run`,
  ).bind(
    localId ?? crypto.randomUUID(), title, times.allDay ? 1 : 0, times.start, times.end,
    typeof item.location === 'string' ? item.location : '', typeof item.description === 'string' ? item.description : '',
    SYNC_USER, SYNC_USER, now, now, calendarId, item.id, typeof item.etag === 'string' ? item.etag : null,
    typeof item.recurringEventId === 'string' ? item.recurringEventId : null, typeof item.htmlLink === 'string' ? item.htmlLink : null, editable, note, runId,
  )
}

interface Cursor {
  syncToken?: string
  pageToken?: string
  /** รอบดึงทั้งชุดที่ยังไม่จบ: id ของรอบ และจุดเริ่มเวลา */
  full?: { runId: string; timeMin: string }
}

const cancelEvent = (env: AppEnv, calendarId: string, eventId: string) =>
  env.DB.prepare(`UPDATE events SET source_state = 'cancelled', version = version + 1 WHERE google_calendar_id = ? AND google_event_id = ? AND source_state = 'ok'`).bind(calendarId, eventId)

/** ให้ Google กระจายรายการย่อยของ series (รวมข้อยกเว้นที่ย้ายหรือยกเลิก) แล้วปรับสำเนาของ series นั้นให้ตรง */
async function expandSeries(env: AppEnv, gapi: Gapi, calendarId: string, seriesId: string): Promise<void> {
  const runId = crypto.randomUUID()
  const now = Date.now()
  const params = new URLSearchParams({
    timeMin: new Date(now - INSTANCE_PAST_DAYS * DAY_MS).toISOString(),
    timeMax: new Date(now + INSTANCE_FUTURE_DAYS * DAY_MS).toISOString(),
    maxResults: '250',
    showDeleted: 'false',
  })
  const statements: D1PreparedStatement[] = []
  let complete = false
  for (let page = 0; page < 3; page++) {
    let data: GEvent
    try {
      data = await gapi.json(`${eventsUrl(calendarId)}/${encodeURIComponent(seriesId)}/instances?${params}`)
    } catch (error) {
      // series ถูกลบไปแล้ว: ถือว่าไม่มีรายการย่อยเหลือ
      if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) {
        complete = true
        break
      }
      throw error
    }
    for (const item of (data.items ?? []) as GEvent[]) {
      if (item.status === 'cancelled') continue
      const statement = upsertStatement(env, calendarId, { ...item, recurringEventId: item.recurringEventId ?? seriesId }, runId)
      if (statement) statements.push(statement)
    }
    if (!data.nextPageToken) {
      complete = true
      break
    }
    params.set('pageToken', data.nextPageToken)
  }
  if (complete) {
    // รายการย่อยที่ Google ไม่ส่งมาแล้ว (ถูกยกเลิกหรือกฎการซ้ำเปลี่ยน) ไม่แสดงต่อ
    statements.push(
      env.DB.prepare(
        `UPDATE events SET source_state = 'cancelled', version = version + 1
          WHERE google_calendar_id = ? AND recurring_event_id = ? AND source_state = 'ok' AND (seen_run IS NULL OR seen_run != ?)`,
      ).bind(calendarId, seriesId, runId),
    )
  }
  statements.push(
    env.DB.prepare('UPDATE calendar_series SET needs_expand = ?, expanded_at = ? WHERE calendar_id = ? AND event_id = ?').bind(complete ? 0 : 1, nowIso(), calendarId, seriesId),
  )
  await batchAll(env, statements)
}

registerSyncer('calendar', async ({ env, gapi, resource, cursor: rawCursor }) => {
  const calendarId = resource!.resourceId
  let cursor: Cursor = {}
  try {
    cursor = rawCursor ? (JSON.parse(rawCursor) as Cursor) : {}
  } catch {
    cursor = {}
  }
  let changed = false
  const runId = cursor.full?.runId ?? crypto.randomUUID()
  const incremental = !!cursor.syncToken
  if (!incremental && !cursor.full) {
    cursor = { full: { runId, timeMin: new Date(Date.now() - FULL_SYNC_PAST_DAYS * DAY_MS).toISOString() } }
  }

  let finished = false
  for (let page = 0; page < MAX_PAGES && gapi.remaining() > MAX_SERIES_PER_RUN; page++) {
    // singleEvents=false: ได้ series และข้อยกเว้นตามตัวตนจริง ไม่ใช่สำเนาที่กระจายแล้ว
    const params = new URLSearchParams({ maxResults: '250', singleEvents: 'false' })
    if (cursor.syncToken) params.set('syncToken', cursor.syncToken)
    else params.set('timeMin', cursor.full!.timeMin)
    if (cursor.pageToken) params.set('pageToken', cursor.pageToken)

    let data: GEvent
    try {
      data = await gapi.json(`${eventsUrl(calendarId)}?${params}`)
    } catch (error) {
      // sync token หรือ page token ใช้ไม่ได้แล้ว: ล้าง cursor เพื่อดึงใหม่ทั้งชุดของปฏิทินนี้
      if (error instanceof GoogleApiError && error.status === 410) throw new CursorInvalid()
      throw error
    }

    const statements: D1PreparedStatement[] = []
    for (const item of (data.items ?? []) as GEvent[]) {
      if (typeof item.id !== 'string') continue
      if (item.recurringEventId) {
        // ข้อยกเว้นของ series (แก้ครั้งเดียว/ยกเลิกครั้งเดียว): ให้กระจาย series นั้นใหม่จาก Google
        statements.push(
          env.DB.prepare(
            `INSERT INTO calendar_series (calendar_id, event_id, needs_expand, seen_run) VALUES (?, ?, 1, ?)
             ON CONFLICT (calendar_id, event_id) DO UPDATE SET needs_expand = 1`,
          ).bind(calendarId, item.recurringEventId, runId),
        )
      } else if (item.status === 'cancelled') {
        statements.push(
          cancelEvent(env, calendarId, item.id),
          // ถ้าเป็น series: ยกเลิกรายการย่อยทั้งหมดและลบตัวตนของ series
          env.DB.prepare(`UPDATE events SET source_state = 'cancelled', version = version + 1 WHERE google_calendar_id = ? AND recurring_event_id = ? AND source_state = 'ok'`).bind(calendarId, item.id),
          env.DB.prepare('DELETE FROM calendar_series WHERE calendar_id = ? AND event_id = ?').bind(calendarId, item.id),
        )
      } else if (Array.isArray(item.recurrence)) {
        statements.push(
          env.DB.prepare(
            `INSERT INTO calendar_series (calendar_id, event_id, etag, needs_expand, seen_run) VALUES (?, ?, ?, 1, ?)
             ON CONFLICT (calendar_id, event_id) DO UPDATE SET needs_expand = (calendar_series.etag IS NOT excluded.etag) OR calendar_series.needs_expand,
               etag = excluded.etag, seen_run = excluded.seen_run`,
          ).bind(calendarId, item.id, item.etag ?? null, runId),
          // รายการเดี่ยวที่ถูกเปลี่ยนเป็นกำหนดการซ้ำ: แถวเดิมของรายการเดี่ยวไม่ใช้แล้ว
          env.DB.prepare(`UPDATE events SET source_state = 'cancelled', version = version + 1 WHERE google_calendar_id = ? AND google_event_id = ? AND recurring_event_id IS NULL AND source_state = 'ok'`).bind(calendarId, item.id),
        )
      } else {
        const statement = upsertStatement(env, calendarId, item, runId)
        if (statement) statements.push(statement)
      }
    }
    if (statements.length > 0) {
      await batchAll(env, statements)
      changed = true
    }

    if (data.nextPageToken) {
      cursor = { ...cursor, pageToken: data.nextPageToken }
      continue
    }
    if (typeof data.nextSyncToken !== 'string') throw new CursorInvalid()
    if (cursor.full) {
      // จบรอบดึงทั้งชุด: รายการเดี่ยวและ series ในช่วงที่ดึงซึ่ง Google ไม่ส่งมาแล้ว ถือว่าถูกลบที่ Google
      const since = toBangkok(cursor.full.timeMin)!
      const swept = await env.DB.batch([
        env.DB.prepare(
          `UPDATE events SET source_state = 'cancelled', version = version + 1
            WHERE source = 'calendar' AND google_calendar_id = ? AND recurring_event_id IS NULL AND source_state = 'ok'
              AND end_at >= ? AND (seen_run IS NULL OR seen_run != ?)`,
        ).bind(calendarId, since, runId),
        env.DB.prepare(
          `UPDATE events SET source_state = 'cancelled', version = version + 1
            WHERE source = 'calendar' AND google_calendar_id = ? AND source_state = 'ok' AND recurring_event_id IN
              (SELECT event_id FROM calendar_series WHERE calendar_id = ? AND (seen_run IS NULL OR seen_run != ?))`,
        ).bind(calendarId, calendarId, runId),
        env.DB.prepare('DELETE FROM calendar_series WHERE calendar_id = ? AND (seen_run IS NULL OR seen_run != ?)').bind(calendarId, runId),
      ])
      if (swept.some((r) => r.meta.changes > 0)) changed = true
    }
    cursor = { syncToken: data.nextSyncToken }
    finished = true
    break
  }

  // กระจาย series ที่เปลี่ยน หรือที่กระจายไว้นานแล้ว (ให้ช่วงเวลาข้างหน้าเลื่อนตามวัน) จำนวนจำกัดต่อรอบ
  const stale = new Date(Date.now() - REEXPAND_AFTER_MS).toISOString()
  const { results: series } = await env.DB.prepare(
    `SELECT event_id FROM calendar_series WHERE calendar_id = ? AND (needs_expand = 1 OR expanded_at IS NULL OR expanded_at < ?)
      ORDER BY needs_expand DESC, expanded_at LIMIT ?`,
  )
    .bind(calendarId, stale, MAX_SERIES_PER_RUN)
    .all<{ event_id: string }>()
  for (const s of series) {
    if (gapi.remaining() < 3) break
    await expandSeries(env, gapi, calendarId, s.event_id)
    changed = true
  }

  void finished
  return { changed, cursor: JSON.stringify(cursor) }
})

// ---------- เว็บ → Google Calendar ----------

const getByGoogleId = (env: AppEnv, calendarId: string, eventId: string) =>
  env.DB.prepare('SELECT * FROM events WHERE google_calendar_id = ? AND google_event_id = ?').bind(calendarId, eventId).first<EventRow>()

/** event ID ของ Google ที่ได้จาก id ในระบบ (ตัวอักษร 0-9 a-f อยู่ในชุดที่ Google รับ) ใช้ซ้ำได้เมื่อ retry จึงไม่เกิดรายการซ้ำ */
export const googleIdFor = (localId: string) => `mu${localId.replace(/-/g, '').toLowerCase()}`

const sameAsInput = (item: GEvent, input: EventInput) => {
  const times = fromGoogleTimes(item)
  return (
    !!times && times.allDay === input.allDay && times.start === input.start && times.end === input.end &&
    (item.summary ?? '') === input.title && (item.location ?? '') === input.location && (item.description ?? '') === input.description
  )
}

async function store(env: AppEnv, calendarId: string, item: GEvent, localId?: string): Promise<EventRow> {
  const statement = upsertStatement(env, calendarId, item, 'web', localId)
  if (!statement) throw new HttpError(502, 'saved_unverified', 'Google Calendar รับการบันทึกแล้ว แต่คำตอบที่ได้อ่านไม่ได้ กด “อัปเดตจาก Google” เพื่อตรวจ')
  await statement.run()
  await bumpDataVersion(env, 'calendar')
  return (await getByGoogleId(env, calendarId, item.id))!
}

/** Google ปฏิเสธการเขียนเพราะสิทธิ์: บันทึกว่าแหล่งนี้อ่านได้อย่างเดียว เพื่อให้เว็บแสดงตามจริงและไม่ลองเขียนซ้ำ */
async function handleForbidden(env: AppEnv, error: unknown): Promise<never> {
  if (error instanceof GoogleApiError && error.status === 403 && !['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded'].includes(error.reason)) {
    if (error.reason === 'forbidden' || error.reason === 'forbiddenForNonOrganizer' || error.reason === 'requiredAccessLevel') {
      if (error.reason !== 'forbiddenForNonOrganizer') await patchResource(env, 'calendar', { access: 'read' })
      throw new HttpError(403, 'source_read_only', 'Google Calendar ไม่อนุญาตให้บัญชีชมรมแก้รายการนี้ ยังไม่ได้บันทึกอะไร แก้ที่ Google Calendar หรือให้เจ้าของปฏิทินเพิ่มสิทธิ์')
    }
  }
  throw error
}

/** เพิ่มกำหนดการจากเว็บ: สร้างที่ Google ด้วย event ID ที่กำหนดเอง ถ้ามีอยู่แล้ว (409) ถือเป็นคำขอเดิมและใช้รายการนั้น */
export async function createEvent(env: AppEnv, resource: SyncResource, localId: string, input: EventInput): Promise<{ row: EventRow; verified: boolean }> {
  requireWritable(resource, 'ปฏิทิน')
  const gapi = makeGapi(env)
  const calendarId = resource.resourceId
  const googleId = googleIdFor(localId)
  try {
    let item: GEvent
    try {
      item = await gapi.json(`${eventsUrl(calendarId)}?sendUpdates=none`, jsonInit('POST', {
        id: googleId, summary: input.title, location: input.location, description: input.description, ...toGoogleTimes(input),
      }))
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 409) {
        item = await gapi.json(`${eventsUrl(calendarId)}/${googleId}`)
        if (item.status === 'cancelled') throw new HttpError(409, 'event_deleted', 'กำหนดการนี้ถูกสร้างและถูกลบใน Google Calendar ไปแล้ว ถ้าต้องการให้เพิ่มเป็นรายการใหม่')
      } else if (isUnknownOutcome(error)) {
        throw outcomeUnknown('กำหนดการใหม่')
      } else {
        return await handleForbidden(env, error)
      }
    }
    return { row: await store(env, calendarId, item, localId), verified: sameAsInput(item, input) }
  } catch (error) {
    throw toHttpError(error)
  }
}

/** แก้กำหนดการจากเว็บ: ส่งเฉพาะฟิลด์ที่เปลี่ยน พร้อม If-Match เพื่อให้ Google ปฏิเสธถ้ารายการถูกแก้ไปแล้ว */
export async function updateEvent(env: AppEnv, resource: SyncResource, row: EventRow, input: EventInput, expectedVersion: number): Promise<{ row: EventRow; verified: boolean }> {
  requireWritable(resource, 'ปฏิทิน')
  if (row.editable !== 1) throw new HttpError(409, 'event_not_editable', `แก้กำหนดการนี้จากเว็บไม่ได้: ${row.edit_note} ยังไม่ได้บันทึกอะไร`, { googleUrl: row.html_link })
  if (row.source_state !== 'ok') throw new HttpError(404, 'not_found', 'กำหนดการนี้ถูกยกเลิกหรือลบใน Google Calendar แล้ว')
  if (row.version !== expectedVersion) throw versionConflict(toApiEvent(row))
  const calendarId = resource.resourceId
  const eventId = row.google_event_id!
  const gapi = makeGapi(env)

  const patch: GEvent = {}
  if (input.title !== row.title) patch.summary = input.title
  if (input.location !== row.location) patch.location = input.location
  if (input.description !== row.description) patch.description = input.description
  if (input.allDay !== (row.all_day === 1) || input.start !== row.start_at || input.end !== row.end_at) Object.assign(patch, toGoogleTimes(input))
  if (Object.keys(patch).length === 0) return { row, verified: true }

  try {
    let item: GEvent
    try {
      item = await gapi.json(`${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}?sendUpdates=none`, jsonInit('PATCH', patch, row.etag ? { 'If-Match': row.etag } : {}))
    } catch (error) {
      if (error instanceof GoogleApiError && error.status === 412) {
        // ถูกแก้ที่ Google หลังสำเนาของเรา: ดึงค่าล่าสุดมาให้ผู้ใช้ตรวจ ยังไม่ได้เขียนอะไร
        const latest = await gapi.json(`${eventsUrl(calendarId)}/${encodeURIComponent(eventId)}`)
        if (latest.status === 'cancelled') {
          await cancelEvent(env, calendarId, eventId).run()
          throw new HttpError(404, 'not_found', 'กำหนดการนี้ถูกลบใน Google Calendar แล้ว')
        }
        throw versionConflict(toApiEvent(await store(env, calendarId, latest)))
      }
      if (error instanceof GoogleApiError && (error.status === 404 || error.status === 410)) {
        await cancelEvent(env, calendarId, eventId).run()
        await bumpDataVersion(env, 'calendar')
        throw new HttpError(404, 'not_found', 'กำหนดการนี้ถูกลบใน Google Calendar แล้ว ยังไม่ได้บันทึกสิ่งที่แก้')
      }
      if (isUnknownOutcome(error)) throw outcomeUnknown('การแก้กำหนดการ')
      return await handleForbidden(env, error)
    }
    return { row: await store(env, calendarId, item), verified: sameAsInput(item, input) }
  } catch (error) {
    throw toHttpError(error)
  }
}

// ---------- ตั้งค่า ----------

export interface CalendarInfo {
  id: string
  name: string
  accessRole: string
  primary: boolean
  timeZone: string
}

export const canWrite = (accessRole: string) => accessRole === 'owner' || accessRole === 'writer'
export const canRead = (accessRole: string) => canWrite(accessRole) || accessRole === 'reader'

/** รายชื่อปฏิทินที่บัญชีชมรมเห็นตาม scope ที่ได้รับ (ถ้ามีเฉพาะ calendar.app.created จะเห็นเฉพาะปฏิทินที่เว็บสร้าง) */
export async function listCalendars(gapi: Gapi): Promise<CalendarInfo[]> {
  const out: CalendarInfo[] = []
  const params = new URLSearchParams({ maxResults: '250', minAccessRole: 'reader' })
  for (let page = 0; page < 4; page++) {
    const data = await gapi.json(`${CAL_API}/users/me/calendarList?${params}`)
    for (const item of (data.items ?? []) as GEvent[]) {
      if (typeof item.id !== 'string' || item.deleted) continue
      out.push({ id: item.id, name: item.summaryOverride ?? item.summary ?? item.id, accessRole: item.accessRole ?? '', primary: item.primary === true, timeZone: item.timeZone ?? '' })
    }
    if (!data.nextPageToken) break
    params.set('pageToken', data.nextPageToken)
  }
  return out
}

/** กำหนดการในเว็บที่อาจซ้ำกับรายการที่มีอยู่แล้วในปฏิทิน (ชื่อและเวลาเริ่มตรงกัน) ให้ผู้ดูแลตัดสินก่อนย้าย */
export async function previewCalendar(env: AppEnv, gapi: Gapi, calendarId: string): Promise<{ localEvents: number; upcoming: number; duplicates: { id: string; title: string; start: string }[]; truncated: boolean }> {
  const { results: local } = await env.DB.prepare(`SELECT id, title, start_at FROM events WHERE source = 'local' ORDER BY start_at`).all<{ id: string; title: string; start_at: string }>()
  const keys = new Set<string>()
  let upcoming = 0
  let truncated = false
  const earliest = local[0]?.start_at
  const params = new URLSearchParams({
    maxResults: '250', singleEvents: 'true', orderBy: 'startTime',
    timeMin: new Date(Math.min(Date.now(), earliest ? Date.parse(`${earliest}:00+07:00`) : Date.now()) - DAY_MS).toISOString(),
    timeMax: new Date(Date.now() + INSTANCE_FUTURE_DAYS * DAY_MS).toISOString(),
  })
  for (let page = 0; page < 3; page++) {
    const data = await gapi.json(`${eventsUrl(calendarId)}?${params}`)
    for (const item of (data.items ?? []) as GEvent[]) {
      const times = fromGoogleTimes(item)
      if (!times) continue
      if (times.end >= toBangkok(new Date().toISOString())!) upcoming++
      keys.add(`${(item.summary ?? '').trim()}|${times.start}`)
    }
    if (!data.nextPageToken) break
    params.set('pageToken', data.nextPageToken)
    truncated = page === 2
  }
  return {
    localEvents: local.length,
    upcoming,
    duplicates: local.filter((e) => keys.has(`${e.title}|${e.start_at}`)).map((e) => ({ id: e.id, title: e.title, start: e.start_at })),
    truncated,
  }
}

/** ก่อนย้าย: จำนวนกำหนดการที่อยู่เฉพาะในเว็บ และรายการที่อาจซ้ำกับของที่มีในปฏิทิน */
export async function previewLocalEvents(env: AppEnv, resource: SyncResource): Promise<{ count: number; duplicates: { id: string; title: string; detail: string }[] }> {
  try {
    const preview = await previewCalendar(env, makeGapi(env), resource.resourceId)
    return { count: preview.localEvents, duplicates: preview.duplicates.map((d) => ({ id: d.id, title: d.title, detail: d.start })) }
  } catch (error) {
    throw toHttpError(error)
  }
}

/** ย้ายกำหนดการที่อยู่เฉพาะในเว็บขึ้นปฏิทิน ทีละชุดเล็ก ทำซ้ำได้: event ID มาจาก id ในระบบ จึงไม่สร้างซ้ำ */
export async function pushLocalEvents(env: AppEnv, resource: SyncResource, skipIds: string[]): Promise<{ pushed: number; remaining: number; skipped: number }> {
  requireWritable(resource, 'ปฏิทิน')
  const gapi = makeGapi(env)
  const calendarId = resource.resourceId
  const skip = new Set(skipIds)
  const { results: local } = await env.DB.prepare(`SELECT * FROM events WHERE source = 'local' ORDER BY start_at`).all<EventRow>()
  const pending = local.filter((e) => !skip.has(e.id))
  let pushed = 0
  try {
    for (const event of pending.slice(0, 10)) {
      const input: EventInput = { title: event.title, location: event.location, description: event.description, allDay: event.all_day === 1, start: event.start_at, end: event.end_at }
      const googleId = googleIdFor(event.id)
      let item: GEvent
      try {
        item = await gapi.json(`${eventsUrl(calendarId)}?sendUpdates=none`, jsonInit('POST', {
          id: googleId, summary: input.title, location: input.location, description: input.description, ...toGoogleTimes(input),
        }))
      } catch (error) {
        if (!(error instanceof GoogleApiError && error.status === 409)) {
          if (isUnknownOutcome(error)) throw outcomeUnknown('กำหนดการที่ย้ายขึ้นปฏิทิน')
          throw error
        }
        item = await gapi.json(`${eventsUrl(calendarId)}/${googleId}`)
      }
      const { editable, note } = editability(item)
      await env.DB.prepare(
        `UPDATE events SET source = 'calendar', google_calendar_id = ?, google_event_id = ?, etag = ?, html_link = ?, editable = ?, edit_note = ?,
                source_state = ?, seen_run = 'web' WHERE id = ? AND source = 'local'`,
      )
        .bind(calendarId, googleId, item.etag ?? null, item.htmlLink ?? null, editable, note, item.status === 'cancelled' ? 'cancelled' : 'ok', event.id)
        .run()
      pushed++
    }
  } catch (error) {
    if (pushed > 0) await bumpDataVersion(env, 'calendar')
    throw toHttpError(error)
  }
  if (pushed > 0) await bumpDataVersion(env, 'calendar')
  return { pushed, remaining: pending.length - pushed, skipped: local.length - pending.length }
}
