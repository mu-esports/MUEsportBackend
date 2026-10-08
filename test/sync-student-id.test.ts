import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { planStudentIds } from '../worker/sheets'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'
import { connectClub, FakeWorkspace, syncNow } from './workspace'
import type { FakeSheet } from './workspace'

// ทุกกรณีในไฟล์นี้ใช้ Google Sheets จำลอง (test/workspace.ts) ไม่ได้ต่อกับ Google จริง
const HEAD8 = ['รหัสสมาชิก (ระบบใช้จับคู่ ห้ามแก้)', 'ชื่อ', 'ชื่อเล่น', 'บทบาท', 'สถานะ', 'ช่องทางติดต่อ', 'หมายเหตุ', 'วันที่เพิ่ม']
const HEAD = [...HEAD8, 'รหัสนักศึกษา']
const COLUMNS8 = { id: HEAD8[0], name: 'ชื่อ', nickname: 'ชื่อเล่น', role: 'บทบาท', status: 'สถานะ', contact: 'ช่องทางติดต่อ', note: 'หมายเหตุ', addedAt: 'วันที่เพิ่ม' }
const COLUMNS = { ...COLUMNS8, studentId: 'รหัสนักศึกษา' }
const row = (id: string, name: string, studentId = '', extra: Partial<Record<'status' | 'contact' | 'note', string>> = {}) =>
  [id, name, name.slice(0, 2), 'สมาชิก', extra.status ?? 'ใช้งาน', extra.contact ?? '', extra.note ?? '', '2026-09-01', studentId]
const STUDENT_COL = 8
const TEMP = 'Temp-Pass-7391'

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

async function linkSheet(rows: string[][], options: { head?: string[]; columns?: Record<string, string>; canEdit?: boolean } = {}): Promise<FakeSheet> {
  const sheet = ws.addSheet('ทะเบียนสมาชิก', [options.head ?? HEAD, ...rows], { canEdit: options.canEdit })
  const res = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, headerRow: 1, columns: options.columns ?? COLUMNS } })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  return sheet
}
const members = async () => (await data(await call('/api/members', { as: staff }))).members as Record<string, any>[]
const member = async (id: string) => (await members()).find((m) => m.id === id)!
const input = (m: Record<string, any>, changes: Record<string, unknown> = {}) => ({
  name: m.name, nickname: m.nickname, studentId: m.studentId, role: m.role, status: m.status, contact: m.contact, note: m.note, expectedVersion: m.version, ...changes,
})
const patch = (id: string, body: unknown, as: Actor = staff) => call(`/api/members/${id}`, { method: 'PATCH', as, body })
const issues = async () => ((await data(await call('/api/sync', { as: staff }))).sync.find((s: any) => s.kind === 'sheets').issues as { code: string; where?: string }[])
const setPassword = (id: string, studentId: string) => call(`/api/members/${id}/account/password`, { method: 'POST', as: admin, body: { studentId, password: TEMP } })
const login = (studentId: string, password = TEMP) => call('/auth/member/login', { method: 'POST', body: { studentId, password } })
const sessionOf = async (res: Response) => (await data(await call('/api/session', { cookie: res.headers.get('Set-Cookie')!.split(';')[0] }))).member

describe('ตัดสินรหัสนักศึกษาจากสิ่งที่ชีตระบุ (ฟังก์ชันล้วน)', () => {
  const current = (entries: [string, string, 'web' | 'sheet'][]) => new Map(entries.map(([id, studentId, origin]) => [id, { studentId, origin }]))
  const claims = (entries: [string, string, ('' | 'invalid' | 'duplicate')?][]) => new Map(entries.map(([id, value, issue]) => [id, { value, issue: issue ?? '' }]))

  it('ใช้ค่าที่ไม่ซ้ำ สลับรหัสระหว่างสองคนได้ และช่องว่างล้างเฉพาะค่าที่เคยมาจากชีต', () => {
    const plan = planStudentIds(current([['a', '111', 'sheet'], ['b', '222', 'sheet'], ['c', '333', 'sheet'], ['d', '444', 'web'], ['e', '', 'web']]), claims([['a', '222'], ['b', '111'], ['c', ''], ['d', ''], ['e', '555']]))
    expect(plan.get('a')).toEqual({ studentId: '222', origin: 'sheet', issue: '', claimed: '' })
    expect(plan.get('b')).toEqual({ studentId: '111', origin: 'sheet', issue: '', claimed: '' })
    expect(plan.get('c')).toEqual({ studentId: '', origin: 'web', issue: '', claimed: '' })
    expect(plan.get('d')).toEqual({ studentId: '444', origin: 'web', issue: '', claimed: '' })
    expect(plan.get('e')).toEqual({ studentId: '555', origin: 'sheet', issue: '', claimed: '' })
  })

  it('ชนกับรหัสที่คนอื่นถืออยู่: ฝ่ายที่กำลังจะเปลี่ยนถอย และการถอยไม่ทำให้เกิดรหัสซ้ำต่อเนื่อง', () => {
    // x (ไม่อยู่ในชีต) ถือ 900; a ขอ 900 → ถอย; b ขอรหัสเดิมของ a (111) → ต้องถอยด้วยเพราะ a ยังถือ 111 อยู่
    const plan = planStudentIds(current([['x', '900', 'web'], ['a', '111', 'sheet'], ['b', '222', 'sheet']]), claims([['a', '900'], ['b', '111']]))
    expect(plan.get('a')).toEqual({ studentId: '111', origin: 'sheet', issue: 'taken', claimed: '900' })
    expect(plan.get('b')).toEqual({ studentId: '222', origin: 'sheet', issue: 'taken', claimed: '111' })
    const final = ['x', 'a', 'b'].map((id) => plan.get(id)?.studentId ?? '900')
    expect(new Set(final).size).toBe(3)
  })

  it('ค่าที่ซ้ำกันในชีตหรือผิดรูปแบบ: คงค่าเดิมและบันทึกสิ่งที่ชีตระบุไว้ให้ตรวจ', () => {
    const plan = planStudentIds(current([['a', '111', 'sheet'], ['b', '', 'web']]), claims([['a', '777', 'duplicate'], ['b', '777', 'duplicate'], ['c', 'ไม่ถูก', 'invalid']]))
    expect(plan.get('a')).toEqual({ studentId: '111', origin: 'sheet', issue: 'duplicate', claimed: '777' })
    expect(plan.get('b')).toEqual({ studentId: '', origin: 'web', issue: 'duplicate', claimed: '777' })
    expect(plan.get('c')).toEqual({ studentId: '', origin: 'web', issue: 'invalid', claimed: 'ไม่ถูก' })
  })
})

describe('รหัสนักศึกษาจากคอลัมน์ในชีต', () => {
  it('ชีตใช้ u/U หรือตัวเลขล้วน: เข้าบัญชีเดียวกัน และตรวจแถวซ้ำข้ามสองรูปแบบ', async () => {
    await linkSheet([row('id-a', 'ตัวอย่าง ก', 'U0065002'), row('id-b', 'ตัวอย่าง ข', 'u6501234'), row('id-c', 'ตัวอย่าง ค', '6501234')])
    expect((await member('id-a')).studentId).toBe('0065002')
    expect((await setPassword('id-a', 'u0065002')).status).toBe(201)
    const res = await login('U0065002')
    expect(res.status).toBe(200)
    expect((await sessionOf(res)).id).toBe('id-a')
    for (const id of ['id-b', 'id-c']) {
      expect((await member(id)).studentIdIssue.code).toBe('duplicate')
      expect((await setPassword(id, '6501234')).status).toBe(409)
    }
  })
  it('อ่านเป็นข้อความตามที่ชีตแสดง คงเลขศูนย์นำหน้า และเรียงแถวใหม่ไม่ทำให้บัญชีสลับคน', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '0012345'), row('id-b', 'บุญมี ทดสอบ', 'B6500002'), row('id-c', 'ชาตรี ทดสอบ', '')])
    expect((await member('id-a')).studentId).toBe('0012345')
    expect((await member('id-b')).studentId).toBe('B6500002')
    expect((await member('id-c')).account.blocked).toBe('no_student_id')
    expect((await setPassword('id-a', '0012345')).status).toBe(201)

    // เรียงแถวใหม่ที่ Google: บัญชีผูกกับรหัสสมาชิก ไม่ใช่เลขแถว
    const cells = ws.cells(sheet.id)
    cells.splice(1, 3, cells[3], cells[2], cells[1])
    await syncNow('sheets', staff)
    expect((await env.DB.prepare('SELECT member_id, login_id FROM member_accounts').all()).results).toEqual([{ member_id: 'id-a', login_id: '0012345' }])
    expect((await sessionOf(await login('0012345'))).id).toBe('id-a')
    expect((await member('id-b')).studentId).toBe('B6500002')
    expect(await issues()).toEqual([])
  })

  it('รหัสซ้ำกันในชีต: แสดงเป็นปัญหา ไม่ใช้กับแถวใด เปิดบัญชีไม่ได้ และบัญชีที่มีอยู่ไม่เปลี่ยนเจ้าของ', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6512345'), row('id-b', 'บุญมี ทดสอบ', ''), row('id-c', 'ชาตรี ทดสอบ', '')])
    expect((await setPassword('id-a', '6512345')).status).toBe(201)

    // มีคนพิมพ์รหัสของอารีลงในแถวของบุญมีและชาตรี
    ws.cells(sheet.id)[2][STUDENT_COL] = '6512345'
    ws.cells(sheet.id)[3][STUDENT_COL] = '6512345'
    await syncNow('sheets', staff)
    const found = await issues()
    expect(found).toEqual([{ code: 'duplicate_student_id', where: 'แถว 2 และ 3 และ 4', message: expect.stringContaining('รหัสนักศึกษาซ้ำกัน') }])
    for (const id of ['id-b', 'id-c']) {
      const m = await member(id)
      expect(m.studentId, id).toBe('')
      expect(m.studentIdIssue, id).toEqual({ code: 'duplicate', claimed: '6512345' })
      expect(m.account.blocked, id).toBe('student_id_conflict')
      const res = await setPassword(id, '6512345')
      expect(res.status, id).toBe(409)
      expect((await data(res)).error).toBe('student_id_conflict')
    }
    // เจ้าของเดิมยังเป็นคนเดิม: รหัสในทะเบียนคงเดิม บัญชีและรหัสผ่านใช้ได้ และไม่มีบัญชีใหม่เกิดขึ้น
    const owner = await member('id-a')
    expect(owner.studentId).toBe('6512345')
    expect(owner.studentIdIssue).toEqual({ code: 'duplicate', claimed: '6512345' })
    expect(owner.account).toMatchObject({ state: 'must_change', loginId: '6512345', loginMismatch: false })
    expect((await sessionOf(await login('6512345'))).id).toBe('id-a')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_accounts').first<{ n: number }>())?.n).toBe(1)

    // แก้ที่ชีตให้ไม่ซ้ำ: ปัญหาหายและค่าถูกใช้ตามปกติ
    ws.cells(sheet.id)[2][STUDENT_COL] = '6500002'
    ws.cells(sheet.id)[3][STUDENT_COL] = ''
    await syncNow('sheets', staff)
    expect(await issues()).toEqual([])
    expect(await member('id-b')).toMatchObject({ studentId: '6500002', studentIdIssue: null })
    expect((await member('id-a')).studentIdIssue).toBeNull()
    expect((await setPassword('id-b', '6500002')).status).toBe(201)
  })

  it('รหัสผิดรูปแบบในชีต: ข้อมูลอื่นของแถวยังซิงค์ แต่รหัสนักศึกษาคงค่าเดิมและแจ้งให้แก้', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6512345')])
    ws.cells(sheet.id)[1][STUDENT_COL] = '65 12345'
    ws.cells(sheet.id)[1][2] = 'อารีย์'
    await syncNow('sheets', staff)
    const m = await member('id-a')
    expect(m).toMatchObject({ nickname: 'อารีย์', studentId: '6512345', studentIdIssue: { code: 'invalid', claimed: '65 12345' } })
    expect((await issues()).map((i) => [i.code, i.where])).toEqual([['invalid_student_id', 'แถว 2']])
  })

  it('ชีตเปลี่ยนรหัสของสมาชิกที่มีบัญชี: ทะเบียนตามชีต แต่รหัสเข้าสู่ระบบรอผู้ดูแลยืนยัน', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6512345')])
    expect((await setPassword('id-a', '6512345')).status).toBe(201)
    ws.cells(sheet.id)[1][STUDENT_COL] = '6599999'
    await syncNow('sheets', staff)
    const m = await member('id-a')
    expect(m.studentId).toBe('6599999')
    expect(m.account).toMatchObject({ loginId: '6512345', loginMismatch: true })
    expect((await login('6599999')).status).toBe(401)
    expect((await sessionOf(await login('6512345'))).id).toBe('id-a')
    const confirmed = await call('/api/members/id-a/account/login-id', { method: 'POST', as: admin, body: { studentId: '6599999' } })
    expect((await data(confirmed)).account).toMatchObject({ loginId: '6599999', loginMismatch: false })
    expect((await login('6512345')).status).toBe(401)
    expect((await login('6599999')).status).toBe(200)
  })

  it('สลับรหัสระหว่างสองแถวในชีต และช่องที่ถูกลบในชีต: ทะเบียนตามชีต บัญชีเดิมยังใช้รหัสเดิมจนกว่าจะยืนยัน', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6500001'), row('id-b', 'บุญมี ทดสอบ', '6500002'), row('id-c', 'ชาตรี ทดสอบ', '6500003')])
    expect((await setPassword('id-c', '6500003')).status).toBe(201)
    ws.cells(sheet.id)[1][STUDENT_COL] = '6500002'
    ws.cells(sheet.id)[2][STUDENT_COL] = '6500001'
    ws.cells(sheet.id)[3][STUDENT_COL] = ''
    const result = await syncNow('sheets', staff)
    expect(result.status.error).toBeNull()
    expect((await member('id-a')).studentId).toBe('6500002')
    expect((await member('id-b')).studentId).toBe('6500001')
    const c = await member('id-c')
    expect(c.studentId).toBe('')
    // บัญชีไม่ถูกปิดหรือย้ายเอง: ยังเข้าด้วยรหัสเดิม และหน้าเว็บบอกว่าไม่ตรงกับทะเบียน
    expect(c.account).toMatchObject({ state: 'must_change', loginId: '6500003', loginMismatch: true })
    expect((await sessionOf(await login('6500003'))).id).toBe('id-c')
  })

  it('ชีตระบุรหัสที่สมาชิกเฉพาะในเว็บใช้อยู่: ไม่ใช้ค่านั้น และไม่ย้ายรหัสของคนเดิม', async () => {
    const local = (await data(await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { name: 'คนในเว็บ', nickname: 'เว็บ', studentId: '6577777', role: 'member', status: 'active', contact: '', note: '' } }))).member
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6577777')])
    expect((await member('id-a'))).toMatchObject({ studentId: '', studentIdIssue: { code: 'taken', claimed: '6577777' } })
    expect((await member(local.id)).studentId).toBe('6577777')
    await syncNow('sheets', staff)
    expect((await issues()).map((i) => [i.code, i.where])).toEqual([['student_id_taken', 'แถว 2']])
    expect((await setPassword('id-a', '6577777')).status).toBe(409)
    void sheet
  })

  it('แก้และเพิ่มจากเว็บเมื่อชีตมีคอลัมน์รหัสนักศึกษา: ค่าลงช่องของแถวนั้นในชีต และรหัสซ้ำถูกปฏิเสธก่อนเขียน', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6500001'), row('id-b', 'บุญมี ทดสอบ', '')])
    const b = await member('id-b')
    const saved = await patch('id-b', input(b, { studentId: '0065002' }))
    expect(saved.status).toBe(200)
    expect((await data(saved)).member.studentId).toBe('0065002')
    expect(ws.cells(sheet.id)[2][STUDENT_COL]).toBe('0065002')

    const before = JSON.stringify(ws.cells(sheet.id))
    const dup = await patch('id-b', input(await member('id-b'), { studentId: '6500001' }))
    expect(dup.status).toBe(409)
    expect((await data(dup)).error).toBe('student_id_taken')
    expect(JSON.stringify(ws.cells(sheet.id))).toBe(before)

    const created = await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { name: 'ดวงใจ ทดสอบ', nickname: 'ใจ', studentId: '6500004', role: 'member', status: 'active', contact: '', note: '' } })
    expect(created.status).toBe(201)
    expect((await data(created)).member.studentId).toBe('6500004')
    expect(ws.cells(sheet.id)[3][STUDENT_COL]).toBe('6500004')
    // แถวที่ชีตระบุรหัสผิดรูปแบบ (ยังเป็นปัญหาค้าง): แก้ฟิลด์อื่นจากเว็บไม่เขียนทับช่องรหัสในชีต
    ws.cells(sheet.id)[1][STUDENT_COL] = '65 00001'
    await syncNow('sheets', staff)
    const a = await member('id-a')
    expect(a).toMatchObject({ studentId: '6500001', studentIdIssue: { code: 'invalid', claimed: '65 00001' } })
    expect((await patch('id-a', input(a, { nickname: 'อารีย์' }))).status).toBe(200)
    expect(ws.cells(sheet.id)[1][STUDENT_COL]).toBe('65 00001')
    expect(ws.cells(sheet.id)[1][2]).toBe('อารีย์')
    expect(await member('id-a')).toMatchObject({ nickname: 'อารีย์', studentId: '6500001' })
  })

  it('รหัสผ่านและข้อมูลบัญชีไม่ถูกเขียนลงชีตในขั้นตอนใด', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6512345')])
    expect((await setPassword('id-a', '6512345')).status).toBe(201)
    const first = await login('6512345')
    const cookie = first.headers.get('Set-Cookie')!.split(';')[0]
    const session = await data(await call('/api/session', { cookie }))
    const actor = { id: 'id-a', cookie, csrf: session.csrfToken }
    const changed = await call('/api/member/password', { method: 'POST', as: actor, body: { currentPassword: TEMP, newPassword: 'My-Own-Secret-2026' } })
    expect(changed.status).toBe(200)
    await syncNow('sheets', staff)
    const dump = JSON.stringify(sheet.tabs)
    expect(dump).not.toMatch(/Temp-Pass|My-Own-Secret|argon2|\$v=19|must_change|password/i)
    expect(sheet.tabs[0].cells[0]).toEqual(HEAD)
    expect(sheet.tabs[0].cells[1]).toHaveLength(9)
  })

  it('สมาชิกแก้ช่องทางติดต่อของตัวเอง: เขียนเฉพาะช่องนั้นของแถวตัวเองในชีต', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ', '6512345', { contact: 'เดิม', note: 'หมายเหตุทีมงาน' }), row('id-b', 'บุญมี ทดสอบ', '6500002', { contact: 'ของบุญมี' })])
    await setPassword('id-a', '6512345')
    const temp = await login('6512345')
    let cookie = temp.headers.get('Set-Cookie')!.split(';')[0]
    let csrf = (await data(await call('/api/session', { cookie }))).csrfToken
    const changed = await call('/api/member/password', { method: 'POST', as: { id: 'id-a', cookie, csrf }, body: { currentPassword: TEMP, newPassword: 'My-Own-Secret-2026' } })
    cookie = changed.headers.get('Set-Cookie')!.split(';')[0]
    csrf = (await data(changed)).csrfToken
    const actor = { id: 'id-a', cookie, csrf }
    const me = (await data(await call('/api/member/me', { as: actor }))).member
    expect(me).toMatchObject({ contact: 'เดิม', contactEditable: true })
    const before = structuredClone(ws.cells(sheet.id))
    const res = await call('/api/member/me', { method: 'PATCH', as: actor, body: { contact: 'line: aree', expectedVersion: me.version, name: 'แอบเปลี่ยนชื่อ', note: 'แอบแก้' } })
    expect(res.status).toBe(200)
    expect((await data(res)).member.contact).toBe('line: aree')
    const after = ws.cells(sheet.id)
    before[1][5] = 'line: aree'
    expect(after).toEqual(before)
    expect(JSON.stringify(await data(await call('/api/member/me', { as: actor })))).not.toContain('หมายเหตุทีมงาน')
  })

  it('ชีตที่เว็บมีสิทธิ์อ่านอย่างเดียว: สมาชิกแก้ช่องทางติดต่อไม่ได้ และได้ข้อความสำหรับสมาชิก', async () => {
    await linkSheet([row('id-a', 'อารี ทดสอบ', '6512345', { note: 'หมายเหตุทีมงาน' })], { canEdit: false })
    await setPassword('id-a', '6512345')
    const temp = await login('6512345')
    const cookie = temp.headers.get('Set-Cookie')!.split(';')[0]
    const csrf = (await data(await call('/api/session', { cookie }))).csrfToken
    const changed = await call('/api/member/password', { method: 'POST', as: { id: 'id-a', cookie, csrf }, body: { currentPassword: TEMP, newPassword: 'My-Own-Secret-2026' } })
    const actor = { id: 'id-a', cookie: changed.headers.get('Set-Cookie')!.split(';')[0], csrf: (await data(changed)).csrfToken }
    const me = (await data(await call('/api/member/me', { as: actor }))).member
    expect(me.contactEditable).toBe(false)
    const res = await call('/api/member/me', { method: 'PATCH', as: actor, body: { contact: 'x', expectedVersion: me.version } })
    expect(res.status).toBe(409)
    const body = await data(res)
    expect(body.error).toBe('contact_not_editable')
    expect(JSON.stringify(body)).not.toContain('หมายเหตุทีมงาน')
  })
})

describe('ชีตที่เชื่อมไว้ก่อนมีคอลัมน์รหัสนักศึกษา', () => {
  it('รหัสที่กรอกในเว็บเก็บในเว็บ ไม่ถูกล้างเมื่อซิงค์ และเปิดบัญชีได้', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ').slice(0, 8), row('id-b', 'บุญมี ทดสอบ').slice(0, 8)], { head: HEAD8, columns: COLUMNS8 })
    const a = await member('id-a')
    expect(a.studentId).toBe('')
    const saved = await patch('id-a', input(a, { studentId: '6512345' }))
    expect(saved.status).toBe(200)
    expect((await data(saved)).member.studentId).toBe('6512345')
    // ไม่มีคอลัมน์นี้ในชีต: ชีตไม่ถูกแตะ
    expect(ws.cells(sheet.id)[1]).toHaveLength(8)
    ws.cells(sheet.id)[1][2] = 'อารีย์'
    await syncNow('sheets', staff)
    expect(await member('id-a')).toMatchObject({ nickname: 'อารีย์', studentId: '6512345' })
    expect((await setPassword('id-a', '6512345')).status).toBe(201)
    // รหัสซ้ำกับคนอื่นยังถูกปฏิเสธ
    const dup = await patch('id-b', input(await member('id-b'), { studentId: '6512345' }))
    expect(dup.status).toBe(409)
  })

  it('ผู้ดูแลเพิ่มคอลัมน์รหัสนักศึกษาให้ชีตเดิม: รหัสที่กรอกในเว็บถูกเขียนลงช่องว่างของแถวนั้น และชีตกลายเป็นแหล่งหลัก', async () => {
    const sheet = await linkSheet([row('id-a', 'อารี ทดสอบ').slice(0, 8), row('id-b', 'บุญมี ทดสอบ').slice(0, 8)], { head: HEAD8, columns: COLUMNS8 })
    await patch('id-a', input(await member('id-a'), { studentId: '0012345' }))

    const info = await data(await call('/api/setup/student-id-column', { as: admin }))
    expect(info).toMatchObject({ mapped: null, headers: [], writable: true, defaultHeader: 'รหัสนักศึกษา' })
    expect((await call('/api/setup/student-id-column', { as: staff })).status).toBe(403)
    expect((await call('/api/setup/student-id-column', { method: 'POST', as: staff, body: { add: true } })).status).toBe(403)

    const added = await call('/api/setup/student-id-column', { method: 'POST', as: admin, body: { add: true } })
    expect(added.status).toBe(200)
    expect((await data(added)).mapped).toBe('รหัสนักศึกษา')
    expect(ws.cells(sheet.id)[0]).toEqual(HEAD)
    // รอบซิงค์หลังจับคู่: ค่าที่กรอกในเว็บลงช่องที่ว่างของแถวเดิม (ไม่หาย) แถวที่ไม่มีค่าไม่ถูกเขียน
    expect(ws.cells(sheet.id)[1][STUDENT_COL]).toBe('0012345')
    expect(ws.cells(sheet.id)[2][STUDENT_COL] ?? '').toBe('')
    expect((await member('id-a')).studentId).toBe('0012345')
    expect((await data(await call('/api/setup', { as: admin }))).studentIdColumn).toBe('รหัสนักศึกษา')

    // จากนี้ชีตเป็นแหล่งหลัก: แก้ที่ชีตแล้วเว็บตาม และลบที่ชีตแล้วเว็บล้าง
    ws.cells(sheet.id)[1][STUDENT_COL] = '0099999'
    await syncNow('sheets', staff)
    expect((await member('id-a')).studentId).toBe('0099999')
    ws.cells(sheet.id)[1][STUDENT_COL] = ''
    await syncNow('sheets', staff)
    expect((await member('id-a')).studentId).toBe('')
    expect(ws.cells(sheet.id)[1][STUDENT_COL]).toBe('')
  })

  it('จับคู่กับคอลัมน์ที่มีอยู่แล้ว: ค่าที่ชีตมีถูกใช้ ค่าที่กรอกในเว็บเติมลงช่องว่าง และไม่เขียนทับสูตร', async () => {
    const head = [...HEAD8, 'เลข นศ.', 'อื่น ๆ']
    const sheet = await linkSheet([
      [...row('id-a', 'อารี ทดสอบ').slice(0, 8), '6500001', 'x'],
      [...row('id-b', 'บุญมี ทดสอบ').slice(0, 8), '', 'y'],
      [...row('id-c', 'ชาตรี ทดสอบ').slice(0, 8), '=""', 'z'],
    ], { head, columns: COLUMNS8 })
    await patch('id-b', input(await member('id-b'), { studentId: '6500002' }))
    await patch('id-c', input(await member('id-c'), { studentId: '6500003' }))

    const info = await data(await call('/api/setup/student-id-column', { as: admin }))
    expect(info.headers).toEqual(['เลข นศ.', 'อื่น ๆ'])
    expect((await call('/api/setup/student-id-column', { method: 'POST', as: admin, body: { header: 'ชื่อ' } })).status).toBe(422)
    expect((await call('/api/setup/student-id-column', { method: 'POST', as: admin, body: { header: 'ไม่มีคอลัมน์นี้' } })).status).toBe(422)
    const mapped = await call('/api/setup/student-id-column', { method: 'POST', as: admin, body: { header: 'เลข นศ.' } })
    expect(mapped.status).toBe(200)
    expect((await member('id-a')).studentId).toBe('6500001')
    expect(ws.cells(sheet.id)[2][STUDENT_COL]).toBe('6500002')
    expect((await member('id-b')).studentId).toBe('6500002')
    // ช่องที่เป็นสูตรไม่ถูกเขียนทับ และค่าในเว็บของสมาชิกคนนั้นยังอยู่
    expect(ws.cells(sheet.id)[3][STUDENT_COL]).toBe('=""')
    expect((await member('id-c')).studentId).toBe('6500003')
    // คอลัมน์อื่นไม่ถูกแตะ
    expect(ws.cells(sheet.id).map((r) => r[9])).toEqual(['อื่น ๆ', 'x', 'y', 'z'])
  })

  it('ชีตอ่านอย่างเดียว: เพิ่มคอลัมน์ไม่ได้ และรหัสที่กรอกในเว็บไม่ถูกล้างแม้ช่องในชีตว่าง', async () => {
    const head = [...HEAD8, 'รหัสนักศึกษา']
    const sheet = await linkSheet([[...row('id-a', 'อารี ทดสอบ').slice(0, 8), '']], { head: HEAD8.concat(['คอลัมน์อื่น']), columns: COLUMNS8, canEdit: false })
    void head
    await env.DB.prepare(`UPDATE members SET student_id = '6512345', student_id_origin = 'web' WHERE id = 'id-a'`).run()
    const added = await call('/api/setup/student-id-column', { method: 'POST', as: admin, body: { add: true } })
    expect(added.status).toBe(403)
    expect(ws.cells(sheet.id)[0]).toHaveLength(9)
    const mapped = await call('/api/setup/student-id-column', { method: 'POST', as: admin, body: { header: 'คอลัมน์อื่น' } })
    expect(mapped.status).toBe(200)
    expect((await member('id-a')).studentId).toBe('6512345')
    expect(ws.cells(sheet.id)[1][STUDENT_COL] ?? '').toBe('')
    expect((await issues()).map((i) => i.code)).toEqual(['student_id_not_in_sheet'])
  })
})
