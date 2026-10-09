import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { call, CLUB_EMAIL, data, env, FakeGoogle, key, MEMBER_PASSWORD, resetDb, seedAccount, seedMember, seedUser } from './helpers'

/**
 * หน้าเข้าสู่ระบบฟอร์มเดียว: คำว่า google ในช่องชื่อผู้ใช้เป็นเพียงคำที่หน้าเว็บใช้เลือกช่องทาง Google ของทีมงาน
 * ชุดนี้ตรวจฝั่ง server ว่าคำนี้ไม่ใช่บัญชี รหัสผ่านพิเศษ หรือทางข้ามสิทธิ์ และรหัสนักศึกษาเดิมยังเข้าสู่ระบบได้ทุกรูปแบบ
 * (พฤติกรรมของหน้าเว็บ เช่น การไม่ส่งรหัสผ่านเมื่อพิมพ์ google ตรวจในชุด UI)
 */
beforeEach(resetDb)
afterEach(() => vi.unstubAllGlobals())

const WORDS = ['google', 'Google', 'GOOGLE', 'gOoGlE', '  google  ']
const login = (studentId: unknown, password: unknown) => call('/auth/member/login', { method: 'POST', body: { studentId, password } })
const count = async (table: string) => (await env.DB.prepare(`SELECT COUNT(*) AS n FROM ${table}`).first<{ n: number }>())!.n

describe('คำว่า google ไม่ใช่บัญชีหรือทางลัด', () => {
  it('ส่งคำนี้มาที่เส้นทางเข้าสู่ระบบของสมาชิก: ได้คำตอบเหมือนรหัสที่ไม่มีบัญชี ไม่มี session และไม่บอกอะไรเพิ่ม', async () => {
    await seedUser(CLUB_EMAIL, 'admin')
    const member = await seedMember({ studentId: '6500001' })
    await seedAccount(member.id, { loginId: '6500001' })
    const unknown = await data(await login('6599999', MEMBER_PASSWORD))

    for (const word of WORDS) {
      const challenge = await call('/auth/member/challenge', { method: 'POST', body: { studentId: word } })
      expect(challenge.status, word).toBe(200)
      // ค่าที่ได้เป็นค่าสุ่มคงที่แบบเดียวกับรหัสที่ไม่มีบัญชี ไม่มีตัวตรวจรหัสผ่าน
      expect(Object.keys(await data(challenge)).sort()).toEqual(['algorithm', 'm', 'p', 'salt', 't'])

      for (const password of [MEMBER_PASSWORD, 'google', 'admin', '']) {
        // ข้อนี้ไม่ได้ตรวจการจำกัดจำนวนครั้ง: ล้างตัวนับก่อนทุกครั้งเพื่อให้เห็นคำตอบของการตรวจรหัสจริง
        await env.DB.prepare('DELETE FROM login_throttle').run()
        const res = await login(word, password)
        if (password === '') {
          expect(res.status).toBe(422)
          continue
        }
        expect(res.status, `${word}/${password}`).toBe(401)
        expect(await data(res)).toEqual(unknown)
        expect(res.headers.get('Set-Cookie')).toBeNull()
      }
    }
    expect(await count('member_sessions')).toBe(0)
    expect(await count('sessions')).toBe(1)
    // ไม่มีผู้ใช้ทีมงานหรือบัญชีสมาชิกเกิดขึ้นจากคำนี้
    expect(await count('users')).toBe(1)
    expect(await count('member_accounts')).toBe(1)
  })

  it('คำนี้ใช้เป็นรหัสนักศึกษาไม่ได้ทั้งตอนเพิ่มและตอนแก้สมาชิก (กันบัญชีที่เข้าสู่ระบบจากหน้าเว็บไม่ได้)', async () => {
    const staff = await seedUser('staff@example.com', 'staff')
    const INPUT = { name: 'สมชาย ทดสอบ', nickname: 'ชาย', role: 'member', status: 'active', contact: '', note: '' }
    for (const word of WORDS) {
      const res = await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { ...INPUT, studentId: word } })
      expect(res.status, word).toBe(422)
      const body = await data(res)
      expect(body.field).toBe('studentId')
      expect(body.message).toContain('google')
    }
    expect(await count('members')).toBe(0)

    const created = await data(await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { ...INPUT, studentId: '6500001' } }))
    const edit = await call(`/api/members/${created.member.id}`, { method: 'PATCH', as: staff, body: { ...INPUT, studentId: 'Google', expectedVersion: created.member.version } })
    expect(edit.status).toBe(422)
    expect((await env.DB.prepare('SELECT student_id FROM members').first<{ student_id: string }>())?.student_id).toBe('6500001')
    // รหัสที่มีคำนี้เป็นเพียงส่วนหนึ่งยังใช้ได้ตามรูปแบบเดิม
    expect((await call('/api/members', { method: 'POST', as: staff, headers: { 'Idempotency-Key': key() }, body: { ...INPUT, studentId: 'google01' } })).status).toBe(201)
  })
})

describe('ช่องทางของทีมงานยังเป็นขั้นตอน Google เดิม', () => {
  it('/auth/login เริ่มขั้นตอนของ Google ตามเดิม ไม่รับชื่อผู้ใช้หรือรหัสผ่าน และไม่ออก session จนกว่า Google จะยืนยันบัญชีที่ได้รับสิทธิ์', async () => {
    await FakeGoogle.start()
    await seedUser(CLUB_EMAIL, 'admin')
    const sessionsBefore = await count('sessions')
    const res = await call('/auth/login?return=%2Fmembers&username=google&password=x')
    expect(res.status).toBe(302)
    const target = new URL(res.headers.get('Location')!)
    expect(target.origin + target.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth')
    // ค่าที่ส่งมากับคำขอเริ่มต้นไม่ถูกส่งต่อให้ Google และไม่มี session เกิดขึ้น
    expect(target.search).not.toMatch(/password|username/)
    expect((res.headers.get('Set-Cookie') ?? '')).not.toContain('mu_session=')
    expect(await count('sessions')).toBe(sessionsBefore)
    // เส้นทางนี้รับเฉพาะ GET: ส่งชื่อผู้ใช้/รหัสผ่านแบบฟอร์มมาไม่ได้
    expect((await call('/auth/login', { method: 'POST', body: { username: 'google', password: 'x' } })).status).toBe(404)
  })
})

describe('รหัสนักศึกษาเดิมยังเข้าสู่ระบบได้ตามเดิม', () => {
  it('ตัวเลขล้วน มี u/U นำหน้า ตัวพิมพ์เล็กใหญ่ และเลขศูนย์นำหน้า เข้าบัญชีเดิมของคนเดิม', async () => {
    const zero = await seedMember({ studentId: '0065002', name: 'ณิชา ทดสอบ' })
    await seedAccount(zero.id, { loginId: '0065002' })
    const letters = await seedMember({ studentId: 'B6512345', name: 'กฤต ทดสอบ' })
    await seedAccount(letters.id, { loginId: 'B6512345' })

    const who = async (studentId: string) => {
      const res = await login(studentId, MEMBER_PASSWORD)
      if (res.status !== 200) return `status ${res.status}`
      const cookie = res.headers.get('Set-Cookie')!.split(';')[0]
      return (await data(await call('/api/session', { cookie }))).member?.id as string
    }
    for (const typed of ['0065002', 'u0065002', 'U0065002', ' 0065002 ']) expect(await who(typed), typed).toBe(zero.id)
    // หน้าเข้าสู่ระบบส่งตัวอักษรอังกฤษเป็นตัวเล็ก: ต้องเข้าบัญชีเดิมได้
    for (const typed of ['B6512345', 'b6512345']) expect(await who(typed), typed).toBe(letters.id)
    // ไม่แปลงเป็นตัวเลข: ตัดศูนย์นำหน้าแล้วไม่ใช่รหัสเดิม
    expect(await who('65002')).toBe('status 401')
  })
})
