import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { FakeDrive, MIME, PDF_BYTES } from './drive'
import { call, CLUB_EMAIL, data, env, FakeGoogle, resetDb, seedMemberActor, seedUser } from './helpers'
import type { Actor } from './helpers'
import { ALL_SCOPES, connectClub, FakeWorkspace, googleCalls } from './workspace'

const READONLY = 'https://www.googleapis.com/auth/drive.readonly'
const LIBRARY_SCOPES = `${ALL_SCOPES} ${READONLY}`

let google: FakeGoogle
let ws: FakeWorkspace
let drive: FakeDrive
let admin: Actor
let staff: Actor
let member: Actor

beforeEach(async () => {
  await resetDb()
  google = await FakeGoogle.start()
  ws = new FakeWorkspace(google)
  drive = new FakeDrive(google)
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staff = await seedUser('staff@example.com', 'staff')
  member = await seedMemberActor()
})
afterEach(() => vi.unstubAllGlobals())

describe('ภาพย่อของคลังไฟล์', () => {
  beforeEach(() => connectClub(google, LIBRARY_SCOPES))
  const addImage = (extra = {}) => drive.add({ name: 'รูปชมรม.HEIC', mimeType: 'image/heic', thumbnailLink: 'https://lh3.googleusercontent.com/test-thumbnail', thumbnailVersion: crypto.randomUUID(), ...extra })
  const image = (id: string, actor: Actor | null = member) => call(`/api/library/files/${id}/thumbnail`, { as: actor })
  const mockImage = (type = 'image/jpeg', bytes = new Uint8Array([255, 216, 255, 217])) => {
    let calls = 0
    google.services.unshift((url) => {
      if (url.hostname !== 'lh3.googleusercontent.com') return undefined
      calls++
      return new Response(bytes, { headers: { 'Content-Type': type } })
    })
    return () => calls
  }

  it('แสดง HEIC จากภาพย่อที่ Google สร้าง โดยไม่ส่ง URL หรือ token ให้ browser', async () => {
    const file = addImage()
    const body = await data(await files(member))
    expect(body.files[0]).toMatchObject({ thumbnail: true, previewable: true })
    expect(JSON.stringify(body)).not.toContain('googleusercontent.com')
    const detail = await data(await call(`/api/library/files/${file.id}`, { as: member }))
    expect(detail.preview.kind).toBe('thumbnail')
    mockImage()
    const response = await image(file.id)
    expect(response.status).toBe(200)
    expect(response.headers.get('Content-Type')).toBe('image/jpeg')
    expect(response.headers.get('Cache-Control')).toContain('no-store')
    await expectNoTokens(response, JSON.stringify(body))
    expect((await response.arrayBuffer()).byteLength).toBe(4)
  })

  it('ใช้ภาพจาก cache แต่ยังตรวจสิทธิ์ใหม่ และไม่ให้เปิดภาพเมื่อถอนการแชร์หรือเปลี่ยน session', async () => {
    const file = addImage()
    const count = mockImage()
    expect((await image(file.id)).status).toBe(200)
    expect((await image(file.id)).status).toBe(200)
    expect(count()).toBe(1)
    expect((await image(file.id, null)).status).toBe(401)
    file.inaccessible = true
    expect((await image(file.id)).status).toBe(404)
    expect(count()).toBe(1)
  })

  it('ภาพใหม่ไม่ใช้ cache ของรุ่นเก่า', async () => {
    const file = addImage()
    const count = mockImage()
    expect((await image(file.id)).status).toBe(200)
    file.thumbnailVersion = crypto.randomUUID()
    expect((await image(file.id)).status).toBe(200)
    expect(count()).toBe(2)
  })

  it('ไม่โหลด URL ภายนอกหรือส่ง credential ตาม redirect ไปเว็บไซต์อื่น', async () => {
    const wrong = addImage({ thumbnailLink: 'https://attacker.example/image.jpg' })
    expect((await image(wrong.id)).status).toBe(404)
    const file = addImage()
    google.services.unshift((url) => url.hostname === 'lh3.googleusercontent.com' ? new Response(null, { status: 302, headers: { Location: 'https://attacker.example/image.jpg' } }) : undefined)
    expect((await image(file.id)).status).toBe(502)
    expect(google.calls.some((request) => request.url.includes('attacker.example'))).toBe(false)
  })

  it('เคารพข้อจำกัดดาวน์โหลดและไม่ส่ง HTML หรือภาพใหญ่เกินกำหนด', async () => {
    const blocked = addImage({ canDownload: false })
    expect((await image(blocked.id)).status).toBe(403)
    const html = addImage()
    mockImage('text/html')
    expect((await image(html.id)).status).toBe(415)
    const large = addImage()
    mockImage('image/jpeg', new Uint8Array(2 * 1024 * 1024 + 1))
    expect((await image(large.id)).status).toBe(413)
  })
})

const files = (as: Actor | null, query = '') => call(`/api/library/files${query}`, { as })
const names = async (res: Response) => (await data(res)).files.map((f: any) => f.name)
const listCalls = () => drive.lists.length
const expireCache = () => env.DB.prepare(`UPDATE library_cache SET fetched_at = ? WHERE key LIKE 'list:%'`).bind(new Date(Date.now() - 61_000).toISOString()).run()

/** ไม่มีคำตอบใดของคลังที่มี token ของ Google หรือส่วนหัว Authorization */
async function expectNoTokens(res: Response, body: string) {
  for (const text of [body, JSON.stringify([...res.headers.entries()])]) {
    expect(text).not.toMatch(/access-\d|refresh-secret|Bearer |refresh_token|access_token/)
  }
}

describe('คลังพร้อมใช้เมื่อบัญชีชมรมอนุญาตสิทธิ์อ่านไฟล์แล้วเท่านั้น', () => {
  it('ยังไม่ได้เชื่อม Google: ตอบเป็นสถานะไม่พร้อม ไม่ตอบเป็นรายการว่าง', async () => {
    const res = await files(admin)
    expect(res.status).toBe(409)
    expect(await data(res)).toMatchObject({ error: 'library_unavailable', reason: 'not_connected' })
    const status = await data(await call('/api/library/status', { as: admin }))
    expect(status).toMatchObject({ enabled: false, reason: 'not_connected', canEnable: false })
  })

  it('เชื่อมแล้วแต่ยังไม่ได้อนุญาต drive.readonly: บอกว่าต้องเปิดใช้คลัง และไม่เรียก Drive เลย', async () => {
    await connectClub(google)
    drive.add({ name: 'ไฟล์ที่มีอยู่จริง', mimeType: MIME.pdf, bytes: PDF_BYTES })
    for (const actor of [admin, staff, member]) {
      const res = await files(actor)
      expect(res.status).toBe(409)
      const body = await data(res)
      expect(body).toMatchObject({ error: 'library_unavailable', reason: 'missing_scope' })
      expect(body.files).toBeUndefined()
    }
    expect(listCalls()).toBe(0)
    expect((await data(await call('/api/library/status', { as: admin })))).toMatchObject({ enabled: false, reason: 'missing_scope', canEnable: true })
    expect((await data(await call('/api/library/status', { as: staff })))).toMatchObject({ enabled: false, reason: 'missing_scope', canEnable: false })
    // สมาชิกเห็นเพียงว่ายังไม่พร้อม ไม่เห็นรายละเอียดการเชื่อมต่อ
    const forMember = await data(await call('/api/library/status', { as: member }))
    expect(forMember).toMatchObject({ enabled: false, reason: 'unavailable', canEnable: false, message: 'คลังไฟล์ของชมรมยังไม่พร้อมใช้งานในตอนนี้ ติดต่อทีมงาน' })
    expect((await data(await files(member))).message).toBe('คลังไฟล์ของชมรมยังไม่พร้อมใช้งานในตอนนี้ ติดต่อทีมงาน')
  })

  it('สิทธิ์อ่านคลังขอเพิ่มได้เฉพาะผู้ดูแลผ่านขั้นตอนเชื่อมบัญชีชมรม และไม่อยู่ในขั้นตอนเข้าสู่ระบบของใคร', async () => {
    const connect = await call('/api/google/connect', { method: 'POST', as: admin, body: { service: 'library', returnTo: '/files' } })
    expect(connect.status).toBe(200)
    const authUrl = new URL((await data(connect)).authUrl)
    const scopes = authUrl.searchParams.get('scope')!.split(' ')
    expect(scopes).toContain(READONLY)
    expect(scopes).toContain('https://www.googleapis.com/auth/drive.file')
    // ไม่ขอสิทธิ์เขียนทั้ง Drive
    expect(scopes).not.toContain('https://www.googleapis.com/auth/drive')
    expect(authUrl.searchParams.get('include_granted_scopes')).toBe('true')
    expect(authUrl.searchParams.get('login_hint')).toBe(CLUB_EMAIL)

    expect((await call('/api/google/connect', { method: 'POST', as: staff, body: { service: 'library' } })).status).toBe(403)
    expect((await call('/api/google/connect', { method: 'POST', as: member, body: { service: 'library' } })).status).toBe(403)
    expect((await call('/api/google/connect', { method: 'POST', as: admin, body: { service: 'library', returnTo: 'https://evil.example' } })).status).toBe(422)
    expect((await call('/api/google/connect', { method: 'POST', as: admin, body: { service: 'library', returnTo: '/member' } })).status).toBe(422)

    const login = await call('/auth/login')
    expect(new URL(login.headers.get('Location')!).searchParams.get('scope')).toBe('openid email profile')
  })

  it('Google แจ้งว่า token ไม่มีสิทธิ์อ่านไฟล์ (แม้ระบบบันทึกว่ามี): ตอบว่าต้องเปิดใช้คลัง ไม่ตอบว่าไม่มีไฟล์', async () => {
    await connectClub(google, LIBRARY_SCOPES)
    google.failOnce((url) => url.pathname === '/drive/v3/files', 403, { error: { code: 403, errors: [{ reason: 'insufficientPermissions' }] } })
    const res = await files(staff)
    expect(res.status).toBe(409)
    expect(await data(res)).toMatchObject({ error: 'library_unavailable', reason: 'missing_scope' })
  })
})

describe('รายการไฟล์', () => {
  beforeEach(() => connectClub(google, LIBRARY_SCOPES))

  it('แสดงไฟล์ที่บัญชีชมรมเข้าถึงได้: ไม่มีไฟล์ในถังขยะ ไม่มีโฟลเดอร์ มีไฟล์ที่ถูกแชร์มา ทางลัด และไฟล์ที่ไม่มีตัวอย่าง', async () => {
    const folder = drive.add({ name: 'เอกสารประชุม', mimeType: MIME.folder })
    const doc = drive.add({ name: 'รายงานประชุม', mimeType: MIME.doc, parents: [folder.id] })
    drive.add({ name: 'งบประมาณ', mimeType: MIME.sheet })
    drive.add({ name: 'โปสเตอร์.png', mimeType: 'image/png', bytes: new Uint8Array(10), ownedByMe: false, parents: [] })
    drive.add({ name: 'ระเบียบ.docx', mimeType: MIME.docx, bytes: new Uint8Array(20) })
    drive.add({ name: 'คลิป.mp4', mimeType: 'video/mp4', bytes: new Uint8Array(30) })
    drive.add({ name: 'ทางลัดรายงาน', mimeType: MIME.shortcut, shortcut: { targetId: doc.id, targetMimeType: MIME.doc } })
    drive.add({ name: 'ไฟล์ในถังขยะ', mimeType: MIME.pdf, trashed: true })

    const res = await files(member)
    expect(res.status).toBe(200)
    const body = await data(res)
    expect(body.files.map((f: any) => f.name)).toEqual(['ทางลัดรายงาน', 'คลิป.mp4', 'ระเบียบ.docx', 'โปสเตอร์.png', 'งบประมาณ', 'รายงานประชุม'])
    expect(body).toMatchObject({ nextPageToken: null, incomplete: false, stale: false, pageSize: 30 })
    expect(Date.parse(body.fetchedAt)).toBeGreaterThan(Date.now() - 5000)
    const byName = Object.fromEntries(body.files.map((f: any) => [f.name, f]))
    expect(byName['รายงานประชุม']).toMatchObject({ kind: 'doc', folder: 'เอกสารประชุม', shortcut: false, shared: false, previewable: true })
    expect(byName['งบประมาณ']).toMatchObject({ kind: 'sheet', folder: null })
    expect(byName['โปสเตอร์.png']).toMatchObject({ kind: 'image', shared: true, size: 10, previewable: true })
    // ไฟล์ที่ไม่มีตัวอย่างในเว็บยังอยู่ในรายการ
    expect(byName['ระเบียบ.docx']).toMatchObject({ kind: 'office', previewable: false })
    expect(byName['คลิป.mp4']).toMatchObject({ kind: 'video', previewable: false })
    expect(byName['ทางลัดรายงาน']).toMatchObject({ kind: 'doc', shortcut: true, previewable: true })
    // สมาชิกและทีมงานเห็นรายการเดียวกัน
    expect(await names(await files(staff))).toEqual(body.files.map((f: any) => f.name))
    // รายการใช้ metadata เท่านั้น: ไม่มีการดึงหรือส่งออกเนื้อหาไฟล์ใด
    expect(googleCalls(google, 'alt=media')).toBe(0)
    expect(googleCalls(google, '/export')).toBe(0)
    const sent = drive.lists[0]
    expect(sent.get('corpora')).toBe('user')
    expect(sent.get('supportsAllDrives')).toBe('true')
    expect(sent.get('includeItemsFromAllDrives')).toBe('true')
    expect(sent.get('pageSize')).toBe('30')
    expect(sent.get('fields')).not.toMatch(/thumbnailLink|webContentLink|exportLinks|permissions|owners|emailAddress/)
    await expectNoTokens(res, JSON.stringify(body))
  })

  it('แบ่งหน้าด้วย nextPageToken: หน้าที่ยังมีต่อไม่ถูกนับเป็นรายการทั้งหมด และไล่ต่อจนครบได้', async () => {
    for (let i = 1; i <= 65; i++) drive.add({ name: `ไฟล์ ${String(i).padStart(2, '0')}`, mimeType: MIME.pdf, bytes: PDF_BYTES })
    const seen: string[] = []
    let query = '?sort=name'
    const sizes: number[] = []
    for (let page = 0; page < 5; page++) {
      const body = await data(await files(member, query))
      seen.push(...body.files.map((f: any) => f.name))
      sizes.push(body.files.length)
      if (!body.nextPageToken) break
      expect(body.files).toHaveLength(30)
      query = `?sort=name&pageToken=${encodeURIComponent(body.nextPageToken)}`
    }
    expect(sizes).toEqual([30, 30, 5])
    expect(seen).toHaveLength(65)
    expect(new Set(seen).size).toBe(65)
    expect(seen[0]).toBe('ไฟล์ 01')
    expect(seen[64]).toBe('ไฟล์ 65')
    // ขอจำนวนน้อยสำหรับหน้าแรกของสมาชิกได้ แต่ขอเกินขนาดหน้าไม่ได้
    expect((await data(await files(member, '?limit=5'))).files).toHaveLength(5)
    expect((await files(member, '?limit=500')).status).toBe(422)
  })

  it('token ของหน้าถัดไปใช้กับคำค้นอื่นไม่ได้: แจ้งให้โหลดใหม่ ไม่แสดงผลผิดชุด', async () => {
    for (let i = 1; i <= 40; i++) drive.add({ name: `ไฟล์ ${i}`, mimeType: MIME.pdf })
    const first = await data(await files(staff))
    const res = await files(staff, `?sort=name&pageToken=${encodeURIComponent(first.nextPageToken)}`)
    expect(res.status).toBe(409)
    expect((await data(res)).error).toBe('page_expired')
  })

  it('ค้นชื่อ กรองประเภท และเรียงลำดับทำที่ Google ด้วยคำค้นที่ server สร้างเอง', async () => {
    drive.add({ name: 'แผนงาน 2569', mimeType: MIME.doc })
    drive.add({ name: 'แผนงบ', mimeType: MIME.sheet })
    drive.add({ name: 'สไลด์เปิดบ้าน', mimeType: MIME.slides })
    drive.add({ name: 'ใบสมัคร', mimeType: MIME.form })
    drive.add({ name: 'กติกา.pdf', mimeType: MIME.pdf })
    drive.add({ name: 'โลโก้.png', mimeType: 'image/png' })
    drive.add({ name: 'สรุป.docx', mimeType: MIME.docx })
    drive.add({ name: "it's a 'quote' \\ test.txt", mimeType: 'text/plain' })
    expect(await names(await files(staff, '?q=' + encodeURIComponent('แผน') + '&sort=name'))).toEqual(['แผนงบ', 'แผนงาน 2569'])
    const expected: Record<string, string[]> = {
      doc: ['แผนงาน 2569'], sheet: ['แผนงบ'], slides: ['สไลด์เปิดบ้าน'], form: ['ใบสมัคร'], pdf: ['กติกา.pdf'], image: ['โลโก้.png'], office: ['สรุป.docx'], other: ["it's a 'quote' \\ test.txt"],
    }
    for (const [type, list] of Object.entries(expected)) expect(await names(await files(staff, `?type=${type}`)), type).toEqual(list)
    // อักขระพิเศษในคำค้นถูก escape ไม่เปลี่ยนความหมายของคำค้น
    expect(await names(await files(staff, '?q=' + encodeURIComponent("'quote' \\")))).toEqual(["it's a 'quote' \\ test.txt"])
    expect(await names(await files(staff, '?q=' + encodeURIComponent("' or name contains '")))).toEqual([])
    for (const bad of ['?type=folder', '?sort=size', '?limit=0', '?limit=abc', '?pageToken=' + encodeURIComponent('a b'), '?q=' + 'x'.repeat(101)]) {
      expect((await files(staff, bad)).status, bad).toBe(422)
    }
  })

  it('ไม่มีไฟล์จริง ๆ ต่างจากโหลดไม่สำเร็จ: รายการว่างตอบ 200 พร้อมเวลาที่ถาม Google', async () => {
    const res = await files(member)
    expect(res.status).toBe(200)
    expect(await data(res)).toMatchObject({ files: [], nextPageToken: null, stale: false })
  })

  it('ใช้รายการที่เพิ่งดึงซ้ำช่วงสั้น ๆ และสะท้อนการเปลี่ยนชื่อ สร้าง และลบใน Google เมื่อครบรอบหรือกดรีเฟรช', async () => {
    const file = drive.add({ name: 'ชื่อเดิม', mimeType: MIME.pdf })
    const first = await data(await files(member))
    expect(first.files.map((f: any) => f.name)).toEqual(['ชื่อเดิม'])
    file.name = 'ชื่อใหม่'
    drive.add({ name: 'ไฟล์ที่เพิ่งสร้าง', mimeType: MIME.doc })
    // ภายในช่วงสั้น ๆ: ใช้ชุดเดิม ไม่เรียก Google ซ้ำ ไม่ว่ากี่คนเปิดหน้า
    for (const actor of [member, staff, admin]) expect(await names(await files(actor))).toEqual(['ชื่อเดิม'])
    expect(listCalls()).toBe(1)
    const cachedBody = await data(await files(member))
    expect(cachedBody.fetchedAt).toBe(first.fetchedAt)
    // กดรีเฟรชถี่เกิน: ยังไม่เรียก Google
    expect(await names(await files(member, '?fresh=1'))).toEqual(['ชื่อเดิม'])
    expect(listCalls()).toBe(1)
    // ครบรอบ: ถาม Google ใหม่และได้สถานะล่าสุด
    await expireCache()
    const next = await data(await files(member))
    expect(next.files.map((f: any) => f.name)).toEqual(['ไฟล์ที่เพิ่งสร้าง', 'ชื่อใหม่'])
    expect(Date.parse(next.fetchedAt)).toBeGreaterThan(Date.parse(first.fetchedAt) - 1)
    expect(listCalls()).toBe(2)
    // รีเฟรชหลังพ้นช่วงกันกดถี่ (10 วินาที): ถามใหม่แม้ยังไม่ครบรอบปกติ
    file.trashed = true
    await env.DB.prepare(`UPDATE library_cache SET fetched_at = ? WHERE key LIKE 'list:%'`).bind(new Date(Date.now() - 11_000).toISOString()).run()
    expect(await names(await files(member))).toEqual(['ไฟล์ที่เพิ่งสร้าง', 'ชื่อใหม่'])
    expect(await names(await files(member, '?fresh=1'))).toEqual(['ไฟล์ที่เพิ่งสร้าง'])
    expect(listCalls()).toBe(3)
  })

  it('Google ล้มเหลว: แสดงชุดที่เก็บไว้พร้อมบอกว่าไม่ใช่ข้อมูลล่าสุด ถ้าไม่มีชุดที่เก็บไว้ตอบเป็นข้อผิดพลาด', async () => {
    drive.add({ name: 'ไฟล์เดิม', mimeType: MIME.pdf })
    google.failOnce((url) => url.pathname === '/drive/v3/files', 500)
    const cold = await files(member)
    expect(cold.status).toBe(502)
    const coldBody = await data(cold)
    expect(coldBody.error).toBe('google_error')
    expect(coldBody.files).toBeUndefined()

    // Google ล่มทำให้ระบบเว้นระยะก่อนถามใหม่: ระหว่างนั้นไม่ยิง Google ซ้ำ
    const before = listCalls()
    const waiting = await files(member)
    expect(waiting.status).toBe(429)
    expect(listCalls()).toBe(before)
    await env.DB.prepare('UPDATE library_state SET next_attempt_at = NULL').run()

    const ok = await data(await files(member))
    expect(ok.stale).toBe(false)
    await expireCache()
    google.failOnce((url) => url.pathname === '/drive/v3/files', 429, { error: { code: 429, errors: [{ reason: 'rateLimitExceeded' }] } })
    const stale = await data(await files(member))
    expect(stale).toMatchObject({ stale: true, fetchedAt: (await env.DB.prepare(`SELECT fetched_at FROM library_cache WHERE key LIKE 'list:%'`).first<{ fetched_at: string }>())!.fetched_at })
    expect(stale.files.map((f: any) => f.name)).toEqual(['ไฟล์เดิม'])
    expect(stale.error.code).toBe('rate_limited')
    const state = await env.DB.prepare('SELECT * FROM library_state').first<Record<string, any>>()
    expect(state?.failure_count).toBe(1)
    expect(Date.parse(state?.next_attempt_at)).toBeGreaterThan(Date.now())
  })

  it('Google แจ้งว่าผลค้นหาอาจไม่ครบ: ส่งต่อให้หน้าเว็บบอกผู้ใช้', async () => {
    drive.add({ name: 'ก', mimeType: MIME.pdf })
    drive.incompleteSearch = true
    expect((await data(await files(staff))).incomplete).toBe(true)
  })

  it('ชื่อโฟลเดอร์ถามเพิ่มได้จำกัดต่อคำขอ และจำไว้ใช้ครั้งถัดไป', async () => {
    for (let i = 1; i <= 9; i++) {
      const folder = drive.add({ name: `โฟลเดอร์ ${i}`, mimeType: MIME.folder })
      drive.add({ name: `ไฟล์ในโฟลเดอร์ ${i}`, mimeType: MIME.pdf, parents: [folder.id] })
    }
    const first = await data(await files(staff, '?sort=name'))
    expect(first.files.filter((f: any) => f.folder !== null)).toHaveLength(6)
    // รายการ 1 + โฟลเดอร์บนสุด 1 + ชื่อโฟลเดอร์ไม่เกิน 6
    expect(googleCalls(google, '/drive/v3/files')).toBe(8)
    await expireCache()
    const second = await data(await files(staff, '?sort=name'))
    expect(second.files.filter((f: any) => f.folder !== null)).toHaveLength(9)
  })
})

describe('สิทธิ์เปิดคลัง', () => {
  beforeEach(() => connectClub(google, LIBRARY_SCOPES))

  it('ต้องเข้าสู่ระบบ: ทุกเส้นทางของคลังตอบ 401 เมื่อไม่มี session และบัญชีที่ถูกปิดใช้ session เดิมไม่ได้', async () => {
    const file = drive.add({ name: 'ลับ.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    const paths = ['/api/library/status', '/api/library/files', `/api/library/files/${file.id}`, `/api/library/files/${file.id}/content`, `/api/library/files/${file.id}/text`, `/api/library/files/${file.id}/sheet`, `/api/library/files/${file.id}/form`]
    for (const path of paths) {
      const res = await call(path)
      expect(res.status, path).toBe(401)
      expect(await res.text()).not.toContain('%PDF')
    }
    expect((await call(`/api/library/files/${file.id}/content`, { as: member })).status).toBe(200)
    await env.DB.prepare(`UPDATE member_accounts SET status = 'disabled' WHERE member_id = ?`).bind(member.id).run()
    for (const path of paths) expect((await call(path, { as: member })).status, path).toBe(401)
    expect(googleCalls(google, 'alt=media')).toBe(1)
  })

  it('สมาชิกที่ยังไม่เปลี่ยนรหัสผ่านชั่วคราวเปิดรายการ รายละเอียด และเนื้อหาไฟล์ไม่ได้ และไม่มีคำขอไป Google', async () => {
    const file = drive.add({ name: 'ลับ.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    const temp = await seedMemberActor({ mustChange: true })
    const before = google.calls.length
    for (const path of ['/api/library/status', '/api/library/files', `/api/library/files/${file.id}`, `/api/library/files/${file.id}/content`, `/api/library/files/${file.id}/text`, `/api/library/files/${file.id}/sheet`, `/api/library/files/${file.id}/form`]) {
      const res = await call(path, { as: temp })
      expect(res.status, path).toBe(403)
      expect((await data(res)).error).toBe('password_change_required')
    }
    expect(google.calls.length).toBe(before)
  })

  it('คลังอ่านได้อย่างเดียว: ไม่มีคำสั่งเปลี่ยนข้อมูลใด', async () => {
    const file = drive.add({ name: 'ก.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    for (const actor of [admin, member]) {
      for (const method of ['POST', 'PUT', 'PATCH', 'DELETE']) {
        for (const path of ['/api/library/files', `/api/library/files/${file.id}`, `/api/library/files/${file.id}/content`]) {
          expect((await call(path, { method, as: actor, body: {} })).status, `${method} ${path}`).toBe(404)
        }
      }
    }
    expect(google.calls.filter((c) => c.method !== 'GET' && !c.url.includes('oauth2'))).toEqual([])
  })

  it('สมาชิกเปิดไฟล์ได้เมื่อเปิดใช้คลังแล้วเท่านั้น ส่วนทีมงานยังเปิดตัวอย่างของเอกสารที่เว็บสร้างได้ด้วยสิทธิ์เดิม', async () => {
    await env.DB.prepare(`UPDATE google_connections SET scopes = ?`).bind(ALL_SCOPES).run()
    const doc = drive.add({ name: 'เอกสารของเว็บ', mimeType: MIME.doc })
    expect((await call(`/api/library/files/${doc.id}`, { as: staff })).status).toBe(200)
    expect((await call(`/api/library/files/${doc.id}/content`, { as: staff })).status).toBe(200)
    for (const path of [`/api/library/files/${doc.id}`, `/api/library/files/${doc.id}/content`]) {
      const res = await call(path, { as: member })
      expect(res.status, path).toBe(409)
      expect((await data(res)).error).toBe('library_unavailable')
    }
  })
})

describe('ตัวอย่างไฟล์', () => {
  beforeEach(() => connectClub(google, LIBRARY_SCOPES))

  const detail = async (id: string, as: Actor = member) => data(await call(`/api/library/files/${id}`, { as }))
  const content = (id: string, as: Actor = member, headers: Record<string, string> = {}) => call(`/api/library/files/${id}/content`, { as, headers })

  it('เอกสาร Google: ส่งออกเป็น PDF ผ่านเว็บ พร้อมส่วนหัวที่กันการ cache และกันการรันเนื้อหา', async () => {
    const doc = drive.add({ name: 'รายงาน "ไตรมาส 3"', mimeType: MIME.doc })
    const info = await detail(doc.id)
    expect(info.file).toMatchObject({ id: doc.id, name: 'รายงาน "ไตรมาส 3"', kind: 'doc' })
    expect(info.preview).toMatchObject({ kind: 'pdf', reason: null })
    const res = await content(doc.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('application/pdf')
    expect(res.headers.get('Cache-Control')).toBe('private, no-store')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
    expect(res.headers.get('Content-Disposition')).toMatch(/^inline; filename\*=UTF-8''/)
    expect(res.headers.get('Content-Disposition')).not.toMatch(/["\r\n]/)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    const body = new Uint8Array(await res.arrayBuffer())
    expect(body).toEqual(PDF_BYTES)
    await expectNoTokens(res, new TextDecoder().decode(body))
    expect(google.calls.some((c) => c.url.includes(`/drive/v3/files/${doc.id}/export?mimeType=application%2Fpdf`))).toBe(true)
    // สไลด์ใช้วิธีเดียวกัน
    const slides = drive.add({ name: 'สไลด์', mimeType: MIME.slides })
    expect((await detail(slides.id)).preview.kind).toBe('pdf')
    expect((await content(slides.id)).headers.get('Content-Type')).toBe('application/pdf')
  })

  it('ปุ่มแก้ไขมีเฉพาะทีมงาน สมาชิกได้เพียงลิงก์เปิดต้นฉบับของ Google', async () => {
    const doc = drive.add({ name: 'แผนงาน', mimeType: MIME.doc })
    const readOnly = drive.add({ name: 'ของคนอื่น', mimeType: MIME.sheet, canEdit: false, tabs: [{ sheetId: 0, title: 'S', cells: [['a']] }] })
    const forMember = await detail(doc.id, member)
    expect(forMember.links).toEqual({ open: `https://drive.google.com/file/d/${doc.id}/view?usp=drivesdk`, edit: null })
    expect(forMember.registered).toBeUndefined()
    const forStaff = await detail(doc.id, staff)
    expect(forStaff.links.edit).toEqual({ url: `https://drive.google.com/file/d/${doc.id}/view?usp=drivesdk`, label: 'แก้ไขใน Google Docs' })
    expect(forStaff.registered).toBeNull()
    // บัญชีชมรมแก้ไฟล์นี้ไม่ได้: ไม่เรียกว่าปุ่มแก้ไข
    expect((await detail(readOnly.id, staff)).links.edit.label).toBe('เปิดใน Google Sheets')
    // ไฟล์ทั่วไปไม่มีปุ่มแก้ไขใน Google
    const pdf = drive.add({ name: 'ก.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    expect((await detail(pdf.id, staff)).links.edit).toBeNull()
  })

  it('ไฟล์ PDF: ส่งไฟล์ตามจริง รองรับ Range และชนิดเนื้อหากำหนดที่ server', async () => {
    const bytes = new Uint8Array(5000).map((_, i) => i % 251)
    const pdf = drive.add({ name: 'คู่มือ.pdf', mimeType: MIME.pdf, bytes })
    const full = await content(pdf.id)
    expect(full.status).toBe(200)
    // Google จำลองส่ง text/html มา: ระบบไม่ส่งต่อค่านั้น
    expect(full.headers.get('Content-Type')).toBe('application/pdf')
    expect(full.headers.get('Accept-Ranges')).toBe('bytes')
    expect(full.headers.get('Content-Length')).toBe('5000')
    expect(new Uint8Array(await full.arrayBuffer())).toEqual(bytes)
    const part = await content(pdf.id, member, { Range: 'bytes=100-199' })
    expect(part.status).toBe(206)
    expect(part.headers.get('Content-Range')).toBe('bytes 100-199/5000')
    expect(new Uint8Array(await part.arrayBuffer())).toEqual(bytes.slice(100, 200))
    // Range ที่ผิดรูปแบบไม่ถูกส่งต่อไป Google
    const odd = await content(pdf.id, member, { Range: 'bytes=0-1, 5-9' })
    expect(odd.status).toBe(200)
  })

  it('รูปภาพที่ปลอดภัยแสดงได้ ส่วน SVG, HTML และชนิดอื่นไม่ถูกส่งเป็นเนื้อหาที่รันได้', async () => {
    const png = drive.add({ name: 'โลโก้.png', mimeType: 'image/png', bytes: new Uint8Array([137, 80, 78, 71]) })
    const res = await content(png.id)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('image/png')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
    for (const [name, mimeType] of [['วาด.svg', 'image/svg+xml'], ['หน้าเว็บ.html', 'text/html'], ['สคริปต์.js', 'text/javascript'], ['คลิป.mp4', 'video/mp4'], ['สรุป.docx', MIME.docx], ['ภาพ.heic', 'image/heic']]) {
      const file = drive.add({ name, mimeType, bytes: new TextEncoder().encode('<script>alert(1)</script>') })
      const info = await detail(file.id)
      expect(info.preview, name).toMatchObject({ kind: 'none', reason: 'unsupported' })
      // ยังเปิดต้นฉบับได้ด้วยลิงก์ของ Google
      expect(info.links.open, name).toBe(`https://drive.google.com/file/d/${file.id}/view?usp=drivesdk`)
      const blocked = await content(file.id)
      expect(blocked.status, name).toBe(415)
      expect(await blocked.text()).not.toContain('<script>')
      expect((await call(`/api/library/files/${file.id}/text`, { as: member })).status, name).toBe(415)
    }
    expect(googleCalls(google, 'alt=media')).toBe(1)
  })

  it('ไฟล์ใหญ่เกินขีดจำกัด และเอกสารที่ Google ไม่ยอมส่งออก: บอกเหตุผลตรง ๆ และยังเปิดต้นฉบับได้', async () => {
    const big = drive.add({ name: 'ใหญ่.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES, size: 25 * 1024 * 1024 + 1 })
    const info = await detail(big.id)
    expect(info.preview).toMatchObject({ kind: 'none', reason: 'too_large', maxBytes: 25 * 1024 * 1024 })
    expect(info.links.open).toBeTruthy()
    const res = await content(big.id)
    expect(res.status).toBe(413)
    expect((await data(res)).error).toBe('file_too_large')
    expect(googleCalls(google, 'alt=media')).toBe(0)

    const huge = drive.add({ name: 'เอกสารยาวมาก', mimeType: MIME.doc, exported: 'too_large' })
    expect((await detail(huge.id)).preview.kind).toBe('pdf')
    const exported = await content(huge.id)
    expect(exported.status).toBe(413)
    expect(await data(exported)).toMatchObject({ error: 'export_too_large' })
  })

  it('เจ้าของปิดการดาวน์โหลด: ไม่แสดงตัวอย่าง และไม่พยายามดึงเนื้อหา', async () => {
    const file = drive.add({ name: 'ห้ามโหลด.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES, canDownload: false })
    expect((await detail(file.id)).preview).toMatchObject({ kind: 'none', reason: 'download_disabled' })
    const res = await content(file.id)
    expect(res.status).toBe(403)
    expect((await data(res)).error).toBe('download_disabled')
    expect(googleCalls(google, 'alt=media')).toBe(0)
  })

  it('โฟลเดอร์ไม่ถูกส่งออกเป็นเอกสาร และทางลัดถูกตามไปยังไฟล์ปลายทางโดย Google ตรวจสิทธิ์อีกครั้ง', async () => {
    const folder = drive.add({ name: 'โฟลเดอร์', mimeType: MIME.folder })
    expect((await detail(folder.id)).preview).toMatchObject({ kind: 'none', reason: 'folder' })
    expect((await content(folder.id)).status).toBe(415)
    expect(googleCalls(google, '/export')).toBe(0)

    const target = drive.add({ name: 'ต้นฉบับ.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    const shortcut = drive.add({ name: 'ทางลัดไปต้นฉบับ', mimeType: MIME.shortcut, shortcut: { targetId: target.id, targetMimeType: MIME.pdf } })
    const info = await detail(shortcut.id)
    expect(info.file).toMatchObject({ id: shortcut.id, name: 'ทางลัดไปต้นฉบับ', shortcut: true, kind: 'pdf' })
    expect(info.preview.kind).toBe('pdf')
    expect(new Uint8Array(await (await content(shortcut.id)).arrayBuffer())).toEqual(PDF_BYTES)

    const toFolder = drive.add({ name: 'ทางลัดไปโฟลเดอร์', mimeType: MIME.shortcut, shortcut: { targetId: folder.id, targetMimeType: MIME.folder } })
    expect((await detail(toFolder.id)).preview).toMatchObject({ kind: 'none', reason: 'folder' })
    // ปลายทางที่บัญชีชมรมเปิดไม่ได้แล้ว
    const gone = drive.add({ name: 'ถูกยกเลิกแชร์.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES, inaccessible: true })
    const dangling = drive.add({ name: 'ทางลัดเสีย', mimeType: MIME.shortcut, shortcut: { targetId: gone.id, targetMimeType: MIME.pdf } })
    for (const path of [`/api/library/files/${dangling.id}`, `/api/library/files/${dangling.id}/content`]) {
      const res = await call(path, { as: member })
      expect(res.status, path).toBe(404)
      expect((await data(res)).error).toBe('file_unavailable')
    }
  })

  it('ไฟล์ที่ถูกลบ อยู่ในถังขยะ บัญชีชมรมเปิดไม่ได้ หรือรหัสไม่ถูกต้อง: ตอบว่าเปิดไม่ได้ ไม่ส่งเนื้อหา', async () => {
    const trashed = drive.add({ name: 'ถังขยะ.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES, trashed: true })
    const denied = drive.add({ name: 'ไม่มีสิทธิ์.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES, inaccessible: true })
    for (const id of [trashed.id, denied.id, 'file-that-does-not-exist', 'x', '../../etc/passwd', 'https:%2F%2Fevil.example%2Ffile']) {
      for (const suffix of ['', '/content', '/text', '/sheet', '/form']) {
        const res = await call(`/api/library/files/${id}${suffix}`, { as: member })
        expect(res.status, `${id}${suffix}`).toBe(404)
        const text = await res.text()
        expect(text).not.toContain('%PDF')
      }
    }
    // รหัสที่ไม่ใช่รูปแบบของ Drive ไม่ถูกส่งไป Google เลย
    expect(google.calls.some((c) => c.url.includes('evil.example') || c.url.includes('passwd'))).toBe(false)
    expect(googleCalls(google, 'alt=media')).toBe(0)
  })

  it('ไฟล์ข้อความ: ส่งเป็นข้อความใน JSON และบอกเมื่อแสดงไม่ครบทั้งไฟล์', async () => {
    const small = drive.add({ name: 'บันทึก.txt', mimeType: 'text/plain', bytes: new TextEncoder().encode('บรรทัดที่ 1\n<b>ไม่ใช่ HTML</b>') })
    const res = await call(`/api/library/files/${small.id}/text`, { as: member })
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect(await data(res)).toMatchObject({ text: 'บรรทัดที่ 1\n<b>ไม่ใช่ HTML</b>', truncated: false, maxBytes: 512 * 1024 })
    const big = drive.add({ name: 'ยาว.csv', mimeType: 'text/csv', bytes: new Uint8Array(600 * 1024).fill(65) })
    const body = await data(await call(`/api/library/files/${big.id}/text`, { as: member }))
    expect(body.text).toHaveLength(512 * 1024)
    expect(body).toMatchObject({ truncated: true, bytes: 512 * 1024, totalBytes: 600 * 1024 })
    const empty = drive.add({ name: 'ว่าง.txt', mimeType: 'text/plain', bytes: new Uint8Array() })
    expect(await data(await call(`/api/library/files/${empty.id}/text`, { as: member }))).toMatchObject({ text: '', truncated: false })
    expect((await detail(small.id)).preview.kind).toBe('text')
  })

  it('Google Sheets: เลือกแท็บได้ บอกขอบเขตที่แสดง และไม่แสดงแท็บ แถว หรือคอลัมน์ที่ซ่อน', async () => {
    const rows = Array.from({ length: 450 }, (_, r) => [`แถว ${r + 1}`, `ค่า ${r + 1}`, 'ซ่อน', ''])
    const sheet = drive.add({
      name: 'ตารางซ้อม', mimeType: MIME.sheet,
      tabs: [
        { sheetId: 0, title: "ตาราง 'หลัก'", cells: rows, rowCount: 1000, columnCount: 60, hiddenRows: [1], hiddenColumns: [2] },
        { sheetId: 77, title: 'สรุป', cells: [['รวม', '450']], rowCount: 10, columnCount: 5 },
        { sheetId: 99, title: 'ซ่อนทั้งแท็บ', cells: [['ลับ']], hidden: true },
      ],
    })
    const sheetOf = async (query = '') => data(await call(`/api/library/files/${sheet.id}/sheet${query}`, { as: member }))
    const first = await sheetOf()
    expect(first.title).toBe('ตารางซ้อม')
    expect(first.tabs.map((t: any) => t.title)).toEqual(["ตาราง 'หลัก'", 'สรุป'])
    expect(first.tab).toBe(0)
    expect(first.range).toEqual({ firstRow: 1, lastRow: 200, firstColumn: 1, lastColumn: 40, totalRows: 1000, totalColumns: 60 })
    expect(first).toMatchObject({ hasMoreRows: true, truncatedColumns: true, hiddenRows: 1, hiddenColumns: 1 })
    expect(first.rows).toHaveLength(199)
    expect(first.rows[0]).toEqual({ number: 1, cells: ['แถว 1', 'ค่า 1', ...Array(37).fill('')] })
    expect(first.rows[1].number).toBe(3)
    expect(JSON.stringify(first)).not.toContain('ซ่อน')
    expect(first.columns).toHaveLength(39)
    expect(first.columns.slice(0, 3)).toEqual([1, 2, 4])

    const third = await sheetOf('?offset=400')
    expect(third.range).toMatchObject({ firstRow: 401, lastRow: 600 })
    // แถวว่างท้ายช่วงไม่ถูกส่ง แต่ขอบเขตที่อ่านยังรายงานตามจริง และยังมีแถวในชีตต่ออีก
    expect(third.rows).toHaveLength(50)
    expect(third.hasMoreRows).toBe(true)
    const last = await sheetOf('?offset=800')
    expect(last).toMatchObject({ hasMoreRows: false, rows: [] })

    const summary = await sheetOf('?tab=77')
    expect(summary).toMatchObject({ tab: 77, hasMoreRows: false, truncatedColumns: false })
    expect(summary.rows).toEqual([{ number: 1, cells: ['รวม', '450', '', '', ''] }])
    // แท็บที่ซ่อนหรือไม่มี เปิดไม่ได้แม้ระบุรหัสตรง ๆ
    for (const tab of ['99', '12345', 'abc']) expect((await call(`/api/library/files/${sheet.id}/sheet?tab=${tab}`, { as: member })).status, tab).toBe(404)
    for (const offset of ['-1', '1.5', 'x']) expect((await call(`/api/library/files/${sheet.id}/sheet?offset=${offset}`, { as: member })).status, offset).toBe(422)
    expect((await detail(sheet.id)).preview.kind).toBe('sheet')
    const pdf = drive.add({ name: 'ก.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    expect((await call(`/api/library/files/${pdf.id}/sheet`, { as: member })).status).toBe(415)
    expect((await content(sheet.id)).status).toBe(415)
  })

  it('Google Forms: แสดงชื่อ คำอธิบาย และคำถาม ไม่มีคำตอบของผู้ตอบ และสมาชิกไม่ได้ลิงก์หน้าแก้ฟอร์ม', async () => {
    const form = ws.addForm('ใบสมัครสมาชิก', [
      { title: 'ชื่อ-นามสกุล', questionItem: { question: { required: true, textQuestion: {} } } },
      { title: 'เกมที่เล่น', description: 'เลือกได้หลายข้อ', questionItem: { question: { choiceQuestion: { type: 'CHECKBOX', options: [{ value: 'Valorant' }, { value: 'RoV' }, { isOther: true }] } } } },
      { title: 'ส่วนที่ 2', pageBreakItem: {} },
    ])
    form.info.description = 'กรอกเพื่อสมัครเข้าชมรม'
    ws.submit(form.formId, { q1: 'คำตอบลับของผู้ตอบ' }, { email: 'respondent@example.com' })
    drive.add({ id: form.formId, name: 'ใบสมัครสมาชิก', mimeType: MIME.form })

    const res = await call(`/api/library/files/${form.formId}/form`, { as: member })
    const body = await data(res)
    expect(body).toMatchObject({ title: 'ใบสมัครสมาชิก', description: 'กรอกเพื่อสมัครเข้าชมรม', responderUrl: `https://docs.google.com/forms/d/e/${form.formId}/viewform` })
    expect(body.items).toEqual([
      { kind: 'short_text', title: 'ชื่อ-นามสกุล', description: '', required: true, options: [], rows: [] },
      { kind: 'checkbox', title: 'เกมที่เล่น', description: 'เลือกได้หลายข้อ', required: false, options: ['Valorant', 'RoV', 'อื่น ๆ'], rows: [] },
      { kind: 'section', title: 'ส่วนที่ 2', description: '', required: false, options: [], rows: [] },
    ])
    expect(JSON.stringify(body)).not.toMatch(/คำตอบลับ|respondent@example\.com|responseId/)
    // ตัวอย่างฟอร์มไม่เรียกคำตอบของผู้ตอบจาก Google เลย
    expect(googleCalls(google, '/responses')).toBe(0)
    await expectNoTokens(res, JSON.stringify(body))

    const forMember = await detail(form.formId, member)
    expect(forMember.preview.kind).toBe('form')
    expect(forMember.links).toEqual({ open: null, edit: null })
    const forStaff = await detail(form.formId, staff)
    expect(forStaff.links.edit).toEqual({ url: `https://docs.google.com/forms/d/${form.formId}/edit`, label: 'แก้ไขใน Google Forms' })
    // คำตอบของผู้ตอบและการนำเข้ายังเป็นเส้นทางของทีมงานเท่านั้น
    expect((await call('/api/forms', { as: member })).status).toBe(403)
    const pdf = drive.add({ name: 'ก.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    expect((await call(`/api/library/files/${pdf.id}/form`, { as: member })).status).toBe(415)
  })

  it('Google จำกัดคำขอหรือขัดข้องระหว่างเปิดไฟล์: ตอบเป็นข้อผิดพลาดที่ลองใหม่ได้ ไม่ตอบว่าไฟล์หาย', async () => {
    const pdf = drive.add({ name: 'ก.pdf', mimeType: MIME.pdf, bytes: PDF_BYTES })
    google.failOnce((url) => url.pathname.endsWith(pdf.id), 429, { error: { code: 429, errors: [{ reason: 'userRateLimitExceeded' }] } })
    const limited = await call(`/api/library/files/${pdf.id}`, { as: member })
    expect(limited.status).toBe(429)
    expect((await data(limited)).error).toBe('rate_limited')
    google.failOnce((url) => url.searchParams.get('alt') === 'media', 503)
    const broken = await content(pdf.id)
    expect(broken.status).toBe(502)
    expect((await data(broken)).error).toBe('google_error')
    expect((await content(pdf.id)).status).toBe(200)
  })

  it('ทีมงานเห็นว่าไฟล์ใดเป็นเอกสารที่ลงทะเบียนไว้ในเว็บ และลิงก์เอกสารเดิมพาไปยังไฟล์เดียวกัน', async () => {
    const created = await call('/api/documents', { method: 'POST', as: staff, headers: { 'Idempotency-Key': 'library-doc-key-00001' }, body: { title: 'เอกสารจากเว็บ', text: '' } })
    expect(created.status).toBe(201)
    const document = (await data(created)).document
    expect(document.googleId).toBeTruthy()
    drive.add({ id: document.googleId, name: 'เอกสารจากเว็บ', mimeType: MIME.doc })
    const info = await detail(document.googleId, staff)
    expect(info.registered).toEqual({ documentId: document.id })
    const old = await data(await call(`/api/documents/${document.id}/file`, { as: staff }))
    expect(old.document).toMatchObject({ id: document.id, googleId: document.googleId, title: 'เอกสารจากเว็บ' })
    expect((await call(`/api/documents/${document.id}/file`, { as: member })).status).toBe(403)
    expect((await call('/api/documents/no-such-id/file', { as: staff })).status).toBe(404)
  })
})
