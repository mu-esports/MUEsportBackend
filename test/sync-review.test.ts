import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { runScheduled, SCHEDULED_BUDGET } from '../worker/sync'
import { call, CLUB_EMAIL, data, env, FakeGoogle, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'
import { connectClub, FakeWorkspace, loseResponseOnce } from './workspace'
import type { FakeForm, FakeSheet } from './workspace'

// regression จากการตรวจโค้ด (Codex-google-sync-review-fixes.md) ทุกกรณีใช้ Google จำลอง ไม่ได้ต่อกับ Google จริง
let google: FakeGoogle
let ws: FakeWorkspace
let admin: Actor
let staffA: Actor
let staffB: Actor

beforeEach(async () => {
  await resetDb()
  google = await FakeGoogle.start()
  ws = new FakeWorkspace(google)
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staffA = await seedUser('staff.a@example.com', 'staff')
  staffB = await seedUser('staff.b@example.com', 'staff')
  await connectClub(google)
})
afterEach(() => vi.unstubAllGlobals())

const textQ = (title: string) => ({ title, questionItem: { question: { textQuestion: { paragraph: false } } } })
const members = async () => (await data(await call('/api/members', { as: admin }))).members as Record<string, any>[]
const count = async (sql: string) => (await env.DB.prepare(sql).first<{ n: number }>())!.n

async function linkedForm(): Promise<{ form: FakeForm; responseId: string }> {
  const form = ws.addForm('สมัครสมาชิก', [textQ('ชื่อ'), textQ('ชื่อเล่น')])
  const responseId = ws.submit(form.formId, { [form.items[0].questionItem.question.questionId]: 'ดารา', [form.items[1].questionItem.question.questionId]: 'ดา' })
  const res = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'forms', resourceId: form.formId } })
  expect(res.status).toBe(201)
  return { form, responseId }
}
async function linkedSheet(): Promise<FakeSheet> {
  const sheet = ws.addSheet('ทะเบียน', [['รหัส', 'ชื่อ', 'ชื่อเล่น', 'ติดต่อ', 'หมายเหตุ']])
  const res = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, headerRow: 1, columns: { id: 'รหัส', name: 'ชื่อ', nickname: 'ชื่อเล่น', contact: 'ติดต่อ', note: 'หมายเหตุ' } } })
  expect(res.status).toBe(201)
  return sheet
}
const PAYLOAD = { name: 'ดารา ทดสอบ', nickname: 'ดา', contact: 'discord: dara', note: '' }
const importAs = (as: Actor, responseId: string, body: Record<string, string> = PAYLOAD) =>
  call(`/api/forms/responses/${responseId}/import`, { method: 'POST', as, body })

describe.each([['D1 อย่างเดียว', false], ['เชื่อม Google Sheets', true]] as const)('นำคำตอบ Forms เป็นสมาชิก: สองบัญชีพร้อมกัน (%s)', (_label, withSheet) => {
  let sheet: FakeSheet | null
  let responseId: string
  beforeEach(async () => {
    sheet = withSheet ? await linkedSheet() : null
    responseId = (await linkedForm()).responseId
  })
  const sheetRows = () => (sheet ? ws.cells(sheet.id).slice(1).filter((r) => r.some((c) => c !== '')) : [])
  const expectSingle = async (name: string) => {
    const list = await members()
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ name, role: 'member', status: 'active', source: withSheet ? 'sheets' : 'local' })
    expect(await count('SELECT COUNT(*) AS n FROM members')).toBe(1)
    if (sheet) {
      expect(sheetRows()).toHaveLength(1)
      expect(sheetRows()[0][0]).toBe(list[0].id)
    }
    const claim = await env.DB.prepare('SELECT member_id, status FROM form_imports').all()
    expect(claim.results).toEqual([{ member_id: list[0].id, status: 'completed' }])
    return list[0]
  }

  it('staff A และ staff B (คนละบัญชี คนละ session) กดนำเข้าคำตอบเดียวกันพร้อมกันด้วยค่าเดียวกัน → สมาชิกคนเดียว รหัสเดียว', async () => {
    expect(staffA.id).not.toBe(staffB.id)
    const [a, b] = await Promise.all([importAs(staffA, responseId), importAs(staffB, responseId)])
    expect([a.status, b.status]).toEqual([201, 201])
    const [bodyA, bodyB] = [await data(a), await data(b)]
    expect(bodyA.memberId).toBe(bodyB.memberId)
    const member = await expectSingle('ดารา ทดสอบ')
    expect(member.id).toBe(bodyA.memberId)
    // บันทึกผู้กระทำแยกจากตัวตนของงานนำเข้า: มีผู้จองหนึ่งคน และ audit ระบุว่าใครทำ
    const row = await env.DB.prepare('SELECT claimed_by, completed_by FROM form_imports').first<{ claimed_by: string; completed_by: string }>()
    expect([staffA.id, staffB.id]).toContain(row!.claimed_by)
    expect(row!.completed_by).toBe(row!.claimed_by)
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'forms.response_imported'`)).toBe(1)
    // กดซ้ำภายหลังจากอีกบัญชี (รวมผู้ดูแล) ก็ไม่เพิ่ม
    expect((await importAs(admin, responseId)).status).toBe(201)
    await expectSingle('ดารา ทดสอบ')
  })

  it('สองคนปรับค่าต่างกันแล้วกดพร้อมกัน → มีผู้ชนะคนเดียว อีกคนได้ already_imported พร้อมรหัสสมาชิกที่เกิดแล้ว ไม่ได้สมาชิกอีกคน', async () => {
    const [a, b] = await Promise.all([
      importAs(staffA, responseId, { ...PAYLOAD, name: 'ดารา (ค่าของ A)' }),
      importAs(staffB, responseId, { ...PAYLOAD, name: 'ดารา (ค่าของ B)' }),
    ])
    expect([a.status, b.status].sort()).toEqual([201, 409])
    const winner = a.status === 201 ? 'A' : 'B'
    const lost = await data(a.status === 409 ? a : b)
    const won = await data(a.status === 201 ? a : b)
    expect(lost.error).toBe('already_imported')
    expect(lost.memberId).toBe(won.memberId)
    await expectSingle(`ดารา (ค่าของ ${winner})`)
  })

  it('งานนำเข้าค้างกลางทาง (สร้างสมาชิกแล้วแต่ยังไม่ได้บันทึกผลการตรวจ) แล้วอีกบัญชีลองใหม่ → ทำต่อรายการเดิม ไม่สร้างเพิ่ม', async () => {
    if (sheet) {
      // Google ต่อแถวสำเร็จแต่คำตอบหาย: คำขอของ A ล้มเหลวโดยยังไม่ได้ปิดงาน
      loseResponseOnce(google, ws, (url) => url.pathname.endsWith(':batchUpdate'))
      const first = await importAs(staffA, responseId)
      expect(first.status).toBe(502)
      expect((await data(first)).error).toBe('save_outcome_unknown')
      expect(sheetRows()).toHaveLength(1)
    } else {
      // จำลอง Worker หยุดหลังเขียนสมาชิกแต่ก่อนอัปเดต review_status: ย้อนสถานะของงานและคำตอบกลับเป็นค้าง โดยสมาชิกยังอยู่
      expect((await importAs(staffA, responseId)).status).toBe(201)
      await env.DB.batch([
        env.DB.prepare(`UPDATE form_imports SET status = 'pending', completed_by = NULL, completed_at = NULL`),
        env.DB.prepare(`UPDATE form_responses SET review_status = 'new', member_id = NULL`),
      ])
    }
    const pending = await env.DB.prepare('SELECT member_id, status, claimed_by FROM form_imports').first<{ member_id: string; status: string; claimed_by: string }>()
    expect(pending).toMatchObject({ status: 'pending', claimed_by: staffA.id })

    // B ลองใหม่ด้วยค่าที่ต่างออกไป: ระบบทำงานของ A ให้จบด้วยค่าที่ A ยืนยัน และบอก B ว่านำเข้าไปแล้ว
    const retry = await importAs(staffB, responseId, { ...PAYLOAD, name: 'ค่าของ B' })
    expect(retry.status).toBe(409)
    expect(await data(retry)).toMatchObject({ error: 'already_imported', memberId: pending!.member_id })
    const member = await expectSingle('ดารา ทดสอบ')
    expect(member.id).toBe(pending!.member_id)
    const view = await data(await call('/api/forms', { as: staffB }))
    expect(view.responses[0]).toMatchObject({ reviewStatus: 'imported', memberId: member.id })
    const done = await env.DB.prepare('SELECT claimed_by, completed_by FROM form_imports').first<{ claimed_by: string; completed_by: string }>()
    expect(done).toEqual({ claimed_by: staffA.id, completed_by: staffB.id })
  })
})

it('รหัสคำตอบที่ยาวมากและขึ้นต้นเหมือนกันไม่ชนกัน: แต่ละคำตอบได้สมาชิกของตัวเอง (ไม่มีการตัดรหัสให้สั้น)', async () => {
  const form = ws.addForm('ฟอร์ม', [textQ('ชื่อ')])
  const prefix = 'R'.repeat(80)
  const one = ws.submit(form.formId, {}, { responseId: `${prefix}-1` })
  const two = ws.submit(form.formId, {}, { responseId: `${prefix}-2` })
  await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'forms', resourceId: form.formId } })
  expect((await importAs(staffA, one, { ...PAYLOAD, name: 'คนที่หนึ่ง' })).status).toBe(201)
  expect((await importAs(staffB, two, { ...PAYLOAD, name: 'คนที่สอง' })).status).toBe(201)
  expect((await members()).map((m) => m.name).sort()).toEqual(['คนที่สอง', 'คนที่หนึ่ง'])
})

describe('Cron: งบคำขอรวมและความคืบหน้าของทุกบริการ', () => {
  const ROTATE_MS = 5 * 60_000
  const googleApiCalls = () => google.calls.filter((c) => !c.url.includes('oauth2')).length
  const due = () => env.DB.prepare('UPDATE sync_state SET last_attempt_at = NULL, next_attempt_at = NULL').run()

  /** เชื่อมครบสี่บริการ โดยให้บริการต้น ๆ มีงานมากกว่างบของรอบเดียว */
  async function linkAll() {
    const sheet = ws.addSheet('ทะเบียน', [['รหัส', 'ชื่อ'], ['m1', 'อารี']])
    await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, columns: { id: 'รหัส', name: 'ชื่อ' } } })
    const calendar = ws.addCalendar('ปฏิทิน')
    await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'calendar', resourceId: calendar.id } })
    const form = ws.addForm('ฟอร์ม', [textQ('ชื่อ')])
    await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'forms', resourceId: form.formId } })
    const docs = []
    for (let i = 0; i < 3; i++) {
      const doc = google.addDoc(`เอกสาร ${i}`, 'x')
      docs.push(doc)
      await env.DB.prepare(`INSERT INTO documents (id, google_document_id, title, created_by, updated_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, 'x', 'x')`).bind(`d${i}`, doc.id, doc.title, admin.id, admin.id).run()
    }
    return { sheet, calendar, form, docs }
  }
  const titles = async () => ((await env.DB.prepare('SELECT title FROM documents ORDER BY id').all<{ title: string }>()).results).map((r) => r.title)
  const attempted = async () => Object.fromEntries(((await env.DB.prepare('SELECT kind, last_attempt_at, last_error_code FROM sync_state').all<{ kind: string; last_attempt_at: string | null; last_error_code: string | null }>()).results).map((r) => [r.kind, r]))

  it('ทั้งสี่บริการถึงรอบพร้อมกัน บริการต้น ๆ ใช้งบเต็ม (แบ่งหน้ายาว) และมีบริการล้มเหลว → Docs และทุกบริการยังได้ทำงานในรอบเดียวกัน ภายในงบรวม ทุกลำดับการหมุน', async () => {
    const { sheet, calendar, form, docs } = await linkAll()
    // ปฏิทินและฟอร์มมีข้อมูลหลายสิบหน้า (หน้าละ 1 รายการ) ชีตถูกย้ายไปถังขยะ (ล้มเหลว)
    ws.pageSize = 1
    calendar.minToken = 999_999 // บังคับให้ต้องดึงใหม่ทั้งชุด
    await env.DB.prepare(`UPDATE sync_state SET cursor = NULL WHERE kind = 'calendar'`).run()
    for (let i = 0; i < 40; i++) ws.putEvent(calendar.id, { summary: `งาน ${i}`, start: { date: '2030-01-01' }, end: { date: '2030-01-02' } })
    for (let i = 0; i < 40; i++) ws.submit(form.formId, {}, { at: `2026-10-01T03:${String(i).padStart(2, '0')}:00Z` })
    await env.DB.prepare(`UPDATE sync_state SET cursor = NULL WHERE kind = 'forms'`).run()
    sheet.trashed = true

    for (let slot = 0; slot < 4; slot++) {
      await due()
      docs.forEach((doc, i) => google.renameExternally(doc.id, `เอกสาร ${i} รอบ ${slot}`))
      google.calls.length = 0
      const report = await runScheduled(env, slot * ROTATE_MS)
      // ลำดับหมุนตามช่วงเวลา และทุกบริการได้งบอย่างน้อยหนึ่งในสี่ของงบรวม
      expect(report.map((r) => r.kind)).toEqual([...['sheets', 'calendar', 'forms', 'docs'].slice(slot), ...['sheets', 'calendar', 'forms', 'docs'].slice(0, slot)])
      expect(report.every((r) => r.ran && r.budget >= SCHEDULED_BUDGET / 4), JSON.stringify(report)).toBe(true)
      expect(report.reduce((sum, r) => sum + r.used, 0)).toBeLessThanOrEqual(SCHEDULED_BUDGET)
      expect(googleApiCalls()).toBeLessThanOrEqual(SCHEDULED_BUDGET)
      // Docs ได้ทำงานจริงในรอบนี้ ไม่ว่าจะอยู่ลำดับใด: ชื่อที่เปลี่ยนใน Google ขึ้นในรายการ
      expect(await titles(), `slot ${slot} ${JSON.stringify(report)}`).toEqual([0, 1, 2].map((i) => `เอกสาร ${i} รอบ ${slot}`))
      const state = await attempted()
      expect(Object.values(state).every((s) => s.last_attempt_at !== null)).toBe(true)
      // บริการที่ล้มเหลวไม่กินงบของบริการอื่นและไม่ทำให้รอบหยุด
      expect(state.sheets.last_error_code).toBe('resource_unavailable')
    }
    expect((await members()).length).toBe(1) // สำเนาเดิมของชีตยังอยู่
  })

  it('บริการที่ข้อมูลมากกว่างบของรอบเดียวทำต่อจากตำแหน่งเดิมในรอบถัดไปจนครบ โดย Docs ไม่ถูกข้ามสักรอบ', async () => {
    const { calendar, form, docs } = await linkAll()
    ws.pageSize = 1
    calendar.minToken = 999_999
    await env.DB.prepare(`UPDATE sync_state SET cursor = NULL WHERE kind IN ('calendar', 'forms')`).run()
    for (let i = 0; i < 9; i++) ws.putEvent(calendar.id, { summary: `งาน ${i}`, start: { date: '2030-01-01' }, end: { date: '2030-01-02' } })
    for (let i = 0; i < 7; i++) ws.submit(form.formId, {}, { at: `2026-10-01T03:0${i}:00Z` })
    calendar.minToken = 0

    let rounds = 0
    for (; rounds < 8; rounds++) {
      await due()
      google.renameExternally(docs[0].id, `รอบ ${rounds}`)
      google.calls.length = 0
      const report = await runScheduled(env, 0)
      expect(googleApiCalls()).toBeLessThanOrEqual(SCHEDULED_BUDGET)
      expect(report.find((r) => r.kind === 'docs')!.ran).toBe(true)
      expect((await titles())[0]).toBe(`รอบ ${rounds}`)
      const events = (await data(await call('/api/events', { as: admin }))).events.length
      const responses = await count('SELECT COUNT(*) AS n FROM form_responses')
      if (events === 9 && responses === 7) break
    }
    // ครบภายในจำนวนรอบที่จำกัด (หน้าละ 1 รายการ รอบละไม่เกิน 4 หน้าของปฏิทิน และ 3 หน้าของฟอร์ม)
    expect(rounds).toBeLessThanOrEqual(3)
    expect((await data(await call('/api/events', { as: admin }))).events).toHaveLength(9)
    expect(await count('SELECT COUNT(*) AS n FROM form_responses')).toBe(7)
  })
})
