import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, resetDb, seedAccount, seedMember, seedMemberSession, seedUser } from './helpers'
import type { Actor } from './helpers'
import { createMemberWithId } from '../worker/members'
import { connectClub, FakeWorkspace, syncNow } from './workspace'

let admin: Actor
let staff: Actor
beforeEach(async () => {
  await resetDb()
  admin = await seedUser(CLUB_EMAIL, 'admin')
  staff = await seedUser('staff@example.test', 'staff')
})
afterEach(() => vi.unstubAllGlobals())

const row = (id: string) => env.DB.prepare('SELECT id FROM members WHERE id = ?').bind(id).first()
const marker = (id: string) => env.DB.prepare('SELECT * FROM member_deletions WHERE member_id = ?').bind(id).first()
const listed = async (id: string) => (await data(await call('/api/members', { as: admin }))).members.find((m: { id: string }) => m.id === id)
const payload = async (id: string) => {
  const member = await listed(id)
  return { expectedVersion: member.version, expectedAccountRevision: member.account.revision ?? '' }
}
const remove = (id: string, body: unknown, as: Actor | null = admin, options: Record<string, unknown> = {}) =>
  call(`/api/members/${id}/delete`, { method: 'POST', as, body, ...options })

describe('ลบข้อมูลสมาชิกเฉพาะเว็บ', () => {
  it('เฉพาะ admin พร้อม CSRF/Origin; สมาชิกและ staff ลบทะเบียนไม่ได้', async () => {
    const target = await seedMember({ studentId: '6501011' })
    await seedAccount(target.id, { loginId: '6501011' })
    const member = await seedMemberSession(target.id)
    const body = await payload(target.id)
    expect((await remove(target.id, body, null)).status).toBe(401)
    expect((await remove(target.id, body, member)).status).toBe(403)
    expect((await remove(target.id, body, staff)).status).toBe(403)
    expect((await remove(target.id, body, admin, { raw: true })).status).toBe(403)
    expect((await remove(target.id, body, admin, { raw: true, headers: { Origin: 'https://other.example', 'X-CSRF-Token': admin.csrf } })).status).toBe(403)
    expect(await row(target.id)).not.toBeNull()
    expect(await marker(target.id)).toBeNull()
  })

  it('ลบทะเบียน บัญชี ทุก session รูป และนักกีฬาใน transaction เดียว ไม่แตะบุคคลอื่นหรือบัญชีทีมงาน', async () => {
    const target = await seedMember({ studentId: '6501012' })
    const other = await seedMember({ studentId: '6501013' })
    await seedAccount(target.id, { loginId: '6501012' })
    await seedAccount(other.id, { loginId: '6501013' })
    const session = await seedMemberSession(target.id)
    await seedMemberSession(target.id)
    await env.DB.prepare("INSERT INTO member_photos (member_id,content_type,bytes,size,width,height,version,updated_by,updated_at) VALUES (?,'image/jpeg',?,4,1,1,'v1',?,'2026-10-09')").bind(target.id, new Uint8Array([255,216,255,217]), admin.id).run()
    await env.DB.prepare("INSERT INTO athletes (member_id,game,status,created_by,updated_by,created_at,updated_at) VALUES (?,'RoV','active',?,?,'2026-10-09','2026-10-09')").bind(target.id, admin.id, admin.id).run()
    expect((await remove(target.id, await payload(target.id))).status).toBe(200)
    for (const table of ['members','member_accounts','member_sessions','member_photos','athletes']) {
      const field = table === 'members' ? 'id' : 'member_id'
      expect(await env.DB.prepare(`SELECT ${field} FROM ${table} WHERE ${field} = ?`).bind(target.id).first()).toBeNull()
    }
    expect(await listed(target.id)).toBeUndefined()
    expect(await row(other.id)).not.toBeNull()
    expect((await data(await call('/api/session', { as: session }))).member).toBeNull()
    expect((await call('/api/members', { as: admin })).status).toBe(200)
    const deleted = await marker(target.id)
    expect(Object.keys(deleted!)).toEqual(['member_id','deleted_by','deleted_at'])
    expect(deleted!.deleted_by).toBe(admin.id)
  })

  it('รุ่นทะเบียนหรือบัญชีเปลี่ยนหลังเปิด dialog: ไม่ลบและคืนข้อมูลปัจจุบัน', async () => {
    const target = await seedMember({ studentId: '6501014' })
    await seedAccount(target.id, { loginId: '6501014' })
    const before = await payload(target.id)
    await env.DB.prepare('UPDATE members SET name = ?, version = version + 1 WHERE id = ?').bind('ชื่อใหม่ ทดสอบ', target.id).run()
    const conflict = await remove(target.id, before)
    expect(conflict.status).toBe(409)
    expect((await data(conflict)).current.name).toBe('ชื่อใหม่ ทดสอบ')
    const changed = await payload(target.id)
    await env.DB.prepare("UPDATE member_accounts SET revision = 'different' WHERE member_id = ?").bind(target.id).run()
    expect((await remove(target.id, changed)).status).toBe(409)
    expect(await marker(target.id)).toBeNull()
  })

  it('ตรวจรุ่นซ้ำใน transaction เมื่อแก้ไขมาถึงระหว่างอ่านข้อมูลกับเริ่มลบ', async () => {
    const target = await seedMember()
    const before = await payload(target.id)
    const db = new Proxy(env.DB, { get(db, name) {
      if (name === 'batch') return async (statements: D1PreparedStatement[]) => {
        await env.DB.prepare('UPDATE members SET version = version + 1 WHERE id = ?').bind(target.id).run()
        return env.DB.batch(statements)
      }
      const value = Reflect.get(db, name)
      return typeof value === 'function' ? value.bind(db) : value
    } })
    expect((await remove(target.id, before, admin, { env: { ...env, DB: db } })).status).toBe(409)
    expect(await row(target.id)).not.toBeNull()
    expect(await marker(target.id)).toBeNull()
  })

  it('transaction ล้มเหลว: ทะเบียนและบัญชียังอยู่ ไม่มี marker ค้าง', async () => {
    const target = await seedMember({ studentId: '6501015' })
    await seedAccount(target.id, { loginId: '6501015' })
    const db = new Proxy(env.DB, { get(db, name) {
      if (name === 'batch') return (statements: D1PreparedStatement[]) => env.DB.batch([...statements, env.DB.prepare('INSERT INTO nonexistent_table VALUES (1)')])
      const value = Reflect.get(db, name)
      return typeof value === 'function' ? value.bind(db) : value
    } })
    expect((await remove(target.id, await payload(target.id), admin, { env: { ...env, DB: db } })).status).toBe(500)
    expect(await row(target.id)).not.toBeNull()
    expect(await env.DB.prepare('SELECT member_id FROM member_accounts WHERE member_id = ?').bind(target.id).first()).not.toBeNull()
    expect(await marker(target.id)).toBeNull()
  })

  it('เรียกซ้ำหลังคำตอบหายไม่ลบอะไรเพิ่ม และ ID ที่ไม่เคยมีไม่ถือว่าลบสำเร็จ', async () => {
    const target = await seedMember()
    const before = await payload(target.id)
    expect((await remove(target.id, before)).status).toBe(200)
    expect(await data(await remove(target.id, before))).toEqual({ deleted: false })
    expect((await remove('not-a-member', before)).status).toBe(404)
  })

  it('ไม่คืนทะเบียนจาก retry คำสั่งเพิ่มเก่า หรือ Forms stable ID ที่ถูกลบ', async () => {
    const body = { name: 'สมชาย ทดสอบ', nickname: 'ชาย', studentId: '6501016', role: 'member', status: 'active', contact: '', note: '' }
    const createKey = key()
    const created = await data(await call('/api/members', { method: 'POST', as: admin, body, headers: { 'Idempotency-Key': createKey } }))
    const id = created.member.id
    await remove(id, await payload(id))
    expect((await call('/api/members', { method: 'POST', as: admin, body, headers: { 'Idempotency-Key': createKey } })).status).toBe(409)
    await expect(createMemberWithId(env, admin.id, id, { name: body.name, nickname: body.nickname, role: 'member', status: 'active', contact: '', note: '' })).rejects.toMatchObject({ code: 'member_deleted' })
    // รอเขียนจากรอบนำเข้าที่อ่านข้อมูลก่อนลบ: ถึงไม่ได้อ่าน marker ใหม่ DB ก็ห้ามคืน ID เดิม
    const staleInsert = await env.DB.prepare(`INSERT INTO members (id,name,nickname,role,status,contact,note,added_at,version,created_by,updated_by,created_at,updated_at)
      VALUES (?,'ข้อมูลจากรอบเก่า','','member','active','','','2026-10-09',1,'seed','seed','2026-10-09','2026-10-09')`).bind(id).run()
    expect(staleInsert.meta.changes).toBe(0)
    expect(await row(id)).toBeNull()
  })

  it('คงแถวใน Google Sheets ที่อ่านอย่างเดียว และซิงค์ซ้ำไม่สร้างทะเบียนที่ลบกลับมา', async () => {
    const google = await FakeGoogle.start()
    const workspace = new FakeWorkspace(google)
    await connectClub(google)
    const columns = { id: 'ID', name: 'ชื่อ', nickname: 'ชื่อเล่น', role: 'บทบาท', status: 'สถานะ', contact: 'ติดต่อ', note: 'หมายเหตุ', addedAt: 'วันที่เพิ่ม', studentId: 'รหัสนักศึกษา' }
    const rows = [Object.values(columns), ['sheet-deleted','สมชาย ชีต','ชาย','สมาชิก','ใช้งาน','','','2026-10-01','6501017'], ['sheet-kept','สมหญิง ชีต','หญิง','สมาชิก','ใช้งาน','','','2026-10-01','6501018']]
    const sheet = workspace.addSheet('ทะเบียนทดสอบ', rows, { canEdit: false })
    const link = await call('/api/setup/link', { method: 'POST', as: admin, body: { kind: 'sheets', resourceId: sheet.id, sheetId: 0, headerRow: 1, columns } })
    expect(link.status).toBe(201)
    await syncNow('sheets', admin)
    const original = JSON.stringify(sheet.tabs[0].cells)
    expect((await remove('sheet-deleted', await payload('sheet-deleted'))).status).toBe(200)
    expect(JSON.stringify(sheet.tabs[0].cells)).toBe(original)
    await seedMember({ studentId: '6501017' })
    await syncNow('sheets', admin)
    expect(await row('sheet-deleted')).toBeNull()
    expect(await row('sheet-kept')).not.toBeNull()
    expect(JSON.stringify(sheet.tabs[0].cells)).toBe(original)
    const survivor = (await data(await call('/api/members', { as: admin }))).members.find((m: { studentId: string }) => m.studentId === '6501017')
    expect(survivor.studentIdIssue).toBeNull()
  })
})
