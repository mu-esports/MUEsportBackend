import { beforeEach, describe, expect, it } from 'vitest'
import { call, CLUB_EMAIL, data, env, key, MEMBER_PASSWORD, resetDb, seedAccount, seedMember, seedMemberSession, seedUser } from './helpers'
import type { Actor } from './helpers'

beforeEach(resetDb)

const INPUT = { name: 'สมชาย ทดสอบ', nickname: 'ชาย', role: 'member', status: 'active', contact: '', note: '' }
const TEMP = 'Temp-Pass-7391'

const createMember = (as: Actor, extra: Record<string, unknown> = {}) =>
  call('/api/members', { method: 'POST', as, headers: { 'Idempotency-Key': key() }, body: { ...INPUT, ...extra } })

const setPassword = (as: Actor | null, memberId: string, body: Record<string, unknown>) =>
  call(`/api/members/${memberId}/account/password`, { method: 'POST', as, body })

const login = (studentId: string, password: string, headers: Record<string, string> = {}) =>
  call('/auth/member/login', { method: 'POST', body: { studentId, password }, headers })

const memberRow = (id: string) => env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(id).first<Record<string, any>>()
const accountRow = (id: string) => env.DB.prepare('SELECT * FROM member_accounts WHERE member_id = ?').bind(id).first<Record<string, any>>()

describe('รหัสนักศึกษาในทะเบียน (ข้อมูลในเว็บ)', () => {
  it('เก็บเป็นข้อความตามที่กรอก คงเลขศูนย์นำหน้า ตัดช่องว่างหัวท้าย และว่างได้', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const created = await data(await createMember(staff, { studentId: '  0012345 ' }))
    expect(created.member.studentId).toBe('0012345')
    expect((await memberRow(created.member.id))?.student_id).toBe('0012345')
    const blank = await data(await createMember(staff, { name: 'ไม่มีรหัส' }))
    expect(blank.member.studentId).toBe('')
    // สมาชิกที่ยังไม่มีรหัสนักศึกษา: ข้อมูลอยู่ครบ แต่ยังเปิดบัญชีไม่ได้ พร้อมเหตุผล
    expect(blank.member.account).toEqual({ state: 'none', loginId: null, loginMismatch: false, passwordSetAt: null, lastLoginAt: null, blocked: 'no_student_id' })
    expect(created.member.account.blocked).toBeNull()
    const list = await data(await call('/api/members', { as: staff }))
    expect(list.members.map((m: any) => m.studentId).sort()).toEqual(['', '0012345'])
  })

  it('รูปแบบที่ไม่รองรับถูกปฏิเสธพร้อมบอกช่องที่ผิด และไม่มีการบันทึก', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    for (const studentId of ['65 12345', '๖๕๑๒๓๔๕', '6512345!', '-6512345', '6512345.', 'x'.repeat(33), 6512345]) {
      const res = await createMember(staff, { studentId })
      expect(res.status, String(studentId)).toBe(422)
      expect((await data(res)).field).toBe('studentId')
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>())?.n).toBe(0)
    // รูปแบบที่ใช้ได้: ตัวเลข อักษรอังกฤษ และ - _ . คั่นกลาง
    for (const studentId of ['6512345', 'B6512345', '65-1234-5', 'a.b_c', '7']) {
      expect((await createMember(staff, { studentId })).status, studentId).toBe(201)
    }
  })

  it('รหัสซ้ำกับสมาชิกคนอื่น (ไม่สนตัวพิมพ์) ถูกปฏิเสธทั้งตอนเพิ่มและตอนแก้ และข้อมูลเดิมไม่เปลี่ยน', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const first = (await data(await createMember(staff, { studentId: 'B6512345' }))).member
    const dup = await createMember(staff, { name: 'อีกคน', studentId: 'b6512345' })
    expect(dup.status).toBe(409)
    expect(await data(dup)).toMatchObject({ error: 'student_id_taken', field: 'studentId' })
    const second = (await data(await createMember(staff, { name: 'อีกคน', studentId: '6500002' }))).member
    const edit = await call(`/api/members/${second.id}`, { method: 'PATCH', as: staff, body: { ...INPUT, name: 'อีกคน', studentId: 'B6512345', expectedVersion: 1 } })
    expect(edit.status).toBe(409)
    expect((await data(edit)).error).toBe('student_id_taken')
    expect((await memberRow(second.id))).toMatchObject({ student_id: '6500002', version: 1 })
    expect((await memberRow(first.id))).toMatchObject({ student_id: 'B6512345', version: 1 })
    // แก้ตัวพิมพ์ของรหัสตัวเอง และล้างรหัสตัวเอง ทำได้
    expect((await call(`/api/members/${first.id}`, { method: 'PATCH', as: staff, body: { ...INPUT, studentId: 'b6512345', expectedVersion: 1 } })).status).toBe(200)
    expect((await call(`/api/members/${first.id}`, { method: 'PATCH', as: staff, body: { ...INPUT, studentId: '', expectedVersion: 2 } })).status).toBe(200)
    expect((await memberRow(first.id))?.student_id).toBe('')
  })

  it('คำขอเพิ่มสมาชิกสองคำขอที่ใช้รหัสนักศึกษาเดียวกันพร้อมกัน สำเร็จได้เพียงคำขอเดียว', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const results = await Promise.all([createMember(staff, { name: 'ก', studentId: '6500009' }), createMember(staff, { name: 'ข', studentId: '6500009' })])
    expect(results.map((r) => r.status).sort()).toEqual([201, 409])
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM members WHERE student_id = '6500009'`).first<{ n: number }>())?.n).toBe(1)
  })
})

describe('ผู้ดูแลเปิดบัญชีและตั้งรหัสผ่าน', () => {
  it('ทำได้เฉพาะผู้ดูแล: ทีมงานทั่วไป ผู้ไม่เข้าสู่ระบบ และคำขอที่ไม่มี CSRF ถูกปฏิเสธ', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const staff = await seedUser('staff@example.com', 'staff')
    const member = await seedMember({ studentId: '6512345' })
    const body = { studentId: '6512345', password: TEMP }
    for (const action of ['password', 'disable', 'login-id']) {
      expect((await call(`/api/members/${member.id}/account/${action}`, { method: 'POST', body })).status, action).toBe(401)
      expect((await call(`/api/members/${member.id}/account/${action}`, { method: 'POST', as: staff, body })).status, action).toBe(403)
      expect((await call(`/api/members/${member.id}/account/${action}`, { method: 'POST', as: admin, raw: true, body, headers: { Origin: 'https://staff.example.test' } })).status, action).toBe(403)
    }
    expect(await accountRow(member.id)).toBeNull()
  })

  it('เปิดบัญชี: เก็บเฉพาะผลของ Argon2id ไม่มีรหัสผ่านในคำตอบ รายชื่อ หรือบันทึกการดำเนินการ', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const member = await seedMember({ studentId: '6512345' })
    const res = await setPassword(admin, member.id, { studentId: '6512345', password: TEMP })
    expect(res.status).toBe(201)
    const body = await data(res)
    expect(body.account).toMatchObject({ state: 'must_change', loginId: '6512345', loginMismatch: false, blocked: null })
    const row = await accountRow(member.id)
    expect(row?.password_hash).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$[A-Za-z0-9+/]{22}\$[A-Za-z0-9+/]{43}$/)
    expect(row).toMatchObject({ login_id: '6512345', status: 'active', must_change_password: 1, password_set_by: admin.id })
    const list = JSON.stringify(await data(await call('/api/members', { as: admin })))
    for (const text of [JSON.stringify(body), list]) {
      expect(text).not.toContain(TEMP)
      expect(text).not.toMatch(/argon2|password_hash|"hash"|salt/i)
    }
    const audit = await env.DB.prepare('SELECT * FROM audit_log').all<Record<string, unknown>>()
    expect(audit.results.map((a) => a.action)).toEqual(['member_account.opened'])
    expect(audit.results[0]).toMatchObject({ user_id: admin.id, target: member.id })
    expect(JSON.stringify(audit.results)).not.toContain(TEMP)
    // ไม่มีตารางอื่นใดเก็บรหัสผ่านที่ตั้ง
    for (const table of ['members', 'member_accounts', 'member_sessions', 'audit_log', 'login_throttle']) {
      const dump = JSON.stringify((await env.DB.prepare(`SELECT * FROM ${table}`).all()).results)
      expect(dump, table).not.toContain(TEMP)
    }
  })

  it('salt สุ่มต่อบัญชี: รหัสผ่านเดียวกันของสองบัญชีได้ผลที่ต่างกัน', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const a = await seedMember({ studentId: '6500001' })
    const b = await seedMember({ studentId: '6500002' })
    await setPassword(admin, a.id, { studentId: '6500001', password: TEMP })
    await setPassword(admin, b.id, { studentId: '6500002', password: TEMP })
    expect((await accountRow(a.id))?.password_hash).not.toBe((await accountRow(b.id))?.password_hash)
  })

  it('เงื่อนไขก่อนเปิดบัญชี: ต้องมีรหัสนักศึกษา สมาชิกต้องใช้งานอยู่ และรหัสผ่านชั่วคราวต้องผ่านเกณฑ์', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const noId = await seedMember({})
    const none = await setPassword(admin, noId.id, { studentId: '', password: TEMP })
    expect(none.status).toBe(409)
    expect((await data(none)).error).toBe('student_id_required')

    const suspended = await seedMember({ studentId: '6500003', status: 'suspended' })
    const sus = await setPassword(admin, suspended.id, { studentId: '6500003', password: TEMP })
    expect(sus.status).toBe(409)
    expect((await data(sus)).error).toBe('member_suspended')

    const member = await seedMember({ studentId: 'B6512345' })
    const cases: [Record<string, unknown>, number, string][] = [
      [{ studentId: 'B6512345', password: 'short-1' }, 422, 'validation_failed'],
      [{ studentId: 'B6512345', password: 'x'.repeat(129) }, 422, 'validation_failed'],
      [{ studentId: 'B6512345' }, 422, 'validation_failed'],
      // รหัสนักศึกษาที่ผู้ดูแลยืนยันไม่ตรงกับของสมาชิกคนนี้
      [{ studentId: '6599999', password: TEMP }, 409, 'student_id_changed'],
      [{ password: TEMP }, 409, 'student_id_changed'],
    ]
    for (const [body, status, error] of cases) {
      const res = await setPassword(admin, member.id, body)
      expect(res.status, JSON.stringify(body)).toBe(status)
      expect((await data(res)).error).toBe(error)
    }
    // ห้ามใช้รหัสนักศึกษาเป็นรหัสผ่าน (ไม่สนตัวพิมพ์และช่องว่างหัวท้าย)
    const longId = await seedMember({ studentId: 'MUESPORT-2569' })
    const same = await setPassword(admin, longId.id, { studentId: 'MUESPORT-2569', password: ' muesport-2569 ' })
    expect(same.status).toBe(422)
    expect((await data(same)).message).toContain('ต้องไม่ใช่รหัสนักศึกษา')
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_accounts').first<{ n: number }>())?.n).toBe(0)
    expect((await setPassword(admin, 'no-such-member', { studentId: 'x', password: TEMP })).status).toBe(404)
  })

  it('รีเซ็ตรหัสผ่าน: session เดิมทั้งหมดถูกยกเลิก รหัสเดิมใช้ไม่ได้ และต้องเปลี่ยนรหัสอีกครั้ง', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const member = await seedMember({ studentId: '6512345' })
    await seedAccount(member.id, { loginId: '6512345' })
    const phone = await seedMemberSession(member.id)
    const laptop = await seedMemberSession(member.id)
    expect((await call('/api/member/me', { as: phone })).status).toBe(200)

    const reset = await setPassword(admin, member.id, { studentId: '6512345', password: TEMP })
    expect(reset.status).toBe(200)
    expect((await data(reset)).account.state).toBe('must_change')
    for (const old of [phone, laptop]) expect((await call('/api/member/me', { as: old })).status).toBe(401)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<{ n: number }>())?.n).toBe(0)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(401)
    const ok = await login('6512345', TEMP)
    expect(ok.status).toBe(200)
    expect((await data(ok)).mustChangePassword).toBe(true)
    const actions = (await env.DB.prepare('SELECT action FROM audit_log ORDER BY id').all<{ action: string }>()).results.map((a) => a.action)
    expect(actions).toEqual(['member_account.password_reset'])
  })

  it('ปิดบัญชี: session เดิมถูกยกเลิก เข้าสู่ระบบไม่ได้ และเปิดใหม่ได้ด้วยการตั้งรหัสผ่านอีกครั้ง', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const member = await seedMember({ studentId: '6512345' })
    await seedAccount(member.id, { loginId: '6512345' })
    const session = await seedMemberSession(member.id)

    const disabled = await call(`/api/members/${member.id}/account/disable`, { method: 'POST', as: admin, body: {} })
    expect(disabled.status).toBe(200)
    expect((await data(disabled)).account.state).toBe('disabled')
    expect((await call('/api/member/me', { as: session })).status).toBe(401)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<{ n: number }>())?.n).toBe(0)
    // ข้อมูลสมาชิกไม่ถูกลบ
    expect((await memberRow(member.id))?.name).toBe('สมหญิง ทดสอบ')

    // รหัสผ่านผิด: ตอบเหมือนไม่มีบัญชี; รหัสผ่านถูก: บอกว่าบัญชีถูกปิด และไม่ได้ session
    const wrong = await login('6512345', 'Wrong-Password-1')
    expect(wrong.status).toBe(401)
    const right = await login('6512345', MEMBER_PASSWORD)
    expect(right.status).toBe(403)
    expect((await data(right)).error).toBe('account_disabled')
    expect(right.headers.get('Set-Cookie')).toBeNull()

    // ปิดซ้ำไม่ผิดพลาด และสมาชิกที่ไม่มีบัญชีปิดไม่ได้
    expect((await call(`/api/members/${member.id}/account/disable`, { method: 'POST', as: admin, body: {} })).status).toBe(200)
    const other = await seedMember({ studentId: '6500002' })
    expect((await call(`/api/members/${other.id}/account/disable`, { method: 'POST', as: admin, body: {} })).status).toBe(404)

    const reopened = await setPassword(admin, member.id, { studentId: '6512345', password: TEMP })
    expect((await data(reopened)).account.state).toBe('must_change')
    expect((await login('6512345', TEMP)).status).toBe(200)
    const actions = (await env.DB.prepare('SELECT action FROM audit_log ORDER BY id').all<{ action: string }>()).results.map((a) => a.action)
    expect(actions).toEqual(['member_account.disabled', 'member_account.reopened'])
  })

  it('สมาชิกที่ถูกพักการใช้งาน: เข้าสู่ระบบไม่ได้แม้รหัสผ่านถูก และ session เดิมถูกยกเลิก', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const member = await seedMember({ studentId: '6512345' })
    await seedAccount(member.id, { loginId: '6512345' })
    const session = await seedMemberSession(member.id)
    expect((await call(`/api/members/${member.id}/status`, { method: 'POST', as: staff, body: { status: 'suspended', expectedVersion: 1 } })).status).toBe(200)
    expect((await call('/api/member/me', { as: session })).status).toBe(401)
    const res = await login('6512345', MEMBER_PASSWORD)
    expect(res.status).toBe(403)
    expect(res.headers.get('Set-Cookie')).toBeNull()
    // การแก้ไขสมาชิกจากฟอร์ม (เปลี่ยนสถานะเป็นพัก) ก็ยกเลิก session เช่นกัน
    const other = await seedMember({ studentId: '6500002' })
    await seedAccount(other.id, { loginId: '6500002' })
    const otherSession = await seedMemberSession(other.id)
    const edit = await call(`/api/members/${other.id}`, { method: 'PATCH', as: staff, body: { ...INPUT, studentId: '6500002', status: 'suspended', expectedVersion: 1 } })
    expect(edit.status).toBe(200)
    expect((await call('/api/member/me', { as: otherSession })).status).toBe(401)
  })
})

describe('ตัวตนของบัญชีผูกกับสมาชิก ไม่ย้ายตามรหัสนักศึกษา', () => {
  it('แก้ชื่อ ชื่อเล่น หรือข้อมูลอื่นของสมาชิก ไม่กระทบบัญชี', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const member = await seedMember({ studentId: '6512345' })
    await seedAccount(member.id, { loginId: '6512345' })
    const before = await accountRow(member.id)
    const edit = await call(`/api/members/${member.id}`, { method: 'PATCH', as: staff, body: { ...INPUT, name: 'ชื่อใหม่', nickname: 'ใหม่', studentId: '6512345', contact: 'x', expectedVersion: 1 } })
    expect(edit.status).toBe(200)
    expect(await accountRow(member.id)).toEqual(before)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)
  })

  it('แก้รหัสนักศึกษาในทะเบียน: รหัสเข้าสู่ระบบยังเป็นค่าเดิมจนกว่าผู้ดูแลจะยืนยัน', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const staff = await seedUser('staff@example.com', 'staff')
    const member = await seedMember({ studentId: '6512345' })
    await seedAccount(member.id, { loginId: '6512345' })
    const session = await seedMemberSession(member.id)

    const edit = await data(await call(`/api/members/${member.id}`, { method: 'PATCH', as: staff, body: { ...INPUT, studentId: '6599999', expectedVersion: 1 } }))
    expect(edit.member.studentId).toBe('6599999')
    expect(edit.member.account).toMatchObject({ state: 'active', loginId: '6512345', loginMismatch: true })
    // ยังเข้าด้วยรหัสเดิม รหัสใหม่ยังใช้ไม่ได้ และ session เดิมยังอยู่
    expect((await login('6599999', MEMBER_PASSWORD)).status).toBe(401)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)
    expect((await call('/api/member/me', { as: session })).status).toBe(200)

    // ทีมงานทั่วไปยืนยันไม่ได้ และค่าที่ยืนยันต้องตรงกับทะเบียน ณ ตอนนั้น
    expect((await call(`/api/members/${member.id}/account/login-id`, { method: 'POST', as: staff, body: { studentId: '6599999' } })).status).toBe(403)
    const stale = await call(`/api/members/${member.id}/account/login-id`, { method: 'POST', as: admin, body: { studentId: '6588888' } })
    expect(stale.status).toBe(409)
    expect((await accountRow(member.id))?.login_id).toBe('6512345')

    const confirmed = await call(`/api/members/${member.id}/account/login-id`, { method: 'POST', as: admin, body: { studentId: '6599999' } })
    expect(confirmed.status).toBe(200)
    expect((await data(confirmed)).account).toMatchObject({ loginId: '6599999', loginMismatch: false })
    expect((await accountRow(member.id))?.member_id).toBe(member.id)
    expect((await call('/api/member/me', { as: session })).status).toBe(401)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(401)
    expect((await login('6599999', MEMBER_PASSWORD)).status).toBe(200)
  })

  it('รหัสนักศึกษาที่ยังเป็นรหัสเข้าสู่ระบบของบัญชีอื่น เปิดบัญชีใหม่ไม่ได้ และบัญชีเดิมไม่เปลี่ยนเจ้าของ', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const first = await seedMember({ name: 'เจ้าของเดิม', studentId: '6512345' })
    await seedAccount(first.id, { loginId: '6512345' })
    // ทะเบียนของเจ้าของเดิมถูกเปลี่ยนเป็นรหัสอื่น แล้วรหัสเดิมถูกใส่ให้สมาชิกอีกคน
    await call(`/api/members/${first.id}`, { method: 'PATCH', as: admin, body: { ...INPUT, name: 'เจ้าของเดิม', studentId: '6500001', expectedVersion: 1 } })
    const second = (await data(await createMember(admin, { name: 'คนใหม่', studentId: '6512345' }))).member
    const res = await setPassword(admin, second.id, { studentId: '6512345', password: TEMP })
    expect(res.status).toBe(409)
    expect((await data(res)).error).toBe('login_id_taken')
    expect(await accountRow(second.id)).toBeNull()
    // รหัสผ่านของเจ้าของเดิมยังเข้าได้ด้วยรหัสเดิม และได้ session ของเจ้าของเดิม ไม่ใช่ของคนใหม่
    const ok = await login('6512345', MEMBER_PASSWORD)
    expect(ok.status).toBe(200)
    const cookie = ok.headers.get('Set-Cookie')!.split(';')[0]
    expect((await data(await call('/api/session', { cookie }))).member.id).toBe(first.id)

    // หลังผู้ดูแลยืนยันรหัสใหม่ของเจ้าของเดิม จึงเปิดบัญชีของคนใหม่ได้
    expect((await call(`/api/members/${first.id}/account/login-id`, { method: 'POST', as: admin, body: { studentId: '6500001' } })).status).toBe(200)
    expect((await setPassword(admin, second.id, { studentId: '6512345', password: TEMP })).status).toBe(201)
    expect((await accountRow(first.id))?.login_id).toBe('6500001')
  })

  it('ยืนยันรหัสเข้าสู่ระบบไม่ได้เมื่อรหัสในทะเบียนว่าง หรือซ้ำกับรหัสเข้าสู่ระบบของบัญชีอื่น', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const a = await seedMember({ studentId: '' })
    await seedAccount(a.id, { loginId: '6512345' })
    const blank = await call(`/api/members/${a.id}/account/login-id`, { method: 'POST', as: admin, body: { studentId: '' } })
    expect(blank.status).toBe(409)
    // บัญชียังใช้รหัสเดิมได้ แม้ทะเบียนจะไม่มีรหัสแล้ว
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)

    const b = await seedMember({ studentId: '6500002' })
    await seedAccount(b.id, { loginId: '6500009' })
    const c = await seedMember({ studentId: '6500009' })
    await seedAccount(c.id, { loginId: '6500010' })
    const taken = await call(`/api/members/${c.id}/account/login-id`, { method: 'POST', as: admin, body: { studentId: '6500009' } })
    expect(taken.status).toBe(409)
    expect((await data(taken)).error).toBe('login_id_taken')
    expect((await accountRow(c.id))?.login_id).toBe('6500010')
  })
})
