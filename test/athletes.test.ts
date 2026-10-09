import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, CLUB_EMAIL, data, env, FakeGoogle, MEMBER_PASSWORD, resetDb, seedAccount, seedMember, seedMemberSession, seedUser } from './helpers'
import type { Actor } from './helpers'
import { connectClub, FakeWorkspace, syncNow } from './workspace'

/**
 * โปรไฟล์นักกีฬา: สิทธิ์ (ทีมงานเท่านั้น และไม่ใช่สิทธิ์ของระบบ) การผูกกับคนในทะเบียนโดยไม่สร้างบุคคลซ้ำ การแก้/ถอด และการไม่ถูกซิงค์ชีตล้าง
 * รันกับ Worker และ D1 local ของชุดทดสอบ ส่วนที่เกี่ยวกับชีตใช้ Google Sheets จำลอง (test/workspace.ts)
 */
let admin: Actor
let staff: Actor

beforeEach(async () => {
  await resetDb()
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staff = await seedUser('staff@example.com', 'staff')
})
afterEach(() => vi.unstubAllGlobals())

const INPUT = { game: 'Valorant', team: 'MU Alpha', position: 'Duelist', ign: 'mind#TH1', status: 'active', note: 'ซ้อมวันพุธ' }

const list = async (as: Actor | null = staff) => call('/api/athletes', { as })
const athletes = async () => (await data(await list())).athletes as Record<string, any>[]
const add = (as: Actor | null, memberId: unknown, extra: Record<string, unknown> = {}, options: { raw?: boolean } = {}) =>
  call('/api/athletes', { method: 'POST', as, body: { memberId, ...INPUT, ...extra }, ...options })
const patch = (as: Actor | null, memberId: string, body: Record<string, unknown>) => call(`/api/athletes/${memberId}`, { method: 'PATCH', as, body })
const remove = (as: Actor | null, memberId: string, body: Record<string, unknown>) => call(`/api/athletes/${memberId}/remove`, { method: 'POST', as, body })
const count = async (sql: string, ...values: unknown[]) => (await env.DB.prepare(sql).bind(...values).first<{ n: number }>())!.n
const members = async () => (await data(await call('/api/members', { as: staff }))).members as Record<string, any>[]

describe('สิทธิ์ของหน้านักกีฬา', () => {
  it('ทีมงาน (staff และ admin) จัดการได้ ผู้ไม่เข้าสู่ระบบและสมาชิกเปิดไม่ได้ทุกเส้นทาง และคำสั่งเปลี่ยนข้อมูลต้องมี Origin กับ CSRF', async () => {
    const person = await seedMember({ studentId: '6500001', role: 'admin' })
    await seedAccount(person.id, { loginId: '6500001' })
    const memberSession = await seedMemberSession(person.id)

    for (const [name, actor, status, code] of [['anonymous', null, 401, 'unauthenticated'], ['member', memberSession, 403, 'staff_only']] as const) {
      const responses = [await list(actor), await add(actor, person.id), await patch(actor, person.id, { ...INPUT, expectedVersion: 1 }), await remove(actor, person.id, { expectedVersion: 1 })]
      for (const res of responses) {
        expect(res.status, name).toBe(status)
        expect((await data(res)).error, name).toBe(code)
      }
    }
    expect(await count('SELECT COUNT(*) AS n FROM athletes')).toBe(0)

    // คำขอที่ไม่ได้มาจากหน้าเว็บ
    const noOrigin = await add(staff, person.id, {}, { raw: true })
    expect(noOrigin.status).toBe(403)
    expect((await data(noOrigin)).error).toBe('bad_origin')
    expect((await data(await add({ ...staff, csrf: admin.csrf }, person.id))).error).toBe('bad_csrf')
    expect(await count('SELECT COUNT(*) AS n FROM athletes')).toBe(0)

    // staff ทั่วไปเพิ่มได้ (ไม่ต้องเป็น admin) และ admin แก้/ถอดได้
    expect((await add(staff, person.id)).status).toBe(201)
    expect((await patch(admin, person.id, { ...INPUT, team: 'MU Bravo', expectedVersion: 1 })).status).toBe(200)
    expect((await remove(admin, person.id, { expectedVersion: 2 })).status).toBe(200)
  })

  it('นักกีฬาไม่ใช่สิทธิ์ของระบบ: คนที่เป็นนักกีฬายังเป็นสมาชิกธรรมดา เปิดหลังบ้านไม่ได้ และไม่มีผู้ใช้ทีมงานเพิ่มขึ้น', async () => {
    const person = await seedMember({ studentId: '6500001' })
    await seedAccount(person.id, { loginId: '6500001' })
    const usersBefore = await env.DB.prepare('SELECT id, role, status FROM users ORDER BY id').all()
    expect((await add(staff, person.id)).status).toBe(201)

    // เข้าสู่ระบบด้วยรหัสนักศึกษาหลังเป็นนักกีฬา: session เป็นของสมาชิก ไม่มีบทบาททีมงาน
    const login = await call('/auth/member/login', { method: 'POST', body: { studentId: '6500001', password: MEMBER_PASSWORD } })
    expect(login.status).toBe(200)
    const cookie = login.headers.get('Set-Cookie')!.split(';')[0]
    const session = await data(await call('/api/session', { cookie }))
    expect(session.user).toBeNull()
    expect(session.member).toMatchObject({ id: person.id, studentId: '6500001' })
    expect(JSON.stringify(session.member)).not.toMatch(/role|athlete|admin|staff/i)
    const actor = { id: person.id, cookie, csrf: session.csrfToken as string }
    for (const path of ['/api/athletes', '/api/members', '/api/users', '/api/sources', '/api/sync', '/api/setup']) {
      const res = await call(path, { as: actor })
      expect(res.status, path).toBe(403)
      expect((await data(res)).error, path).toBe('staff_only')
    }
    expect((await data(await add(actor, person.id))).error).toBe('staff_only')
    // ยังใช้หน้าของสมาชิกได้ตามเดิม
    expect((await call('/api/member/me', { as: actor })).status).toBe(200)
    // ไม่มีผู้ใช้ทีมงานถูกสร้างหรือเปลี่ยนบทบาท
    expect((await env.DB.prepare('SELECT id, role, status FROM users ORDER BY id').all()).results).toEqual(usersBefore.results)
    expect((await env.DB.prepare('SELECT DISTINCT role FROM users ORDER BY role').all<{ role: string }>()).results.map((r) => r.role)).toEqual(['admin', 'staff'])
  })
})

describe('เพิ่มนักกีฬาจากคนในทะเบียนสมาชิก', () => {
  it('ผูกกับรหัสสมาชิก: ข้อมูลบุคคลมาจากทะเบียน ไม่มีบุคคล รหัสนักศึกษา หรือบัญชีซ้ำ และทะเบียนยังนับคนเท่าเดิม', async () => {
    const a = await seedMember({ name: 'ณิชา ตัวอย่างสุข', nickname: 'มายด์', studentId: '0065002' })
    const b = await seedMember({ name: 'กฤตเมธ ตัวอย่างเกม', nickname: 'เมธ', studentId: '6500004', status: 'suspended' })
    await seedAccount(a.id, { loginId: '0065002' })
    const before = { members: await count('SELECT COUNT(*) AS n FROM members'), accounts: await count('SELECT COUNT(*) AS n FROM member_accounts') }

    const res = await add(staff, a.id)
    expect(res.status).toBe(201)
    expect((await data(res)).athlete).toMatchObject({
      memberId: a.id, name: 'ณิชา ตัวอย่างสุข', nickname: 'มายด์', studentId: '0065002', memberStatus: 'active', photoVersion: null,
      game: 'Valorant', team: 'MU Alpha', position: 'Duelist', ign: 'mind#TH1', status: 'active', note: 'ซ้อมวันพุธ', version: 1,
    })
    // ช่องที่ไม่บังคับเว้นว่างได้ และคนที่ถูกพักในทะเบียนยังเป็นนักกีฬาได้ (สถานะสองอย่างแยกกัน)
    expect((await add(staff, b.id, { game: '  RoV  ', team: '', position: '', ign: '', status: 'inactive', note: '' })).status).toBe(201)

    const roster = await athletes()
    expect(roster.map((x) => [x.memberId, x.game, x.status, x.memberStatus])).toEqual([[a.id, 'Valorant', 'active', 'active'], [b.id, 'RoV', 'inactive', 'suspended']])
    // ทะเบียนสมาชิกไม่ถูกเพิ่มหรือซ้ำ และสมาชิกแต่ละคนบอกโปรไฟล์นักกีฬาของตัวเอง
    expect(await count('SELECT COUNT(*) AS n FROM members')).toBe(before.members)
    expect(await count('SELECT COUNT(*) AS n FROM member_accounts')).toBe(before.accounts)
    const registry = await members()
    expect(registry).toHaveLength(2)
    expect(registry.find((m) => m.id === a.id)?.athlete).toEqual({ game: 'Valorant', status: 'active' })
    expect(registry.find((m) => m.id === b.id)?.athlete).toEqual({ game: 'RoV', status: 'inactive' })
    // แก้ชื่อในทะเบียนแล้วหน้านักกีฬาเห็นชื่อใหม่ทันที (ไม่มีสำเนาชื่อในตารางนักกีฬา)
    const person = registry.find((m) => m.id === a.id)!
    const renamed = await call(`/api/members/${a.id}`, {
      method: 'PATCH', as: staff,
      body: { name: 'ณิชา ชื่อใหม่', nickname: person.nickname, studentId: person.studentId, role: person.role, status: person.status, contact: person.contact, note: person.note, expectedVersion: person.version },
    })
    expect(renamed.status).toBe(200)
    expect((await athletes()).find((x) => x.memberId === a.id)?.name).toBe('ณิชา ชื่อใหม่')
  })

  it('คนเดิมเพิ่มซ้ำไม่ได้และไม่ถูกเขียนทับ สมาชิกที่ไม่มีในทะเบียนเพิ่มไม่ได้ และไม่จับคู่จากชื่อ', async () => {
    const a = await seedMember({ name: 'ชื่อซ้ำ ทดสอบ', studentId: '6500001' })
    await seedMember({ name: 'ชื่อซ้ำ ทดสอบ', studentId: '6500002' })
    expect((await add(staff, a.id)).status).toBe(201)

    const again = await add(staff, a.id, { game: 'RoV', team: 'อื่น' })
    expect(again.status).toBe(409)
    const body = await data(again)
    expect(body).toMatchObject({ error: 'already_athlete', field: 'memberId', current: { memberId: a.id, game: 'Valorant', team: 'MU Alpha', version: 1 } })
    expect(await athletes()).toHaveLength(1)

    const missing = await add(staff, 'no-such-member')
    expect(missing.status).toBe(404)
    expect(await data(missing)).toMatchObject({ error: 'member_not_found', field: 'memberId' })
    // ส่งชื่อมาแทนรหัสสมาชิก: ไม่ผูกให้เอง
    expect((await add(staff, 'ชื่อซ้ำ ทดสอบ')).status).toBe(404)
    for (const bad of [undefined, null, '', 12, 'x'.repeat(65)]) {
      const res = await add(staff, bad)
      expect(res.status, String(bad)).toBe(422)
      expect((await data(res)).field).toBe('memberId')
    }
    expect(await athletes()).toHaveLength(1)
  })

  it('ตรวจข้อมูลที่กรอก: ต้องมีเกมและสถานะที่รู้จัก ข้อความยาวเกินถูกปฏิเสธพร้อมบอกช่อง', async () => {
    const a = await seedMember({ studentId: '6500001' })
    const cases: [Record<string, unknown>, string][] = [
      [{ game: '' }, 'game'], [{ game: '   ' }, 'game'], [{ game: 7 }, 'game'], [{ game: 'x'.repeat(61) }, 'game'],
      [{ status: 'retired' }, 'status'], [{ status: undefined }, 'status'],
      [{ team: 'x'.repeat(61) }, 'team'], [{ position: 'x'.repeat(61) }, 'position'], [{ ign: 'x'.repeat(61) }, 'ign'], [{ note: 'x'.repeat(2001) }, 'note'], [{ note: 5 }, 'note'],
    ]
    for (const [extra, field] of cases) {
      const res = await add(staff, a.id, extra)
      expect(res.status, JSON.stringify(extra).slice(0, 40)).toBe(422)
      expect((await data(res)).field).toBe(field)
    }
    expect(await count('SELECT COUNT(*) AS n FROM athletes')).toBe(0)
    // ไม่รับค่าอื่นจากเบราว์เซอร์มาเปลี่ยนบุคคลหรือสิทธิ์
    const ok = await add(staff, a.id, { name: 'ชื่อปลอม', role: 'admin', studentId: '9999999', version: 50 })
    expect(ok.status).toBe(201)
    const row = await env.DB.prepare('SELECT name, role, student_id FROM members WHERE id = ?').bind(a.id).first()
    expect(row).toEqual({ name: 'สมหญิง ทดสอบ', role: 'member', student_id: '6500001' })
    expect((await data(ok)).athlete.version).toBe(1)
  })
})

describe('แก้ไขและถอดโปรไฟล์นักกีฬา', () => {
  it('แก้ไขต้องอ้างรุ่นที่เห็น: รุ่นเก่าถูกปฏิเสธพร้อมค่าล่าสุด และไม่ทับการแก้ของคนอื่น', async () => {
    const a = await seedMember({ studentId: '6500001' })
    await add(staff, a.id)
    const first = await patch(staff, a.id, { ...INPUT, team: 'MU Bravo', status: 'inactive', expectedVersion: 1 })
    expect(first.status).toBe(200)
    expect((await data(first)).athlete).toMatchObject({ team: 'MU Bravo', status: 'inactive', version: 2 })

    const stale = await patch(admin, a.id, { ...INPUT, team: 'ทับของเก่า', expectedVersion: 1 })
    expect(stale.status).toBe(409)
    expect(await data(stale)).toMatchObject({ error: 'version_conflict', current: { team: 'MU Bravo', version: 2 } })
    expect((await athletes())[0]).toMatchObject({ team: 'MU Bravo', version: 2 })

    expect((await patch(staff, a.id, { ...INPUT })).status).toBe(422)
    expect((await patch(staff, 'no-such-member', { ...INPUT, expectedVersion: 1 })).status).toBe(404)
    expect((await patch(staff, a.id, { ...INPUT, game: '', expectedVersion: 2 })).status).toBe(422)
  })

  it('ถอดโปรไฟล์นักกีฬา: ทะเบียน บัญชีเข้าสู่ระบบ session และรูปของคนนั้นยังอยู่ และเพิ่มกลับเป็นนักกีฬาได้', async () => {
    const a = await seedMember({ studentId: '6500001' })
    await seedAccount(a.id, { loginId: '6500001' })
    const session = await seedMemberSession(a.id)
    await env.DB.prepare(`INSERT INTO member_photos (member_id, content_type, bytes, size, width, height, version, updated_by, updated_at) VALUES (?, 'image/png', ?, 4, 8, 8, 'v-test', 'seed', ?)`)
      .bind(a.id, new Uint8Array([1, 2, 3, 4]), new Date().toISOString()).run()
    await add(staff, a.id)
    const accountBefore = await env.DB.prepare('SELECT * FROM member_accounts WHERE member_id = ?').bind(a.id).first()

    // รุ่นไม่ตรง: ไม่ถอด
    const stale = await remove(staff, a.id, { expectedVersion: 9 })
    expect(stale.status).toBe(409)
    expect((await data(stale)).error).toBe('version_conflict')
    expect(await athletes()).toHaveLength(1)
    expect((await remove(staff, a.id, {})).status).toBe(422)

    const res = await remove(staff, a.id, { expectedVersion: 1 })
    expect(res.status).toBe(200)
    expect(await data(res)).toEqual({ removed: true })
    expect(await athletes()).toHaveLength(0)
    // เรียกซ้ำ: ไม่มีอะไรให้ถอดแล้ว ตอบสำเร็จโดยไม่ทำอะไรเพิ่ม
    expect(await data(await remove(staff, a.id, { expectedVersion: 1 }))).toEqual({ removed: false })

    expect(await count('SELECT COUNT(*) AS n FROM members WHERE id = ?', a.id)).toBe(1)
    expect(await env.DB.prepare('SELECT * FROM member_accounts WHERE member_id = ?').bind(a.id).first()).toEqual(accountBefore)
    expect(await count('SELECT COUNT(*) AS n FROM member_photos WHERE member_id = ?', a.id)).toBe(1)
    expect((await call('/api/member/me', { as: session })).status).toBe(200)
    expect((await call('/auth/member/login', { method: 'POST', body: { studentId: '6500001', password: MEMBER_PASSWORD } })).status).toBe(200)
    const person = (await members()).find((m) => m.id === a.id)!
    expect(person).toMatchObject({ athlete: null, photoVersion: 'v-test', account: { state: 'active' } })
    // เพิ่มกลับได้ เป็นโปรไฟล์ใหม่ รุ่นเริ่มที่ 1
    const back = await add(admin, a.id, { game: 'RoV' })
    expect(back.status).toBe(201)
    expect((await data(back)).athlete).toMatchObject({ game: 'RoV', version: 1 })
    const actions = (await env.DB.prepare(`SELECT action FROM audit_log WHERE action LIKE 'athlete.%' ORDER BY id`).all<{ action: string }>()).results.map((r) => r.action)
    expect(actions).toEqual(['athlete.added', 'athlete.removed', 'athlete.added'])
  })

  it('การรีเซ็ตรหัสผ่าน ปิดบัญชี และพักสมาชิก ไม่ลบหรือเปลี่ยนโปรไฟล์นักกีฬา', async () => {
    const a = await seedMember({ studentId: '6500001' })
    await seedAccount(a.id, { loginId: '6500001' })
    await add(staff, a.id)
    const before = (await athletes())[0]
    expect((await call(`/api/members/${a.id}/account/password`, { method: 'POST', as: admin, body: { studentId: '6500001', password: 'Temp-Pass-7391' } })).status).toBe(200)
    expect((await call(`/api/members/${a.id}/account/disable`, { method: 'POST', as: admin, body: {} })).status).toBe(200)
    const person = (await members()).find((m) => m.id === a.id)!
    expect((await call(`/api/members/${a.id}/status`, { method: 'POST', as: staff, body: { status: 'suspended', expectedVersion: person.version } })).status).toBe(200)
    const after = (await athletes())[0]
    expect(after).toEqual({ ...before, memberStatus: 'suspended' })
  })
})

describe('ซิงค์ Google Sheets ไม่ล้างข้อมูลนักกีฬาและรูป', () => {
  const HEAD = ['รหัสสมาชิก (ระบบใช้จับคู่ ห้ามแก้)', 'ชื่อ', 'ชื่อเล่น', 'บทบาท', 'สถานะ', 'ช่องทางติดต่อ', 'หมายเหตุ', 'วันที่เพิ่ม']
  const COLUMNS = { id: HEAD[0], name: 'ชื่อ', nickname: 'ชื่อเล่น', role: 'บทบาท', status: 'สถานะ', contact: 'ช่องทางติดต่อ', note: 'หมายเหตุ', addedAt: 'วันที่เพิ่ม' }
  const ROW_A = ['id-a', 'อารี ทดสอบ', 'อา', 'สมาชิก', 'ใช้งาน', '', '', '2026-09-01']
  const ROW_B = ['id-b', 'บุญมี ทดสอบ', 'บี', 'สมาชิก', 'ใช้งาน', '', '', '2026-09-02']
  const ROW_C = ['id-c', 'ชาตรี ทดสอบ', 'ซี', 'สมาชิก', 'ใช้งาน', '', '', '2026-09-03']

  it('เรียงแถวใหม่ แก้ชื่อ และลบแถวในชีต: โปรไฟล์นักกีฬาและรูปยังผูกกับรหัสสมาชิกเดิม ไม่สลับคนและไม่หาย', async () => {
    const google = await FakeGoogle.start()
    const ws = new FakeWorkspace(google)
    await connectClub(google)
    const sheet = ws.addSheet('ทะเบียนสมาชิก', [HEAD, ROW_A, ROW_B, ROW_C])
    const linked = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, headerRow: 1, columns: COLUMNS } })
    expect(linked.status).toBe(201)

    expect((await add(staff, 'id-a', { game: 'Valorant', ign: 'aree' })).status).toBe(201)
    expect((await add(staff, 'id-c', { game: 'RoV', ign: 'chatri' })).status).toBe(201)
    const photo = (id: string, version: string) =>
      env.DB.prepare(`INSERT INTO member_photos (member_id, content_type, bytes, size, width, height, version, updated_by, updated_at) VALUES (?, 'image/png', ?, 4, 8, 8, ?, 'seed', ?)`)
        .bind(id, new Uint8Array([1, 2, 3, 4]), version, new Date().toISOString()).run()
    await photo('id-a', 'photo-a')
    await photo('id-c', 'photo-c')

    // ที่ Google: เรียงเป็น C, B, A แก้ชื่อของ A แล้วลบแถวของ C ทิ้ง
    const cells = ws.cells(sheet.id)
    cells.splice(1, 3, cells[3], cells[2], cells[1])
    cells[3][1] = 'อารี ชื่อใหม่'
    await syncNow('sheets', staff)
    cells.splice(1, 1)
    await syncNow('sheets', staff)

    const roster = await athletes()
    expect(roster.map((x) => [x.memberId, x.name, x.game, x.ign, x.photoVersion, x.memberSourceState]).sort()).toEqual([
      ['id-a', 'อารี ชื่อใหม่', 'Valorant', 'aree', 'photo-a', 'ok'],
      // แถวของ C หายจากชีต: ทะเบียนเก็บไว้เป็น "ไม่พบในชีต" โปรไฟล์นักกีฬาและรูปยังอยู่กับคนเดิม
      ['id-c', 'ชาตรี ทดสอบ', 'RoV', 'chatri', 'photo-c', 'missing'],
    ])
    const registry = await members()
    expect(registry.find((m) => m.id === 'id-b')).toMatchObject({ athlete: null, photoVersion: null })
    expect(registry.find((m) => m.id === 'id-c')).toMatchObject({ sourceState: 'missing', athlete: { game: 'RoV', status: 'active' }, photoVersion: 'photo-c' })
    // การซิงค์ไม่เขียนข้อมูลนักกีฬาหรือรูปลงชีต: ชีตยังมีเฉพาะคอลัมน์เดิม
    expect(ws.cells(sheet.id)[0]).toEqual(HEAD)
    expect(JSON.stringify(ws.cells(sheet.id))).not.toMatch(/Valorant|RoV|aree|photo-a/)
    // แก้โปรไฟล์นักกีฬาจากเว็บหลังซิงค์ยังทำได้ตามรุ่นเดิม (ซิงค์ไม่ได้แตะรุ่นของโปรไฟล์)
    expect((await patch(staff, 'id-a', { ...INPUT, expectedVersion: 1 })).status).toBe(200)
  })
})
