import { beforeEach, describe, expect, it } from 'vitest'
import type { AppEnv } from '../worker/env'
import { call, CLUB_EMAIL, data, env, MEMBER_PASSWORD, resetDb, seedAccount, seedMember, seedMemberSession, seedSession, seedUser } from './helpers'
import type { Actor } from './helpers'

/**
 * ลบบัญชีเข้าสู่ระบบของสมาชิก (เฉพาะผู้ดูแล): สิทธิ์ การลบพร้อม session แบบสำเร็จหรือไม่สำเร็จทั้งชุด การเปิดบัญชีใหม่ การชนกับการแก้จากที่อื่น และการเรียกซ้ำ
 * ทุกข้อรันกับ Worker และ D1 local ของชุดทดสอบ ไม่มีการเรียก Google
 */
beforeEach(resetDb)

const TEMP = 'Temp-Pass-7391'

let admin: Actor
let staff: Actor

const remove = (as: Actor | null, memberId: string, body: unknown, options: { raw?: boolean; env?: AppEnv; headers?: Record<string, string> } = {}) =>
  call(`/api/members/${memberId}/account/delete`, { method: 'POST', as, body, ...options })
const status = (as: Actor | null, memberId: string) => call(`/api/members/${memberId}/account`, { as })
const setPassword = (memberId: string, studentId: string, password = TEMP) =>
  call(`/api/members/${memberId}/account/password`, { method: 'POST', as: admin, body: { studentId, password } })
const login = (studentId: string, password: string) => call('/auth/member/login', { method: 'POST', body: { studentId, password } })

const accountRow = (id: string) => env.DB.prepare('SELECT * FROM member_accounts WHERE member_id = ?').bind(id).first<Record<string, any>>()
const count = async (sql: string, ...values: unknown[]) => (await env.DB.prepare(sql).bind(...values).first<{ n: number }>())!.n
const sessionsOf = (id: string) => count('SELECT COUNT(*) AS n FROM member_sessions WHERE member_id = ?', id)
const revisionOf = async (id: string) => (await data(await status(admin, id))).account.revision as string

/** สมาชิกที่มีบัญชีและ session สองอุปกรณ์ */
async function memberWithAccount(studentId: string, name = 'สมหญิง ทดสอบ') {
  const member = await seedMember({ studentId, name })
  await seedAccount(member.id, { loginId: studentId })
  const sessions = [await seedMemberSession(member.id), await seedMemberSession(member.id)]
  return { id: member.id, studentId, sessions }
}

beforeEach(async () => {
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staff = await seedUser('staff@example.com', 'staff')
})

describe('สิทธิ์ลบบัญชีเข้าสู่ระบบ', () => {
  it('ต้องเป็นผู้ดูแลที่เข้าสู่ระบบด้วย Google พร้อม Origin และ CSRF ของเว็บ: คนอื่นลบไม่ได้และไม่มีอะไรถูกลบ', async () => {
    const target = await memberWithAccount('6500001')
    const other = await memberWithAccount('6500002', 'สมชาย ทดสอบ')
    const revision = await revisionOf(target.id)
    const body = { expectedRevision: revision }

    expect((await remove(null, target.id, body)).status).toBe(401)
    // สมาชิก (แม้เป็นเจ้าของบัญชีเอง หรือบทบาทในทะเบียนเป็นผู้ดูแล) ลบไม่ได้
    const roleAdmin = await seedMember({ studentId: '6500003', role: 'admin' })
    await seedAccount(roleAdmin.id, { loginId: '6500003' })
    for (const actor of [target.sessions[0], other.sessions[0], await seedMemberSession(roleAdmin.id)]) {
      const res = await remove(actor, target.id, body)
      expect(res.status).toBe(403)
      expect((await data(res)).error).toBe('staff_only')
    }
    // ทีมงานทั่วไปไม่ใช่ผู้ดูแล
    const byStaff = await remove(staff, target.id, body)
    expect(byStaff.status).toBe(403)
    expect((await data(byStaff)).error).toBe('forbidden')
    // ผู้ดูแลแต่คำขอไม่ได้มาจากหน้าเว็บ (ไม่มี Origin/CSRF, Origin อื่น หรือ CSRF ของ session อื่น)
    const noHeaders = await remove(admin, target.id, body, { raw: true })
    expect(noHeaders.status).toBe(403)
    expect((await data(noHeaders)).error).toBe('bad_origin')
    const foreign = await remove(admin, target.id, body, { raw: true, headers: { Origin: 'https://evil.example', 'X-CSRF-Token': admin.csrf } })
    expect((await data(foreign)).error).toBe('bad_origin')
    const wrongCsrf = await remove({ ...admin, csrf: staff.csrf }, target.id, body)
    expect((await data(wrongCsrf)).error).toBe('bad_csrf')
    // เส้นทางนี้รับเฉพาะ POST
    for (const method of ['GET', 'DELETE', 'PUT', 'PATCH']) expect((await call(`/api/members/${target.id}/account/delete`, { method, as: admin, body: method === 'GET' ? undefined : body })).status, method).toBe(404)

    expect(await accountRow(target.id)).not.toBeNull()
    expect(await sessionsOf(target.id)).toBe(2)
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_account.deleted'`)).toBe(0)
  })

  it('อ่านสถานะบัญชีของสมาชิกหนึ่งคนได้เฉพาะทีมงาน และคำตอบไม่มีตัวตรวจรหัสผ่าน', async () => {
    const target = await memberWithAccount('6500001')
    expect((await status(null, target.id)).status).toBe(401)
    expect((await status(target.sessions[0], target.id)).status).toBe(403)
    const res = await status(staff, target.id)
    expect(res.status).toBe(200)
    const text = await res.text()
    const body = JSON.parse(text)
    expect(body.account).toMatchObject({ state: 'active', loginId: '6500001' })
    expect(typeof body.account.revision).toBe('string')
    const row = await accountRow(target.id)
    expect(text).not.toContain(row!.password_hash)
    expect(text).not.toMatch(/argon2|password_hash|salt/i)
    expect((await status(staff, 'no-such-member')).status).toBe(404)
  })
})

describe('ลบบัญชีเข้าสู่ระบบ', () => {
  it('ลบบัญชีและ session ทั้งหมดของคนนั้นเท่านั้น: ทะเบียน นักกีฬา รูป บัญชีคนอื่น และ session ของทีมงานยังอยู่ครบ', async () => {
    const target = await memberWithAccount('6500001')
    const other = await memberWithAccount('6500002', 'สมชาย ทดสอบ')
    const now = new Date().toISOString()
    await env.DB.batch([
      env.DB.prepare(`INSERT INTO athletes (member_id, game, status, created_by, updated_by, created_at, updated_at) VALUES (?, 'Valorant', 'active', 'seed', 'seed', ?, ?)`).bind(target.id, now, now),
      env.DB.prepare(`INSERT INTO member_photos (member_id, content_type, bytes, size, width, height, version, updated_by, updated_at) VALUES (?, 'image/png', ?, 4, 8, 8, 'v-test', 'seed', ?)`).bind(target.id, new Uint8Array([1, 2, 3, 4]), now),
    ])
    const staffSessionsBefore = await count('SELECT COUNT(*) AS n FROM sessions')
    const memberBefore = await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(target.id).first()
    const hashBefore = (await accountRow(target.id))!.password_hash as string

    const res = await remove(admin, target.id, { expectedRevision: await revisionOf(target.id) })
    expect(res.status).toBe(200)
    const text = await res.text()
    expect(JSON.parse(text)).toEqual({
      account: { state: 'none', loginId: null, loginMismatch: false, passwordSetAt: null, lastLoginAt: null, blocked: null, revision: null },
      deleted: true,
    })
    // คำตอบและ audit ไม่มีตัวตรวจรหัสผ่านหรือรหัสนักศึกษา
    expect(text).not.toContain(hashBefore)
    const audit = await env.DB.prepare(`SELECT * FROM audit_log WHERE action = 'member_account.deleted'`).all<Record<string, any>>()
    expect(audit.results).toHaveLength(1)
    expect(audit.results[0]).toMatchObject({ user_id: admin.id, target: target.id, detail: '' })
    expect(JSON.stringify(audit.results)).not.toContain(hashBefore)
    expect(JSON.stringify(audit.results)).not.toContain('6500001')

    expect(await accountRow(target.id)).toBeNull()
    expect(await sessionsOf(target.id)).toBe(0)
    // ของคนอื่นและของทีมงานไม่ถูกแตะ
    expect(await accountRow(other.id)).not.toBeNull()
    expect(await sessionsOf(other.id)).toBe(2)
    expect((await call('/api/member/me', { as: other.sessions[0] })).status).toBe(200)
    expect(await count('SELECT COUNT(*) AS n FROM sessions')).toBe(staffSessionsBefore)
    expect((await call('/api/members', { as: staff })).status).toBe(200)
    // ทะเบียน โปรไฟล์นักกีฬา และรูปของคนที่ถูกลบบัญชียังอยู่
    expect(await env.DB.prepare('SELECT * FROM members WHERE id = ?').bind(target.id).first()).toEqual(memberBefore)
    expect(await count('SELECT COUNT(*) AS n FROM athletes WHERE member_id = ?', target.id)).toBe(1)
    expect(await count('SELECT COUNT(*) AS n FROM member_photos WHERE member_id = ?', target.id)).toBe(1)
    const listed = (await data(await call('/api/members', { as: staff }))).members.find((m: any) => m.id === target.id)
    expect(listed).toMatchObject({ studentId: '6500001', photoVersion: 'v-test', athlete: { game: 'Valorant', status: 'active' } })
    expect(listed.account).toMatchObject({ state: 'none', revision: null, blocked: null })
    // session เดิมของคนที่ถูกลบใช้ไม่ได้ทันที ทั้งอ่านข้อมูลตนเองและอ่านรูปของตัวเอง
    for (const session of target.sessions) {
      expect((await call('/api/member/me', { as: session })).status).toBe(401)
      expect((await call(`/api/members/${target.id}/photo`, { as: session })).status).toBe(401)
      expect((await data(await call('/api/session', { as: session }))).member).toBeNull()
    }
    // เข้าสู่ระบบด้วยรหัสเดิมไม่ได้ และคำตอบเหมือนกรณีไม่มีบัญชี
    const denied = await login('6500001', MEMBER_PASSWORD)
    expect(denied.status).toBe(401)
    expect((await data(denied)).error).toBe('invalid_credentials')
  })

  it('เปิดบัญชีใหม่ได้ตามกฎเดิม: session เก่ายังใช้ไม่ได้ รหัสผ่านเก่าใช้ไม่ได้ และบัญชีใหม่มีรุ่นใหม่', async () => {
    const target = await memberWithAccount('6500001')
    const oldRevision = await revisionOf(target.id)
    expect((await remove(admin, target.id, { expectedRevision: oldRevision })).status).toBe(200)

    const opened = await setPassword(target.id, '6500001')
    expect(opened.status).toBe(201)
    const account = (await data(opened)).account
    expect(account).toMatchObject({ state: 'must_change', loginId: '6500001' })
    expect(account.revision).not.toBe(oldRevision)
    // session ที่ออกก่อนลบบัญชีถูกลบจริง จึงไม่กลับมาใช้ได้เมื่อมีบัญชีใหม่
    for (const session of target.sessions) expect((await call('/api/member/me', { as: session })).status).toBe(401)
    expect((await login('6500001', MEMBER_PASSWORD)).status).toBe(401)
    const fresh = await login('6500001', TEMP)
    expect(fresh.status).toBe(200)
    expect(await data(fresh)).toEqual({ ok: true, mustChangePassword: true })
    // กล่องยืนยันเก่าที่ถือรุ่นของบัญชีเดิม ลบบัญชีใหม่ไม่ได้
    const stale = await remove(admin, target.id, { expectedRevision: oldRevision })
    expect(stale.status).toBe(409)
    expect((await data(stale)).error).toBe('account_changed')
    expect(await accountRow(target.id)).not.toBeNull()
    expect(await sessionsOf(target.id)).toBe(1)
  })

  it('บัญชีที่ปิดอยู่ก็ลบได้ และสมาชิกที่ถูกพักการใช้งานยังลบบัญชีได้', async () => {
    const disabled = await seedMember({ studentId: '6500001' })
    await seedAccount(disabled.id, { loginId: '6500001', status: 'disabled' })
    const suspended = await seedMember({ studentId: '6500002', status: 'suspended' })
    await seedAccount(suspended.id, { loginId: '6500002' })
    for (const id of [disabled.id, suspended.id]) {
      const res = await remove(admin, id, { expectedRevision: await revisionOf(id) })
      expect(res.status).toBe(200)
      expect((await data(res)).deleted).toBe(true)
      expect(await accountRow(id)).toBeNull()
    }
    expect(await count('SELECT COUNT(*) AS n FROM members')).toBe(2)
  })
})

describe('กันกล่องยืนยันเก่าและคำขอซ้ำ', () => {
  it('บัญชีถูกรีเซ็ตรหัส ปิด หรือเปลี่ยนรหัสเข้าสู่ระบบจากที่อื่นหลังเปิดกล่อง: ไม่ลบ ตอบ 409 พร้อมสถานะล่าสุด', async () => {
    const target = await memberWithAccount('6500001')
    const seen = await revisionOf(target.id)

    // อีกแท็บรีเซ็ตรหัสผ่าน (สมาชิกเข้าสู่ระบบใหม่ด้วยรหัสชั่วคราวแล้ว)
    expect((await setPassword(target.id, '6500001')).status).toBe(200)
    expect((await login('6500001', TEMP)).status).toBe(200)
    const afterReset = await revisionOf(target.id)
    expect(afterReset).not.toBe(seen)
    const res = await remove(admin, target.id, { expectedRevision: seen })
    expect(res.status).toBe(409)
    const body = await data(res)
    expect(body.error).toBe('account_changed')
    expect(body.account).toMatchObject({ state: 'must_change', loginId: '6500001', revision: afterReset })
    expect(await accountRow(target.id)).not.toBeNull()
    expect(await sessionsOf(target.id)).toBe(1)

    // ปิดบัญชี และยืนยันเปลี่ยนรหัสเข้าสู่ระบบ ก็เปลี่ยนรุ่นเช่นกัน
    expect((await call(`/api/members/${target.id}/account/disable`, { method: 'POST', as: admin, body: {} })).status).toBe(200)
    const afterDisable = await revisionOf(target.id)
    expect(afterDisable).not.toBe(afterReset)
    expect((await remove(admin, target.id, { expectedRevision: afterReset })).status).toBe(409)
    await env.DB.prepare(`UPDATE members SET student_id = '6599999' WHERE id = ?`).bind(target.id).run()
    expect((await call(`/api/members/${target.id}/account/login-id`, { method: 'POST', as: admin, body: { studentId: '6599999' } })).status).toBe(200)
    const afterLoginId = await revisionOf(target.id)
    expect(afterLoginId).not.toBe(afterDisable)
    expect((await remove(admin, target.id, { expectedRevision: afterDisable })).status).toBe(409)
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_account.deleted'`)).toBe(0)

    // ตรวจสถานะล่าสุดแล้วยืนยันใหม่ด้วยรุ่นล่าสุด: ลบได้
    expect((await remove(admin, target.id, { expectedRevision: afterLoginId })).status).toBe(200)
    expect(await accountRow(target.id)).toBeNull()
  })

  it('การเข้าสู่ระบบของสมาชิกไม่เปลี่ยนรุ่นของบัญชี แต่การเปลี่ยนรหัสผ่านเองเปลี่ยน', async () => {
    const target = await memberWithAccount('6500001')
    const before = await revisionOf(target.id)
    const session = await login('6500001', MEMBER_PASSWORD)
    expect(session.status).toBe(200)
    expect(await revisionOf(target.id)).toBe(before)

    const cookie = session.headers.get('Set-Cookie')!.split(';')[0]
    const csrf = (await data(await call('/api/session', { cookie }))).csrfToken
    const changed = await call('/api/member/password', { method: 'POST', as: { id: target.id, cookie, csrf }, body: { currentPassword: MEMBER_PASSWORD, newPassword: 'My-Own-Secret-2026' } })
    expect(changed.status).toBe(200)
    expect(await revisionOf(target.id)).not.toBe(before)
  })

  it('บัญชีเปลี่ยนรุ่นระหว่างคำขอลบ (หลังตรวจแล้วแต่ก่อนลบ): คำสั่งลบทั้งชุดไม่ลบอะไร และ session ยังอยู่', async () => {
    const target = await memberWithAccount('6500001')
    const seen = await revisionOf(target.id)
    // ฐานข้อมูลที่จำลองว่ามีการรีเซ็ตจากอีกคำขอ แทรกเข้ามาก่อนคำสั่งลบชุดนี้พอดี
    let raced = false
    const racingDb = new Proxy(env.DB, {
      get(db, property) {
        if (property === 'batch') {
          return async (statements: D1PreparedStatement[]) => {
            if (!raced) {
              raced = true
              await db.prepare(`UPDATE member_accounts SET revision = 'changed-elsewhere' WHERE member_id = ?`).bind(target.id).run()
            }
            return db.batch(statements)
          }
        }
        const value = Reflect.get(db, property)
        return typeof value === 'function' ? value.bind(db) : value
      },
    })
    const res = await remove(admin, target.id, { expectedRevision: seen }, { env: { ...env, DB: racingDb } })
    expect(raced).toBe(true)
    expect(res.status).toBe(409)
    expect((await data(res)).account.revision).toBe('changed-elsewhere')
    expect(await accountRow(target.id)).not.toBeNull()
    expect(await sessionsOf(target.id)).toBe(2)
    for (const session of target.sessions) expect((await call('/api/member/me', { as: session })).status).toBe(200)
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_account.deleted'`)).toBe(0)
  })

  it('ฐานข้อมูลล้มเหลวระหว่างลบ: ตอบข้อผิดพลาด ไม่บันทึกว่าลบ และบัญชีกับ session ยังอยู่ครบ', async () => {
    const target = await memberWithAccount('6500001')
    const failingDb = new Proxy(env.DB, {
      get(db, property) {
        if (property === 'batch') return async () => Promise.reject(new Error('D1_ERROR: simulated failure'))
        const value = Reflect.get(db, property)
        return typeof value === 'function' ? value.bind(db) : value
      },
    })
    const res = await remove(admin, target.id, { expectedRevision: await revisionOf(target.id) }, { env: { ...env, DB: failingDb } })
    expect(res.status).toBe(500)
    expect((await data(res)).error).toBe('internal_error')
    expect(await accountRow(target.id)).not.toBeNull()
    expect(await sessionsOf(target.id)).toBe(2)
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_account.deleted'`)).toBe(0)
    // ลองใหม่หลังระบบกลับมา: ลบได้ตามปกติ
    expect((await remove(admin, target.id, { expectedRevision: await revisionOf(target.id) })).status).toBe(200)
  })

  it('เรียกซ้ำหลังลบแล้ว หรือสมาชิกไม่มีบัญชี: ตอบสถานะปัจจุบันโดยไม่ทำอะไรเพิ่ม และไม่บันทึกซ้ำ', async () => {
    const target = await memberWithAccount('6500001')
    const revision = await revisionOf(target.id)
    expect((await remove(admin, target.id, { expectedRevision: revision })).status).toBe(200)
    const again = await remove(admin, target.id, { expectedRevision: revision })
    expect(again.status).toBe(200)
    expect(await data(again)).toMatchObject({ deleted: false, account: { state: 'none', revision: null } })
    expect(await count(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member_account.deleted'`)).toBe(1)

    const never = await seedMember({ studentId: '6500002' })
    const none = await remove(admin, never.id, { expectedRevision: '' })
    expect(none.status).toBe(200)
    expect((await data(none)).deleted).toBe(false)
    expect(await count('SELECT COUNT(*) AS n FROM members')).toBe(2)
  })

  it('คำขอที่ไม่ครบหรือผิดรูปแบบถูกปฏิเสธก่อนแตะบัญชี', async () => {
    const target = await memberWithAccount('6500001')
    for (const body of [{}, { expectedRevision: 5 }, { expectedRevision: null }, { expectedRevision: 'x'.repeat(65) }]) {
      const res = await remove(admin, target.id, body)
      expect(res.status, JSON.stringify(body)).toBe(422)
      expect((await data(res)).field).toBe('expectedRevision')
    }
    expect((await call(`/api/members/${target.id}/account/delete`, { method: 'POST', as: admin, body: 'expectedRevision=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })).status).toBe(415)
    expect((await remove(admin, 'no-such-member', { expectedRevision: 'x' })).status).toBe(404)
    expect(await accountRow(target.id)).not.toBeNull()
    expect(await sessionsOf(target.id)).toBe(2)
  })

  it('session ของทีมงานที่ใช้ลบยังใช้งานได้ต่อ และ session ทีมงานอื่นไม่ถูกยกเลิก', async () => {
    const target = await memberWithAccount('6500001')
    const second = await seedSession(admin.id)
    expect((await remove(admin, target.id, { expectedRevision: await revisionOf(target.id) })).status).toBe(200)
    expect((await call('/api/members', { as: admin })).status).toBe(200)
    expect((await call('/api/members', { as: { id: admin.id, ...second } })).status).toBe(200)
    expect((await call('/api/members', { as: staff })).status).toBe(200)
  })
})
