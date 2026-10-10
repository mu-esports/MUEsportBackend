import { beforeEach, describe, expect, it } from 'vitest'
import { handleMemberSelf } from '../worker/accounts'
import { loadSession } from '../worker/session'
import { call, CLUB_EMAIL, data, env, MEMBER_PASSWORD, ORIGIN, resetDb, seedAccount, seedMember, seedUser } from './helpers'
import type { Actor } from './helpers'

beforeEach(resetDb)
const NEXT = 'My-Personal-Secret-3019'
async function signedIn(mustChange = true) {
  const member = await seedMember({ studentId: '6543210' })
  await seedAccount(member.id, { loginId: '6543210', mustChange })
  const res = await call('/auth/member/login', { method: 'POST', body: { studentId: '6543210', password: MEMBER_PASSWORD } })
  expect(res.status).toBe(200)
  const cookie = res.headers.get('Set-Cookie')!.split(';')[0]
  const session = await data(await call('/api/session', { cookie }))
  return { id: member.id, cookie, csrf: session.csrfToken } satisfies Actor
}
const setup = (as: Actor | null, body: unknown = { newPassword: NEXT }) => call('/api/member/password/setup', { method: 'POST', as, body })

describe('ตั้งรหัสส่วนตัวโดยใช้การยืนยันจาก login', () => {
  it('รหัสชั่วคราวถูกตรวจเพียงที่ login: ตั้งรหัสใหม่ได้โดยไม่มี currentPassword และยกเลิก session เก่าทั้งหมด', async () => {
    const actor = await signedIn()
    const changed = await setup(actor)
    expect(changed.status).toBe(200)
    expect(await data(changed.clone())).toMatchObject({ ok: true })
    expect((await data(await call('/api/session', { as: actor }))).member).toBeNull()
    expect((await setup(actor)).status).toBe(401)
    const cookie = changed.headers.get('Set-Cookie')!.split(';')[0]
    const session = await data(await call('/api/session', { cookie }))
    expect(session.member.mustChangePassword).toBe(false)
    expect(session.member.id).toBe(actor.id)
    expect((await call('/api/member/me', { cookie })).status).toBe(200)
    expect((await call('/auth/member/login', { method: 'POST', body: { studentId: '6543210', password: MEMBER_PASSWORD } })).status).toBe(401)
    expect((await call('/auth/member/login', { method: 'POST', body: { studentId: '6543210', password: NEXT } })).status).toBe(200)
  })

  it('anonymous และทีมงานตั้งรหัสผ่านของสมาชิกผ่านเส้นทางนี้ไม่ได้', async () => {
    expect((await setup(null)).status).toBe(401)
    expect((await setup(await seedUser(CLUB_EMAIL, 'admin'))).status).toBe(403)
  })

  it('ต้องผ่าน Origin และ CSRF แม้มี session จากการตรวจรหัสชั่วคราวแล้ว', async () => {
    const actor = await signedIn()
    expect((await setup({ ...actor, csrf: 'wrong' })).status).toBe(403)
    expect((await call('/api/member/password/setup', { method: 'POST', as: actor, body: { newPassword: NEXT }, raw: true, headers: { Origin: 'https://other.example.test', 'X-CSRF-Token': actor.csrf } })).status).toBe(403)
  })

  it('บัญชีที่ใช้รหัสส่วนตัวแล้วต้องรับรหัสชั่วคราวจาก admin ก่อนเปลี่ยนได้', async () => {
    const actor = await signedIn(false)
    const res = await setup(actor)
    expect(res.status).toBe(403)
    expect((await data(res)).error).toBe('admin_reset_required')
  })

  it('การยืนยันตัวตนมีอายุ 15 นาที: session เก่า เวลาผิดรูปแบบ หรืออยู่ในอนาคตตั้งรหัสไม่ได้', async () => {
    const actor = await signedIn()
    for (const created of [new Date(Date.now() - 15 * 60_000).toISOString(), 'invalid', new Date(Date.now() + 60_000).toISOString()]) {
      await env.DB.prepare('UPDATE member_sessions SET created_at = ? WHERE member_id = ?').bind(created, actor.id).run()
      const res = await setup(actor)
      expect(res.status).toBe(409)
      expect((await data(res)).error).toBe('password_setup_expired')
    }
  })

  it('ยังตรวจความยาว รหัสนักศึกษา และการใช้รหัสชั่วคราวซ้ำ ก่อนบันทึก', async () => {
    const actor = await signedIn()
    for (const next of ['', 'short', '6543210', 'x'.repeat(129), MEMBER_PASSWORD]) {
      const res = await setup(actor, { newPassword: next })
      expect(res.status).toBe(422)
      expect((await data(res)).field).toBe('newPassword')
    }
    expect((await data(await call('/api/session', { as: actor }))).member.mustChangePassword).toBe(true)
  })

  it('admin รีเซ็ตรหัสใหม่แล้ว session ที่ยืนยันด้วยรหัสชั่วคราวเดิมใช้ตั้งรหัสไม่ได้', async () => {
    const actor = await signedIn()
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    expect((await call(`/api/members/${actor.id}/account/password`, { method: 'POST', as: admin, body: { studentId: '6543210', password: 'Temporary-New-0912' } })).status).toBe(200)
    expect((await setup(actor)).status).toBe(401)
  })

  it('session ถูกถอนหลังโหลดแล้ว: การบันทึกตรวจซ้ำใน transaction จึงไม่เปลี่ยนรหัสและไม่สร้าง session ใหม่', async () => {
    const actor = await signedIn()
    const url = new URL(ORIGIN + '/api/member/password/setup')
    const request = new Request(url, { method: 'POST', headers: { Cookie: actor.cookie, Origin: ORIGIN, 'X-CSRF-Token': actor.csrf, 'Content-Type': 'application/json' }, body: JSON.stringify({ newPassword: NEXT }) })
    const session = await loadSession(request, env)
    const before = await env.DB.prepare('SELECT password_hash FROM member_accounts WHERE member_id = ?').bind(actor.id).first()
    await env.DB.prepare('DELETE FROM member_sessions WHERE member_id = ?').bind(actor.id).run()
    await expect(handleMemberSelf({ request, url, session, env }, ['password', 'setup'])).rejects.toMatchObject({ status: 409, code: 'password_changed' })
    expect(await env.DB.prepare('SELECT password_hash FROM member_accounts WHERE member_id = ?').bind(actor.id).first()).toEqual(before)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<{ n: number }>())?.n).toBe(0)
  })
})
