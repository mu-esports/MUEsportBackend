import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, resetDb, seedUser } from './helpers'
import type { Actor } from './helpers'
import { connectClub, FakeWorkspace, googleCalls, loseResponseOnce, syncNow } from './workspace'
import type { FakeSheet } from './workspace'

// ทุกกรณีในไฟล์นี้ใช้ Google Sheets จำลอง (test/workspace.ts) ไม่ได้ต่อกับ Google จริง
const HEAD = ['รหัสสมาชิก (ระบบใช้จับคู่ ห้ามแก้)', 'ชื่อ', 'ชื่อเล่น', 'บทบาท', 'สถานะ', 'ช่องทางติดต่อ', 'หมายเหตุ', 'วันที่เพิ่ม']
const COLUMNS = { id: HEAD[0], name: 'ชื่อ', nickname: 'ชื่อเล่น', role: 'บทบาท', status: 'สถานะ', contact: 'ช่องทางติดต่อ', note: 'หมายเหตุ', addedAt: 'วันที่เพิ่ม' }
const ROW_A = ['id-a', 'อารี ทดสอบ', 'อา', 'สมาชิก', 'ใช้งาน', 'discord: aree', '', '2026-09-01']
const ROW_B = ['id-b', 'บุญมี ทดสอบ', 'บี', 'ทีมงาน', 'พักการใช้งาน', '', 'หมายเหตุเดิม', '2026-09-02']
const ROW_C = ['id-c', 'ชาตรี ทดสอบ', 'ซี', 'ผู้ดูแล', 'ใช้งาน', '', '', '2026-09-03']

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

async function linkSheet(rows: string[][], options: { head?: string[]; columns?: Record<string, string>; canEdit?: boolean; extra?: Record<string, unknown> } = {}): Promise<FakeSheet> {
  const sheet = ws.addSheet('ทะเบียนสมาชิก', [options.head ?? HEAD, ...rows], { canEdit: options.canEdit })
  const res = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, headerRow: 1, columns: options.columns ?? COLUMNS, ...options.extra } })
  expect(res.status, JSON.stringify(await res.clone().json())).toBe(201)
  // ชีตเก่านี้ไม่มีคอลัมน์รหัสนักศึกษา: ทะเบียนทดสอบมีรหัสที่กรอกไว้ในเว็บแล้ว เพื่อให้แก้ข้อมูลผ่านฟอร์มได้
  const legacy = await env.DB.prepare("SELECT id FROM members WHERE student_id = '' ORDER BY id").all<{ id: string }>()
  for (const [i, row] of legacy.results.entries()) {
    await env.DB.prepare("UPDATE members SET student_id = ?, student_id_origin = 'web' WHERE id = ?").bind(`65410${String(i).padStart(2, '0')}`, row.id).run()
  }
  return sheet
}
const members = async () => (await data(await call('/api/members', { as: staff }))).members as Record<string, any>[]
const member = async (id: string) => (await members()).find((m) => m.id === id)!
const input = (m: Record<string, any>, changes: Record<string, unknown> = {}) => ({
  name: m.name, nickname: m.nickname, studentId: m.studentId, role: m.role, status: m.status, contact: m.contact, note: m.note, expectedVersion: m.version, ...changes,
})
const patch = (id: string, body: unknown) => call(`/api/members/${id}`, { method: 'PATCH', as: staff, body })
const status = async () => (await data(await call('/api/sync', { as: staff }))).sync.find((s: any) => s.kind === 'sheets')

describe('Google Sheets → เว็บ', () => {
  it('เชื่อมชีตแล้วสมาชิกในเว็บมาจากชีต และข้อมูลที่แก้ใน Google ขึ้นเว็บหลังซิงค์', async () => {
    const sheet = await linkSheet([ROW_A, ROW_B])
    let list = await members()
    expect(list.map((m) => [m.id, m.name, m.role, m.status, m.source])).toEqual([
      ['id-b', 'บุญมี ทดสอบ', 'staff', 'suspended', 'sheets'],
      ['id-a', 'อารี ทดสอบ', 'member', 'active', 'sheets'],
    ])
    const before = await member('id-a')

    // แก้ชื่อเล่นและเพิ่มแถวใหม่ที่ฝั่ง Google
    ws.cells(sheet.id)[1][2] = 'อารีย์'
    ws.cells(sheet.id).push(ROW_C)
    const result = await syncNow('sheets', staff)
    expect(result).toMatchObject({ ran: true, status: { error: null, linked: true } })
    expect(result.status.lastSuccessAt).not.toBeNull()

    list = await members()
    expect(list).toHaveLength(3)
    const after = await member('id-a')
    expect(after.nickname).toBe('อารีย์')
    expect(after.version).toBe(before.version + 1)
    // แถวที่ไม่ได้แก้ รุ่นไม่เปลี่ยน
    expect((await member('id-b')).version).toBe(1)
  })

  it('เรียงแถวใหม่ที่ Google: จับคู่ด้วยรหัส ไม่ใช่ลำดับแถว ข้อมูลไม่สลับคน และการแก้จากเว็บลงแถวที่ถูก', async () => {
    const sheet = await linkSheet([ROW_A, ROW_B, ROW_C])
    const cells = ws.cells(sheet.id)
    cells.splice(1, 3, cells[3], cells[1], cells[2]) // เรียงเป็น C, A, B
    await syncNow('sheets', staff)
    const list = await members()
    expect(list.find((m) => m.id === 'id-a')).toMatchObject({ name: 'อารี ทดสอบ', nickname: 'อา', version: 1 })
    expect(list.find((m) => m.id === 'id-c')).toMatchObject({ name: 'ชาตรี ทดสอบ', role: 'admin', version: 1 })

    const a = await member('id-a')
    expect((await patch('id-a', input(a, { contact: 'line: aree' }))).status).toBe(200)
    expect(ws.cells(sheet.id)[2]).toEqual(['id-a', 'อารี ทดสอบ', 'อา', 'สมาชิก', 'ใช้งาน', 'line: aree', '', '2026-09-01'])
    expect(ws.cells(sheet.id)[1]).toEqual(ROW_C)
  })

  it('แถวใหม่ที่พิมพ์ใน Google โดยไม่มีรหัส: ระบบออกรหัสลงเฉพาะเซลล์รหัส (และวันที่เพิ่มที่ว่าง) แล้วสมาชิกขึ้นเว็บ', async () => {
    const sheet = await linkSheet([ROW_A])
    ws.cells(sheet.id).push(['', 'ดารา ใหม่', 'ดา', '', '', 'โทร 0812345678', '', ''])
    const result = await syncNow('sheets', staff)
    expect(result.status.error).toBeNull()
    const row = ws.cells(sheet.id)[2]
    expect(row[0]).toMatch(/^[0-9a-f-]{36}$/)
    expect(row.slice(1, 7)).toEqual(['ดารา ใหม่', 'ดา', '', '', 'โทร 0812345678', ''])
    expect(row[7]).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    expect(await member(row[0])).toMatchObject({ name: 'ดารา ใหม่', role: 'member', status: 'active', contact: 'โทร 0812345678', source: 'sheets' })
  })

  it('รหัสซ้ำและแถวผิดรูปแบบ: แสดงรายการที่ต้องแก้ ไม่จับคู่ผิด ไม่ทิ้งรายการเดิม และแถวอื่นยังอัปเดต', async () => {
    const sheet = await linkSheet([ROW_A, ROW_B])
    const cells = ws.cells(sheet.id)
    cells.push(['id-a', 'คนละคน รหัสซ้ำ', 'ซ้ำ', 'สมาชิก', 'ใช้งาน', '', '', '2026-09-05'])
    cells[2][3] = 'หัวหน้าเผ่า' // บทบาทที่ไม่รองรับ
    cells.push(ROW_C)
    const result = await syncNow('sheets', staff)
    const issues = result.status.issues as { code: string; where: string; message: string }[]
    expect(issues.map((i) => i.code).sort()).toEqual(['duplicate_id', 'invalid_row'])
    expect(issues.find((i) => i.code === 'duplicate_id')!.where).toBe('แถว 2 และ 4')
    expect(issues.find((i) => i.code === 'invalid_row')).toMatchObject({ where: 'แถว 3' })
    // รายการที่ต้องแก้ไม่มีข้อมูลติดต่อของสมาชิก
    expect(JSON.stringify(issues)).not.toContain('discord')

    const list = await members()
    expect(list).toHaveLength(3)
    expect(list.find((m) => m.id === 'id-a')).toMatchObject({ name: 'อารี ทดสอบ', sourceState: 'ok', version: 1 })
    expect(list.find((m) => m.id === 'id-b')).toMatchObject({ role: 'staff', sourceState: 'ok', version: 1 })
    expect(list.find((m) => m.id === 'id-c')).toMatchObject({ name: 'ชาตรี ทดสอบ' })
  })

  it('แถวหายจากชีต: สมาชิกถูกทำเครื่องหมายว่าไม่พบต้นฉบับ ไม่ถูกลบ มีบันทึก และแก้จากเว็บไม่ได้จนกว่าจะกลับมา', async () => {
    const sheet = await linkSheet([ROW_A, ROW_B])
    ws.cells(sheet.id).splice(2, 1)
    await syncNow('sheets', staff)
    const b = await member('id-b')
    expect(b).toMatchObject({ name: 'บุญมี ทดสอบ', sourceState: 'missing', source: 'sheets' })
    const log = await env.DB.prepare(`SELECT target FROM audit_log WHERE action = 'member.source_missing'`).first<{ target: string }>()
    expect(log?.target).toBe('id-b')

    const res = await patch('id-b', input(b, { note: 'แก้' }))
    expect(res.status).toBe(409)
    expect((await data(res)).error).toBe('source_missing')

    // แถวกลับมา (เช่น กู้จากประวัติเวอร์ชัน): กลับเป็นปกติ
    ws.cells(sheet.id).push(ROW_B)
    await syncNow('sheets', staff)
    expect(await member('id-b')).toMatchObject({ sourceState: 'ok' })
  })

  it('หัวคอลัมน์ที่จับคู่ไว้หาย (schema เปลี่ยน): ซิงค์หยุดพร้อมเหตุผล เว็บยังแสดงข้อมูลสำเร็จครั้งก่อน ไม่กลายเป็นรายการว่าง', async () => {
    const sheet = await linkSheet([ROW_A, ROW_B])
    const okAt = (await status()).lastSuccessAt
    ws.cells(sheet.id)[0][1] = 'Full name'
    const failed = await syncNow('sheets', staff)
    expect(failed.status.error).toMatchObject({ code: 'malformed' })
    expect(failed.status.error.message).toContain('ไม่พบคอลัมน์ “ชื่อ”')
    expect(failed.status.lastSuccessAt).toBe(okAt)
    expect(await members()).toHaveLength(2)
    expect((await member('id-a')).sourceState).toBe('ok')

    // ชีตว่างทั้งแผ่นก็ไม่ทำให้สมาชิกหาย
    const saved = ws.cells(sheet.id).splice(0)
    expect((await syncNow('sheets', staff)).status.error).toMatchObject({ code: 'malformed' })
    expect(await members()).toHaveLength(2)

    ws.cells(sheet.id).push(...saved)
    ws.cells(sheet.id)[0][1] = 'ชื่อ'
    expect((await syncNow('sheets', staff)).status.error).toBeNull()
  })

  it('Google จำกัดคำขอ (429): เก็บข้อมูลเดิม บอกสถานะ และเว้นระยะก่อนลองใหม่แม้ผู้ใช้กดปุ่ม', async () => {
    await linkSheet([ROW_A])
    google.failOnce((url) => url.pathname.endsWith('values:batchGetByDataFilter'), 429, { error: { code: 429, status: 'RESOURCE_EXHAUSTED' } })
    const failed = await syncNow('sheets', staff)
    expect(failed.status.error).toMatchObject({ code: 'rate_limited' })
    expect(Date.parse(failed.status.retryAt)).toBeGreaterThan(Date.now() + 30_000)
    expect(await members()).toHaveLength(1)

    const reads = googleCalls(google, 'batchGetByDataFilter')
    await env.DB.prepare(`UPDATE sync_state SET last_attempt_at = NULL WHERE kind = 'sheets'`).run()
    const again = await data(await call('/api/sync/sheets', { method: 'POST', as: staff, body: { force: true } }))
    expect(again).toMatchObject({ ran: false, skipped: 'backoff' })
    expect(googleCalls(google, 'batchGetByDataFilter')).toBe(reads)
  })

  it('หลายแท็บ/หลายอุปกรณ์เรียกพร้อมกัน: ภายในช่วงขั้นต่ำมีการอ่าน Google เพียงรอบเดียว', async () => {
    await linkSheet([ROW_A])
    await env.DB.prepare(`UPDATE sync_state SET last_attempt_at = NULL WHERE kind = 'sheets'`).run()
    const before = googleCalls(google, 'batchGetByDataFilter')
    const results = await Promise.all([1, 2, 3, 4].map(() => call('/api/sync/sheets', { method: 'POST', as: staff }).then((r) => data(r))))
    expect(results.filter((r) => r.ran)).toHaveLength(1)
    const later = await data(await call('/api/sync/sheets', { method: 'POST', as: admin }))
    expect(later).toMatchObject({ ran: false, skipped: 'recent' })
    expect(googleCalls(google, 'batchGetByDataFilter')).toBe(before + 1)
  })

  it('บทบาทในชีตเป็นข้อมูลของสมาชิกเท่านั้น ไม่สร้างหรือยกระดับสิทธิ์เข้าหลังบ้าน', async () => {
    const users = async () => (await env.DB.prepare('SELECT email, role FROM users ORDER BY email').all()).results
    const before = await users()
    await linkSheet([['id-x', 'staff@example.com', 'ผู้ดูแล', 'ผู้ดูแล', 'ใช้งาน', 'staff@example.com', '', '2026-09-01']])
    expect((await member('id-x')).role).toBe('admin')
    expect(await users()).toEqual(before)
    expect((await call('/api/users', { as: staff })).status).toBe(403)
  })
})

describe('เว็บ → Google Sheets', () => {
  it('แก้จากเว็บ: เขียนเฉพาะเซลล์ที่เปลี่ยน ไม่แตะคอลัมน์อื่นหรือแถวอื่น และยืนยันจากการอ่านกลับ', async () => {
    const head = ['คะแนน (ทีมงานกรอกเอง)', ...HEAD, 'สูตรรวม']
    const sheet = await linkSheet([
      ['10', ...ROW_A, '=SUM(A2)'],
      ['20', ...ROW_B, '=SUM(A3)'],
    ], { head })
    const b = await member('id-b')
    const writes = () => google.calls.filter((c) => c.url.endsWith('values:batchUpdateByDataFilter')).length
    const res = await patch('id-b', input(b, { nickname: 'บีบี', status: 'active' }))
    expect(res.status).toBe(200)
    expect((await data(res)).member).toMatchObject({ nickname: 'บีบี', status: 'active', version: b.version + 1, source: 'sheets' })
    expect(writes()).toBe(1)
    expect(ws.cells(sheet.id)[2]).toEqual(['20', 'id-b', 'บุญมี ทดสอบ', 'บีบี', 'ทีมงาน', 'ใช้งาน', '', 'หมายเหตุเดิม', '2026-09-02', '=SUM(A3)'])
    expect(ws.cells(sheet.id)[1]).toEqual(['10', ...ROW_A, '=SUM(A2)'])
    expect(ws.cells(sheet.id)[0]).toEqual(head)

    // พัก/คืนสถานะเขียนเฉพาะเซลล์สถานะ
    const again = await member('id-b')
    const suspend = await call('/api/members/id-b/status', { method: 'POST', as: staff, body: { status: 'suspended', expectedVersion: again.version } })
    expect(suspend.status).toBe(200)
    expect(ws.cells(sheet.id)[2][5]).toBe('พักการใช้งาน')
  })

  it('เพิ่มสมาชิกจากเว็บ: ต่อแถวใหม่พร้อมรหัส และคำขอเดิมที่ลองใหม่หลังคำตอบของ Google หายไม่สร้างแถวซ้ำ', async () => {
    const sheet = await linkSheet([ROW_A])
    const body = { name: 'เอกชัย ใหม่', nickname: 'เอก', studentId: '6543212', role: 'member', status: 'active', contact: '0812345678', note: '' }
    const idem = key()
    loseResponseOnce(google, ws, (url) => url.pathname.endsWith(':batchUpdate'))
    const first = await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': idem }, body })
    expect(first.status).toBe(502)
    expect((await data(first)).error).toBe('save_outcome_unknown')

    const retry = await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': idem }, body })
    expect(retry.status).toBeLessThan(300)
    const created = (await data(retry)).member
    expect(created).toMatchObject({ ...body, source: 'sheets' })
    const rows = ws.cells(sheet.id).filter((r) => r[1] === 'เอกชัย ใหม่')
    expect(rows).toHaveLength(1)
    // เบอร์โทรถูกเก็บเป็นข้อความตรงตัว (เลขศูนย์นำหน้าไม่หาย)
    expect(rows[0]).toEqual([created.id, 'เอกชัย ใหม่', 'เอก', 'สมาชิก', 'ใช้งาน', '0812345678', '', created.addedAt])
    expect(await members()).toHaveLength(2)
  })

  it('conflict: แถวถูกแก้ใน Google หลังผู้ใช้เปิดฟอร์ม → ไม่เขียนทับ และได้ค่าล่าสุดจาก Google กลับไปให้ตรวจ', async () => {
    const sheet = await linkSheet([ROW_A])
    const opened = await member('id-a')
    ws.cells(sheet.id)[1][6] = 'แก้ที่ Google'
    const res = await patch('id-a', input(opened, { note: 'แก้ที่เว็บ' }))
    expect(res.status).toBe(409)
    const body = await data(res)
    expect(body.error).toBe('version_conflict')
    expect(body.current).toMatchObject({ note: 'แก้ที่ Google', version: opened.version + 1 })
    expect(ws.cells(sheet.id)[1][6]).toBe('แก้ที่ Google')
    expect(google.calls.some((c) => c.url.endsWith('values:batchUpdateByDataFilter'))).toBe(false)
  })

  it('ไม่เขียนทับสูตร: ช่องที่เป็นสูตรในชีตแก้จากเว็บไม่ได้ และสูตรยังอยู่', async () => {
    const sheet = await linkSheet([['id-f', 'ฟ้า สูตร', 'ฟ้า', 'สมาชิก', '=IF(TRUE,"ใช้งาน","")', '', '', '2026-09-01']])
    // ค่าที่แสดงของสูตรไม่ใช่สถานะที่รองรับ จึงถูกรายงานเป็นแถวที่ต้องแก้ และแก้จากเว็บไม่ได้
    ws.cells(sheet.id)[1][4] = 'ใช้งาน'
    await syncNow('sheets', staff)
    await env.DB.prepare("UPDATE members SET student_id = '6543213', student_id_origin = 'web' WHERE id = 'id-f'").run()
    ws.cells(sheet.id)[1][5] = '=A2'
    const m = await member('id-f')
    const res = await patch('id-f', input(m, { contact: 'ใหม่' }))
    expect(res.status).toBe(409)
    expect(await data(res)).toMatchObject({ error: 'version_conflict' })
    const latest = await member('id-f')
    const second = await patch('id-f', input(latest, { contact: 'ใหม่' }))
    expect(second.status).toBe(409)
    expect(await data(second)).toMatchObject({ error: 'cell_is_formula', field: 'contact' })
    expect(ws.cells(sheet.id)[1][5]).toBe('=A2')
  })

  it('race ที่เหลือของ Sheets (ไม่มี compare-and-swap ระดับแถว): แถวถูกย้ายก่อนเขียน → ตรวจพบและไม่เขียน; ถูกย้ายในช่วงสั้นก่อนคำสั่งเขียนถึง → ตรวจพบหลังเขียนและแจ้งแถวที่กระทบ', async () => {
    const sheet = await linkSheet([ROW_A, ROW_B])
    const swap = () => {
      const cells = ws.cells(sheet.id)
      ;[cells[1], cells[2]] = [cells[2], cells[1]]
    }
    // (1) ย้ายก่อนการอ่านยืนยันแถว: ระบบเห็นว่ารหัสในแถวไม่ตรง จึงไม่เขียน
    let done = false
    google.interceptors.push((url, init) => {
      if (!done && url.pathname.endsWith('values:batchGetByDataFilter') && String(init?.body).includes('"FORMULA"')) {
        done = true
        swap()
      }
      return undefined
    })
    const a = await member('id-a')
    const moved = await patch('id-a', input(a, { note: 'x' }))
    expect(await data(moved)).toMatchObject({ error: 'source_moved' })
    expect(ws.cells(sheet.id).map((r) => r[6])).toEqual(['หมายเหตุ', 'หมายเหตุเดิม', ''])

    // (2) ย้ายหลังอ่านยืนยันแต่ก่อนคำสั่งเขียนไปถึง: ค่าลงผิดแถว ระบบอ่านกลับแล้วรายงานตามจริง ไม่บอกว่าบันทึกสำเร็จ
    let late = false
    google.interceptors.push((url) => {
      if (!late && url.pathname.endsWith('values:batchUpdateByDataFilter')) {
        late = true
        swap()
      }
      return undefined
    })
    const a2 = await member('id-a')
    const misplaced = await patch('id-a', input(a2, { note: 'ลงผิดแถว' }))
    expect(misplaced.status).toBe(502)
    const body = await data(misplaced)
    expect(body.error).toBe('write_misplaced')
    expect(body.message).toContain('แถว 3')
    // สำเนาในเว็บสะท้อนสิ่งที่อยู่ในชีตจริงหลังเหตุการณ์ (ไม่ซ่อนความเสียหาย)
    expect((await member('id-b')).note).toBe('ลงผิดแถว')
    expect((await member('id-a')).note).toBe('')
  })

  it('ชีตที่บัญชีชมรมอ่านได้อย่างเดียว: แสดงสิทธิ์ตามจริง และ server ปฏิเสธการแก้และการเพิ่ม', async () => {
    const sheet = await linkSheet([ROW_A], { canEdit: false })
    expect((await status()).resource).toMatchObject({ access: 'read', origin: 'selected' })
    const a = await member('id-a')
    const res = await patch('id-a', input(a, { note: 'x' }))
    expect(res.status).toBe(403)
    expect((await data(res)).error).toBe('source_read_only')
    const add = await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: input(a, { studentId: '6543214' }) })
    expect(add.status).toBe(403)
    expect(ws.cells(sheet.id)).toHaveLength(2)
  })
})

describe('ตั้งค่าชีตและข้อมูลเดิม', () => {
  const MEMBER = { name: 'เดิม ในเว็บ', nickname: 'เดิม', role: 'staff', status: 'active', contact: 'c', note: 'n' }
  const addLocal = async (body = MEMBER) => {
    const count = await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>()
    return (await data(await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { ...body, studentId: `65420${String(count!.n).padStart(2, '0')}` } }))).member
  }

  it('preview ก่อนเชื่อม: หัวคอลัมน์ การจับคู่ที่เสนอ จำนวนแถว รายการซ้ำ และสมาชิกในเว็บที่ยังไม่อยู่ในชีต โดยไม่เขียนอะไร', async () => {
    const local = await addLocal()
    const sheet = ws.addSheet('ชีตเดิม', [['ลำดับ', 'ชื่อ-นามสกุล', 'Nickname', 'ตำแหน่ง', 'ID'], ['1', 'อารี', 'อา', 'สมาชิก', local.id], ['2', 'บี', 'บี', 'ทีมงาน', 'x1'], ['3', 'ซี', 'ซี', 'สมาชิก', 'x1'], ['4', '', 'ดี', '', '']])
    const snapshot = JSON.stringify(ws.cells(sheet.id))
    const res = await call('/api/setup/preview', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id } })
    expect(res.status).toBe(200)
    const preview = await data(res)
    expect(preview.headers).toEqual(['ลำดับ', 'ชื่อ-นามสกุล', 'Nickname', 'ตำแหน่ง', 'ID'])
    expect(preview.columns).toEqual({ id: 'ID', name: 'ชื่อ-นามสกุล', nickname: 'Nickname', role: 'ตำแหน่ง' })
    expect(preview.stats).toMatchObject({ rows: 4, withId: 3, withoutId: 1, invalid: 1, duplicateIds: 1, matchedLocal: 1, localOnly: 0 })
    expect(JSON.stringify(ws.cells(sheet.id))).toBe(snapshot)
    expect((await status()).linked).toBe(false)
    // ทีมงานทั่วไปตั้งค่าไม่ได้
    expect((await call('/api/setup/preview', { method: 'POST', as: staff, body: { kind: 'sheets', resourceId: sheet.id } })).status).toBe(403)
  })

  it('ชีตเดิมที่ไม่มีคอลัมน์รหัส: ต้องยืนยันก่อน ระบบจึงเพิ่มคอลัมน์รหัสต่อท้ายโดยไม่แตะคอลัมน์เดิม', async () => {
    const sheet = ws.addSheet('ชีตเดิม', [['ชื่อ', 'เล่น'], ['อารี', 'อา'], ['บี', 'บี']])
    const body = { kind: 'sheets', resourceId: sheet.id, sheetId: 0, headerRow: 1, columns: { name: 'ชื่อ', nickname: 'เล่น' } }
    const refused = await call('/api/setup/link', { method: 'POST', as: admin, body })
    expect(refused.status).toBe(422)
    expect(ws.cells(sheet.id)[0]).toEqual(['ชื่อ', 'เล่น'])

    const linked = await call('/api/setup/link', { method: 'POST', as: admin, body: { ...body, addIdColumn: true } })
    expect(linked.status).toBe(201)
    const cells = ws.cells(sheet.id)
    expect(cells[0]).toEqual(['ชื่อ', 'เล่น', HEAD[0]])
    expect(cells[1].slice(0, 2)).toEqual(['อารี', 'อา'])
    expect(cells[1][2]).toMatch(/^[0-9a-f-]{36}$/)
    expect((await members()).map((m) => m.name).sort()).toEqual(['บี', 'อารี'])
  })

  it('ย้ายสมาชิกเดิมในเว็บขึ้นชีต: อยู่ครบ รหัสเดิม ทำซ้ำไม่เกิดแถวซ้ำ และยกเลิกการเชื่อมไม่ลบข้อมูลทั้งสองฝั่ง', async () => {
    const one = await addLocal()
    const two = await addLocal({ ...MEMBER, name: 'สอง ในเว็บ', nickname: 'สอง' })
    const sheet = await linkSheet([ROW_A])
    // ยังไม่ย้าย: สมาชิกเดิมยังอยู่และบอกว่าอยู่เฉพาะในเว็บ
    expect((await members()).map((m) => [m.id, m.source]).sort()).toEqual([[one.id, 'local'], [two.id, 'local'], ['id-a', 'sheets']].sort())

    const push = () => call('/api/sync/sheets/push-local', { method: 'POST', as: admin, body: {} })
    expect((await call('/api/sync/sheets/push-local', { method: 'POST', as: staff, body: {} })).status).toBe(403)
    expect(await data(await push())).toMatchObject({ pushed: 2, remaining: 0 })
    expect(await data(await push())).toMatchObject({ pushed: 0, remaining: 0 })
    const cells = ws.cells(sheet.id)
    expect(cells).toHaveLength(4)
    expect(cells.find((r) => r[0] === one.id)).toEqual([one.id, 'เดิม ในเว็บ', 'เดิม', 'ทีมงาน', 'ใช้งาน', 'c', 'n', one.addedAt])
    const after = await members()
    expect(after.every((m) => m.source === 'sheets')).toBe(true)
    expect(after.find((m) => m.id === one.id)).toMatchObject({ ...MEMBER, version: one.version })

    const unlinked = await call('/api/setup/link/sheets', { method: 'DELETE', as: admin })
    expect(unlinked.status).toBe(200)
    expect(ws.cells(sheet.id)).toHaveLength(4)
    const kept = await members()
    expect(kept).toHaveLength(3)
    expect(kept.every((m) => m.source === 'local')).toBe(true)
    // หลังยกเลิกการเชื่อม แก้ในเว็บได้ตามเดิม และไม่มีการเรียก Google
    const calls = google.calls.length
    expect((await patch(one.id, input(kept.find((m) => m.id === one.id)!, { note: 'local' }))).status).toBe(200)
    expect(google.calls.length).toBe(calls)
  })

  it('ก่อนย้าย: บอกจำนวนและคนที่ชื่อตรงกับแถวที่มีอยู่แล้วในชีต (รหัสไม่ตรง) และย้ายเฉพาะรายการที่ผู้ดูแลไม่ได้ข้าม', async () => {
    const same = await addLocal({ ...MEMBER, name: ' อารี  ทดสอบ', nickname: 'อารี' })
    const other = await addLocal({ ...MEMBER, name: 'ใหม่ จริง', nickname: 'ใหม่' })
    const sheet = await linkSheet([ROW_A])
    expect((await call('/api/sync/sheets/push-local', { as: staff })).status).toBe(403)
    const snapshot = JSON.stringify(ws.cells(sheet.id))
    const preview = await data(await call('/api/sync/sheets/push-local', { as: admin }))
    expect(preview).toEqual({ count: 2, duplicates: [{ id: same.id, title: 'อารี  ทดสอบ', detail: 'อารี' }] })
    // การดูก่อนย้ายไม่เขียนอะไรลงชีต
    expect(JSON.stringify(ws.cells(sheet.id))).toBe(snapshot)

    const pushed = await data(await call('/api/sync/sheets/push-local', { method: 'POST', as: admin, body: { skipIds: [same.id] } }))
    expect(pushed).toMatchObject({ pushed: 1, remaining: 0, skipped: 1 })
    expect(ws.cells(sheet.id).map((r) => r[0])).toEqual([HEAD[0], 'id-a', other.id])
    // รายการที่ข้ามยังอยู่ในเว็บครบ และยังบอกว่าอยู่เฉพาะในเว็บ
    expect(await member(same.id)).toMatchObject({ source: 'local', name: 'อารี  ทดสอบ' })
  })

  it('ไฟล์ที่บัญชีชมรมเปิดไม่ได้ หรือไม่ใช่ชีต: ไม่เชื่อม และบอกเหตุผลตามจริง', async () => {
    const missing = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: 'file-that-was-never-granted', sheetId: 0, columns: COLUMNS } })
    expect(missing.status).toBe(409)
    expect((await data(missing)).error).toBe('file_not_granted')
    const form = ws.addForm('ฟอร์ม')
    const wrong = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: form.formId, sheetId: 0, columns: COLUMNS } })
    expect((await data(wrong)).error).toBe('wrong_file_type')
    expect((await status()).linked).toBe(false)
  })
})
