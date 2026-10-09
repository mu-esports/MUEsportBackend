import { beforeEach, describe, expect, it } from 'vitest'
import { inspectImage, MAX_PHOTO_BYTES } from '../worker/photos'
import { call, CLUB_EMAIL, data, env, resetDb, seedAccount, seedMember, seedMemberActor, seedMemberSession, seedUser } from './helpers'
import type { Actor } from './helpers'

/**
 * รูปโปรไฟล์ของคนในทะเบียน: สิทธิ์อ่าน/เขียน ขนาดและชนิดไฟล์ที่ตรวจจากเนื้อไฟล์จริง การแทนรูป การลบ การ cache และการไม่หายเมื่อจัดการบัญชี
 * รันกับ Worker และ D1 local ของชุดทดสอบ ไฟล์รูปในนี้เป็นส่วนหัวที่สร้างขึ้นเพื่อทดสอบ ไม่ใช่รูปของบุคคลจริง
 */
let admin: Actor
let staff: Actor

beforeEach(async () => {
  await resetDb()
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staff = await seedUser('staff@example.com', 'staff')
})

// ---------- ไฟล์รูปทดสอบ (ส่วนหัวถูกต้องตามรูปแบบ ตามด้วยไบต์เติมให้ได้ขนาดที่ต้องการ) ----------
const pad = (head: number[], size: number, fill = 0x11) => {
  const out = new Uint8Array(Math.max(size, head.length)).fill(fill)
  out.set(head)
  return out
}
const be32 = (n: number) => [(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]
const be16 = (n: number) => [(n >>> 8) & 255, n & 255]
const le16 = (n: number) => [n & 255, (n >>> 8) & 255]
const le24 = (n: number) => [n & 255, (n >>> 8) & 255, (n >>> 16) & 255]
const ascii = (text: string) => [...text].map((c) => c.charCodeAt(0))

const png = (width: number, height: number, size = 64, fill = 0x11) =>
  pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IHDR'), ...be32(width), ...be32(height), 8, 2, 0, 0, 0, 1, 2, 3, 4], size, fill)
const jpeg = (width: number, height: number, size = 64) =>
  pad([0xff, 0xd8, 0xff, 0xe0, ...be16(16), ...ascii('JFIF'), 0, 1, 1, 0, 0, 1, 0, 1, 0, 0, 0xff, 0xc0, ...be16(17), 8, ...be16(height), ...be16(width), 3, 1, 0x11, 0, 2, 0x11, 1, 3, 0x11, 1], size)
const webpExtended = (width: number, height: number, flags = 0, size = 64) =>
  pad([...ascii('RIFF'), 0x38, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8X'), 10, 0, 0, 0, flags, 0, 0, 0, ...le24(width - 1), ...le24(height - 1)], size)
const webpLossy = (width: number, height: number) =>
  pad([...ascii('RIFF'), 0x38, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '), 0x20, 0, 0, 0, 0x30, 0x01, 0x00, 0x9d, 0x01, 0x2a, ...le16(width), ...le16(height)], 64)
const webpLossless = (width: number, height: number) => {
  const bits = ((width - 1) | ((height - 1) << 14)) >>> 0
  return pad([...ascii('RIFF'), 0x38, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8L'), 0x20, 0, 0, 0, 0x2f, bits & 255, (bits >>> 8) & 255, (bits >>> 16) & 255, (bits >>> 24) & 255], 64)
}

const url = (id: string) => `/api/members/${id}/photo`
const put = (as: Actor | null, id: string, bytes: Uint8Array, type = 'image/png', options: { raw?: boolean; headers?: Record<string, string> } = {}) =>
  call(url(id), { method: 'PUT', as, body: bytes, raw: options.raw, headers: { 'Content-Type': type, ...options.headers } })
const get = (as: Actor | null, id: string, headers: Record<string, string> = {}) => call(url(id), { as, headers })
const del = (as: Actor | null, id: string) => call(url(id), { method: 'DELETE', as })
const photoRow = (id: string) => env.DB.prepare('SELECT content_type, size, width, height, version, updated_by FROM member_photos WHERE member_id = ?').bind(id).first<Record<string, any>>()
const memberOf = async (id: string) => (await data(await call('/api/members', { as: staff }))).members.find((m: any) => m.id === id)
const bytesOf = async (res: Response) => new Uint8Array(await res.arrayBuffer())

describe('ตรวจชนิดและขนาดจากเนื้อไฟล์', () => {
  it('อ่านชนิดและขนาดภาพของ JPEG, PNG และ WebP (lossy, lossless, extended) จากส่วนหัว', () => {
    expect(inspectImage(png(512, 300))).toEqual({ type: 'image/png', width: 512, height: 300 })
    expect(inspectImage(jpeg(480, 512))).toEqual({ type: 'image/jpeg', width: 480, height: 512 })
    expect(inspectImage(webpExtended(512, 512))).toEqual({ type: 'image/webp', width: 512, height: 512 })
    expect(inspectImage(webpLossy(320, 240))).toEqual({ type: 'image/webp', width: 320, height: 240 })
    expect(inspectImage(webpLossless(400, 100))).toEqual({ type: 'image/webp', width: 400, height: 100 })
    // JPEG ที่มีส่วนอื่นคั่นก่อนส่วนที่บอกขนาด และมีไบต์เติมก่อน marker
    const withExtras = new Uint8Array([0xff, 0xd8, 0xff, 0xfe, 0, 4, 1, 2, 0xff, 0xff, 0xdb, 0, 3, 9, 0xff, 0xc2, 0, 11, 8, 0, 100, 0, 200, 1, 1, 0x11, 0])
    expect(inspectImage(withExtras)).toEqual({ type: 'image/jpeg', width: 200, height: 100 })
  })

  it('ไฟล์ที่ไม่ใช่รูปที่รองรับ หรือส่วนหัวไม่ครบ ไม่ผ่าน แม้จะตั้งชื่อหรือแจ้งชนิดเป็นรูป', () => {
    const text = (value: string) => new TextEncoder().encode(value)
    const rejected: [string, Uint8Array][] = [
      ['ว่าง', new Uint8Array()],
      ['SVG', text('<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><script>alert(1)</script></svg>')],
      ['HTML', text('<!doctype html><html><body><img src=x onerror=alert(1)></body></html>')],
      ['GIF', pad([...ascii('GIF89a'), 10, 0, 10, 0], 64)],
      ['BMP', pad([...ascii('BM')], 64)],
      ['PDF', text('%PDF-1.4 fake')],
      ['PNG ถูกตัด', png(100, 100).slice(0, 20)],
      ['PNG ที่ chunk แรกไม่ใช่ IHDR', pad([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, ...be32(13), ...ascii('IDAT'), ...be32(10), ...be32(10)], 64)],
      ['PNG ขนาดศูนย์', png(0, 10)],
      ['JPEG ไม่มีส่วนบอกขนาด', new Uint8Array([0xff, 0xd8, 0xff, 0xe0, 0, 4, 1, 2, 0xff, 0xda, 0, 2, 0xff, 0xd9])],
      ['JPEG มีแต่ส่วนต้น', new Uint8Array([0xff, 0xd8, 0xff])],
      ['WebP ภาพเคลื่อนไหว', webpExtended(100, 100, 0x02)],
      ['RIFF ที่ไม่ใช่ WebP', pad([...ascii('RIFF'), 0x38, 0, 0, 0, ...ascii('WAVE'), ...ascii('fmt ')], 64)],
      ['WebP lossy ที่ไม่มี start code', pad([...ascii('RIFF'), 0x38, 0, 0, 0, ...ascii('WEBP'), ...ascii('VP8 '), 0x20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 100, 0, 100, 0], 64)],
    ]
    for (const [name, bytes] of rejected) expect(inspectImage(bytes), name).toBeNull()
  })
})

describe('สิทธิ์อ่านและแก้รูป', () => {
  it('ทีมงานตั้งรูปได้ ผู้ไม่เข้าสู่ระบบและสมาชิกตั้ง/ลบไม่ได้ และคำสั่งต้องมี Origin กับ CSRF ของเว็บ', async () => {
    const person = await seedMemberActor({ studentId: '6500001' })
    const image = png(256, 256)

    expect((await put(null, person.id, image)).status).toBe(401)
    expect((await del(null, person.id)).status).toBe(401)
    // สมาชิกยังไม่มีสิทธิ์แก้รูปเอง (แม้เป็นรูปของตัวเอง)
    for (const res of [await put(person, person.id, image), await del(person, person.id)]) {
      expect(res.status).toBe(403)
      expect((await data(res)).error).toBe('staff_only')
    }
    const noOrigin = await put(staff, person.id, image, 'image/png', { raw: true })
    expect((await data(noOrigin)).error).toBe('bad_origin')
    expect((await data(await put({ ...staff, csrf: admin.csrf }, person.id, image))).error).toBe('bad_csrf')
    expect(await photoRow(person.id)).toBeNull()

    const res = await put(staff, person.id, image)
    expect(res.status).toBe(200)
    const { photoVersion } = await data(res)
    expect(photoVersion).toMatch(/^[0-9a-f]{16}$/)
    expect(await photoRow(person.id)).toEqual({ content_type: 'image/png', size: image.length, width: 256, height: 256, version: photoVersion, updated_by: staff.id })
    expect((await put(admin, person.id, jpeg(100, 100), 'image/jpeg')).status).toBe(200)
    expect((await put(staff, 'no-such-member', image)).status).toBe(404)
    // เส้นทางนี้ไม่มี POST/PATCH
    for (const method of ['POST', 'PATCH']) expect((await call(url(person.id), { method, as: staff, body: {} })).status).toBe(404)
  })

  it('อ่านรูปได้เฉพาะ session ที่มีสิทธิ์: ทีมงานอ่านได้ทุกคน สมาชิกอ่านได้เฉพาะของตัวเอง และ session ที่ใช้ไม่ได้แล้วอ่านไม่ได้', async () => {
    const owner = await seedMemberActor({ studentId: '6500001' })
    const other = await seedMemberActor({ studentId: '6500002', name: 'สมชาย ทดสอบ' })
    const image = png(200, 200, 300, 0x33)
    await put(staff, owner.id, image)
    await put(staff, other.id, jpeg(64, 64), 'image/jpeg')

    const anonymous = await get(null, owner.id)
    expect(anonymous.status).toBe(401)
    expect(anonymous.headers.get('Content-Type')).toContain('application/json')
    expect(anonymous.headers.get('Cache-Control')).toBe('no-store')

    for (const actor of [staff, admin, owner]) {
      const res = await get(actor, owner.id)
      expect(res.status).toBe(200)
      expect(res.headers.get('Content-Type')).toBe('image/png')
      expect(await bytesOf(res)).toEqual(image)
    }
    // สมาชิกขอรูปของคนอื่น: ตอบเหมือนไม่มีรูป ทั้งที่คนนั้นมีรูป และไม่ได้เนื้อรูป
    const denied = await get(owner, other.id)
    expect(denied.status).toBe(404)
    expect(await data(denied)).toMatchObject({ error: 'no_photo' })
    expect((await get(owner, 'no-such-member')).status).toBe(404)
    // สมาชิกที่ยังต้องเปลี่ยนรหัสผ่านชั่วคราว อ่านไม่ได้แม้เป็นรูปของตัวเอง
    const temp = await seedMemberActor({ studentId: '6500003', mustChange: true })
    await put(staff, temp.id, image)
    const mustChange = await get(temp, temp.id)
    expect(mustChange.status).toBe(403)
    expect((await data(mustChange)).error).toBe('password_change_required')
    // session หมดอายุ บัญชีถูกปิด และบัญชีถูกลบ: อ่านไม่ได้ทั้งหมด
    expect((await get(await seedMemberSession(owner.id, -1000), owner.id)).status).toBe(401)
    await call(`/api/members/${other.id}/account/disable`, { method: 'POST', as: admin, body: {} })
    expect((await get(other, other.id)).status).toBe(401)
    const revision = (await data(await call(`/api/members/${owner.id}/account`, { as: admin }))).account.revision
    expect((await call(`/api/members/${owner.id}/account/delete`, { method: 'POST', as: admin, body: { expectedRevision: revision } })).status).toBe(200)
    expect((await get(owner, owner.id)).status).toBe(401)
    // ทีมงานยังอ่านรูปของทั้งสองคนได้ (รูปเป็นข้อมูลของทะเบียน ไม่หายไปกับบัญชี)
    expect((await get(staff, owner.id)).status).toBe(200)
    expect((await get(staff, other.id)).status).toBe(200)
  })

  it('ส่วนหัวของคำตอบ: ชนิดตามเนื้อไฟล์จริง ห้ามเดาชนิด เก็บสำเนาได้เฉพาะของผู้ใช้และต้องถาม server ก่อนใช้ทุกครั้ง', async () => {
    const person = await seedMember({ studentId: '6500001' })
    // แจ้งชนิดเป็น PNG แต่เนื้อไฟล์เป็น JPEG: เก็บและส่งตามเนื้อไฟล์จริง
    const { photoVersion } = await data(await put(staff, person.id, jpeg(128, 96), 'image/png'))
    const res = await get(staff, person.id)
    expect(res.headers.get('Content-Type')).toBe('image/jpeg')
    expect(res.headers.get('Cache-Control')).toBe('private, no-cache')
    expect(res.headers.get('Vary')).toBe('Cookie')
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff')
    expect(res.headers.get('Content-Security-Policy')).toBe("default-src 'none'; sandbox")
    expect(res.headers.get('ETag')).toBe(`"${photoVersion}"`)
    expect(res.headers.get('Set-Cookie')).toBeNull()

    // รูปยังไม่เปลี่ยน: ตอบ 304 โดยไม่ส่งเนื้อรูป แต่ยังตรวจ session ก่อนเสมอ
    const unchanged = await get(staff, person.id, { 'If-None-Match': `"${photoVersion}"` })
    expect(unchanged.status).toBe(304)
    expect((await unchanged.arrayBuffer()).byteLength).toBe(0)
    expect(unchanged.headers.get('Cache-Control')).toBe('private, no-cache')
    expect((await get(null, person.id, { 'If-None-Match': `"${photoVersion}"` })).status).toBe(401)
    expect((await get(staff, person.id, { 'If-None-Match': '"other-version"' })).status).toBe(200)
  })
})

describe('ขีดจำกัดและไฟล์ปลอม', () => {
  it('หยุดอ่าน stream ที่ไม่มี Content-Length ทันทีเมื่อเกินเพดาน และไม่เปลี่ยนรูปเดิม', async () => {
    const person = await seedMember({ studentId: '6500001' })
    await put(staff, person.id, png(64, 64))
    const before = await photoRow(person.id)
    let reads = 0
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        reads++
        controller.enqueue(reads === 1 ? png(512, 512, MAX_PHOTO_BYTES) : new Uint8Array(32))
      },
      cancel() { cancelled = true },
    }, { highWaterMark: 0 })
    const response = await call(url(person.id), { method: 'PUT', as: staff, body: stream, headers: { 'Content-Type': 'image/png' } })
    expect(response.status).toBe(413)
    expect(cancelled).toBe(true)
    expect(reads).toBe(2)
    expect(await photoRow(person.id)).toEqual(before)
  })

  it('รับเฉพาะรูปไม่เกิน 256 KiB และไม่เกิน 512×512: เกินแล้วไม่บันทึก', async () => {
    const person = await seedMember({ studentId: '6500001' })
    expect((await put(staff, person.id, png(512, 512, MAX_PHOTO_BYTES))).status).toBe(200)
    const before = await photoRow(person.id)

    const tooBig = await put(staff, person.id, png(512, 512, MAX_PHOTO_BYTES + 1))
    expect(tooBig.status).toBe(413)
    expect((await data(tooBig)).error).toBe('photo_too_large')
    for (const image of [png(513, 512), png(512, 513), jpeg(1024, 768), webpExtended(4000, 3000)]) {
      const res = await put(staff, person.id, image)
      expect(res.status).toBe(422)
      expect((await data(res)).error).toBe('photo_dimensions')
    }
    // ไฟล์ที่ล้มเหลวไม่แตะรูปเดิม
    expect(await photoRow(person.id)).toEqual(before)
  })

  it('ไฟล์ที่ไม่ใช่รูปจริงถูกปฏิเสธ ไม่ว่าเบราว์เซอร์จะแจ้งชนิดอะไร และรูปเดิมยังอยู่', async () => {
    const person = await seedMember({ studentId: '6500001' })
    const original = png(64, 64, 128, 0x44)
    const { photoVersion } = await data(await put(staff, person.id, original))
    const text = (value: string) => new TextEncoder().encode(value)
    const fakes: [string, Uint8Array, string][] = [
      ['SVG แจ้งเป็น PNG', text('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), 'image/png'],
      ['HTML แจ้งเป็น JPEG', text('<html><script>alert(1)</script></html>'), 'image/jpeg'],
      ['ข้อความแจ้งเป็น WebP', text('RIFFxxxxWEBPnot-a-real-image-at-all-123456'), 'image/webp'],
      ['GIF แจ้งเป็น PNG', pad([...ascii('GIF89a'), 10, 0, 10, 0], 64), 'image/png'],
      ['ไฟล์ว่าง', new Uint8Array(), 'image/png'],
      ['WebP ภาพเคลื่อนไหว', webpExtended(64, 64, 0x02), 'image/webp'],
      ['รูปจริงแต่แจ้งชนิดเป็น SVG', png(64, 64), 'image/svg+xml'],
      ['รูปจริงแต่แจ้งชนิดเป็น HTML', png(64, 64), 'text/html'],
      ['รูปจริงแต่แจ้งชนิดเป็น JSON', png(64, 64), 'application/json'],
    ]
    for (const [name, bytes, type] of fakes) {
      const res = await put(staff, person.id, bytes, type)
      expect(res.status, name).toBe(415)
      expect((await data(res)).error, name).toBe('unsupported_image')
    }
    const row = await photoRow(person.id)
    expect(row?.version).toBe(photoVersion)
    expect(await bytesOf(await get(staff, person.id))).toEqual(original)
    // ไม่มีเส้นทางให้ server ไปดึงรูปจาก URL ที่ผู้ใช้ส่งมา
    const byUrl = await call(url(person.id), { method: 'PUT', as: staff, body: { url: 'https://example.com/a.png' } })
    expect(byUrl.status).toBe(415)
    expect((await photoRow(person.id))?.version).toBe(photoVersion)
  })
})

describe('เปลี่ยนรูป ลบรูป และข้อมูลในรายชื่อ', () => {
  it('เปลี่ยนรูปแล้วรุ่นเปลี่ยน สำเนาเก่าใช้ต่อไม่ได้ และรายชื่อสมาชิกมีเฉพาะรุ่นของรูป ไม่มีเนื้อรูป', async () => {
    const person = await seedMember({ studentId: '6500001' })
    await seedAccount(person.id, { loginId: '6500001' })
    const session = await seedMemberSession(person.id)
    expect((await memberOf(person.id)).photoVersion).toBeNull()

    const first = png(100, 100, 2000, 0x21)
    const second = jpeg(300, 200, 3000)
    const a = (await data(await put(staff, person.id, first))).photoVersion
    expect((await memberOf(person.id)).photoVersion).toBe(a)
    const b = (await data(await put(admin, person.id, second, 'image/jpeg'))).photoVersion
    expect(b).not.toBe(a)
    expect(await photoRow(person.id)).toMatchObject({ content_type: 'image/jpeg', size: 3000, width: 300, height: 200, version: b, updated_by: admin.id })
    expect(await env.DB.prepare('SELECT COUNT(*) AS n FROM member_photos WHERE member_id = ?').bind(person.id).first()).toEqual({ n: 1 })

    // เบราว์เซอร์ที่ถือสำเนารุ่นเก่า: ได้รูปใหม่ ไม่ได้ 304
    const fresh = await get(staff, person.id, { 'If-None-Match': `"${a}"` })
    expect(fresh.status).toBe(200)
    expect(fresh.headers.get('ETag')).toBe(`"${b}"`)
    expect(await bytesOf(fresh)).toEqual(second)

    // รายชื่อสมาชิก รายชื่อนักกีฬา และข้อมูลตนเองของสมาชิก: มีรุ่นของรูปเท่านั้น
    const listText = await (await call('/api/members', { as: staff })).text()
    expect(JSON.parse(listText).members[0].photoVersion).toBe(b)
    expect(listText).not.toMatch(/"bytes"|base64|data:image/)
    expect(listText.length).toBeLessThan(2000)
    await call('/api/athletes', { method: 'POST', as: staff, body: { memberId: person.id, game: 'Valorant', team: '', position: '', ign: '', status: 'active', note: '' } })
    const rosterText = await (await call('/api/athletes', { as: staff })).text()
    expect(JSON.parse(rosterText).athletes[0].photoVersion).toBe(b)
    expect(rosterText).not.toMatch(/"bytes"|base64|data:image/)
    const me = await data(await call('/api/member/me', { as: session }))
    expect(me.member.photoVersion).toBe(b)
    expect(JSON.stringify(me)).not.toMatch(/"bytes"|base64|data:image/)

    const actions = (await env.DB.prepare(`SELECT action, target, detail FROM audit_log WHERE action LIKE 'member_photo.%' ORDER BY id`).all()).results
    expect(actions).toEqual([{ action: 'member_photo.updated', target: person.id, detail: '' }, { action: 'member_photo.updated', target: person.id, detail: '' }])
  })

  it('ลบรูป: กลับเป็นไม่มีรูป เรียกซ้ำได้ และตั้งรูปเดิมใหม่ได้รุ่นเดิมตามเนื้อไฟล์', async () => {
    const person = await seedMember({ studentId: '6500001' })
    const image = webpLossless(128, 128)
    const version = (await data(await put(staff, person.id, image, 'image/webp'))).photoVersion

    const res = await del(staff, person.id)
    expect(res.status).toBe(200)
    expect(await data(res)).toEqual({ photoVersion: null })
    expect(await photoRow(person.id)).toBeNull()
    expect((await get(staff, person.id)).status).toBe(404)
    // สำเนาที่เบราว์เซอร์เก็บไว้ใช้ต่อไม่ได้: server ตอบว่าไม่มีรูปแล้ว
    expect((await get(staff, person.id, { 'If-None-Match': `"${version}"` })).status).toBe(404)
    expect((await memberOf(person.id)).photoVersion).toBeNull()
    expect(await data(await del(staff, person.id))).toEqual({ photoVersion: null })
    expect((await del(staff, 'no-such-member')).status).toBe(404)
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_photo.removed'`).first<{ n: number }>())?.n).toBe(1)

    expect((await data(await put(staff, person.id, image, 'image/webp'))).photoVersion).toBe(version)
    expect((await get(staff, person.id)).headers.get('Content-Type')).toBe('image/webp')
  })

  it('รูปไม่หายเมื่อรีเซ็ตรหัสผ่าน ปิดบัญชี ลบบัญชีเข้าสู่ระบบ แก้ข้อมูลสมาชิก หรือพักสมาชิก', async () => {
    const person = await seedMember({ studentId: '6500001' })
    await seedAccount(person.id, { loginId: '6500001' })
    const image = png(90, 90, 500, 0x55)
    const version = (await data(await put(staff, person.id, image))).photoVersion

    expect((await call(`/api/members/${person.id}/account/password`, { method: 'POST', as: admin, body: { studentId: '6500001', password: 'Temp-Pass-7391' } })).status).toBe(200)
    expect((await call(`/api/members/${person.id}/account/disable`, { method: 'POST', as: admin, body: {} })).status).toBe(200)
    const revision = (await data(await call(`/api/members/${person.id}/account`, { as: admin }))).account.revision
    expect((await call(`/api/members/${person.id}/account/delete`, { method: 'POST', as: admin, body: { expectedRevision: revision } })).status).toBe(200)
    const current = await memberOf(person.id)
    const edited = await call(`/api/members/${person.id}`, {
      method: 'PATCH', as: staff,
      body: { name: 'ชื่อใหม่ ทดสอบ', nickname: current.nickname, studentId: current.studentId, role: current.role, status: 'suspended', contact: 'line: test', note: '', expectedVersion: current.version },
    })
    expect(edited.status).toBe(200)
    expect((await data(edited)).member).toMatchObject({ name: 'ชื่อใหม่ ทดสอบ', status: 'suspended', photoVersion: version })
    expect(await bytesOf(await get(staff, person.id))).toEqual(image)
  })
})
