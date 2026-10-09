import { beforeEach, describe, expect, it } from 'vitest'
import { sha256Hex } from '../worker/crypto'
import { call, CLUB_EMAIL, data, env, resetDb, seedAccount, seedMember, seedMemberActor, seedMemberSession, seedSession, seedUser } from './helpers'

beforeEach(resetDb)

/** ทุกเส้นทางของหลังบ้านที่มีอยู่ใน Worker (ทีมงานและผู้ดูแล) รวมเส้นทางจัดการบัญชีสมาชิก */
const STAFF_ROUTES: [string, string][] = [
  ['GET', '/api/members'], ['POST', '/api/members'], ['PATCH', '/api/members/x'], ['POST', '/api/members/x/status'],
  ['POST', '/api/members/x/account/password'], ['POST', '/api/members/x/account/disable'], ['POST', '/api/members/x/account/login-id'],
  ['GET', '/api/events'], ['POST', '/api/events'], ['PATCH', '/api/events/x'],
  ['GET', '/api/users'], ['POST', '/api/users'], ['PATCH', '/api/users/x'],
  ['GET', '/api/documents'], ['POST', '/api/documents'], ['POST', '/api/documents/link'], ['GET', '/api/documents/x'], ['PUT', '/api/documents/x'],
  ['GET', '/api/documents/x/revision'], ['GET', '/api/documents/operations'], ['POST', '/api/documents/operations/x/resume'], ['DELETE', '/api/documents/operations/x'],
  ['GET', '/api/forms'], ['PATCH', '/api/forms/info'], ['PUT', '/api/forms/mapping'], ['POST', '/api/forms/items'], ['PATCH', '/api/forms/items/x'],
  ['POST', '/api/forms/responses/x/import'], ['POST', '/api/forms/responses/x/dismiss'], ['POST', '/api/forms/responses/x/restore'],
  ['GET', '/api/sync'], ['POST', '/api/sync/sheets'], ['POST', '/api/sync/calendar'], ['POST', '/api/sync/forms'], ['POST', '/api/sync/docs'],
  ['GET', '/api/sync/sheets/push-local'], ['POST', '/api/sync/sheets/push-local'], ['POST', '/api/sync/calendar/push-local'],
  ['GET', '/api/setup'], ['GET', '/api/setup/calendars'], ['POST', '/api/setup/create'], ['POST', '/api/setup/preview'], ['POST', '/api/setup/link'],
  ['DELETE', '/api/setup/link/sheets'], ['DELETE', '/api/setup/operations/x'],
  ['GET', '/api/setup/student-id-column'], ['POST', '/api/setup/student-id-column'],
  ['GET', '/api/sources'], ['POST', '/api/google/connect'], ['POST', '/api/google/check'], ['POST', '/api/google/disconnect'],
]

const MEMBER_ROUTES: [string, string][] = [
  ['GET', '/api/member/me'], ['PATCH', '/api/member/me'], ['GET', '/api/member/events'], ['POST', '/api/member/password'],
]

describe('session ของสมาชิกไม่ผ่าน guard ของทีมงาน', () => {
  it('ทุกเส้นทางหลังบ้านตอบ 403 staff_only ไม่ว่าเป็น GET หรือคำสั่งเปลี่ยนข้อมูล และไม่มีข้อมูลในคำตอบ', async () => {
    const member = await seedMemberActor()
    for (const [method, path] of STAFF_ROUTES) {
      const res = await call(path, { method, as: member, body: method === 'GET' ? undefined : {}, headers: { 'Idempotency-Key': 'guard-test-key-0001' } })
      expect(res.status, `${method} ${path}`).toBe(403)
      const body = await data(res)
      expect(body.error, `${method} ${path}`).toBe('staff_only')
      expect(Object.keys(body).sort(), `${method} ${path}`).toEqual(['error', 'message'])
    }
  })

  it('บทบาทในทะเบียนสมาชิก (ทีมงาน/ผู้ดูแล) ไม่เพิ่มสิทธิ์หลังบ้านให้ session ของสมาชิก', async () => {
    for (const role of ['staff', 'admin'] as const) {
      const member = await seedMemberActor({ role })
      for (const [method, path] of STAFF_ROUTES) {
        const res = await call(path, { method, as: member, body: method === 'GET' ? undefined : {}, headers: { 'Idempotency-Key': 'guard-test-key-0002' } })
        expect(res.status, `${role} ${method} ${path}`).toBe(403)
      }
    }
  })

  it('ค่าที่เบราว์เซอร์ส่งมาอ้างสิทธิ์ (header, body, query) ไม่มีผล', async () => {
    const member = await seedMemberActor()
    const res = await call('/api/members?role=admin&kind=staff', { as: member, headers: { 'X-Role': 'admin', 'X-Session-Kind': 'staff' } })
    expect(res.status).toBe(403)
    const post = await call('/api/users', { method: 'POST', as: member, body: { email: 'x@example.com', role: 'admin', kind: 'staff', actorRole: 'admin' } })
    expect(post.status).toBe(403)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>())?.n).toBe(0)
  })

  it('คำสั่งเปลี่ยนข้อมูลของหลังบ้านไม่ถูกทำแม้ session สมาชิกจะส่ง Origin และ CSRF ของตัวเองครบ', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const target = await seedMember({ name: 'เป้าหมาย', studentId: '6500001' })
    const member = await seedMemberActor()
    const before = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(target.id).first()
    await call(`/api/members/${target.id}`, { method: 'PATCH', as: member, body: { name: 'ถูกแก้', nickname: 'x', role: 'admin', status: 'active', contact: '', note: '', expectedVersion: 1 } })
    await call(`/api/members/${target.id}/status`, { method: 'POST', as: member, body: { status: 'suspended', expectedVersion: 1 } })
    await call(`/api/members/${target.id}/account/password`, { method: 'POST', as: member, body: { studentId: '6500001', password: 'Another-Pass-99' } })
    expect(await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(target.id).first()).toEqual(before)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_accounts WHERE member_id = ?').bind(target.id).first<{ n: number }>())?.n).toBe(0)
    // ผู้ดูแลยังทำรายการเดียวกันได้ตามปกติ
    expect((await call(`/api/members/${target.id}/status`, { method: 'POST', as: admin, body: { status: 'suspended', expectedVersion: 1 } })).status).toBe(200)
  })
})

describe('ชนิดของ session มาจากตารางที่ server พบแถว', () => {
  it('/api/session แยกทีมงานกับสมาชิก และไม่มี hash หรือข้อมูลภายในของบัญชี', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const member = await seedMemberActor({ name: 'สมหญิง ทดสอบ', nickname: 'หญิง', studentId: '6512345' })
    const asStaff = await data(await call('/api/session', { as: staff }))
    expect(asStaff.user).toEqual({ id: staff.id, email: 'staff@example.com', name: 'staff', role: 'staff' })
    expect(asStaff.member).toBeNull()
    const asMember = await data(await call('/api/session', { as: member }))
    expect(asMember.user).toBeNull()
    expect(asMember.member).toEqual({ id: member.id, name: 'สมหญิง ทดสอบ', nickname: 'หญิง', studentId: '6512345', mustChangePassword: false })
    expect(asMember.csrfToken).toBe(member.csrf)
    expect(JSON.stringify(asMember)).not.toMatch(/argon2|password_hash|hash/i)
  })

  it('token ของทีมงานที่เติม prefix ของสมาชิก และ token ของสมาชิกที่ตัด prefix ออก ใช้ไม่ได้ทั้งคู่', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const member = await seedMemberActor()
    const staffToken = admin.cookie.replace('mu_session=', '')
    const memberToken = member.cookie.replace('mu_session=', '')
    expect(memberToken.startsWith('m.')).toBe(true)
    for (const cookie of [`mu_session=m.${staffToken}`, `mu_session=${memberToken.slice(2)}`]) {
      const session = await data(await call('/api/session', { cookie }))
      expect(session.user).toBeNull()
      expect(session.member).toBeNull()
      expect((await call('/api/members', { cookie })).status).toBe(401)
      expect((await call('/api/member/me', { cookie })).status).toBe(401)
    }
  })

  it('แถวในตาราง session ของสมาชิกไม่ทำให้ได้สิทธิ์ทีมงาน แม้ token จะไม่มี prefix', async () => {
    const member = await seedMemberActor()
    // สมมติว่ามีแถว member_sessions ที่ hash ตรงกับ token แบบไม่มี prefix: token แบบนี้ถูกค้นในตารางทีมงานเท่านั้น จึงไม่พบ
    const token = 'plain-token-without-prefix-000000000000000000'
    await env.DB.prepare('INSERT INTO member_sessions (token_hash, member_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .bind(await sha256Hex(token), member.id, new Date().toISOString(), new Date(Date.now() + 3_600_000).toISOString())
      .run()
    expect((await call('/api/members', { cookie: `mu_session=${token}` })).status).toBe(401)
    expect((await call('/api/member/me', { cookie: `mu_session=${token}` })).status).toBe(401)
  })
})

describe('session ของสมาชิกใช้ได้เฉพาะเมื่อบัญชียังใช้งานได้', () => {
  it('ยังไม่เข้าสู่ระบบ: เส้นทางของสมาชิกตอบ 401', async () => {
    for (const [method, path] of MEMBER_ROUTES) {
      const res = await call(path, { method, body: method === 'GET' ? undefined : {} })
      expect(res.status, `${method} ${path}`).toBe(401)
      expect((await data(res)).error).toBe('unauthenticated')
    }
  })

  it('session ที่หมดอายุใช้ไม่ได้', async () => {
    const member = await seedMember({ studentId: '6500002' })
    await seedAccount(member.id, { loginId: '6500002' })
    const expired = await seedMemberSession(member.id, -1000)
    expect((await call('/api/member/me', { as: expired })).status).toBe(401)
    expect((await data(await call('/api/session', { as: expired }))).member).toBeNull()
  })

  it('บัญชีที่ถูกปิดใช้ session เดิมไม่ได้ทันที', async () => {
    const member = await seedMemberActor()
    expect((await call('/api/member/me', { as: member })).status).toBe(200)
    await env.DB.prepare(`UPDATE member_accounts SET status = 'disabled' WHERE member_id = ?`).bind(member.id).run()
    expect((await call('/api/member/me', { as: member })).status).toBe(401)
    expect((await call('/api/member/events', { as: member })).status).toBe(401)
  })

  it('ทีมงานพักสมาชิก: session ของสมาชิกถูกลบ และไม่กลับมาใช้ได้เมื่อเปิดใช้งานอีกครั้ง', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const member = await seedMemberActor()
    expect((await call('/api/member/me', { as: member })).status).toBe(200)
    const suspended = await call(`/api/members/${member.id}/status`, { method: 'POST', as: staff, body: { status: 'suspended', expectedVersion: 1 } })
    expect(suspended.status).toBe(200)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions WHERE member_id = ?').bind(member.id).first<{ n: number }>())?.n).toBe(0)
    expect((await call('/api/member/me', { as: member })).status).toBe(401)
    const active = await call(`/api/members/${member.id}/status`, { method: 'POST', as: staff, body: { status: 'active', expectedVersion: 2 } })
    expect(active.status).toBe(200)
    expect((await call('/api/member/me', { as: member })).status).toBe(401)
  })

  it('การพักที่มาจากเส้นทางอื่น (เช่น รอบซิงค์เขียนสถานะลงฐานข้อมูลตรง ๆ) ก็ยกเลิก session เช่นกัน', async () => {
    const member = await seedMemberActor()
    await env.DB.prepare(`UPDATE members SET status = 'suspended', version = version + 1 WHERE id = ?`).bind(member.id).run()
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions WHERE member_id = ?').bind(member.id).first<{ n: number }>())?.n).toBe(0)
    // การแก้ฟิลด์อื่นไม่ยกเลิก session
    const other = await seedMemberActor()
    await env.DB.prepare(`UPDATE members SET nickname = 'ใหม่', version = version + 1 WHERE id = ?`).bind(other.id).run()
    expect((await call('/api/member/me', { as: other })).status).toBe(200)
  })
})

describe('รหัสผ่านชั่วคราวต้องเปลี่ยนก่อนใช้งาน', () => {
  it('session ที่ยังต้องเปลี่ยนรหัสผ่านเปิดข้อมูลของสมาชิกไม่ได้ ทั้งอ่านและเขียน', async () => {
    const member = await seedMemberActor({ mustChange: true })
    expect((await data(await call('/api/session', { as: member }))).member.mustChangePassword).toBe(true)
    for (const [method, path] of [['GET', '/api/member/me'], ['PATCH', '/api/member/me'], ['GET', '/api/member/events']]) {
      const res = await call(path, { method, as: member, body: method === 'GET' ? undefined : { contact: 'x', expectedVersion: 1 } })
      expect(res.status, `${method} ${path}`).toBe(403)
      expect((await data(res)).error).toBe('password_change_required')
    }
    expect((await env.DB.prepare('SELECT contact FROM members WHERE id = ?').bind(member.id).first<{ contact: string }>())?.contact).toBe('')
  })

  it('ออกจากระบบได้แม้ยังไม่ได้เปลี่ยนรหัสผ่าน', async () => {
    const member = await seedMemberActor({ mustChange: true })
    expect((await call('/auth/logout', { method: 'POST', as: member })).status).toBe(200)
    expect((await call('/api/session', { as: member }).then(data)).member).toBeNull()
  })
})

describe('ทีมงานไม่ผ่าน guard ของสมาชิก', () => {
  it('เส้นทางข้อมูลตนเองของสมาชิกตอบ 403 member_only กับทีมงานและผู้ดูแล', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const staff = await seedUser('staff@example.com', 'staff')
    for (const actor of [admin, staff]) {
      for (const [method, path] of MEMBER_ROUTES) {
        const res = await call(path, { method, as: actor, body: method === 'GET' ? undefined : {} })
        expect(res.status, `${method} ${path}`).toBe(403)
        expect((await data(res)).error).toBe('member_only')
      }
    }
  })
})

describe('คำสั่งเปลี่ยนข้อมูลของสมาชิกต้องมาจากหน้าเว็บของระบบ', () => {
  it('ไม่มี Origin หรือ CSRF token ไม่ถูกต้อง: ไม่ทำรายการ', async () => {
    const member = await seedMemberActor()
    const body = { contact: 'discord: x', expectedVersion: 1 }
    const noOrigin = await call('/api/member/me', { method: 'PATCH', as: member, raw: true, body, headers: { 'X-CSRF-Token': member.csrf } })
    expect(noOrigin.status).toBe(403)
    expect((await data(noOrigin)).error).toBe('bad_origin')
    const foreign = await call('/api/member/me', { method: 'PATCH', as: member, raw: true, body, headers: { Origin: 'https://evil.example', 'X-CSRF-Token': member.csrf } })
    expect(foreign.status).toBe(403)
    const noCsrf = await call('/api/member/me', { method: 'PATCH', as: member, raw: true, body, headers: { Origin: 'https://staff.example.test' } })
    expect(noCsrf.status).toBe(403)
    expect((await data(noCsrf)).error).toBe('bad_csrf')
    // CSRF token ของ session อื่นใช้แทนกันไม่ได้
    const other = await seedMemberActor()
    const crossed = await call('/api/member/me', { method: 'PATCH', as: member, raw: true, body, headers: { Origin: 'https://staff.example.test', 'X-CSRF-Token': other.csrf } })
    expect(crossed.status).toBe(403)
    expect((await env.DB.prepare('SELECT contact FROM members WHERE id = ?').bind(member.id).first<{ contact: string }>())?.contact).toBe('')
    const logout = await call('/auth/logout', { method: 'POST', as: member, raw: true })
    expect(logout.status).toBe(403)
    expect((await call('/api/member/me', { as: member })).status).toBe(200)
  })
})

describe('สมาชิกเห็นและแก้ได้เฉพาะข้อมูลของตัวเอง', () => {
  it('ข้อมูลตนเองไม่มีหมายเหตุของทีมงาน บทบาท หรือข้อมูลบัญชีภายใน', async () => {
    const member = await seedMemberActor({ name: 'ก้อง ทดสอบ', nickname: 'ก้อง', studentId: '6511111', contact: 'line: kong', note: 'หมายเหตุภายในของทีมงาน', role: 'staff' })
    const body = await data(await call('/api/member/me', { as: member }))
    expect(body).toEqual({
      // photoVersion = รุ่นของรูปโปรไฟล์ของตัวเอง (null = ยังไม่มีรูป) ไม่มีเนื้อรูปและไม่มีข้อมูลนักกีฬาหรือข้อมูลภายในอื่น
      member: { name: 'ก้อง ทดสอบ', nickname: 'ก้อง', studentId: '6511111', loginId: '6511111', status: 'active', contact: 'line: kong', version: 1, contactEditable: true, passwordChangedAt: null, photoVersion: null },
    })
    expect(JSON.stringify(body)).not.toContain('หมายเหตุภายใน')
  })

  it('ระบุรหัสของสมาชิกคนอื่นใน query หรือ body ไม่ทำให้อ่านหรือแก้ข้อมูลของคนนั้นได้ (IDOR)', async () => {
    const victim = await seedMemberActor({ name: 'เหยื่อ ทดสอบ', nickname: 'เหยื่อ', contact: 'ความลับของเหยื่อ' })
    const attacker = await seedMemberActor({ name: 'ผู้โจมตี', nickname: 'โจ' })
    const read = await data(await call(`/api/member/me?id=${victim.id}&memberId=${victim.id}`, { as: attacker }))
    expect(read.member.name).toBe('ผู้โจมตี')
    expect(JSON.stringify(read)).not.toContain('ความลับของเหยื่อ')
    const write = await call(`/api/member/me?id=${victim.id}`, {
      method: 'PATCH', as: attacker, body: { id: victim.id, memberId: victim.id, contact: 'ถูกเปลี่ยน', expectedVersion: 1, name: 'ชื่อใหม่', role: 'admin', status: 'active', studentId: '9999999', note: 'x' },
    })
    expect(write.status).toBe(200)
    const rows = await env.DB.prepare('SELECT id, name, role, contact, note, student_id FROM members WHERE id IN (?, ?)').bind(victim.id, attacker.id).all<Record<string, string>>()
    const byId = Object.fromEntries(rows.results.map((row) => [row.id, row]))
    expect(byId[victim.id].contact).toBe('ความลับของเหยื่อ')
    // ของตัวเอง: เปลี่ยนได้เฉพาะช่องทางติดต่อ ฟิลด์อื่นที่ส่งมาถูกทิ้ง
    expect(byId[attacker.id]).toMatchObject({ contact: 'ถูกเปลี่ยน', name: 'ผู้โจมตี', role: 'member', note: '', student_id: attacker.studentId })
    // ไม่มีเส้นทางอ่านสมาชิกรายคนหรือรายชื่อทั้งหมดสำหรับสมาชิก
    for (const path of [`/api/member/${victim.id}`, `/api/member/members`, `/api/member/me/${victim.id}`, `/api/members/${victim.id}`]) {
      expect((await call(path, { as: attacker })).status, path).not.toBe(200)
    }
  })

  it('แก้ช่องทางติดต่อต้องส่งรุ่นของข้อมูลที่เห็น: รุ่นเก่าถูกปฏิเสธโดยไม่ส่งข้อมูลทั้งแถวกลับ', async () => {
    const member = await seedMemberActor({ note: 'หมายเหตุภายใน' })
    const ok = await call('/api/member/me', { method: 'PATCH', as: member, body: { contact: 'ig: a', expectedVersion: 1 } })
    expect((await data(ok)).member).toMatchObject({ contact: 'ig: a', version: 2 })
    const stale = await call('/api/member/me', { method: 'PATCH', as: member, body: { contact: 'ig: b', expectedVersion: 1 } })
    expect(stale.status).toBe(409)
    const body = await data(stale)
    expect(body.error).toBe('version_conflict')
    expect(JSON.stringify(body)).not.toContain('หมายเหตุภายใน')
    const tooLong = await call('/api/member/me', { method: 'PATCH', as: member, body: { contact: 'x'.repeat(201), expectedVersion: 2 } })
    expect(tooLong.status).toBe(422)
    // บันทึกการแก้ไม่มีช่องทางติดต่ออยู่ใน audit
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action = 'member.self_contact_updated'`).all<Record<string, unknown>>()
    expect(audit.results).toHaveLength(1)
    expect(JSON.stringify(audit.results)).not.toContain('ig: a')
  })
})

describe('ออกจากระบบ', () => {
  it('ลบ session ของสมาชิกที่ server และล้าง cookie', async () => {
    const member = await seedMemberActor()
    const second = await seedMemberSession(member.id)
    const res = await call('/auth/logout', { method: 'POST', as: member })
    expect(res.status).toBe(200)
    expect(res.headers.get('Set-Cookie')).toMatch(/^mu_session=; .*Max-Age=0/)
    expect((await call('/api/member/me', { as: member })).status).toBe(401)
    // session ของอุปกรณ์อื่นไม่ถูกกระทบ
    expect((await call('/api/member/me', { as: second })).status).toBe(200)
  })

  it('ทีมงานยังออกจากระบบได้ตามเดิม และไม่กระทบ session ของสมาชิก', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const extra = await seedSession(staff.id)
    const member = await seedMemberActor()
    expect((await call('/auth/logout', { method: 'POST', as: staff })).status).toBe(200)
    expect((await call('/api/members', { as: staff })).status).toBe(401)
    expect((await call('/api/members', { as: { id: staff.id, ...extra } })).status).toBe(200)
    expect((await call('/api/member/me', { as: member })).status).toBe(200)
  })
})
