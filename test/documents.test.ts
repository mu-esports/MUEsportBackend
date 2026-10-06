import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { MAX_CONTENT_UNITS, normalizeText, parseDocument, planEdit } from '../worker/docs'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, resetDb, seedUser, toDocsJson } from './helpers'
import type { Actor } from './helpers'
import { encryptSecret } from '../worker/crypto'

const THAI = 'สวัสดีครับ ทีมงาน\nบรรทัดที่สอง มีสระ ำ ิ ี ึ ื และวรรณยุกต์ ่ ้ ๊ ๋\n\nย่อหน้าหลังบรรทัดว่าง'
const EMOJI = 'เริ่ม 🎮 กลาง 👨‍👩‍👧‍👦 ธง 🇹🇭 จบ 🏆'

/** ใช้คำสั่งที่วางแผนไว้กับข้อความจำลอง ตามกติกาดัชนีของ Google Docs (เนื้อหาเริ่มที่ 1 และมี newline ปิดท้าย) */
function applyPlan(oldText: string, newText: string): string {
  let full = `${oldText}\n`
  for (const request of planEdit(oldText, newText, 't.0').requests as Record<string, any>[]) {
    if (request.deleteContentRange) {
      const { startIndex, endIndex } = request.deleteContentRange.range
      expect(startIndex).toBeGreaterThanOrEqual(1)
      // ห้ามลบ newline สุดท้ายของเอกสาร
      expect(endIndex).toBeLessThanOrEqual(full.length)
      full = full.slice(0, startIndex - 1) + full.slice(endIndex - 1)
    } else {
      const { index } = request.insertText.location
      expect(index).toBeGreaterThanOrEqual(1)
      expect(index).toBeLessThanOrEqual(full.length)
      full = full.slice(0, index - 1) + request.insertText.text + full.slice(index - 1)
    }
  }
  expect(full.endsWith('\n')).toBe(true)
  return full.slice(0, -1)
}

const wellFormed = (text: string) => !/[\ud800-\udbff](?![\udc00-\udfff])|(?<![\ud800-\udbff])[\udc00-\udfff]/.test(text)

describe('ตัวแปลง Google Docs (ฟังก์ชันล้วน)', () => {
  it('อ่านเอกสารข้อความพื้นฐาน: ไทย ขึ้นบรรทัดใหม่ emoji และดัชนี UTF-16 ตรงกับ Google', () => {
    for (const text of [THAI, EMOJI, `${THAI}\n${EMOJI}`, 'a', '\n\n', 'บรรทัดเดียว']) {
      const parsed = parseDocument(toDocsJson({ id: 'x', title: 'ชื่อ', text: `${text}\n`, revision: 3 }))
      expect(parsed).toMatchObject({ supported: true, reasons: [], text, revisionId: 'rev-3', tabId: 't.0', title: 'ชื่อ' })
    }
  })

  it('เอกสารว่าง', () => {
    const parsed = parseDocument(toDocsJson({ id: 'x', title: 'ว่าง', text: '\n', revision: 1 }))
    expect(parsed).toMatchObject({ supported: true, text: '' })
  })

  it('โครงสร้างที่ editor รักษาไม่ได้: อ่านได้แต่แก้ไม่ได้ พร้อมเหตุผล', () => {
    const cases: [NonNullable<Parameters<typeof toDocsJson>[0]['rich']>, string][] = [
      ['table', 'ตาราง'], ['image', 'รูปภาพ'], ['tabs', 'หลายแท็บ'], ['header', 'หัวกระดาษ'],
      ['heading', 'หัวข้อ'], ['bold', 'จัดรูปแบบตัวอักษร'], ['suggestion', 'คำแนะนำการแก้ไข'], ['list', 'รายการ'],
    ]
    for (const [rich, reason] of cases) {
      const parsed = parseDocument(toDocsJson({ id: 'x', title: 't', text: 'เนื้อหา\n', revision: 1, rich }))
      expect(parsed.supported, rich).toBe(false)
      expect(parsed.reasons.join(' '), rich).toContain(reason)
      expect(parsed.text).toContain('เนื้อหา')
    }
  })

  it('คำตอบที่ไม่มีเนื้อหาตามแท็บ หรือดัชนีไม่ตรง ถือว่าแก้ไม่ได้ (ไม่เดาโครงสร้าง)', () => {
    expect(parseDocument({ title: 'x', revisionId: 'r', body: { content: [] } }).supported).toBe(false)
    expect(parseDocument(null).supported).toBe(false)
    const shifted = toDocsJson({ id: 'x', title: 't', text: 'abc\n', revision: 1 })
    shifted.tabs[0].documentTab.body.content[1].startIndex = 5
    expect(parseDocument(shifted).supported).toBe(false)
    const softBreak = toDocsJson({ id: 'x', title: 't', text: 'a\u000bb\n', revision: 1 })
    expect(parseDocument(softBreak).supported).toBe(false)
  })

  it('แผนการแก้: ให้ข้อความปลายทางถูกต้อง ไม่แตะ newline สุดท้าย และไม่ตัดกลาง emoji', () => {
    const pairs: [string, string][] = [
      ['', THAI], [THAI, ''], [THAI, THAI], ['', ''],
      [THAI, THAI.replace('บรรทัดที่สอง', 'บรรทัดที่ 2')],
      [THAI, `${THAI}\nเพิ่มท้าย`], [THAI, `เพิ่มหัว\n${THAI}`],
      [EMOJI, EMOJI.replace('🎮', '🎯')], ['🎮', '🎯'], ['a🎮b', 'a🎯b'], ['🎮🎮', '🎮'], ['🎯🎮', '🎮'],
      ['👨‍👩‍👧‍👦', '👨‍👩‍👧'], ['🇹🇭', '🇯🇵'],
      ['บรรทัด\n\n\nท้าย', 'บรรทัด\nท้าย'], ['a\n', 'a'], ['a', 'a\n'], ['\n', ''], ['กา', 'ก้า'],
      [`${'x'.repeat(100)}😀`, `${'x'.repeat(100)}😁`],
    ]
    for (const [before, after] of pairs) {
      expect(applyPlan(before, after), JSON.stringify([before, after])).toBe(after)
      for (const request of planEdit(before, after, 't.0').requests as Record<string, any>[]) {
        if (request.insertText) expect(wellFormed(request.insertText.text)).toBe(true)
      }
    }
  })

  it('แผนการแก้ทำเฉพาะช่วงที่ต่าง และข้อความเดิมไม่สร้างคำสั่ง', () => {
    expect(planEdit(THAI, THAI, 't.0').requests).toEqual([])
    const plan = planEdit('หนึ่ง สอง สาม', 'หนึ่ง 2 สาม', 't.0')
    expect(plan).toMatchObject({ prefix: 6, deleted: 3, inserted: '2' })
    expect(plan.requests).toEqual([
      { deleteContentRange: { range: { startIndex: 7, endIndex: 10, tabId: 't.0' } } },
      { insertText: { location: { index: 7, tabId: 't.0' }, text: '2' } },
    ])
  })

  it('ทำข้อความให้อยู่ในรูปที่ Google Docs เก็บได้ตรงตัว', () => {
    expect(normalizeText('a\r\nb\rc\n')).toBe('a\nb\nc\n')
    expect(normalizeText('a\u0000b\u000bc\u001fde\tf')).toBe('abcde\tf')
    expect(normalizeText(EMOJI)).toBe(EMOJI)
  })
})

describe('เอกสารผ่าน API (Google จำลอง)', () => {
  let google: FakeGoogle
  let admin: Actor
  let staff: Actor

  beforeEach(async () => {
    await resetDb()
    google = await FakeGoogle.start()
    admin = await seedUser(CLUB_EMAIL, 'admin')
    staff = await seedUser('staff@example.com', 'staff')
    // เชื่อม Google ไว้แล้ว: ใส่ connection ที่เข้ารหัสด้วยกุญแจทดสอบ
    google.refreshTokens.set('refresh-secret-1', 'valid')
    await env.DB.prepare(
      `INSERT INTO google_connections (id, google_sub, email, scopes, refresh_token_enc, status, updated_at)
       VALUES ('club', 'club-sub', ?, 'openid email https://www.googleapis.com/auth/drive.file', ?, 'connected', 'x')`,
    )
      .bind(CLUB_EMAIL, await encryptSecret(env.TOKEN_ENCRYPTION_KEY, 'refresh-secret-1'))
      .run()
  })
  afterEach(() => vi.restoreAllMocks())
  afterEach(() => vi.unstubAllGlobals())

  const create = (body: unknown, idem = key(), as: Actor = staff) =>
    call('/api/documents', { method: 'POST', as, headers: { 'Idempotency-Key': idem }, body })
  const save = (id: string, body: unknown, as: Actor = staff) => call(`/api/documents/${id}`, { method: 'PUT', as, body })
  const isDrive = (method: string) => (url: URL, m: string) => url.pathname.startsWith('/drive/v3/files') && m === method
  const isBatchUpdate = (url: URL) => url.pathname.endsWith(':batchUpdate')

  it('สร้างเอกสาร: เนื้อหาอยู่ใน Google Docs จริง และยืนยันหลังอ่านกลับ', async () => {
    const text = `${THAI}\n${EMOJI}`
    const res = await create({ title: 'บันทึกการประชุม', text })
    expect(res.status).toBe(201)
    const body = await data(res)
    expect(body.document).toMatchObject({ title: 'บันทึกการประชุม', status: 'ok', updatedByName: 'staff' })
    expect(body.content).toMatchObject({ text, editable: true })

    expect(google.docs.size).toBe(1)
    const stored = [...google.docs.values()][0]
    expect(stored.text).toBe(`${text}\n`)
    expect(body.document.googleUrl).toBe(`https://docs.google.com/document/d/${stored.id}/edit`)
    // D1 ไม่เก็บเนื้อหาเอกสาร
    const dump = JSON.stringify([
      (await env.DB.prepare('SELECT * FROM documents').all()).results,
      (await env.DB.prepare('SELECT * FROM document_operations').all()).results,
    ])
    expect(dump).not.toContain('สวัสดีครับ')
    // อ่านกลับหลังเขียน
    const calls = google.calls.map((c) => `${c.method} ${new URL(c.url).pathname}`)
    expect(calls.lastIndexOf(`GET /v1/documents/${stored.id}`)).toBeGreaterThan(calls.findIndex((c) => c.includes(':batchUpdate')))
  })

  it('สร้างเอกสารว่าง และตรวจข้อมูลก่อนเรียก Google', async () => {
    const empty = await create({ title: 'ว่าง', text: '' })
    expect(empty.status).toBe(201)
    expect((await data(empty)).content.text).toBe('')

    const before = google.calls.length
    expect((await create({ title: '  ', text: 'x' })).status).toBe(422)
    expect((await create({ title: 'ยาวไป', text: 'ก'.repeat(MAX_CONTENT_UNITS + 1) })).status).toBe(422)
    expect((await create({ title: 'ชนิดผิด', text: 5 })).status).toBe(422)
    expect((await create({ title: 'พอดี', text: 'ก'.repeat(MAX_CONTENT_UNITS) })).status).toBe(201)
    expect(google.docs.size).toBe(2)
    expect(google.calls.slice(before).filter((c) => c.method === 'POST' && c.url.includes('/drive/')).length).toBe(1)
  })

  it('retry ด้วย key เดิมหลังสำเร็จ: ไม่สร้างไฟล์ซ้ำ', async () => {
    const idem = key()
    const first = await data(await create({ title: 'เอกสาร', text: 'เนื้อหา' }, idem))
    const second = await create({ title: 'เอกสาร', text: 'เนื้อหา' }, idem)
    expect(second.status).toBe(200)
    expect((await data(second)).document.id).toBe(first.document.id)
    expect(google.docs.size).toBe(1)
    expect((await create({ title: 'เอกสาร', text: 'เนื้อหาอื่น' }, idem)).status).toBe(422)
  })

  it('Google สร้างไฟล์สำเร็จแต่เขียนเนื้อหาล้มเหลว: บอกสถานะจริง และ retry ทำต่อโดยไม่สร้างไฟล์ซ้ำ', async () => {
    const idem = key()
    google.failOnce(isBatchUpdate, 503)
    const failed = await create({ title: 'ค้าง', text: THAI }, idem)
    expect(failed.status).toBe(502)
    const failure = await data(failed)
    expect(failure.fileCreated).toBe(true)
    expect(failure.message).toContain('สร้างไฟล์ใน Google Docs แล้ว')
    expect(failure.message).toContain('ไม่สร้างไฟล์ซ้ำ')
    // ยังไม่ลงทะเบียนเป็นเอกสาร แต่มีงานค้างให้ตรวจได้
    expect((await data(await call('/api/documents', { as: staff }))).documents).toEqual([])
    const pending = await data(await call('/api/documents/operations', { as: staff }))
    expect(pending.operations).toHaveLength(1)
    expect(pending.operations[0]).toMatchObject({ id: failure.operationId, title: 'ค้าง', status: 'file_created', fileCreated: true })
    expect(JSON.stringify(pending)).not.toContain('สวัสดีครับ')

    const retried = await create({ title: 'ค้าง', text: THAI }, idem)
    expect(retried.status).toBe(201)
    expect(google.docs.size).toBe(1)
    expect([...google.docs.values()][0].text).toBe(`${THAI}\n`)
    expect((await data(await call('/api/documents/operations', { as: staff }))).operations).toEqual([])
    // เนื้อหาชั่วคราวถูกล้างเมื่องานเสร็จ
    expect((await env.DB.prepare('SELECT content, status FROM document_operations').first())).toEqual({ content: null, status: 'completed' })
  })

  it('Google สร้างไฟล์สำเร็จแต่ response หาย: retry หาไฟล์เดิมจากป้ายบนไฟล์ ไม่สร้างใหม่', async () => {
    const idem = key()
    // จำลอง: Drive สร้างไฟล์แล้ว แต่คำตอบกลับมาเป็นข้อผิดพลาด
    let dropped = false
    google.interceptors.push((url, init) => {
      if (dropped || !isDrive('POST')(url, init?.method ?? 'GET')) return undefined
      dropped = true
      const body = JSON.parse(init!.body as string) as { name: string; appProperties: Record<string, string> }
      google.addDoc(body.name, '').appProperties = body.appProperties
      return new Response('{}', { status: 504 })
    })
    const failed = await create({ title: 'หาย', text: 'เนื้อหา' }, idem)
    expect(failed.status).toBe(502)
    expect((await data(failed)).fileState).toBe('unknown')
    expect(google.docs.size).toBe(1)

    const retried = await create({ title: 'หาย', text: 'เนื้อหา' }, idem)
    expect(retried.status).toBe(201)
    expect(google.docs.size).toBe(1)
    expect([...google.docs.values()][0].text).toBe('เนื้อหา\n')
  })

  it('เขียนเนื้อหาสำเร็จแต่บันทึก D1 ไม่ทัน: retry ไม่เขียนซ้ำและไม่สร้างซ้ำ', async () => {
    const idem = key()
    google.failOnce(isBatchUpdate, 503)
    const failed = await data(await create({ title: 'ครึ่งทาง', text: 'เนื้อหา' }, idem))
    // จำลองว่ารอบก่อนเขียนเนื้อหาลง Google ไปแล้วก่อนระบบล้ม
    google.editExternally([...google.docs.keys()][0], 'เนื้อหา')
    const writesBefore = google.calls.filter((c) => c.url.includes(':batchUpdate')).length
    const resumed = await call(`/api/documents/operations/${failed.operationId}/resume`, { method: 'POST', as: staff })
    expect(resumed.status).toBe(201)
    expect(google.calls.filter((c) => c.url.includes(':batchUpdate')).length).toBe(writesBefore)
    expect(google.docs.size).toBe(1)
    expect((await data(await call('/api/documents', { as: staff }))).documents).toHaveLength(1)
  })

  it('ไฟล์ที่สร้างไว้มีเนื้อหาอื่น: ไม่เขียนทับ และให้ตรวจเอง', async () => {
    const idem = key()
    google.failOnce(isBatchUpdate, 503)
    const failed = await data(await create({ title: 'ถูกแก้', text: 'ของฉัน' }, idem))
    google.editExternally([...google.docs.keys()][0], 'มีคนพิมพ์ไว้แล้ว')
    const retried = await create({ title: 'ถูกแก้', text: 'ของฉัน' }, idem)
    expect(retried.status).toBe(409)
    expect((await data(retried)).error).toBe('operation_needs_review')
    expect([...google.docs.values()][0].text).toBe('มีคนพิมพ์ไว้แล้ว\n')
    const resume = await call(`/api/documents/operations/${failed.operationId}/resume`, { method: 'POST', as: staff })
    expect(resume.status).toBe(409)
  })

  it('งานค้างของคนอื่น: staff ไม่เห็นและทำต่อไม่ได้ admin ทำได้ และยกเลิกไม่ลบไฟล์ใน Google', async () => {
    google.failOnce(isBatchUpdate, 503)
    const failed = await data(await create({ title: 'ของ staff', text: 'x' }))
    const other = await seedUser('other@example.com', 'staff')
    expect((await data(await call('/api/documents/operations', { as: other }))).operations).toEqual([])
    expect((await call(`/api/documents/operations/${failed.operationId}/resume`, { method: 'POST', as: other })).status).toBe(404)
    expect((await data(await call('/api/documents/operations', { as: admin }))).operations).toHaveLength(1)

    const dismissed = await data(await call(`/api/documents/operations/${failed.operationId}`, { method: 'DELETE', as: staff }))
    expect(dismissed).toEqual({ ok: true, fileState: 'created', fileRemainsInGoogle: true })
    expect(google.docs.size).toBe(1)
    expect(google.calls.some((c) => c.method === 'DELETE')).toBe(false)
  })

  it('เปิดเอกสาร: โหลดเนื้อหาและ revision ล่าสุดจาก Google ทุกครั้ง', async () => {
    const { document } = await data(await create({ title: 'เอกสาร', text: 'เดิม' }))
    const googleId = [...google.docs.keys()][0]
    google.editExternally(googleId, 'แก้จาก Google Docs')
    google.docs.get(googleId)!.title = 'เปลี่ยนชื่อใน Google'
    const body = await data(await call(`/api/documents/${document.id}`, { as: admin }))
    expect(body.content).toMatchObject({ text: 'แก้จาก Google Docs', revisionId: 'rev-3', editable: true })
    expect(body.document.title).toBe('เปลี่ยนชื่อใน Google')
    expect((await call('/api/documents/no-such', { as: staff })).status).toBe(404)
  })

  it('บันทึกการแก้: แก้เฉพาะช่วงที่ต่าง ใช้ requiredRevisionId และยืนยันหลังอ่านกลับ', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: THAI }))
    const edited = `${THAI.replace('ทีมงาน', 'ทุกคน 🎮')}\nเพิ่มบรรทัด`
    let sent: Record<string, any> | null = null
    google.interceptors.push((url, init) => {
      if (isBatchUpdate(url)) sent = JSON.parse(init!.body as string) as Record<string, any>
      return undefined
    })
    const res = await save(created.document.id, { title: 'เอกสาร', text: edited, baseRevisionId: created.content.revisionId }, admin)
    expect(res.status).toBe(200)
    const body = await data(res)
    expect(body).toMatchObject({ verified: true })
    expect(body.content.text).toBe(edited)
    expect(body.content.revisionId).not.toBe(created.content.revisionId)
    expect(body.document.updatedByName).toBe('muesport2567')
    expect([...google.docs.values()][0].text).toBe(`${edited}\n`)
    expect(sent!.writeControl).toEqual({ requiredRevisionId: created.content.revisionId })
    expect(JSON.stringify(sent!.requests)).not.toContain('สวัสดีครับ')
    expect(sent!.requests.every((r: Record<string, any>) => (r.deleteContentRange?.range ?? r.insertText.location).tabId === 't.0')).toBe(true)
  })

  it('ลบเนื้อหาทั้งหมด: เหลือเอกสารว่างโดยไม่ลบ newline สุดท้าย', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: EMOJI }))
    const body = await data(await save(created.document.id, { title: 'เอกสาร', text: '', baseRevisionId: created.content.revisionId }))
    expect(body.verified).toBe(true)
    expect([...google.docs.values()][0].text).toBe('\n')
  })

  it('เปลี่ยนชื่อจากเว็บไม่ได้หลังสร้าง: server ปฏิเสธและไม่เรียก Drive', async () => {
    const created = await data(await create({ title: 'ชื่อเดิม', text: 'x' }))
    const res = await save(created.document.id, { title: 'ชื่อใหม่', text: 'x', baseRevisionId: created.content.revisionId })
    expect(res.status).toBe(409)
    expect((await data(res)).error).toBe('title_change_not_supported')
    expect([...google.docs.values()][0].title).toBe('ชื่อเดิม')
    expect(google.calls.some((c) => c.method === 'PATCH')).toBe(false)
  })

  it('revision conflict: เอกสารถูกแก้จากที่อื่นก่อนบันทึก ได้ 409 พร้อมฉบับล่าสุด และไม่เขียนทับ', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: 'ต้นฉบับ' }))
    const googleId = [...google.docs.keys()][0]
    google.editExternally(googleId, 'คนอื่นแก้ใน Google Docs')
    const res = await save(created.document.id, { title: 'เอกสาร', text: 'ฉบับของฉัน', baseRevisionId: created.content.revisionId })
    expect(res.status).toBe(409)
    const body = await data(res)
    expect(body.error).toBe('revision_conflict')
    expect(body.latest).toMatchObject({ text: 'คนอื่นแก้ใน Google Docs', editable: true })
    expect(google.docs.get(googleId)!.text).toBe('คนอื่นแก้ใน Google Docs\n')

    // ตรวจฉบับล่าสุดแล้วบันทึกทับด้วย revision ล่าสุดได้
    const forced = await save(created.document.id, { title: 'เอกสาร', text: 'ฉบับของฉัน', baseRevisionId: body.latest.revisionId })
    expect(forced.status).toBe(200)
    expect(google.docs.get(googleId)!.text).toBe('ฉบับของฉัน\n')
  })

  it('revision เปลี่ยนระหว่างอ่านกับเขียน: Google ปฏิเสธคำสั่งเขียน และระบบรายงานเป็น conflict', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: 'ต้นฉบับ' }))
    const googleId = [...google.docs.keys()][0]
    let raced = false
    google.interceptors.push((url) => {
      // มีคนแก้หลังจากระบบอ่าน revision แล้ว แต่ก่อนคำสั่งเขียนไปถึง
      if (!raced && isBatchUpdate(url)) {
        raced = true
        google.editExternally(googleId, 'แทรกเข้ามาพอดี')
      }
      return undefined
    })
    const res = await save(created.document.id, { title: 'เอกสาร', text: 'ฉบับของฉัน', baseRevisionId: created.content.revisionId })
    expect(res.status).toBe(409)
    expect((await data(res)).latest.text).toBe('แทรกเข้ามาพอดี')
    expect(google.docs.get(googleId)!.text).toBe('แทรกเข้ามาพอดี\n')
  })

  it('สองคนแก้เอกสารเดียวกันในเว็บ: คนที่บันทึกทีหลังได้ conflict', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: 'ต้นฉบับ' }))
    const base = created.content.revisionId
    expect((await save(created.document.id, { title: 'เอกสาร', text: 'ของ staff', baseRevisionId: base }, staff)).status).toBe(200)
    const late = await save(created.document.id, { title: 'เอกสาร', text: 'ของ admin', baseRevisionId: base }, admin)
    expect(late.status).toBe(409)
    expect((await data(late)).latest.text).toBe('ของ staff')
  })

  it('เอกสารที่มีโครงสร้าง rich: เปิดอ่านได้ บอกเหตุผล และการบันทึกถูกปฏิเสธโดยไม่แตะเอกสาร', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: 'ข้อความ' }))
    const googleId = [...google.docs.keys()][0]
    google.docs.get(googleId)!.rich = 'table'
    google.docs.get(googleId)!.revision++

    const opened = await data(await call(`/api/documents/${created.document.id}`, { as: staff }))
    expect(opened.content).toMatchObject({ editable: false, text: 'ข้อความ' })
    expect(opened.content.reasons).toContain('มีตาราง')
    expect(opened.document.status).toBe('read_only')

    const writesBefore = google.calls.filter((c) => c.method !== 'GET' && !c.url.includes('oauth2')).length
    const res = await save(created.document.id, { title: 'เอกสาร', text: 'จะเขียนทับ', baseRevisionId: opened.content.revisionId })
    expect(res.status).toBe(409)
    expect(await data(res)).toMatchObject({ error: 'document_not_editable', reasons: ['มีตาราง'] })
    expect(google.calls.filter((c) => c.method !== 'GET' && !c.url.includes('oauth2')).length).toBe(writesBefore)
    expect(google.docs.get(googleId)!.text).toBe('ข้อความ\n')
    expect((await data(await call('/api/documents', { as: staff }))).documents[0].status).toBe('read_only')
  })

  it('Google ล้มเหลวตอนบันทึก: ตอบข้อผิดพลาด เอกสารไม่เปลี่ยน และบันทึกซ้ำได้', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: 'ต้นฉบับ' }))
    const request = { title: 'เอกสาร', text: 'ฉบับใหม่', baseRevisionId: created.content.revisionId }
    google.failOnce(isBatchUpdate, 500)
    const failed = await save(created.document.id, request)
    expect(failed.status).toBe(502)
    expect([...google.docs.values()][0].text).toBe('ต้นฉบับ\n')
    expect((await save(created.document.id, request)).status).toBe(200)
  })

  it('ไฟล์ถูกลบหรือไม่มีสิทธิ์: บอกว่าเปิดไม่ได้ และบันทึกสถานะ', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: 'x' }))
    google.docs.clear()
    const res = await call(`/api/documents/${created.document.id}`, { as: staff })
    expect(res.status).toBe(404)
    expect((await data(res)).error).toBe('document_unavailable')
    expect((await data(await call('/api/documents', { as: staff }))).documents[0].status).toBe('unavailable')
  })

  it('ยังไม่ได้เชื่อม Google: ไม่มีการสร้างปลอม และรายการเอกสารยังเปิดได้', async () => {
    await env.DB.prepare('DELETE FROM google_connections').run()
    const res = await create({ title: 'เอกสาร', text: 'x' })
    expect(res.status).toBe(409)
    expect((await data(res)).error).toBe('google_not_connected')
    expect(google.docs.size).toBe(0)
    expect((await call('/api/documents', { as: staff })).status).toBe(200)
  })

  it('access token ถูกปฏิเสธระหว่างใช้งาน: ขอใหม่หนึ่งครั้งแล้วทำต่อ', async () => {
    const created = await data(await create({ title: 'เอกสาร', text: 'x' }))
    google.failOnce((url) => url.origin === 'https://docs.googleapis.com', 401)
    expect((await call(`/api/documents/${created.document.id}`, { as: staff })).status).toBe(200)
  })

  it('ไม่มี token เนื้อหาเอกสาร หรือ cookie ใน log แม้เกิดข้อผิดพลาด', async () => {
    const logged: string[] = []
    for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
      vi.spyOn(console, level).mockImplementation((...args: unknown[]) => void logged.push(args.map(String).join(' ')))
    }
    google.failOnce(isBatchUpdate, 500)
    await create({ title: 'ลับ', text: 'เนื้อหาลับของเอกสาร' })
    google.interceptors.push((url) => {
      if (isBatchUpdate(url)) throw new Error('network down with Bearer access-123')
      return undefined
    })
    const ok = await data(await create({ title: 'อีกฉบับ', text: '' }))
    await save(ok.document.id, { title: 'อีกฉบับ', text: 'เนื้อหาลับของเอกสาร', baseRevisionId: ok.content.revisionId })
    const all = logged.join('\n')
    expect(all).not.toContain('เนื้อหาลับของเอกสาร')
    expect(all).not.toMatch(/access-\d|refresh-secret|mu_session|test-client-secret/)
  })

  it('รายการเอกสาร: เรียงล่าสุดก่อน พร้อมผู้แก้ในเว็บ และไม่เรียก Google', async () => {
    const first = await data(await create({ title: 'ฉบับแรก', text: 'a' }, key(), staff))
    await data(await create({ title: 'ฉบับสอง', text: 'b' }, key(), admin))
    await save(first.document.id, { title: 'ฉบับแรก', text: 'เนื้อหาที่แก้แล้วในฉบับแรก', baseRevisionId: first.content.revisionId }, admin)
    const before = google.calls.length
    const list = (await data(await call('/api/documents', { as: staff }))).documents
    expect(google.calls.length).toBe(before)
    expect(list.map((d: { title: string }) => d.title)).toEqual(['ฉบับแรก', 'ฉบับสอง'])
    expect(list[0]).toMatchObject({ createdByName: 'staff', updatedByName: 'muesport2567', status: 'ok' })
    expect(JSON.stringify(list)).not.toContain('เนื้อหาที่แก้แล้ว')
  })
})
