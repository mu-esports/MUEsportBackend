import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import worker from '../worker/index'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'
import { ALL_SCOPES, connectClub, FakeWorkspace, loseResponseOnce, syncNow } from './workspace'

// ทุกกรณีในไฟล์นี้ใช้ Google จำลอง (test/helpers.ts, test/workspace.ts) ไม่ได้ต่อกับ Google จริง
const DRIVE_ONLY = 'openid email https://www.googleapis.com/auth/drive.file'
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
})
afterEach(() => vi.unstubAllGlobals())

const create = (kind: string, name: string, idem = key(), extra: Record<string, unknown> = {}, as: Actor = admin) =>
  call('/api/setup/create', { method: 'POST', as, headers: { 'Idempotency-Key': idem }, body: { kind, name, ...extra } })
const statuses = async () => Object.fromEntries(((await data(await call('/api/sync', { as: staff }))).sync as any[]).map((s) => [s.kind, s]))

describe('สร้างชุดข้อมูลชมรม', () => {
  beforeEach(() => connectClub(google))

  it('ไม่มีอะไรถูกสร้างจากการเปิดหน้า ดูสถานะ หรือสั่งซิงค์ ต้องเป็นคำสั่งสร้างของผู้ดูแลเท่านั้น', async () => {
    await call('/api/setup', { as: admin })
    await call('/api/sync', { as: staff })
    await call('/api/sources', { as: admin })
    for (const kind of ['sheets', 'calendar', 'forms', 'docs']) await syncNow(kind, staff)
    expect(google.calls.filter((c) => c.method !== 'GET' && !c.url.includes('oauth2'))).toEqual([])
    expect(ws.sheets.size + ws.calendars.size + ws.forms.size).toBe(0)
    // ทีมงานทั่วไปสั่งสร้างไม่ได้
    expect((await create('sheets', 'ทะเบียน', key(), {}, staff)).status).toBe(403)
    expect((await call('/api/setup', { as: staff })).status).toBe(403)
    expect(ws.sheets.size).toBe(0)
  })

  it('สร้างชีต ปฏิทิน และฟอร์มใหม่ พร้อมโครงตั้งต้นและผูกเข้าระบบ; คำขอเดิมที่ส่งซ้ำไม่สร้างซ้ำ', async () => {
    const keys = { sheets: key(), calendar: key(), forms: key() }
    const names = { sheets: 'MU Esport — ทะเบียนสมาชิก', calendar: 'MU Esport — กำหนดการ', forms: 'MU Esport — สมัครสมาชิก' }
    for (const kind of ['sheets', 'calendar', 'forms'] as const) {
      const res = await create(kind, names[kind], keys[kind])
      expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
      expect((await data(res)).status).toMatchObject({ linked: true, error: null, resource: { name: names[kind], origin: 'created', access: 'write' } })
      const again = await create(kind, names[kind], keys[kind])
      expect(await data(again)).toMatchObject({ replayed: true })
    }
    expect([ws.sheets.size, ws.calendars.size, ws.forms.size]).toEqual([1, 1, 1])
    const sheet = [...ws.sheets.values()][0]
    expect(sheet.tabs[0].cells).toEqual([['รหัสสมาชิก (ระบบใช้จับคู่ ห้ามแก้)', 'ชื่อ', 'ชื่อเล่น', 'บทบาท', 'สถานะ', 'ช่องทางติดต่อ', 'หมายเหตุ', 'วันที่เพิ่ม']])
    const form = [...ws.forms.values()][0]
    expect(form.items.map((i) => i.title)).toEqual(['ชื่อ-นามสกุล', 'ชื่อเล่น', 'ช่องทางติดต่อ (เช่น ชื่อ Discord หรืออีเมล)', 'หมายเหตุ'])
    const view = await data(await call('/api/forms', { as: admin }))
    expect(view.form.mapping.name).toBe(form.items[0].questionItem.question.questionId)
    // ชื่อเดียวกันด้วย key ใหม่ถูกปฏิเสธเพราะมีแหล่งที่เชื่อมอยู่แล้ว ไม่สร้างอันที่สอง
    const second = await create('sheets', names.sheets)
    expect(second.status).toBe(409)
    expect((await data(second)).error).toBe('already_linked')
    expect(ws.sheets.size).toBe(1)
  })

  it.each([
    ['sheets', (url: URL, method: string) => method === 'POST' && url.pathname === '/drive/v3/files'],
    ['calendar', (url: URL, method: string) => method === 'POST' && url.pathname === '/calendar/v3/calendars'],
    ['forms', (url: URL, method: string) => method === 'POST' && url.pathname === '/v1/forms'],
  ] as const)('คำตอบของ Google หายตอนสร้าง %s: ไม่สันนิษฐานว่าไม่ได้สร้าง ลองใหม่แล้วใช้ของเดิม ไม่เกิดรายการซ้ำ', async (kind, match) => {
    const idem = key()
    loseResponseOnce(google, ws, match)
    const lost = await create(kind, 'ชุดข้อมูลชมรม', idem)
    expect(lost.status).toBe(502)
    expect(await data(lost)).toMatchObject({ error: 'operation_create_unknown', fileState: 'unknown' })
    expect((await statuses())[kind].linked).toBe(false)
    const pending = (await data(await call('/api/setup', { as: admin }))).operations
    expect(pending).toMatchObject([{ kind, fileState: 'unknown', canConfirmCreate: false }])

    const retry = await create(kind, 'ชุดข้อมูลชมรม', idem)
    expect(retry.status, JSON.stringify(await retry.clone().json())).toBe(201)
    const count = kind === 'sheets' ? ws.sheets.size : kind === 'calendar' ? ws.calendars.size : ws.forms.size
    expect(count).toBe(1)
    expect((await statuses())[kind]).toMatchObject({ linked: true, error: null })
  })

  it('สร้างไม่สำเร็จและค้นไม่พบ: ระบบไม่สร้างใหม่เอง ต้องรอและให้ผู้ดูแลยืนยันก่อน', async () => {
    const idem = key()
    google.failOnce((url, method) => method === 'POST' && url.pathname === '/drive/v3/files', 503)
    expect((await create('sheets', 'ทะเบียน', idem)).status).toBe(502)
    const retry = await create('sheets', 'ทะเบียน', idem)
    expect(await data(retry)).toMatchObject({ error: 'operation_create_unknown', canConfirmCreate: false })
    // ยืนยันก่อนครบเวลารอไม่ได้
    expect(await data(await create('sheets', 'ทะเบียน', idem, { confirmCreate: true }))).toMatchObject({ error: 'operation_create_unknown' })
    expect(ws.sheets.size).toBe(0)
    await env.DB.prepare('UPDATE setup_operations SET create_attempted_at = ?').bind(new Date(Date.now() - 300_000).toISOString()).run()
    expect((await create('sheets', 'ทะเบียน', idem)).status).toBe(409)
    expect((await create('sheets', 'ทะเบียน', idem, { confirmCreate: true })).status).toBe(201)
    expect(ws.sheets.size).toBe(1)
  })

  it('Google ปฏิเสธชัดเจน (4xx): ไม่มีอะไรถูกสร้าง และลองใหม่ได้ทันที', async () => {
    const idem = key()
    google.failOnce((url, method) => method === 'POST' && url.pathname === '/drive/v3/files', 403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } })
    const refused = await create('sheets', 'ทะเบียน', idem)
    expect(await data(refused)).toMatchObject({ error: 'missing_scope', fileState: 'none' })
    expect((await create('sheets', 'ทะเบียน', idem)).status).toBe(201)
    expect(ws.sheets.size).toBe(1)
  })
})

describe('OAuth scopes ของบริการ', () => {
  it('ยังไม่ได้รับสิทธิ์ Calendar: สร้าง/เลือกปฏิทินไม่ได้ และสถานะบอกตามจริง โดย Docs/Sheets ยังใช้ได้', async () => {
    await connectClub(google, DRIVE_ONLY)
    const overview = await data(await call('/api/setup', { as: admin }))
    expect(overview.scopes).toEqual({ driveFile: true, calendarCreated: false, calendarExisting: false })
    const refused = await create('calendar', 'กำหนดการ')
    expect(refused.status).toBe(409)
    expect((await data(refused)).error).toBe('missing_scope')
    expect(ws.calendars.size).toBe(0)
    expect((await create('sheets', 'ทะเบียน')).status).toBe(201)
  })

  it('ขอสิทธิ์เพิ่มเฉพาะบริการที่ผู้ดูแลเลือก ผ่านขั้นตอนเชื่อมบัญชี (incremental) ไม่ขอในขั้นเข้าสู่ระบบ', async () => {
    const connect = async (body?: unknown) => new URL((await data(await call('/api/google/connect', { method: 'POST', as: admin, body }))).authUrl)
    const base = await connect()
    expect(base.searchParams.get('scope')).toBe(DRIVE_ONLY)
    expect(base.searchParams.get('include_granted_scopes')).toBe('true')
    expect((await connect({ service: 'calendar_created' })).searchParams.get('scope')).toBe(`${DRIVE_ONLY} https://www.googleapis.com/auth/calendar.app.created`)
    expect((await connect({ service: 'calendar_existing' })).searchParams.get('scope')).toBe(
      `${DRIVE_ONLY} https://www.googleapis.com/auth/calendar.calendarlist.readonly https://www.googleapis.com/auth/calendar.events`,
    )
    expect((await call('/api/google/connect', { method: 'POST', as: admin, body: { service: 'everything' } })).status).toBe(422)
    expect((await call('/api/google/connect', { method: 'POST', as: staff, body: { service: 'calendar_created' } })).status).toBe(403)
    const login = await call('/auth/login')
    expect(new URL(login.headers.get('Location')!).searchParams.get('scope')).toBe('openid email profile')
  })

  it('Google ตอบว่าสิทธิ์ไม่พอระหว่างซิงค์ หรือ token ถูกถอน: บริการนั้นแสดงว่าใช้ไม่ได้ ไม่แสดงว่าพร้อม และข้อมูลเดิมยังอยู่', async () => {
    await connectClub(google)
    const calendar = ws.addCalendar('ปฏิทิน')
    ws.putEvent(calendar.id, { summary: 'งาน', start: { date: '2030-01-01' }, end: { date: '2030-01-02' } })
    await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'calendar', resourceId: calendar.id } })
    google.failOnce((url) => url.pathname.endsWith('/events'), 403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } })
    expect((await syncNow('calendar', staff)).status.error).toMatchObject({ code: 'missing_scope' })
    expect((await data(await call('/api/events', { as: staff }))).events).toHaveLength(1)

    // refresh token ถูกถอนที่ Google
    google.refreshTokens.set('refresh-secret-1', 'invalid_grant')
    await env.DB.prepare('UPDATE google_connections SET access_token_enc = NULL').run()
    expect((await syncNow('calendar', staff)).status.error).toMatchObject({ code: 'google_needs_reconnect' })
    expect((await data(await call('/api/sources', { as: admin }))).google.status).toBe('needs_reconnect')
    expect((await data(await call('/api/events', { as: staff }))).events).toHaveLength(1)
  })
})

describe('สถานะแยกรายบริการและงานตามเวลา', () => {
  beforeEach(() => connectClub(google, ALL_SCOPES))

  it('บริการหนึ่งล้มเหลวไม่ทำให้บริการอื่นหายหรือหยุด และหน้าเว็บได้สถานะแยกกัน', async () => {
    const sheet = ws.addSheet('ทะเบียน', [['รหัส', 'ชื่อ'], ['m1', 'อารี']])
    await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, columns: { id: 'รหัส', name: 'ชื่อ' } } })
    const calendar = ws.addCalendar('ปฏิทิน')
    await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'calendar', resourceId: calendar.id } })
    const doc = google.addDoc('บันทึกประชุม', 'เนื้อหา')
    await env.DB.prepare(`INSERT INTO documents (id, google_document_id, title, created_by, updated_by, created_at, updated_at) VALUES ('d1', ?, 'บันทึกประชุม', ?, ?, 'x', 'x')`).bind(doc.id, admin.id, admin.id).run()

    sheet.trashed = true // ชีตถูกย้ายไปถังขยะ
    ws.putEvent(calendar.id, { summary: 'งานใหม่', start: { date: '2030-01-01' }, end: { date: '2030-01-02' } })
    for (const kind of ['sheets', 'calendar', 'forms', 'docs']) await syncNow(kind, staff)
    const all = await statuses()
    expect(all.sheets.error).toMatchObject({ code: 'resource_unavailable' })
    expect(all.calendar).toMatchObject({ error: null, linked: true })
    expect(all.forms).toMatchObject({ linked: false, error: null })
    expect(all.docs.error).toBeNull()
    expect((await data(await call('/api/members', { as: staff }))).members).toHaveLength(1)
    expect((await data(await call('/api/events', { as: staff }))).events).toHaveLength(1)
    expect((await data(await call('/api/documents', { as: staff }))).documents).toHaveLength(1)
    // ทีมงานที่ยังไม่ได้เข้าสู่ระบบดูสถานะไม่ได้
    expect((await call('/api/sync')).status).toBe(401)
    expect((await call('/api/sync/sheets', { method: 'POST', as: staff, raw: true, cookie: staff.cookie })).status).toBe(403)
  })

  it('Cron: อัปเดตสำเนาของทุกบริการที่เชื่อมไว้โดยไม่มีใครเปิดเว็บ และรอบที่ซ้อนกันไม่อ่าน Google ซ้ำ', async () => {
    const sheet = ws.addSheet('ทะเบียน', [['รหัส', 'ชื่อ'], ['m1', 'อารี']])
    await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, columns: { id: 'รหัส', name: 'ชื่อ' } } })
    ws.cells(sheet.id).push(['m2', 'บุญมี'])
    await env.DB.prepare('UPDATE sync_state SET last_attempt_at = NULL').run()
    google.calls.length = 0
    const pending: Promise<unknown>[] = []
    const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p), passThroughOnException() {} }
    await worker.scheduled({} as never, env, ctx as never)
    await worker.scheduled({} as never, env, ctx as never)
    await Promise.all(pending)
    expect((await data(await call('/api/members', { as: staff }))).members).toHaveLength(2)
    expect(google.calls.filter((c) => c.url.endsWith('values:batchGetByDataFilter'))).toHaveLength(1)
  })
})

describe('Google Docs: รายการและฉบับใหม่', () => {
  beforeEach(() => connectClub(google))
  const addDocument = async (title: string, text: string) => {
    const res = await call('/api/documents', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { title, text } })
    return (await data(res)).document as { id: string; title: string }
  }
  const googleDoc = (title: string) => [...google.docs.values()].find((d) => d.title === title)!

  it('เปลี่ยนชื่อเอกสารที่ Google: รายการในเว็บตามหลังซิงค์ โดยไม่ต้องเปิดเอกสาร และไม่ดึงเนื้อหา', async () => {
    const doc = await addDocument('วาระประชุม', 'ข้อหนึ่ง')
    google.renameExternally(googleDoc('วาระประชุม').id, 'วาระประชุม (ฉบับแก้)')
    google.calls.length = 0
    const result = await syncNow('docs', staff)
    expect(result.status.error).toBeNull()
    const list = (await data(await call('/api/documents', { as: staff }))).documents
    expect(list.find((d: any) => d.id === doc.id).title).toBe('วาระประชุม (ฉบับแก้)')
    expect(google.calls.some((c) => c.url.includes('docs.googleapis.com'))).toBe(false)
  })

  it('ตรวจฉบับใหม่แบบเบา: แก้ข้อความที่ Google แล้ว revision เปลี่ยน เว็บโหลดฉบับใหม่ได้ และการบันทึกจากร่างเก่าถูกปฏิเสธ ไม่เขียนทับ', async () => {
    const doc = await addDocument('ร่างประกาศ', 'ฉบับแรก')
    const opened = await data(await call(`/api/documents/${doc.id}`, { as: staff }))
    const check = async () => data(await call(`/api/documents/${doc.id}/revision`, { as: staff }))
    expect(await check()).toEqual({ revisionId: opened.content.revisionId, title: 'ร่างประกาศ' })

    google.editExternally(googleDoc('ร่างประกาศ').id, 'แก้ที่ Google')
    const changed = await check()
    expect(changed.revisionId).not.toBe(opened.content.revisionId)
    // ผู้ใช้มีร่างค้าง: server ไม่ทับ Google และคืนฉบับล่าสุดให้เทียบ
    const save = await call(`/api/documents/${doc.id}`, { method: 'PUT', as: staff, body: { text: 'ร่างของฉัน', baseRevisionId: opened.content.revisionId } })
    expect(save.status).toBe(409)
    expect((await data(save)).latest.text).toBe('แก้ที่ Google')
    expect(googleDoc('ร่างประกาศ').text).toBe('แก้ที่ Google\n')
    // เว็บ → Google ยังทำงานเมื่ออ้าง revision ล่าสุด
    const ok = await call(`/api/documents/${doc.id}`, { method: 'PUT', as: staff, body: { text: 'แก้ที่เว็บ', baseRevisionId: changed.revisionId } })
    expect(await data(ok)).toMatchObject({ verified: true })
    expect(googleDoc('ร่างประกาศ').text).toBe('แก้ที่เว็บ\n')
    expect((await call('/api/documents/nope/revision', { as: staff })).status).toBe(404)
  })

  it('ผูกเอกสารเดิม: ต้องเป็นผู้ดูแล และ server ต้องเปิดไฟล์ได้จริงด้วยสิทธิ์ของบัญชีชมรม การใส่รหัสไฟล์เฉย ๆ ไม่พอ', async () => {
    const existing = google.addDoc('ระเบียบชมรม', 'ข้อ 1', 'table')
    expect((await call('/api/documents/link', { method: 'POST', as: staff, body: { fileId: existing.id } })).status).toBe(403)
    const notGranted = await call('/api/documents/link', { method: 'POST', as: admin, body: { fileId: 'a-file-id-never-granted-to-app' } })
    expect(notGranted.status).toBe(409)
    expect((await data(notGranted)).error).toBe('file_not_granted')

    const linked = await call('/api/documents/link', { method: 'POST', as: admin, body: { fileId: existing.id } })
    expect(linked.status).toBe(201)
    // เอกสารที่มีตารางยังเป็นอ่านอย่างเดียวในเว็บตามเดิม
    expect(await data(linked)).toMatchObject({ document: { title: 'ระเบียบชมรม', status: 'read_only', origin: 'selected' }, content: { editable: false } })
    expect((await call('/api/documents/link', { method: 'POST', as: admin, body: { fileId: existing.id } })).status).toBe(409)
    expect((await data(await call('/api/documents', { as: staff }))).documents).toHaveLength(1)
  })
})
