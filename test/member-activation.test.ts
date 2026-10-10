import { beforeEach, describe, expect, it } from 'vitest'
import { call, data, env, resetDb, seedAccount, seedMember } from './helpers'

beforeEach(resetDb)

const activation = (studentId: unknown) => call('/auth/member/activation', { method: 'POST', body: { studentId } })
// Metadata must not read or calculate a password hash; no password login is exercised in these fixtures.
async function account(studentId: string, mustChange = true, status: 'active' | 'disabled' = 'active', memberStatus: 'active' | 'suspended' = 'active') {
  const member = await seedMember({ studentId, status: memberStatus })
  await seedAccount(member.id, { loginId: studentId, mustChange, status, passwordHash: 'test-only-unread-password-hash' })
  return member
}

describe('คำแนะนำเปิดใช้งานบัญชีครั้งแรกก่อนเข้าสู่ระบบ', () => {
  it('บัญชีใหม่แสดงคำแนะนำสำหรับเลขล้วนและ u/U โดยคงเลขศูนย์นำหน้า และไม่เปิดเผยข้อมูลอื่น', async () => {
    await account('0065432')
    for (const value of ['0065432', 'u0065432', ' U0065432 ']) {
      const res = await activation(value)
      expect(res.status).toBe(200)
      expect(await data(res)).toEqual({ firstTime: true })
      expect(res.headers.get('Cache-Control')).toBe('no-store')
      expect(res.headers.get('Set-Cookie')).toBeNull()
    }
    expect(await data(await activation('65432'))).toEqual({ firstTime: false })
  })

  it('ไม่มีบัญชี ใช้งานแล้ว ปิดบัญชี และพักสมาชิกให้ผลเหมือนกัน', async () => {
    await account('6543210', false)
    await account('6543211', true, 'disabled')
    await account('6543212', true, 'active', 'suspended')
    await seedMember({ studentId: '6543213' })
    for (const id of ['6543210', '6543211', '6543212', '6543213', '6543214']) {
      expect(await data(await activation(id))).toEqual({ firstTime: false })
    }
  })

  it('บัญชีที่เคยเข้าแล้วแต่ยังใช้รหัสชั่วคราวหรือถูกรีเซ็ต ไม่ถูกบอกว่าเป็นครั้งแรก', async () => {
    const member = await account('6543210')
    await env.DB.prepare('UPDATE member_accounts SET last_login_at = ? WHERE member_id = ?').bind(new Date().toISOString(), member.id).run()
    expect(await data(await activation('6543210'))).toEqual({ firstTime: false })
  })

  it('ข้อมูลเก่าซ้ำกันทั้งรูปเลขและ u ไม่เลือกบัญชีหนึ่งมาแสดง แม้อีกบัญชีปิดไว้', async () => {
    await account('6543210')
    await account('u6543210', true, 'disabled')
    for (const id of ['6543210', 'u6543210']) expect(await data(await activation(id))).toEqual({ firstTime: false })
  })

  it('รับรหัสเดิมที่เป็นตัวอักษรโดยไม่สนตัวพิมพ์ใหญ่เล็ก', async () => {
    await account('B6543210')
    expect(await data(await activation('b6543210'))).toEqual({ firstTime: true })
  })

  it('คำขอที่ไม่มาจากหน้าเว็บนี้ถูกปฏิเสธก่อนตรวจบัญชีและไม่จองโควตา', async () => {
    for (const headers of [{}, { Origin: 'https://other.example.test' }] as Record<string, string>[]) {
      const res = await call('/auth/member/activation', { method: 'POST', body: { studentId: '6543210' }, raw: true, headers })
      expect(res.status).toBe(403)
      expect((await data(res)).error).toBe('bad_origin')
    }
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM login_throttle').first<{ n: number }>())?.n).toBe(0)
  })

  it('ตรวจรูปแบบและขนาดคำขอ ไม่ใช้เส้นทาง GET เพื่อเผยรหัสใน URL', async () => {
    for (const value of ['', '   ', null, 1234567, 'x'.repeat(65)]) expect((await activation(value)).status).toBe(422)
    expect((await call('/auth/member/activation', { method: 'POST', body: { studentId: 'x'.repeat(600) } })).status).toBe(413)
    const get = await call('/auth/member/activation?studentId=6543210')
    expect(get.status).toBe(302)
    expect(get.headers.get('Location')).toBe('/login?error=not_found')
  })

  it('จำกัด metadata ร่วมกับ challenge โดยไม่กินโควตาลองรหัสผ่าน ไม่ออก session และไม่แก้บัญชี', async () => {
    const member = await account('6543210')
    const before = await env.DB.prepare('SELECT * FROM member_accounts WHERE member_id = ?').bind(member.id).first()
    for (let i = 0; i < 120; i++) expect((await activation('6543210')).status).toBe(200)
    const limited = await activation('6543210')
    expect(limited.status).toBe(429)
    expect(Number(limited.headers.get('Retry-After'))).toBeGreaterThan(0)
    expect((await call('/auth/member/challenge', { method: 'POST', body: { studentId: '6543210' } })).status).toBe(429)
    const keys = await env.DB.prepare('SELECT key FROM login_throttle').all<{ key: string }>()
    expect(keys.results).toHaveLength(1)
    expect(keys.results[0].key).toMatch(/^challenge:ip:/)
    expect((await env.DB.prepare('SELECT COUNT(*) AS n FROM member_sessions').first<{ n: number }>())?.n).toBe(0)
    expect(await env.DB.prepare('SELECT * FROM member_accounts WHERE member_id = ?').bind(member.id).first()).toEqual(before)
  })
})
