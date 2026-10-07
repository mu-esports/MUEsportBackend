import { beforeEach, describe, expect, it } from 'vitest'
import { call, CLUB_EMAIL, data, env, key, resetDb, seedSession, seedUser } from './helpers'

beforeEach(resetDb)

const MEMBER = { name: 'สมชาย ทดสอบ', nickname: 'ชาย', role: 'member', status: 'active', contact: '', note: '' }

describe('ยังไม่เข้าสู่ระบบ', () => {
  it('ทุกเส้นทางข้อมูลตอบ 401 เป็น JSON และห้าม cache', async () => {
    const routes: [string, string][] = [
      ['GET', '/api/members'], ['POST', '/api/members'], ['PATCH', '/api/members/x'], ['POST', '/api/members/x/status'],
      ['GET', '/api/events'], ['POST', '/api/events'], ['PATCH', '/api/events/x'],
      ['GET', '/api/users'], ['POST', '/api/users'], ['PATCH', '/api/users/x'],
      ['GET', '/api/documents'], ['POST', '/api/documents'], ['GET', '/api/documents/x'], ['PUT', '/api/documents/x'],
      ['GET', '/api/documents/operations'], ['POST', '/api/documents/operations/x/resume'], ['DELETE', '/api/documents/operations/x'],
      ['GET', '/api/sources'], ['POST', '/api/google/connect'], ['POST', '/api/google/check'], ['POST', '/api/google/disconnect'],
      ['POST', '/auth/logout'],
    ]
    for (const [method, path] of routes) {
      const res = await call(path, { method, body: method === 'GET' ? undefined : {} })
      expect(res.status, `${method} ${path}`).toBe(401)
      expect(res.headers.get('Content-Type')).toContain('application/json')
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect((await data(res)).error).toBe('unauthenticated')
    }
  })

  it('เส้นทาง API ที่ไม่มีตอบ 404 เป็น JSON ไม่ใช่หน้าเว็บ', async () => {
    const res = await call('/api/does-not-exist')
    expect(res.status).toBe(404)
    expect(res.headers.get('Content-Type')).toContain('application/json')
    expect((await data(res)).error).toBe('not_found')
  })

  it('/api/session บอกว่าไม่มีผู้ใช้ และไม่มี CSRF token', async () => {
    const body = await data(await call('/api/session'))
    expect(body).toEqual({ authConfigured: true, user: null, member: null, csrfToken: null })
  })
})

describe('สิทธิ์ staff และ admin ตรวจที่ server', () => {
  it('staff ใช้ข้อมูลสมาชิกได้ แต่จัดการทีมงานและการเชื่อม Google ไม่ได้', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    expect((await call('/api/members', { as: staff })).status).toBe(200)
    expect((await call('/api/sources', { as: staff })).status).toBe(200)
    for (const [method, path] of [
      ['GET', '/api/users'], ['POST', '/api/users'], ['PATCH', '/api/users/x'],
      ['POST', '/api/google/connect'], ['POST', '/api/google/check'], ['POST', '/api/google/disconnect'],
    ]) {
      const res = await call(path, { method, as: staff, body: method === 'GET' ? undefined : { email: 'a@b.co', role: 'admin' } })
      expect(res.status, `${method} ${path}`).toBe(403)
    }
  })

  it('ไม่เชื่อ role ที่ส่งมาจาก frontend', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const res = await call('/api/users', { method: 'POST', as: staff, headers: { 'X-Role': 'admin' }, body: { email: 'x@example.com', role: 'admin', actorRole: 'admin' } })
    expect(res.status).toBe(403)
  })

  it('role ของสมาชิกชมรม (Member.role) ไม่ให้สิทธิ์เข้าสู่ระบบ', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { ...MEMBER, role: 'admin' } })
    const users = await env.DB.prepare('SELECT COUNT(*) AS n FROM users').first<{ n: number }>()
    expect(users?.n).toBe(1)
  })

  it('admin เพิ่ม เปลี่ยนสิทธิ์ และถอนสิทธิ์ทีมงานได้ และการถอนสิทธิ์ยกเลิก session ทันที', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const staff = await seedUser('staff@example.com', 'staff')

    const added = await call('/api/users', { method: 'POST', as: admin, body: { email: '  New.Person@Example.com ', role: 'staff' } })
    expect(added.status).toBe(201)
    expect((await data(added)).user).toMatchObject({ email: 'new.person@example.com', role: 'staff', status: 'active', hasSignedIn: false })
    expect((await call('/api/users', { method: 'POST', as: admin, body: { email: 'new.person@example.com', role: 'staff' } })).status).toBe(409)
    expect((await call('/api/users', { method: 'POST', as: admin, body: { email: 'not-an-email', role: 'staff' } })).status).toBe(422)
    expect((await call('/api/users', { method: 'POST', as: admin, body: { email: 'x@example.com', role: 'owner' } })).status).toBe(422)

    expect((await call('/api/members', { as: staff })).status).toBe(200)
    const revoked = await call(`/api/users/${staff.id}`, { method: 'PATCH', as: admin, body: { status: 'revoked' } })
    expect(revoked.status).toBe(200)
    expect((await call('/api/members', { as: staff })).status).toBe(401)

    // คืนสิทธิ์แล้วต้องเข้าสู่ระบบใหม่ session เก่าใช้ไม่ได้
    await call(`/api/users/${staff.id}`, { method: 'PATCH', as: admin, body: { status: 'active' } })
    expect((await call('/api/members', { as: staff })).status).toBe(401)
  })

  it('ถอนสิทธิ์บัญชีชมรมหรือบัญชีตัวเองไม่ได้', async () => {
    const club = await seedUser(CLUB_EMAIL, 'admin')
    const other = await seedUser('admin2@example.com', 'admin')
    expect((await call(`/api/users/${club.id}`, { method: 'PATCH', as: other, body: { status: 'revoked' } })).status).toBe(409)
    expect((await call(`/api/users/${other.id}`, { method: 'PATCH', as: other, body: { role: 'staff' } })).status).toBe(409)
    expect((await call('/api/users', { method: 'POST', as: other, body: { email: CLUB_EMAIL, role: 'staff' } })).status).toBe(422)
  })

  it('สมาชิกที่ถูกพักการใช้งาน (suspended) ไม่กระทบสิทธิ์ผู้เข้าสู่ระบบ', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const created = await data(
      await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { ...MEMBER, contact: 'staff@example.com' } }),
    )
    await call(`/api/members/${created.member.id}/status`, { method: 'POST', as: staff, body: { status: 'suspended', expectedVersion: 1 } })
    expect((await call('/api/members', { as: staff })).status).toBe(200)
  })
})

describe('session', () => {
  it('session หมดอายุใช้ไม่ได้', async () => {
    const staff = await seedUser('staff@example.com', 'staff', { expiresInMs: -1000 })
    expect((await call('/api/members', { as: staff })).status).toBe(401)
    expect((await data(await call('/api/session', { as: staff }))).user).toBeNull()
  })

  it('ผู้ใช้ที่ถูกถอนสิทธิ์ใช้ session เดิมไม่ได้', async () => {
    const staff = await seedUser('staff@example.com', 'staff', { status: 'revoked' })
    expect((await call('/api/members', { as: staff })).status).toBe(401)
  })

  it('D1 เก็บเฉพาะ hash ของ session secret', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const token = staff.cookie.split('=')[1]
    const rows = await env.DB.prepare('SELECT token_hash FROM sessions').all<{ token_hash: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0].token_hash).not.toContain(token)
    expect(rows.results[0].token_hash).toMatch(/^[0-9a-f]{64}$/)
  })

  it('logout ลบ session และล้าง cookie โดยไม่กระทบ session อื่น', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const second = { id: staff.id, ...(await seedSession(staff.id)) }
    const res = await call('/auth/logout', { method: 'POST', as: staff })
    expect(res.status).toBe(200)
    const setCookie = res.headers.get('Set-Cookie') ?? ''
    expect(setCookie).toContain('mu_session=;')
    expect(setCookie).toContain('Max-Age=0')
    expect(setCookie).toContain('HttpOnly')
    expect(setCookie).toContain('SameSite=Lax')
    expect(setCookie).toContain('Secure')
    expect((await call('/api/members', { as: staff })).status).toBe(401)
    expect((await call('/api/members', { as: second })).status).toBe(200)
  })
})

describe('CSRF และการตรวจข้อมูล', () => {
  it('คำสั่งเปลี่ยนข้อมูลต้องมี Origin ของเว็บและ CSRF token ของ session นั้น', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const other = await seedUser('other@example.com', 'staff')
    const send = (headers: Record<string, string>) =>
      call('/api/members', { method: 'POST', raw: true, cookie: staff.cookie, headers: { 'Idempotency-Key': key(), ...headers }, body: MEMBER })

    expect((await data(await send({}))).error).toBe('bad_origin')
    expect((await data(await send({ Origin: 'https://evil.example', 'X-CSRF-Token': staff.csrf }))).error).toBe('bad_origin')
    expect((await data(await send({ Origin: 'https://staff.example.test' }))).error).toBe('bad_csrf')
    expect((await data(await send({ Origin: 'https://staff.example.test', 'X-CSRF-Token': other.csrf }))).error).toBe('bad_csrf')
    expect((await send({ Origin: 'https://staff.example.test', 'X-CSRF-Token': staff.csrf })).status).toBe(201)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>())?.n).toBe(1)
  })

  it('ตรวจข้อมูลที่ server และตอบข้อความไทย', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const post = (body: unknown, headers: Record<string, string> = {}) =>
      call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key(), ...headers }, body })

    const missing = await post({ ...MEMBER, name: '   ' })
    expect(missing.status).toBe(422)
    expect(await data(missing)).toMatchObject({ error: 'validation_failed', field: 'name', message: 'กรอกชื่อสมาชิก' })
    expect((await post({ ...MEMBER, nickname: 'ก'.repeat(41) })).status).toBe(422)
    expect((await post({ ...MEMBER, role: 'owner' })).status).toBe(422)
    expect((await post({ ...MEMBER, status: 'deleted' })).status).toBe(422)
    expect((await post({ ...MEMBER, note: 5 })).status).toBe(422)
    expect((await post('{bad json')).status).toBe(400)
    expect((await post('[]')).status).toBe(400)
    expect((await post(MEMBER, { 'Content-Type': 'text/plain' })).status).toBe(415)
    expect((await post({ ...MEMBER, note: 'x'.repeat(300_000) })).status).toBe(413)
    expect((await call('/api/members', { method: 'POST', as: staff, body: MEMBER })).status).toBe(400)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM members').first<{ n: number }>())?.n).toBe(0)
  })

  it('ข้อความที่มี HTML ถูกเก็บเป็นข้อความธรรมดา และ SQL ใช้ parameter', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const name = `<img src=x onerror=alert(1)>'); DROP TABLE members;--`
    const res = await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { ...MEMBER, name } })
    expect(res.status).toBe(201)
    const listed = await data(await call('/api/members', { as: staff }))
    expect(listed.members[0].name).toBe(name)
  })

  it('กำหนดการ: ตรวจวันเวลา', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const base = { title: 'ซ้อม', allDay: false, start: '2026-10-10T18:00', end: '2026-10-10T20:00', location: '', description: '' }
    const post = (body: unknown) => call('/api/events', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body })
    expect((await post(base)).status).toBe(201)
    expect((await post({ ...base, end: '2026-10-10T18:00' })).status).toBe(422)
    expect((await post({ ...base, end: '2026-10-09T20:00' })).status).toBe(422)
    expect((await post({ ...base, start: '2026-02-30T10:00' })).status).toBe(422)
    expect((await post({ ...base, start: '10/10/2026 18:00' })).status).toBe(422)
    expect((await post({ ...base, allDay: 'yes' })).status).toBe(422)
    expect((await post({ ...base, allDay: true })).status).toBe(422)
    expect((await post({ ...base, allDay: true, start: '2026-10-10T00:00', end: '2026-10-12T23:59' })).status).toBe(201)
    expect((await post({ ...base, title: '' })).status).toBe(422)
  })
})
