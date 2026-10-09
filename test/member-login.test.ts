import { argon2id } from '@noble/hashes/argon2.js'
import { beforeEach, describe, expect, it } from 'vitest'
import { ARGON2_PARAMS, hashPassword, verifyPassword } from '../worker/password'
import { call, CLUB_EMAIL, data, env, MEMBER_PASSWORD, resetDb, seedAccount, seedMember, seedMemberSession, seedUser } from './helpers'
import type { Actor } from './helpers'

beforeEach(resetDb)

const TEMP = 'Temp-Pass-7391'
const NEW = 'My-Own-Secret-2026'

const login = (studentId: unknown, password: unknown, options: { ip?: string; cookie?: string; headers?: Record<string, string>; raw?: boolean } = {}) =>
  call('/auth/member/login', {
    method: 'POST', body: { studentId, password }, cookie: options.cookie, raw: options.raw,
    headers: { ...(options.ip ? { 'CF-Connecting-IP': options.ip } : {}), ...options.headers },
  })

/** ผู้กระทำจาก Set-Cookie ของคำตอบเข้าสู่ระบบ */
async function actorFrom(res: Response, id = ''): Promise<Actor> {
  const cookie = res.headers.get('Set-Cookie')!.split(';')[0]
  const session = await data(await call('/api/session', { cookie }))
  return { id: id || session.member?.id || '', cookie, csrf: session.csrfToken }
}

async function account(studentId: string, options: { mustChange?: boolean; name?: string } = {}) {
  const member = await seedMember({ studentId, name: options.name })
  await seedAccount(member.id, { loginId: studentId, mustChange: options.mustChange })
  return member
}

describe('การเก็บรหัสผ่าน', () => {
  it('ใช้ Argon2id ตามค่าขั้นต่ำของ OWASP (m=19 MiB, t=2, p=1) และตรวจผลได้ถูกต้องใน Workers runtime', () => {
    expect(ARGON2_PARAMS).toEqual({ m: 19456, t: 2, p: 1 })
    const started = Date.now()
    const stored = hashPassword('correct horse battery staple')
    // บันทึกเวลาที่ใช้จริงใน workerd ของเครื่องที่รันชุดทดสอบ (ไม่ใช่ค่าของ production)
    console.log(`argon2id hash in local workerd: ${Date.now() - started} ms`)
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect(verifyPassword('correct horse battery staple', stored)).toEqual({ ok: true, needsRehash: false })
    expect(verifyPassword('correct horse battery stapl', stored).ok).toBe(false)
    expect(verifyPassword('Correct horse battery staple', stored).ok).toBe(false)
    expect(hashPassword('correct horse battery staple')).not.toBe(stored)
  })

  it('ตรงกับ test vector ของ RFC 9106 (Argon2id)', () => {
    const out = argon2id(new Uint8Array(32).fill(1), new Uint8Array(16).fill(2), { t: 3, m: 32, p: 4, dkLen: 32, key: new Uint8Array(8).fill(3), personalization: new Uint8Array(12).fill(4) })
    expect(Array.from(out, (b) => b.toString(16).padStart(2, '0')).join('')).toBe('0d640df58d78766c08c037a34a8b53c9d01ef0452d75b65eb52520e96b01e659')
  })

  it('ค่าที่เก็บไว้ผิดรูปแบบหรือมีค่าเกินขอบเขต ไม่ผ่านการตรวจและไม่ทำให้ Worker คำนวณเกินตัว', () => {
    for (const stored of ['', 'plaintext', '$argon2id$v=19$m=999999999,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g', '$argon2i$v=19$m=19456,t=2,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaA', '$argon2id$v=19$m=19456,t=99,p=1$c2FsdHNhbHRzYWx0c2FsdA$aGFzaGhhc2hoYXNoaGFzaGhhc2hoYXNoaGFzaGhhc2g']) {
      expect(verifyPassword('anything', stored)).toEqual({ ok: false, needsRehash: false })
    }
  })

  it('รหัสผ่านที่ Unicode เขียนได้สองแบบ (NFC/NFD) ตรวจผ่านเหมือนกัน', () => {
    const stored = hashPassword('café-รหัสผ่าน-ยาว')
    expect(verifyPassword('café-รหัสผ่าน-ยาว', stored).ok).toBe(true)
  })
})

describe('เข้าสู่ระบบด้วยรหัสนักศึกษาและรหัสผ่าน', () => {
  it('ตัวเลขล้วน u/U และช่องว่างหัวท้ายเข้าบัญชีเดียวกัน โดยคงศูนย์นำหน้า', async () => {
    for (const stored of ['6501234', 'u0065002']) {
      const member = await account(stored)
      const digits = stored.replace(/^u/i, '')
      for (const typed of [digits, `u${digits}`, ` U${digits} `]) {
        const res = await login(typed, MEMBER_PASSWORD)
        expect(res.status, typed).toBe(200)
        expect((await actorFrom(res)).id).toBe(member.id)
      }
    }
  })

  it('ข้อมูลเก่าที่เก็บสองรูปแบบเป็นคนละบัญชี: ไม่เลือกบัญชีจากรหัสผ่านและไม่ออก session', async () => {
    await account('6501234')
    const other = await seedMember({ studentId: 'u6501234' })
    await seedAccount(other.id, { loginId: 'u6501234' })
    for (const typed of ['6501234', 'u6501234']) {
      expect((await login(typed, MEMBER_PASSWORD)).status).toBe(401)
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<{n:number}>())?.n).toBe(0)
  })

  it('สลับ u/U และตัวเลขไม่ทำให้ข้ามโควตาการลองรหัสผ่าน', async () => {
    await account('6501234')
    for (const typed of ['6501234', 'u6501234', 'U6501234', '6501234', 'u6501234']) {
      expect((await login(typed, 'Wrong-Password-1')).status).toBe(401)
    }
    expect((await login('6501234', MEMBER_PASSWORD)).status).toBe(429)
    expect((await login('u6501234', MEMBER_PASSWORD)).status).toBe(429)
  })
  it('สำเร็จ: ได้ cookie แบบ HttpOnly/SameSite/Secure และ session เป็นของสมาชิกคนนั้น', async () => {
    const member = await account('0012345', { name: 'สมหญิง ทดสอบ' })
    const res = await login('0012345', MEMBER_PASSWORD)
    expect(res.status).toBe(200)
    expect(await data(res)).toEqual({ ok: true, mustChangePassword: false })
    const cookie = res.headers.get('Set-Cookie')!
    expect(cookie).toMatch(/^mu_session=m\.[A-Za-z0-9_-]{43}; Path=\/; Max-Age=604800; HttpOnly; SameSite=Lax; Secure$/)
    expect(res.headers.get('Cache-Control')).toBe('no-store')
    const actor = await actorFrom(res)
    expect(actor.id).toBe(member.id)
    expect((await call('/api/member/me', { as: actor })).status).toBe(200)
    // D1 เก็บเฉพาะ hash ของ session secret
    const token = cookie.split(';')[0].replace('mu_session=', '')
    const rows = await env.DB.prepare('SELECT token_hash FROM member_sessions').all<{ token_hash: string }>()
    expect(rows.results).toHaveLength(1)
    expect(rows.results[0].token_hash).not.toContain(token)
    expect((await env.DB.prepare('SELECT last_login_at FROM member_accounts WHERE member_id = ?').bind(member.id).first<{ last_login_at: string }>())?.last_login_at).toBeTruthy()
  })

  it('เลขศูนย์นำหน้ามีความหมาย ช่องว่างหัวท้ายถูกตัด และตัวพิมพ์ของอักษรอังกฤษไม่มีผล', async () => {
    await account('0012345')
    await account('B6512345')
    expect((await login('12345', MEMBER_PASSWORD)).status).toBe(401)
    expect((await login(' 0012345 ', MEMBER_PASSWORD)).status).toBe(200)
    expect((await login('b6512345', MEMBER_PASSWORD)).status).toBe(200)
  })

  it('ไม่บอกว่ารหัสนักศึกษานี้มีบัญชีหรือไม่: ไม่มีบัญชี ไม่มีสมาชิก และรหัสผ่านผิด ได้คำตอบเดียวกันทุกประการ', async () => {
    await account('6512345')
    await seedMember({ studentId: '6500002' })
    const answers = []
    for (const [id, password] of [['6512345', 'Wrong-Password-1'], ['6500002', MEMBER_PASSWORD], ['9999999', MEMBER_PASSWORD]]) {
      const res = await login(id, password)
      answers.push({ status: res.status, body: await data(res), cookie: res.headers.get('Set-Cookie') })
    }
    expect(answers[0]).toEqual({ status: 401, body: { error: 'invalid_credentials', message: 'รหัสนักศึกษาหรือรหัสผ่านไม่ถูกต้อง ถ้าลืมรหัสผ่านให้ติดต่อทีมงานเพื่อตั้งรหัสใหม่' }, cookie: null })
    expect(answers[1]).toEqual(answers[0])
    expect(answers[2]).toEqual(answers[0])
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<{ n: number }>())?.n).toBe(0)
  })

  it('คำขอต้องมาจากหน้าเว็บของระบบและเป็น JSON: ไม่รับ GET ฟอร์มข้ามเว็บ หรือค่าที่ไม่ใช่ข้อความ', async () => {
    await account('6512345')
    expect((await login('6512345', MEMBER_PASSWORD, { raw: true })).status).toBe(403)
    expect((await login('6512345', MEMBER_PASSWORD, { raw: true, headers: { Origin: 'https://evil.example' } })).status).toBe(403)
    const form = await call('/auth/member/login', { method: 'POST', body: 'studentId=6512345&password=x', headers: { 'Content-Type': 'application/x-www-form-urlencoded' } })
    expect(form.status).toBe(415)
    expect((await call('/auth/member/login?studentId=6512345&password=x')).status).toBe(302)
    for (const [id, password] of [['', MEMBER_PASSWORD], ['6512345', ''], [{ $ne: '' }, MEMBER_PASSWORD], ['6512345', ['x']], [null, null]]) {
      const res = await login(id, password)
      expect(res.status, JSON.stringify([id, password])).toBe(422)
    }
    expect((await login('6'.repeat(65), MEMBER_PASSWORD)).status).toBe(401)
    expect((await login('6512345', 'x'.repeat(5000))).status).toBe(413)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<{ n: number }>())?.n).toBe(0)
  })

  it('เข้าสู่ระบบใหม่ยกเลิก session เดิมที่เบราว์เซอร์นี้ถืออยู่ ทั้งของสมาชิกและของทีมงาน', async () => {
    const member = await account('6512345')
    const first = await actorFrom(await login('6512345', MEMBER_PASSWORD))
    const second = await login('6512345', MEMBER_PASSWORD, { cookie: first.cookie })
    expect(second.status).toBe(200)
    expect((await call('/api/member/me', { as: first })).status).toBe(401)
    const fresh = await actorFrom(second)
    expect(fresh.cookie).not.toBe(first.cookie)
    expect((await call('/api/member/me', { as: fresh })).status).toBe(200)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions WHERE member_id = ?').bind(member.id).first<{ n: number }>())?.n).toBe(1)

    const staff = await seedUser('staff@example.com', 'staff')
    const third = await login('6512345', MEMBER_PASSWORD, { cookie: staff.cookie })
    expect(third.status).toBe(200)
    expect((await call('/api/members', { as: staff })).status).toBe(401)
    // session ใหม่เป็นของสมาชิก ไม่ได้สิทธิ์ของทีมงานที่เคยอยู่ในเบราว์เซอร์เดียวกัน
    expect((await call('/api/members', { as: await actorFrom(third) })).status).toBe(403)
  })

  it('ค่า Argon2id ที่อ่อนกว่าค่าปัจจุบันถูกคำนวณใหม่เมื่อเข้าสู่ระบบสำเร็จ', async () => {
    const salt = new Uint8Array(16).fill(7)
    const weak = argon2id(new TextEncoder().encode(MEMBER_PASSWORD), salt, { m: 8192, t: 1, p: 1, dkLen: 32 })
    const b64 = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/=+$/, '')
    const member = await seedMember({ studentId: '6512345' })
    await seedAccount(member.id, { loginId: '6512345', passwordHash: `$argon2id$v=19$m=8192,t=1,p=1$${b64(salt)}$${b64(weak)}` })
    expect((await login('6512345', 'Wrong-Password-1')).status).toBe(401)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)
    const stored = (await env.DB.prepare('SELECT password_hash FROM member_accounts WHERE member_id = ?').bind(member.id).first<{ password_hash: string }>())!.password_hash
    expect(stored).toMatch(/^\$argon2id\$v=19\$m=19456,t=2,p=1\$/)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)
  })
})

describe('จำกัดจำนวนครั้งที่ลองเข้าสู่ระบบ (ตรวจที่ server)', () => {
  it('ลองผิดเกิน 5 ครั้งต่อรหัสนักศึกษา: ถูกพัก แม้รหัสผ่านถูกก็เข้าไม่ได้ระหว่างพัก และรหัสอื่นไม่ถูกกระทบ', async () => {
    await account('6512345')
    await account('6500002')
    for (let i = 0; i < 5; i++) expect((await login('6512345', `Wrong-Password-${i}`, { ip: `10.0.0.${i}` })).status).toBe(401)
    const blocked = await login('6512345', MEMBER_PASSWORD, { ip: '10.0.9.9' })
    expect(blocked.status).toBe(429)
    const body = await data(blocked)
    expect(body.error).toBe('too_many_attempts')
    expect(body.retryAfterSeconds).toBe(900)
    expect(blocked.headers.get('Retry-After')).toBe('900')
    expect(blocked.headers.get('Set-Cookie')).toBeNull()
    expect((await login('6512345', MEMBER_PASSWORD, { ip: '10.0.9.10' })).status).toBe(429)
    expect((await login('6500002', MEMBER_PASSWORD, { ip: '10.0.9.9' })).status).toBe(200)
    // ตัวนับไม่เก็บรหัสนักศึกษาหรือ IP จริง
    const dump = JSON.stringify((await env.DB.prepare('SELECT * FROM login_throttle').all()).results)
    expect(dump).not.toContain('6512345')
    expect(dump).not.toContain('10.0.')
    expect((await env.DB.prepare(`SELECT COUNT(*) AS n FROM audit_log WHERE action = 'member.login_locked'`).first<{ n: number }>())?.n).toBe(1)
  })

  it('รหัสนักศึกษาที่ไม่มีบัญชีถูกพักแบบเดียวกัน จึงใช้แยกไม่ได้ว่ารหัสใดมีบัญชี', async () => {
    await account('6512345')
    const seen: number[][] = [[], []]
    for (let i = 0; i < 7; i++) {
      seen[0].push((await login('6512345', 'Wrong-Password-1', { ip: `10.1.0.${i}` })).status)
      seen[1].push((await login('9999999', 'Wrong-Password-1', { ip: `10.2.0.${i}` })).status)
    }
    expect(seen[0]).toEqual([401, 401, 401, 401, 401, 429, 429])
    expect(seen[1]).toEqual(seen[0])
  })

  it('คำขอที่ยิงพร้อมกันผ่านการตรวจรหัสผ่านได้ไม่เกินโควตา', async () => {
    await account('6512345')
    const results = await Promise.all(Array.from({ length: 12 }, (_, i) => login('6512345', `Wrong-Password-${i}`, { ip: `10.3.0.${i}` })))
    const statuses = results.map((r) => r.status)
    expect(statuses.filter((s) => s === 401)).toHaveLength(5)
    expect(statuses.filter((s) => s === 429)).toHaveLength(7)
  })

  it('เข้าสู่ระบบสำเร็จล้างตัวนับของรหัสนั้น และการพักหมดเองเมื่อครบเวลา', async () => {
    const member = await account('6512345')
    for (let i = 0; i < 4; i++) expect((await login('6512345', 'Wrong-Password-1')).status).toBe(401)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)
    for (let i = 0; i < 5; i++) expect((await login('6512345', 'Wrong-Password-1')).status).toBe(401)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(429)
    // ครบเวลาพัก: เข้าได้อีกครั้ง
    await env.DB.prepare(`UPDATE login_throttle SET locked_until = ?`).bind(new Date(Date.now() - 1000).toISOString()).run()
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions WHERE member_id = ?').bind(member.id).first<{ n: number }>())?.n).toBe(2)
  })

  it('ถูกพักซ้ำ: เวลาพักรอบถัดไปยาวขึ้นเป็นสองเท่า', async () => {
    await account('6512345')
    for (let i = 0; i < 6; i++) await login('6512345', 'Wrong-Password-1')
    await env.DB.prepare(`UPDATE login_throttle SET locked_until = ? WHERE key LIKE 'id:%'`).bind(new Date(Date.now() - 1000).toISOString()).run()
    let last: Response | null = null
    for (let i = 0; i < 6; i++) last = await login('6512345', 'Wrong-Password-1')
    expect(last!.status).toBe(429)
    expect((await data(last!)).retryAfterSeconds).toBe(1800)
  })

  it('จำกัดตาม IP ด้วย: ลองผิดหลายรหัสจาก IP เดียวถูกพักทั้ง IP แต่การเข้าสู่ระบบสำเร็จไม่ถูกนับ', async () => {
    await account('6512345')
    for (let i = 0; i < 12; i++) expect((await login('6512345', MEMBER_PASSWORD, { ip: '10.9.9.9' })).status).toBe(200)
    for (let i = 0; i < 30; i++) expect((await login(`77${String(i).padStart(5, '0')}`, 'Wrong-Password-1', { ip: '10.9.9.9' })).status, `attempt ${i}`).toBe(401)
    const blocked = await login('6512345', MEMBER_PASSWORD, { ip: '10.9.9.9' })
    expect(blocked.status).toBe(429)
    // IP อื่นยังเข้าบัญชีเดิมได้
    expect((await login('6512345', MEMBER_PASSWORD, { ip: '10.9.9.10' })).status).toBe(200)
  }, 30_000)

  it('ผู้ดูแลตั้งรหัสผ่านใหม่ล้างการพักของรหัสนั้น', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const member = await account('6512345')
    for (let i = 0; i < 6; i++) await login('6512345', 'Wrong-Password-1')
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(429)
    expect((await call(`/api/members/${member.id}/account/password`, { method: 'POST', as: admin, body: { studentId: '6512345', password: TEMP } })).status).toBe(200)
    expect((await login('6512345', TEMP)).status).toBe(200)
  })
})

describe('เปลี่ยนรหัสผ่านชั่วคราวก่อนใช้งาน', () => {
  it('ขั้นตอนครบ: ผู้ดูแลเปิดบัญชี → เข้าสู่ระบบ → ถูกบังคับเปลี่ยนรหัส → ใช้งาน → ออกจากระบบ → รีเซ็ต/ปิดแล้ว session เดิมใช้ไม่ได้', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const created = await data(await call('/api/members', {
      method: 'POST', as: admin, headers: { 'Idempotency-Key': 'full-flow-key-00001' },
      body: { name: 'ภูมิ ทดสอบ', nickname: 'ภูมิ', studentId: '6512345', role: 'member', status: 'active', contact: '', note: 'หมายเหตุทีมงาน' },
    }))
    const id = created.member.id
    expect((await call(`/api/members/${id}/account/password`, { method: 'POST', as: admin, body: { studentId: '6512345', password: TEMP } })).status).toBe(201)

    const first = await login('6512345', TEMP)
    expect(await data(first)).toEqual({ ok: true, mustChangePassword: true })
    const temp = await actorFrom(first, id)
    // ยังไม่เปลี่ยนรหัส: เปิดข้อมูล กิจกรรม และคลังไฟล์ไม่ได้ ทั้งผ่าน API ตรง ๆ
    for (const path of ['/api/member/me', '/api/member/events', '/api/library/files', '/api/library/files/any-file-id', '/api/library/files/any-file-id/content']) {
      const res = await call(path, { as: temp })
      expect(res.status, path).toBe(403)
      expect((await data(res)).error, path).toBe('password_change_required')
    }

    const changed = await call('/api/member/password', { method: 'POST', as: temp, body: { currentPassword: TEMP, newPassword: NEW } })
    expect(changed.status).toBe(200)
    const after = await actorFrom(changed, id)
    expect((await data(await call('/api/session', { as: after }))).member.mustChangePassword).toBe(false)
    // session ที่ใช้รหัสชั่วคราวถูกแทนด้วย session ใหม่
    expect((await call('/api/member/me', { as: temp })).status).toBe(401)
    const me = await data(await call('/api/member/me', { as: after }))
    expect(me.member).toMatchObject({ name: 'ภูมิ ทดสอบ', nickname: 'ภูมิ', studentId: '6512345', status: 'active' })
    expect(me.member.passwordChangedAt).toBeTruthy()
    expect(JSON.stringify(me)).not.toContain('หมายเหตุทีมงาน')
    expect((await call('/api/member/events', { as: after })).status).toBe(200)

    expect((await call('/auth/logout', { method: 'POST', as: after })).status).toBe(200)
    expect((await call('/api/member/me', { as: after })).status).toBe(401)
    expect((await login('6512345', TEMP)).status).toBe(401)

    // รีเซ็ตโดยผู้ดูแล: session ที่เข้าด้วยรหัสของสมาชิกใช้ไม่ได้ทันที
    const again = await actorFrom(await login('6512345', NEW), id)
    expect((await call(`/api/members/${id}/account/password`, { method: 'POST', as: admin, body: { studentId: '6512345', password: 'Another-Temp-5521' } })).status).toBe(200)
    expect((await call('/api/member/me', { as: again })).status).toBe(401)
    expect((await login('6512345', NEW)).status).toBe(401)
    const third = await actorFrom(await login('6512345', 'Another-Temp-5521'), id)
    expect((await call(`/api/members/${id}/account/disable`, { method: 'POST', as: admin, body: {} })).status).toBe(200)
    expect((await call('/api/member/password', { method: 'POST', as: third, body: { currentPassword: 'Another-Temp-5521', newPassword: NEW } })).status).toBe(401)

    const audit = (await env.DB.prepare('SELECT action, detail FROM audit_log ORDER BY id').all<{ action: string; detail: string }>()).results
    expect(audit.map((a) => a.action)).toEqual(['member_account.opened', 'member_account.password_changed', 'member_account.password_reset', 'member_account.disabled'])
    expect(JSON.stringify(audit)).not.toMatch(/Temp-Pass|My-Own-Secret|Another-Temp/)
  })

  it('เปลี่ยนรหัสผ่าน: ต้องรู้รหัสปัจจุบัน รหัสใหม่ต้องผ่านเกณฑ์ และ session อื่นของบัญชีถูกยกเลิก', async () => {
    const member = await account('MUESPORT-2569', { mustChange: true })
    const here = await seedMemberSession(member.id)
    const elsewhere = await seedMemberSession(member.id)
    const change = (body: Record<string, unknown>, as: Actor = here) => call('/api/member/password', { method: 'POST', as, body })

    const wrong = await change({ currentPassword: 'Wrong-Password-1', newPassword: NEW })
    expect(wrong.status).toBe(403)
    expect(await data(wrong)).toMatchObject({ error: 'wrong_password', field: 'currentPassword' })
    const cases: Record<string, unknown>[] = [
      { currentPassword: MEMBER_PASSWORD, newPassword: 'short-1' },
      { currentPassword: MEMBER_PASSWORD, newPassword: MEMBER_PASSWORD },
      { currentPassword: MEMBER_PASSWORD, newPassword: 'muesport-2569' },
      { currentPassword: MEMBER_PASSWORD, newPassword: 'x'.repeat(129) },
      { currentPassword: MEMBER_PASSWORD },
      { newPassword: NEW },
    ]
    for (const body of cases) expect((await change(body)).status, JSON.stringify(body)).toBe(422)
    // ยังเป็นรหัสชั่วคราวเดิม และยังต้องเปลี่ยน
    expect((await env.DB.prepare('SELECT must_change_password FROM member_accounts WHERE member_id = ?').bind(member.id).first<{ must_change_password: number }>())?.must_change_password).toBe(1)
    expect((await change({ currentPassword: MEMBER_PASSWORD, newPassword: NEW }, { ...here, csrf: 'bad' })).status).toBe(403)

    const ok = await change({ currentPassword: MEMBER_PASSWORD, newPassword: NEW })
    expect(ok.status).toBe(200)
    const body = await data(ok)
    const fresh = await actorFrom(ok, member.id)
    expect(body).toEqual({ ok: true, csrfToken: fresh.csrf })
    expect(JSON.stringify(body)).not.toContain(NEW)
    for (const old of [here, elsewhere]) expect((await call('/api/session', { as: old }).then(data)).member).toBeNull()
    expect((await call('/api/member/me', { as: fresh })).status).toBe(200)
    expect((await login('MUESPORT-2569', MEMBER_PASSWORD)).status).toBe(401)
    expect((await login('MUESPORT-2569', NEW)).status).toBe(200)
  })

  it('การเดารหัสผ่านชั่วคราวผ่าน session ที่มีอยู่ถูกจำกัดจำนวนครั้งเหมือนการเข้าสู่ระบบ', async () => {
    const member = await account('6512345', {mustChange:true})
    const session = await seedMemberSession(member.id)
    const statuses: number[] = []
    for (let i = 0; i < 7; i++) statuses.push((await call('/api/member/password', { method: 'POST', as: session, body: { currentPassword: `Wrong-Password-${i}`, newPassword: NEW } })).status)
    expect(statuses).toEqual([403, 403, 403, 403, 403, 429, 429])
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(429)
  })

  it('ทีมงานเปลี่ยนรหัสผ่านแทนสมาชิกผ่านเส้นทางของสมาชิกไม่ได้', async () => {
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    await account('6512345')
    const res = await call('/api/member/password', { method: 'POST', as: admin, body: { currentPassword: MEMBER_PASSWORD, newPassword: NEW, memberId: 'x', studentId: '6512345' } })
    expect(res.status).toBe(403)
    expect((await login('6512345', MEMBER_PASSWORD)).status).toBe(200)
  })
})

describe('กิจกรรมสำหรับสมาชิก', () => {
  it('เห็นเฉพาะข้อมูลที่ใช้แสดง ไม่มีข้อมูลการแก้ไข และแก้หรือเพิ่มไม่ได้', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const member = await account('6512345')
    const session = await seedMemberSession(member.id)
    const start = new Date(Date.now() + 7 * 3_600_000 + 86_400_000).toISOString().slice(0, 10)
    await call('/api/events', { method: 'POST', as: staff, headers: { 'Idempotency-Key': 'member-events-key-01' }, body: { title: 'ซ้อมทีม', allDay: false, start: `${start}T18:00`, end: `${start}T20:00`, location: 'ห้องชมรม', description: 'เตรียมแข่ง' } })
    await call('/api/events', { method: 'POST', as: staff, headers: { 'Idempotency-Key': 'member-events-key-02' }, body: { title: 'งานเก่ามาก', allDay: true, start: '2020-01-01T00:00', end: '2020-01-01T23:59', location: '', description: '' } })
    const body = await data(await call('/api/member/events', { as: session }))
    expect(body.events).toHaveLength(1)
    expect(Object.keys(body.events[0]).sort()).toEqual(['allDay', 'description', 'end', 'id', 'location', 'start', 'title'])
    expect(body.events[0]).toMatchObject({ title: 'ซ้อมทีม', allDay: false, start: `${start}T18:00`, end: `${start}T20:00`, location: 'ห้องชมรม' })
    for (const [method, path] of [['POST', '/api/member/events'], ['PATCH', `/api/member/events/${body.events[0].id}`], ['DELETE', `/api/member/events/${body.events[0].id}`], ['POST', '/api/events'], ['PATCH', `/api/events/${body.events[0].id}`]]) {
      const res = await call(path, { method, as: session, body: { title: 'x' }, headers: { 'Idempotency-Key': 'member-events-key-03' } })
      expect([403, 404], `${method} ${path}`).toContain(res.status)
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM events').first<{ n: number }>())?.n).toBe(2)
  })
})
