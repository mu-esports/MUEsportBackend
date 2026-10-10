import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { fromGoogleTimes, toGoogleTimes } from '../worker/gcal'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'
import { connectClub, FakeWorkspace, googleCalls, loseResponseOnce, syncNow } from './workspace'
import type { FakeCalendar } from './workspace'

// ทุกกรณีในไฟล์นี้ใช้ Google Calendar จำลอง (test/workspace.ts) ไม่ได้ต่อกับ Google จริง
let google: FakeGoogle
let ws: FakeWorkspace
let admin: Actor
let staff: Actor

beforeEach(async () => {
  await resetDb()
  google = await FakeGoogle.start()
  ws = new FakeWorkspace(google)
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staff = await seedUser('staff@example.com', 'staff')
  await connectClub(google)
})
afterEach(() => vi.unstubAllGlobals())

const soon = (days: number, time = '18:00') => `${new Date(Date.now() + days * 86_400_000 + 7 * 3_600_000).toISOString().slice(0, 10)}T${time}`
const timed = (summary: string, start: string, end: string, extra: Record<string, unknown> = {}) => ({
  summary, start: { dateTime: `${start}:00+07:00`, timeZone: 'Asia/Bangkok' }, end: { dateTime: `${end}:00+07:00`, timeZone: 'Asia/Bangkok' }, organizer: { self: true }, ...extra,
})

async function linkCalendar(calendar: FakeCalendar): Promise<void> {
  const res = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'calendar', resourceId: calendar.id } })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
}
const events = async () => (await data(await call('/api/events', { as: staff }))).events as Record<string, any>[]
const byTitle = async (title: string) => (await events()).find((e) => e.title === title)!
const body = (e: Record<string, any>, changes: Record<string, unknown> = {}) => ({
  title: e.title, allDay: e.allDay, start: e.start, end: e.end, location: e.location, description: e.description, expectedVersion: e.version, ...changes,
})
const create = (input: unknown, idem = key(), as: Actor = staff) => call('/api/events', { method: 'POST', as, headers: { 'Idempotency-Key': idem }, body: input })
const status = async () => (await data(await call('/api/sync', { as: staff }))).sync.find((s: any) => s.kind === 'calendar')

describe('แปลงเวลา Google Calendar ↔ ระบบ (ฟังก์ชันล้วน)', () => {
  it('ISO offset ใด ๆ แปลงเป็นเวลา Asia/Bangkok และทั้งวันใช้วันสิ้นสุดแบบไม่รวมของ Google', () => {
    expect(fromGoogleTimes({ start: { dateTime: '2026-10-10T11:00:00Z' }, end: { dateTime: '2026-10-10T13:30:00Z' } })).toEqual({ allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T20:30' })
    expect(fromGoogleTimes({ start: { dateTime: '2026-10-10T20:00:00-05:00' }, end: { dateTime: '2026-10-10T21:00:00-05:00' } })).toEqual({ allDay: false, start: '2026-10-11T08:00', end: '2026-10-11T09:00' })
    // ทั้งวันวันเดียว: Google ส่ง end เป็นวันถัดไป
    expect(fromGoogleTimes({ start: { date: '2026-10-10' }, end: { date: '2026-10-11' } })).toEqual({ allDay: true, start: '2026-10-10T00:00', end: '2026-10-10T23:59' })
    // ทั้งวันหลายวัน ข้ามเดือน
    expect(fromGoogleTimes({ start: { date: '2026-10-30' }, end: { date: '2026-11-02' } })).toEqual({ allDay: true, start: '2026-10-30T00:00', end: '2026-11-01T23:59' })
    expect(fromGoogleTimes({ status: 'cancelled' })).toBeNull()
  })

  it('ส่งกลับ Google: เวลาใส่ offset +07:00 และทั้งวันบวกหนึ่งวันที่ปลายทาง (ไปกลับได้ค่าเดิม)', () => {
    const allDay = { allDay: true, start: '2026-12-31T00:00', end: '2027-01-01T23:59' }
    expect(toGoogleTimes(allDay)).toEqual({ start: { date: '2026-12-31' }, end: { date: '2027-01-02' } })
    expect(fromGoogleTimes(toGoogleTimes(allDay))).toEqual(allDay)
    const range = { allDay: false, start: '2026-10-10T23:30', end: '2026-10-11T01:00' }
    expect(toGoogleTimes(range).start).toEqual({ dateTime: '2026-10-10T23:30:00+07:00', timeZone: 'Asia/Bangkok' })
    expect(fromGoogleTimes(toGoogleTimes(range))).toEqual(range)
  })
})

describe('Google Calendar → เว็บ', () => {
  it('รอบแรกดึงทุกหน้า แล้วรอบถัดไปใช้ sync token ดึงเฉพาะที่เปลี่ยน: เพิ่ม แก้ และยกเลิกที่ Google ขึ้นเว็บ', async () => {
    const calendar = ws.addCalendar('MU Esport — กำหนดการ')
    ws.pageSize = 2
    for (let i = 1; i <= 5; i++) ws.putEvent(calendar.id, timed(`ซ้อม ${i}`, soon(i), soon(i, '20:00'), { location: `ห้อง ${i}` }))
    const allDay = ws.putEvent(calendar.id, { summary: 'แข่งทั้งวัน', start: { date: soon(7).slice(0, 10) }, end: { date: soon(9).slice(0, 10) }, organizer: { self: true } })
    await linkCalendar(calendar)

    let list = await events()
    expect(list.map((e) => e.title)).toEqual(['ซ้อม 1', 'ซ้อม 2', 'ซ้อม 3', 'ซ้อม 4', 'ซ้อม 5', 'แข่งทั้งวัน'])
    expect(list[0]).toMatchObject({ start: soon(1), end: soon(1, '20:00'), location: 'ห้อง 1', source: 'calendar', editable: true, recurring: false, version: 1 })
    expect(list[5]).toMatchObject({ allDay: true, start: `${soon(7).slice(0, 10)}T00:00`, end: `${soon(8).slice(0, 10)}T23:59` })
    expect(google.calls.filter((c) => c.url.includes('/events?') && c.url.includes('pageToken')).length).toBe(2)

    // แก้ เพิ่ม และลบที่ฝั่ง Google
    const first = [...calendar.events.values()].find((e) => e.summary === 'ซ้อม 1')!
    ws.putEvent(calendar.id, { ...first, ...timed('ซ้อมใหญ่', soon(1, '19:00'), soon(1, '21:00')), location: 'ห้องใหม่', description: 'เลื่อนเวลา' })
    ws.putEvent(calendar.id, timed('ประชุมทีม', soon(3, '10:00'), soon(3, '11:00')))
    ws.deleteEvent(calendar.id, allDay.id)
    google.calls.length = 0
    const result = await syncNow('calendar', staff)
    expect(result.status.error).toBeNull()
    expect(google.calls.filter((c) => c.url.includes('/events?')).every((c) => c.url.includes('syncToken=st-'))).toBe(true)

    list = await events()
    expect(list.map((e) => e.title).sort()).toEqual(['ซ้อม 2', 'ซ้อม 3', 'ซ้อม 4', 'ซ้อม 5', 'ซ้อมใหญ่', 'ประชุมทีม'].sort())
    expect(await byTitle('ซ้อมใหญ่')).toMatchObject({ start: soon(1, '19:00'), location: 'ห้องใหม่', description: 'เลื่อนเวลา', version: 2 })
    // รายการที่ลบใน Google ไม่แสดง แต่แถวไม่ถูกลบ
    const kept = await env.DB.prepare(`SELECT source_state FROM events WHERE google_event_id = ?`).bind(allDay.id).first<{ source_state: string }>()
    expect(kept?.source_state).toBe('cancelled')
  })

  it('sync token ใช้ไม่ได้แล้ว (410): ดึงใหม่ทั้งชุดเฉพาะปฏิทินนี้ ข้อมูลอื่นไม่ถูกล้าง และรายการที่หายระหว่างนั้นถูกยกเลิก', async () => {
    await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { name: 'สมาชิก', nickname: 'ส', studentId: '6543210', role: 'member', status: 'active', contact: '', note: '' } })
    const calendar = ws.addCalendar('ปฏิทิน')
    const keep = ws.putEvent(calendar.id, timed('อยู่ต่อ', soon(1), soon(1, '20:00')))
    const gone = ws.putEvent(calendar.id, timed('จะหาย', soon(2), soon(2, '20:00')))
    await linkCalendar(calendar)
    expect(await events()).toHaveLength(2)

    // token หมดอายุ และรายการหนึ่งหายจาก Google โดยไม่มีบันทึกการเปลี่ยนให้ตามได้
    calendar.minToken = 999_999
    calendar.events.delete(gone.id)
    const failed = await syncNow('calendar', staff)
    expect(failed.status.error).toMatchObject({ code: 'malformed' })
    expect(await events()).toHaveLength(2) // ระหว่างรอดึงใหม่ยังแสดงข้อมูลสำเร็จครั้งก่อน
    calendar.minToken = 0
    const recovered = await syncNow('calendar', staff)
    expect(recovered.status.error).toBeNull()
    expect((await events()).map((e) => e.title)).toEqual(['อยู่ต่อ'])
    expect(keep.id).toBeTruthy()
    expect((await data(await call('/api/members', { as: staff }))).members).toHaveLength(1)
  })

  it('กำหนดการซ้ำ: คงตัวตนของ series และข้อยกเว้น เว็บแสดงรายการย่อยแต่ไม่ให้แก้ และตามการยกเลิกรายการย่อยที่ Google', async () => {
    const calendar = ws.addCalendar('ปฏิทิน')
    const master = ws.putEvent(calendar.id, { ...timed('ซ้อมประจำสัปดาห์', soon(1), soon(1, '20:00')), recurrence: ['RRULE:FREQ=WEEKLY;COUNT=3'] })
    const instance = (n: number, extra: Record<string, unknown> = {}) => ({
      ...timed('ซ้อมประจำสัปดาห์', soon(1 + 7 * n), soon(1 + 7 * n, '20:00')), id: `${master.id}_w${n}`, recurringEventId: master.id, etag: `"i${n}"`, status: 'confirmed', htmlLink: `https://calendar.google.com/event?eid=w${n}`, ...extra,
    })
    // สัปดาห์ที่สองเป็นข้อยกเว้น (ย้ายเวลาและเปลี่ยนชื่อ)
    calendar.instances.set(master.id, [instance(0), instance(1, { summary: 'ซ้อมพิเศษ (ย้ายเวลา)', start: { dateTime: `${soon(8, '13:00')}:00+07:00` }, end: { dateTime: `${soon(8, '15:00')}:00+07:00` } }), instance(2)])
    await linkCalendar(calendar)

    let list = await events()
    expect(list.map((e) => [e.title, e.start, e.recurring, e.editable])).toEqual([
      ['ซ้อมประจำสัปดาห์', soon(1), true, false],
      ['ซ้อมพิเศษ (ย้ายเวลา)', soon(8, '13:00'), true, false],
      ['ซ้อมประจำสัปดาห์', soon(15), true, false],
    ])
    expect(list[0].editNote).toContain('กำหนดการซ้ำ')
    const series = await env.DB.prepare('SELECT event_id, needs_expand FROM calendar_series').all()
    expect(series.results).toEqual([{ event_id: master.id, needs_expand: 0 }])

    // แก้จากเว็บถูกปฏิเสธที่ server และไม่มีคำสั่งเขียนไป Google
    const refused = await call(`/api/events/${list[0].id}`, { method: 'PATCH', as: staff, body: body(list[0], { title: 'แก้ทั้งชุด' }) })
    expect(refused.status).toBe(409)
    expect((await data(refused)).error).toBe('event_not_editable')
    expect(google.calls.some((c) => c.method === 'PATCH')).toBe(false)

    // ยกเลิกครั้งที่สามที่ Google: Google รายงานข้อยกเว้นของ series ระบบจึงกระจาย series ใหม่
    calendar.instances.set(master.id, [instance(0), instance(1, { summary: 'ซ้อมพิเศษ (ย้ายเวลา)', start: { dateTime: `${soon(8, '13:00')}:00+07:00` }, end: { dateTime: `${soon(8, '15:00')}:00+07:00` } })])
    ws.putEvent(calendar.id, { id: `${master.id}_w2`, recurringEventId: master.id, status: 'cancelled' })
    await syncNow('calendar', staff)
    list = await events()
    expect(list.map((e) => e.title)).toEqual(['ซ้อมประจำสัปดาห์', 'ซ้อมพิเศษ (ย้ายเวลา)'])

    // ลบทั้ง series ที่ Google
    ws.deleteEvent(calendar.id, master.id)
    await syncNow('calendar', staff)
    expect(await events()).toEqual([])
  })
})

describe('เว็บ → Google Calendar', () => {
  const INPUT = { title: 'นัดซ้อม', allDay: false, start: soon(2), end: soon(2, '20:00'), location: 'ห้อง 1', description: 'พกเมาส์' }

  it('เพิ่มจากเว็บ: สร้างที่ Google ด้วย event ID ที่กำหนด ไม่ส่งอีเมลเชิญ และคำขอเดิมที่ลองใหม่หลังคำตอบหายไม่สร้างรายการซ้ำ', async () => {
    const calendar = ws.addCalendar('ปฏิทิน')
    await linkCalendar(calendar)
    const idem = key()
    loseResponseOnce(google, ws, (url, method) => method === 'POST' && url.pathname.endsWith('/events'))
    const lost = await create(INPUT, idem)
    expect(lost.status).toBe(502)
    expect((await data(lost)).error).toBe('save_outcome_unknown')

    const retry = await create(INPUT, idem)
    expect(retry.status).toBe(201)
    const created = await data(retry)
    expect(created).toMatchObject({ verified: true, event: { ...INPUT, source: 'calendar', editable: true } })
    const stored = [...calendar.events.values()]
    expect(stored).toHaveLength(1)
    expect(stored[0]).toMatchObject({ summary: 'นัดซ้อม', location: 'ห้อง 1', start: { dateTime: `${INPUT.start}:00+07:00`, timeZone: 'Asia/Bangkok' } })
    expect(stored[0].attendees).toBeUndefined()
    const inserts = google.calls.filter((c) => c.method === 'POST' && c.url.includes('/events'))
    expect(inserts.every((c) => c.url.includes('sendUpdates=none'))).toBe(true)
    // ซิงค์ตามมาไม่ทำให้เกิดแถวที่สอง และไม่ส่งรายการเดิมกลับไป Google อีก
    await syncNow('calendar', staff)
    expect(await events()).toHaveLength(1)
    expect(google.calls.filter((c) => c.method === 'POST' && c.url.includes('/events')).length).toBe(inserts.length)
  })

  it('แก้จากเว็บ: ส่งเฉพาะฟิลด์ที่เปลี่ยนพร้อม If-Match ฟิลด์ที่เว็บไม่ได้แก้ (เช่น แขก) ยังอยู่ที่ Google', async () => {
    const calendar = ws.addCalendar('ปฏิทิน')
    const original = ws.putEvent(calendar.id, timed('ประชุม', soon(1), soon(1, '19:00'), { location: 'ห้อง A', attendees: [{ email: 'guest@example.com' }], colorId: '5' }))
    await linkCalendar(calendar)
    const event = await byTitle('ประชุม')
    let sent: { body: Record<string, unknown>; ifMatch: string | null; url: string } | null = null
    google.interceptors.push((url, init) => {
      if (init?.method === 'PATCH') sent = { body: JSON.parse(init.body as string), ifMatch: new Headers(init.headers).get('If-Match'), url: url.href }
      return undefined
    })
    const res = await call(`/api/events/${event.id}`, { method: 'PATCH', as: staff, body: body(event, { location: 'ห้อง B' }) })
    expect(res.status).toBe(200)
    expect(await data(res)).toMatchObject({ verified: true, event: { location: 'ห้อง B', version: event.version + 1 } })
    expect(sent!.body).toEqual({ location: 'ห้อง B' })
    expect(sent!.ifMatch).toBe(original.etag)
    expect(sent!.url).toContain('sendUpdates=none')
    expect(calendar.events.get(original.id)).toMatchObject({ location: 'ห้อง B', summary: 'ประชุม', attendees: [{ email: 'guest@example.com' }], colorId: '5' })
  })

  it('conflict: รายการถูกแก้ที่ Google ก่อน → Google ปฏิเสธด้วย etag ไม่เขียนทับ และเว็บได้ค่าล่าสุดกลับไปให้ตรวจ', async () => {
    const calendar = ws.addCalendar('ปฏิทิน')
    const original = ws.putEvent(calendar.id, timed('ประชุม', soon(1), soon(1, '19:00')))
    await linkCalendar(calendar)
    const opened = await byTitle('ประชุม')
    ws.putEvent(calendar.id, { ...original, summary: 'ประชุม (แก้ที่ Google)' })

    const res = await call(`/api/events/${opened.id}`, { method: 'PATCH', as: staff, body: body(opened, { title: 'ประชุม (แก้ที่เว็บ)' }) })
    expect(res.status).toBe(409)
    const conflict = await data(res)
    expect(conflict.error).toBe('version_conflict')
    expect(conflict.current).toMatchObject({ title: 'ประชุม (แก้ที่ Google)', version: opened.version + 1 })
    expect(calendar.events.get(original.id)!.summary).toBe('ประชุม (แก้ที่ Google)')

    // ถูกลบที่ Google ระหว่างนั้น: บอกตามจริง และรายการหายจากเว็บ
    const latest = await byTitle('ประชุม (แก้ที่ Google)')
    ws.deleteEvent(calendar.id, original.id)
    const deleted = await call(`/api/events/${latest.id}`, { method: 'PATCH', as: staff, body: body(latest, { title: 'x' }) })
    expect(deleted.status).toBe(404)
    expect(await events()).toEqual([])
  })

  it('ผลไม่แน่ชัด (Google ตอบ 5xx): ไม่บอกว่าสำเร็จหรือล้มเหลว และซิงค์ถัดไปแสดงค่าจริงจาก Google', async () => {
    const calendar = ws.addCalendar('ปฏิทิน')
    ws.putEvent(calendar.id, timed('ประชุม', soon(1), soon(1, '19:00')))
    await linkCalendar(calendar)
    const event = await byTitle('ประชุม')
    loseResponseOnce(google, ws, (_url, method) => method === 'PATCH')
    const res = await call(`/api/events/${event.id}`, { method: 'PATCH', as: staff, body: body(event, { title: 'ประชุมใหญ่' }) })
    expect(res.status).toBe(502)
    expect((await data(res)).error).toBe('save_outcome_unknown')
    expect((await events())[0].title).toBe('ประชุม')
    await syncNow('calendar', staff)
    expect((await events())[0]).toMatchObject({ title: 'ประชุมใหญ่', version: event.version + 1 })
  })

  it('ปฏิทินที่บัญชีชมรมอ่านได้อย่างเดียว: แสดงสิทธิ์ตามจริง และ server ปิดการเพิ่ม/แก้โดยไม่เรียกคำสั่งเขียนของ Google', async () => {
    const calendar = ws.addCalendar('ปฏิทินของคณะ', 'reader')
    ws.putEvent(calendar.id, timed('งานคณะ', soon(1), soon(1, '19:00'), { organizer: { self: false } }))
    await linkCalendar(calendar)
    expect((await status()).resource).toMatchObject({ access: 'read' })
    const event = await byTitle('งานคณะ')
    for (const res of [await create(INPUT), await call(`/api/events/${event.id}`, { method: 'PATCH', as: staff, body: body(event, { title: 'x' }) })]) {
      expect(res.status).toBe(403)
      expect((await data(res)).error).toBe('source_read_only')
    }
    expect(google.calls.some((c) => c.method === 'POST' && c.url.includes('/events'))).toBe(false)
    expect(google.calls.some((c) => c.method === 'PATCH')).toBe(false)
    // ปฏิทินที่เห็นได้แค่ว่าง/ไม่ว่าง เชื่อมไม่ได้
    const busyOnly = ws.addCalendar('ว่าง/ไม่ว่าง', 'freeBusyReader')
    await call('/api/setup/link/calendar', { method: 'DELETE', as: admin })
    const refused = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'calendar', resourceId: busyOnly.id } })
    expect((await data(refused)).error).toBe('calendar_no_access')
  })
})

describe('ตั้งค่าปฏิทินและกำหนดการเดิม', () => {
  it('รายชื่อปฏิทินจาก Calendar API บอกสิทธิ์ของแต่ละปฏิทิน และไม่มีปฏิทินใดถูกเชื่อมเองจากการเปิดดู', async () => {
    ws.addCalendar('ของชมรม', 'owner')
    ws.addCalendar('ของคณะ', 'reader')
    const list = (await data(await call('/api/setup/calendars', { as: admin }))).calendars
    expect(list.map((c: any) => [c.name, c.accessRole, c.writable])).toEqual([['ของชมรม', 'owner', true], ['ของคณะ', 'reader', false]])
    expect((await call('/api/setup/calendars', { as: staff })).status).toBe(403)
    expect((await status()).linked).toBe(false)
    expect(googleCalls(google, '/events')).toBe(0)
  })

  it('ย้ายกำหนดการเดิมในเว็บขึ้นปฏิทิน: preview บอกจำนวนและรายการที่อาจซ้ำ ย้ายแล้วอยู่ครบ ทำซ้ำไม่สร้างซ้ำ', async () => {
    const mk = async (title: string, day: number) => (await data(await create({ title, allDay: false, start: soon(day), end: soon(day, '20:00'), location: '', description: '' }))).event
    const one = await mk('ซ้อมทีม', 1)
    const dup = await mk('แข่งรอบแรก', 2)
    const calendar = ws.addCalendar('ปฏิทิน')
    ws.putEvent(calendar.id, timed('แข่งรอบแรก', soon(2), soon(2, '20:00')))

    const preview = await data(await call('/api/setup/preview', { method: 'POST', as: admin, body: { kind: 'calendar', resourceId: calendar.id } }))
    expect(preview).toMatchObject({ writable: true, localEvents: 2, upcoming: 1, duplicates: [{ id: dup.id, title: 'แข่งรอบแรก' }] })
    expect(calendar.events.size).toBe(1)

    await linkCalendar(calendar)
    // ก่อนย้าย: รายการเดิมยังแสดงและบอกว่าอยู่เฉพาะในเว็บ
    expect((await events()).map((e) => [e.title, e.source]).sort()).toEqual([['ซ้อมทีม', 'local'], ['แข่งรอบแรก', 'calendar'], ['แข่งรอบแรก', 'local']].sort())

    const push = (skipIds: string[]) => call('/api/sync/calendar/push-local', { method: 'POST', as: admin, body: { skipIds } }).then((r) => data(r))
    expect(await push([dup.id])).toMatchObject({ pushed: 1, remaining: 0, skipped: 1 })
    expect(await push([dup.id])).toMatchObject({ pushed: 0, remaining: 0, skipped: 1 })
    expect(calendar.events.size).toBe(2)
    const moved = (await events()).find((e) => e.id === one.id)!
    expect(moved).toMatchObject({ title: 'ซ้อมทีม', source: 'calendar', version: one.version })
    await syncNow('calendar', staff)
    expect((await events()).filter((e) => e.title === 'ซ้อมทีม')).toHaveLength(1)

    // ยกเลิกการเชื่อม: ทั้งสองฝั่งยังอยู่ครบ
    await call('/api/setup/link/calendar', { method: 'DELETE', as: admin })
    expect(calendar.events.size).toBe(2)
    expect((await events()).every((e) => e.source === 'local')).toBe(true)
    expect(await events()).toHaveLength(3)
  })
})
