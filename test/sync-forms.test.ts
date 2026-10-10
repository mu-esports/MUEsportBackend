import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, CLUB_EMAIL, data, env, FakeGoogle, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'
import { connectClub, FakeWorkspace, loseResponseOnce, syncNow } from './workspace'
import type { FakeForm } from './workspace'

// ทุกกรณีในไฟล์นี้ใช้ Google Forms จำลอง (test/workspace.ts) ไม่ได้ต่อกับ Google จริง
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

const textQ = (title: string, required = false, paragraph = false) => ({ title, questionItem: { question: { required, textQuestion: { paragraph } } } })
const choiceQ = (title: string, type: string, options: Record<string, unknown>[]) => ({ title, questionItem: { question: { choiceQuestion: { type, options } } } })

function memberForm(): FakeForm {
  return ws.addForm('สมัครสมาชิก MU Esport', [
    textQ('ชื่อ-นามสกุล', true),
    textQ('ชื่อเล่น', true),
    choiceQ('เกมที่เล่น', 'CHECKBOX', [{ value: 'ROV' }, { value: 'Valorant' }, { isOther: true }]),
    textQ('ช่องทางติดต่อ'),
  ])
}
const qid = (form: FakeForm, index: number): string => form.items[index].questionItem.question.questionId

async function linkForm(form: FakeForm): Promise<void> {
  const res = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'forms', resourceId: form.formId } })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
}
const view = async (as: Actor = staff) => data(await call('/api/forms', { as }))

describe('Google Forms → เว็บ', () => {
  it('แสดงคำถามและคำตอบจริง ดึงคำตอบครบทุกหน้า และจับคู่ด้วย questionId/responseId', async () => {
    const form = memberForm()
    ws.pageSize = 2
    for (let i = 1; i <= 5; i++) {
      ws.submit(form.formId, { [qid(form, 0)]: `ผู้สมัคร ${i}`, [qid(form, 1)]: `น${i}`, [qid(form, 2)]: ['ROV', 'Valorant'] }, { at: `2026-10-0${i}T03:00:00Z` })
    }
    await linkForm(form)
    const page = await view()
    expect(page.form).toMatchObject({ title: 'สมัครสมาชิก MU Esport', writable: true, revisionId: 'frev-1' })
    expect(page.items.map((i: any) => [i.title, i.kind, i.required, i.editable])).toEqual([
      ['ชื่อ-นามสกุล', 'short_text', true, true],
      ['ชื่อเล่น', 'short_text', true, true],
      ['เกมที่เล่น', 'checkbox', false, true],
      ['ช่องทางติดต่อ', 'short_text', false, true],
    ])
    expect(page.items[2].options).toEqual([{ value: 'ROV', isOther: false }, { value: 'Valorant', isOther: false }, { value: '', isOther: true }])
    expect(page.responseCount).toBe(5)
    expect(page.responses.map((r: any) => r.answers[qid(form, 0)].values[0])).toEqual(['ผู้สมัคร 5', 'ผู้สมัคร 4', 'ผู้สมัคร 3', 'ผู้สมัคร 2', 'ผู้สมัคร 1'])
    expect(page.responses[0].answers[qid(form, 2)].values).toEqual(['ROV', 'Valorant'])
  })

  it('แก้คำถาม มีคำตอบใหม่ และผู้ตอบแก้คำตอบเดิมที่ Google: เว็บตามหลังซิงค์ โดยไม่เกิดคำตอบซ้ำ', async () => {
    const form = memberForm()
    const first = ws.submit(form.formId, { [qid(form, 0)]: 'อารี', [qid(form, 1)]: 'อา' }, { at: '2026-10-01T03:00:00Z' })
    await linkForm(form)

    ws.editForm(form.formId, (f) => {
      f.items[0].title = 'ชื่อ-นามสกุล (ภาษาไทย)'
      f.items.push(textQ('ชั้นปี'))
    })
    ws.submit(form.formId, { [qid(form, 0)]: 'บุญมี', [qid(form, 1)]: 'บี' }, { at: '2026-10-02T03:00:00Z' })
    ws.submit(form.formId, { [qid(form, 0)]: 'อารี ใจดี', [qid(form, 1)]: 'อา' }, { responseId: first, at: '2026-10-03T03:00:00Z' })
    const result = await syncNow('forms', staff)
    expect(result.status.error).toBeNull()

    const page = await view()
    expect(page.form.revisionId).toBe('frev-2')
    expect(page.items.map((i: any) => i.title)).toEqual(['ชื่อ-นามสกุล (ภาษาไทย)', 'ชื่อเล่น', 'เกมที่เล่น', 'ช่องทางติดต่อ', 'ชั้นปี'])
    expect(page.responseCount).toBe(2)
    expect(page.responses.map((r: any) => [r.responseId === first, r.answers[qid(form, 0)].values[0]])).toEqual([[true, 'อารี ใจดี'], [false, 'บุญมี']])
    // รอบถัดไปขอเฉพาะคำตอบหลังเวลาล่าสุดที่เห็น
    google.calls.length = 0
    await syncNow('forms', staff)
    const list = google.calls.find((c) => c.url.includes('/responses'))!
    expect(new URL(list.url).searchParams.get('filter')).toBe('timestamp >= 2026-10-03T03:00:00Z')
  })

  it('คำถามถูกลบหรือแทนที่ที่ Google: คำตอบเก่าไม่หายและไม่กลายเป็นคำตอบของคำถามใหม่ที่ใช้ชื่อเดิม', async () => {
    const form = memberForm()
    const oldQuestion = qid(form, 3)
    ws.submit(form.formId, { [qid(form, 0)]: 'อารี', [oldQuestion]: 'discord: aree' }, { at: '2026-10-01T03:00:00Z' })
    await linkForm(form)
    // ลบคำถามเดิม แล้วสร้างคำถามใหม่ชื่อเดียวกัน (question ID ใหม่)
    ws.editForm(form.formId, (f) => {
      f.items.splice(3, 1)
      f.items.push(textQ('ช่องทางติดต่อ'))
    })
    await syncNow('forms', staff)
    const page = await view()
    const current = page.items.filter((i: any) => i.title === 'ช่องทางติดต่อ')
    expect(current).toHaveLength(2)
    const removed = current.find((i: any) => i.removedAt !== null)
    const added = current.find((i: any) => i.removedAt === null)
    expect(removed.questions[0].id).toBe(oldQuestion)
    expect(removed.editable).toBe(false)
    expect(added.questions[0].id).not.toBe(oldQuestion)
    const answers = page.responses[0].answers
    expect(answers[oldQuestion].values).toEqual(['discord: aree'])
    expect(answers[added.questions[0].id]).toBeUndefined()
  })

  it('คำตอบที่ถูกลบที่ Google: ตรวจพบในรอบตรวจทั้งชุด เก็บสำเนาไว้เป็นหลักฐานพร้อมเครื่องหมาย ไม่ลบทิ้ง', async () => {
    const form = memberForm()
    const keep = ws.submit(form.formId, { [qid(form, 0)]: 'อยู่ต่อ' }, { at: '2026-10-01T03:00:00Z' })
    const gone = ws.submit(form.formId, { [qid(form, 0)]: 'ถูกลบ' }, { at: '2026-10-02T03:00:00Z' })
    await linkForm(form)
    form.responses = form.responses.filter((r) => r.responseId !== gone)
    // รอบปกติ (ดึงเฉพาะที่เปลี่ยน) ยังไม่รู้ว่าถูกลบ
    await syncNow('forms', staff)
    expect((await view()).responses.map((r: any) => r.sourceState)).toEqual(['ok', 'ok'])
    // ถึงรอบตรวจทั้งชุด
    await env.DB.prepare(`UPDATE sync_state SET cursor = json_remove(cursor, '$.fullAt') WHERE kind = 'forms'`).run()
    await syncNow('forms', staff)
    const responses = (await view()).responses
    expect(responses.find((r: any) => r.responseId === gone)).toMatchObject({ sourceState: 'missing' })
    expect(responses.find((r: any) => r.responseId === keep)).toMatchObject({ sourceState: 'ok' })
  })
})

describe('เว็บ → Google Forms', () => {
  it('แก้หัวเรื่อง/คำอธิบาย และคำถามที่รองรับ: Google เปลี่ยนจริงด้วย batchUpdate + requiredRevisionId และส่วนที่ไม่ได้แก้ยังอยู่', async () => {
    const form = memberForm()
    await linkForm(form)
    let page = await view()
    const info = await call('/api/forms/info', { method: 'PATCH', as: staff, body: { title: 'สมัครสมาชิก 2569', description: 'กรอกให้ครบ', expectedRevision: page.form.revisionId } })
    expect(info.status).toBe(200)
    page = await data(info)
    expect(page).toMatchObject({ verified: true, form: { title: 'สมัครสมาชิก 2569', description: 'กรอกให้ครบ', revisionId: 'frev-2' } })
    expect(form.info).toMatchObject({ title: 'สมัครสมาชิก 2569', description: 'กรอกให้ครบ', documentTitle: 'สมัครสมาชิก MU Esport' })

    // แก้ตัวเลือกของคำถามแบบเลือกได้หลายข้อ: ตัวเลือก "อื่น ๆ" ของ Google ยังอยู่
    const games = page.items[2]
    const item = await call(`/api/forms/items/${games.itemId}`, { method: 'PATCH', as: staff, body: { title: 'เกมที่อยากแข่ง', description: 'เลือกได้หลายข้อ', required: true, options: ['ROV', 'Valorant', 'FC Online'], expectedRevision: page.form.revisionId } })
    expect(item.status).toBe(200)
    expect((await data(item)).verified).toBe(true)
    expect(form.items[2]).toMatchObject({
      title: 'เกมที่อยากแข่ง', description: 'เลือกได้หลายข้อ',
      questionItem: { question: { questionId: games.questions[0].id, required: true, choiceQuestion: { type: 'CHECKBOX', options: [{ value: 'ROV' }, { value: 'Valorant' }, { value: 'FC Online' }, { isOther: true }] } } },
    })
    expect(form.items.map((i) => i.title)).toEqual(['ชื่อ-นามสกุล', 'ชื่อเล่น', 'เกมที่อยากแข่ง', 'ช่องทางติดต่อ'])
    const sent = google.calls.filter((c) => c.url.endsWith(':batchUpdate'))
    expect(sent).toHaveLength(2)

    // เพิ่มคำถามใหม่ต่อท้าย
    page = await view()
    const added = await call('/api/forms/items', { method: 'POST', as: staff, body: { kind: 'dropdown', title: 'ชั้นปี', description: '', required: false, options: ['ปี 1', 'ปี 2'], expectedRevision: page.form.revisionId } })
    expect(added.status).toBe(201)
    expect(form.items[4]).toMatchObject({ title: 'ชั้นปี', questionItem: { question: { choiceQuestion: { type: 'DROP_DOWN', options: [{ value: 'ปี 1' }, { value: 'ปี 2' }] } } } })
  })

  it('conflict: ฟอร์มถูกแก้ที่ Google หลังผู้ใช้เปิด → ไม่เขียนทับ และหน้าเว็บได้ฉบับล่าสุด', async () => {
    const form = memberForm()
    await linkForm(form)
    const opened = await view()
    ws.editForm(form.formId, (f) => {
      f.items[0].title = 'ชื่อจริง (แก้ที่ Google)'
    })
    const res = await call(`/api/forms/items/${opened.items[0].itemId}`, { method: 'PATCH', as: staff, body: { title: 'แก้ที่เว็บ', description: '', required: true, expectedRevision: opened.form.revisionId } })
    expect(res.status).toBe(409)
    expect((await data(res)).error).toBe('revision_conflict')
    expect(form.items[0].title).toBe('ชื่อจริง (แก้ที่ Google)')
    expect(google.calls.some((c) => c.url.endsWith(':batchUpdate'))).toBe(false)
    expect((await view()).items[0].title).toBe('ชื่อจริง (แก้ที่ Google)')
  })

  it('ส่วนที่เว็บรักษาไม่ได้ (ตาราง อัปโหลดไฟล์ branching quiz): อ่านอย่างเดียวพร้อมเหตุผล และ server ไม่ส่งคำสั่งแก้ไป Google', async () => {
    const form = ws.addForm('แบบสำรวจ', [
      choiceQ('ไปต่อส่วนไหน', 'RADIO', [{ value: 'ก', goToAction: 'NEXT_SECTION' }, { value: 'ข', goToSectionId: 'abc' }]),
      { title: 'ตารางเวลา', questionGroupItem: { questions: [{ rowQuestion: { title: 'จันทร์' } }, { rowQuestion: { title: 'อังคาร' } }], grid: { columns: { type: 'RADIO', options: [{ value: 'ว่าง' }, { value: 'ไม่ว่าง' }] } } } },
      { title: 'แนบรูป', questionItem: { question: { fileUploadQuestion: { folderId: 'x' } } } },
      { title: 'ส่วนที่ 2', pageBreakItem: {} },
      { title: 'ให้คะแนน', questionItem: { question: { scaleQuestion: { low: 1, high: 5 } } } },
      textQ('ข้อความธรรมดา'),
    ])
    await linkForm(form)
    const page = await view()
    expect(page.items.map((i: any) => [i.kind, i.editable])).toEqual([['radio', false], ['grid', false], ['file_upload', false], ['section', false], ['scale', false], ['short_text', true]])
    expect(page.items[0].editNote).toContain('branching')
    expect(page.items[1].questions.map((q: any) => q.label)).toEqual(['จันทร์', 'อังคาร'])
    const snapshot = JSON.stringify(form.items)
    for (const item of page.items.slice(0, 5)) {
      const res = await call(`/api/forms/items/${item.itemId}`, { method: 'PATCH', as: staff, body: { title: 'ลองแก้', description: '', required: false, options: ['ก'], expectedRevision: page.form.revisionId } })
      expect(res.status).toBe(409)
      expect((await data(res)).error).toBe('item_not_editable')
    }
    expect(JSON.stringify(form.items)).toBe(snapshot)
    expect(google.calls.some((c) => c.url.endsWith(':batchUpdate'))).toBe(false)

    // ฟอร์มแบบทดสอบ: คำถามทุกข้ออ่านอย่างเดียว
    const quiz = ws.addForm('ควิซ', [textQ('ข้อ 1')], { settings: { quizSettings: { isQuiz: true } } })
    await call('/api/setup/link/forms', { method: 'DELETE', as: admin })
    await linkForm(quiz)
    expect((await view()).items[0]).toMatchObject({ editable: false })
  })

  it('คำตอบต้นฉบับอ่านอย่างเดียว: ไม่มีเส้นทางแก้หรือส่งคำตอบแทนผู้ตอบ', async () => {
    const form = memberForm()
    const id = ws.submit(form.formId, { [qid(form, 0)]: 'อารี' })
    await linkForm(form)
    for (const [method, path] of [['PATCH', `/api/forms/responses/${id}`], ['PUT', `/api/forms/responses/${id}`], ['DELETE', `/api/forms/responses/${id}`], ['POST', '/api/forms/responses'], ['POST', `/api/forms/responses/${id}/submit`]] as const) {
      expect((await call(path, { method, as: admin, body: { answers: {} } })).status).toBe(404)
    }
    expect(google.calls.some((c) => c.url.includes('/responses') && c.method !== 'GET')).toBe(false)
  })

  it('ผลไม่แน่ชัดตอนแก้ฟอร์ม: ไม่บอกว่าสำเร็จ และซิงค์ถัดไปแสดงสิ่งที่ Google มีจริง', async () => {
    const form = memberForm()
    await linkForm(form)
    const page = await view()
    loseResponseOnce(google, ws, (url) => url.pathname.endsWith(':batchUpdate'))
    const res = await call('/api/forms/info', { method: 'PATCH', as: staff, body: { title: 'ชื่อใหม่', description: '', expectedRevision: page.form.revisionId } })
    expect(res.status).toBe(502)
    expect((await data(res)).error).toBe('save_outcome_unknown')
    expect((await view()).form.title).toBe('สมัครสมาชิก MU Esport')
    await syncNow('forms', staff)
    expect((await view()).form.title).toBe('ชื่อใหม่')
  })
})

describe('คำตอบ → ทะเบียนสมาชิก', () => {
  it('ตรวจก่อนเพิ่ม: เสนอค่าตามการจับคู่คำถาม เตือนรายการที่อาจซ้ำ เพิ่มแล้วเป็นสมาชิกธรรมดา ไม่แตะสิทธิ์ และคำตอบต้นฉบับไม่เปลี่ยน', async () => {
    const form = memberForm()
    await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': 'existing-member-key-1' }, body: { name: 'อารี ใจดี', nickname: 'อา', studentId: '6543210', role: 'member', status: 'active', contact: '', note: '' } })
    const dup = ws.submit(form.formId, { [qid(form, 0)]: 'อารี  ใจดี', [qid(form, 1)]: 'อารี', [qid(form, 3)]: 'aree@example.com' }, { at: '2026-10-01T03:00:00Z', email: 'aree@example.com' })
    const fresh = ws.submit(form.formId, { [qid(form, 0)]: 'admin ปลอม', [qid(form, 1)]: 'แอด', [qid(form, 3)]: 'staff@example.com' }, { at: '2026-10-02T03:00:00Z' })
    await linkForm(form)

    const mapping = { name: qid(form, 0), nickname: qid(form, 1), contact: qid(form, 3) }
    expect((await call('/api/forms/mapping', { method: 'PUT', as: staff, body: { mapping } })).status).toBe(403)
    expect((await call('/api/forms/mapping', { method: 'PUT', as: admin, body: { mapping: { name: 'no-such-question' } } })).status).toBe(422)
    const mapped = await data(await call('/api/forms/mapping', { method: 'PUT', as: admin, body: { mapping } }))
    const review = Object.fromEntries(mapped.responses.map((r: any) => [r.responseId, r]))
    expect(review[dup].candidate).toEqual({ name: 'อารี  ใจดี', nickname: 'อารี', contact: 'aree@example.com', note: '' })
    expect(review[dup].duplicates.map((m: any) => m.name)).toEqual(['อารี ใจดี'])
    expect(review[fresh].duplicates).toEqual([])

    const users = async () => (await env.DB.prepare('SELECT email, role, status FROM users ORDER BY email').all()).results
    const before = await users()
    const snapshot = JSON.stringify(form.responses)
    // ทีมงานปรับค่าได้ก่อนเพิ่ม; ค่าบทบาท/สิทธิ์ที่แนบมาถูกละทิ้ง
    const imported = await call(`/api/forms/responses/${fresh}/import`, { method: 'POST', as: staff, body: { name: 'สมชาย ผู้สมัคร', nickname: 'แอด', contact: 'staff@example.com', note: 'จากฟอร์ม', role: 'admin' } })
    expect(imported.status).toBe(201)
    const result = await data(imported)
    const member = (await data(await call('/api/members', { as: staff }))).members.find((m: any) => m.id === result.memberId)
    expect(member).toMatchObject({ name: 'สมชาย ผู้สมัคร', role: 'member', status: 'active', contact: 'staff@example.com', source: 'local' })
    expect(await users()).toEqual(before)
    expect(JSON.stringify(form.responses)).toBe(snapshot)
    expect(google.calls.some((c) => c.url.includes('forms.googleapis.com') && c.method !== 'GET')).toBe(false)
    expect(result.responses.find((r: any) => r.responseId === fresh)).toMatchObject({ reviewStatus: 'imported', memberId: result.memberId })

    // เพิ่มซ้ำไม่ได้ และจำนวนสมาชิกไม่เพิ่ม
    const again = await call(`/api/forms/responses/${fresh}/import`, { method: 'POST', as: admin, body: { name: 'สมชาย ผู้สมัคร', nickname: 'แอด', contact: '', note: '' } })
    expect(again.status).toBe(409)
    expect((await data(await call('/api/members', { as: staff }))).members).toHaveLength(2)

    // ข้ามคำตอบที่ซ้ำ แล้วเรียกคืนได้ โดยคำตอบยังอยู่
    expect((await data(await call(`/api/forms/responses/${dup}/dismiss`, { method: 'POST', as: staff }))).responses.find((r: any) => r.responseId === dup).reviewStatus).toBe('dismissed')
    expect((await data(await call(`/api/forms/responses/${dup}/restore`, { method: 'POST', as: staff }))).responses.find((r: any) => r.responseId === dup).reviewStatus).toBe('new')
  })

  it('เมื่อเชื่อมชีตสมาชิกแล้ว สมาชิกจากคำตอบถูกเพิ่มลงชีตที่เลือก (แหล่งหลัก) ครั้งเดียว', async () => {
    const head = ['รหัส', 'ชื่อ', 'ชื่อเล่น', 'ติดต่อ']
    const sheet = ws.addSheet('ทะเบียน', [head])
    const linked = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, headerRow: 1, columns: { id: 'รหัส', name: 'ชื่อ', nickname: 'ชื่อเล่น', contact: 'ติดต่อ' } } })
    expect(linked.status).toBe(201)
    const form = memberForm()
    const id = ws.submit(form.formId, { [qid(form, 0)]: 'ดารา', [qid(form, 1)]: 'ดา' })
    await linkForm(form)
    const send = () => call(`/api/forms/responses/${id}/import`, { method: 'POST', as: staff, body: { name: 'ดารา', nickname: 'ดา', contact: 'd', note: '' } })
    const [a, b] = await Promise.all([send(), send()])
    // คนเดียวกันกดซ้ำสองครั้งพร้อมกัน (เช่น ดับเบิลคลิก): ได้ผลเดิม ไม่เพิ่มซ้ำ — กรณีสองบัญชีต่างกันอยู่ใน test/sync-review.test.ts
    expect([a.status, b.status].every((s) => s === 201 || s === 409)).toBe(true)
    expect([a.status, b.status]).toContain(201)
    const rows = ws.cells(sheet.id).filter((r) => r[1] === 'ดารา')
    expect(rows).toHaveLength(1)
    expect(rows[0].slice(1)).toEqual(['ดารา', 'ดา', 'd'])
    expect((await data(await call('/api/members', { as: staff }))).members).toHaveLength(1)
  })
})
