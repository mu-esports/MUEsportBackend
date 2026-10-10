import { argon2id } from '@noble/hashes/argon2.js'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { encodePasswordBytes, freshPasswordChallenge, PASSWORD_WORK } from '../src/lib/password-material'
import type { PasswordChallenge, PasswordMaterial } from '../src/lib/password-material'
import { readMaterial, storedPassword, storeMaterial, verifyMaterial } from '../worker/password-relief'
import { call, CLUB_EMAIL, data, env, MEMBER_PASSWORD, resetDb, seedAccount, seedMember, seedUser } from './helpers'

const make = (password: string, c: PasswordChallenge = freshPasswordChallenge()): PasswordMaterial => ({
  ...c, hash: encodePasswordBytes(argon2id(new TextEncoder().encode(password.normalize('NFC')), Uint8Array.from(atob(c.salt), x => x.charCodeAt(0)), { m: c.m, t: c.t, p: c.p, dkLen: 32 })),
})
const seed = async (studentId = '6501234') => {
  const member = await seedMember({ studentId })
  await seedAccount(member.id, { loginId: studentId })
  return member
}
const challenge = async (studentId: string) => data<PasswordChallenge>(await call('/auth/member/challenge', { method: 'POST', body: { studentId } }))
const login = async (studentId: string, password: string) => call('/auth/member/login', { method: 'POST', body: { studentId, passwordProof: make(password, await challenge(studentId)) } })
beforeEach(async () => { await resetDb(); env.PASSWORD_HASH_MODE = 'client' })
afterEach(() => { env.PASSWORD_HASH_MODE = 'server-test' })

describe('Free-compatible Argon2id client work and keyed server verifier', () => {
  it('stores a keyed second hash, binds it to the member, and rejects a database hash submitted as a proof', async () => {
    const material = make(MEMBER_PASSWORD)
    const stored = await storeMaterial(env, 'member-one', material)
    expect(stored).not.toContain(material.hash)
    expect(await verifyMaterial(env, 'member-one', stored, material)).toBe(true)
    expect(await verifyMaterial(env, 'member-two', stored, material)).toBe(false)
    expect(await verifyMaterial(env, 'member-one', stored, { ...material, hash: storedPassword(stored)!.hash })).toBe(false)
    expect(readMaterial({ ...material, m: 8192 }, true)).toBeNull()
    expect(readMaterial({ ...material, hash: 'A'.repeat(43) + '=' }, true)).toBeNull()
    expect(readMaterial({ ...material, salt: 'not-base64' })).toBeNull()
  })

  it('gives stable seeds for unknown accounts and aliases, uses no-store, and does not spend login attempts', async () => {
    const member = await seed()
    const known = await call('/auth/member/challenge', { method: 'POST', body: { studentId: 'u6501234' } })
    expect(known.headers.get('Cache-Control')).toBe('no-store')
    const a = await data<PasswordChallenge>(known)
    expect(a).toEqual(await challenge('6501234'))
    expect(await challenge('u6500009')).toEqual(await challenge('6500009'))
    expect(Object.keys(a).sort()).toEqual(['algorithm', 'm', 'p', 'salt', 't'])
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM login_throttle WHERE key LIKE 'id:%'").first<{ n: number }>()).toEqual({ n: 0 })
    const row = await env.DB.prepare('SELECT password_hash FROM member_accounts WHERE member_id = ?').bind(member.id).first<{ password_hash: string }>()
    expect(row!.password_hash.startsWith('$mu-argon2id$')).toBe(true)
  })

  it('requires a proof in production, rejects wrong passwords uniformly, and admits only the same member for both ID forms', async () => {
    const member = await seed()
    expect((await call('/auth/member/login', { method: 'POST', body: { studentId: '6501234', password: MEMBER_PASSWORD } })).status).toBe(422)
    expect((await login('6501234', 'Wrong-Password-7392')).status).toBe(401)
    expect((await login('6500009', 'Wrong-Password-7392')).status).toBe(401)
    for (const id of ['u6501234', '6501234']) {
      const response = await login(id, MEMBER_PASSWORD)
      expect(response.status).toBe(200)
      const cookie = response.headers.get('Set-Cookie')!.split(';')[0]
      expect(cookie).toContain('mu_session=m.')
      expect((await data(await call('/api/session', { cookie }))).member.id).toBe(member.id)
      expect((await call('/api/members', { cookie })).status).toBe(403)
    }
  })

  it('sets a temporary password with client work, changes it, invalidates the old password and sessions, then logs in with the new one', async () => {
    const member = await seedMember({ studentId: '6501234' })
    const admin = await seedUser(CLUB_EMAIL, 'admin')
    const temp = 'Temporary-Sunny-9041'
    const next = 'My-Final-Password-5082'
    expect((await call(`/api/members/${member.id}/account/password`, { method: 'POST', as: admin, body: { studentId: 'u6501234', password: temp } })).status).toBe(422)
    const opened = await call(`/api/members/${member.id}/account/password`, { method: 'POST', as: admin, body: { studentId: 'u6501234', password: temp, passwordProof: make(temp) } })
    expect(opened.status).toBe(201)
    const response = await login('u6501234', temp)
    expect((await data(response.clone())).mustChangePassword).toBe(true)
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0]
    const session = await data(await call('/api/session', { cookie }))
    const changed = await call('/api/member/password/setup', { method: 'POST', cookie, headers: { 'X-CSRF-Token': session.csrfToken }, body: {
      newPassword: next, comparisonProof: make(next, await challenge('6501234')), passwordProof: make(next),
    } })
    expect(changed.status).toBe(200)
    expect((await data(await call('/api/session', { cookie }))).member).toBeNull()
    expect((await login('6501234', temp)).status).toBe(401)
    expect((await login('u6501234', next)).status).toBe(200)
    const row = await env.DB.prepare('SELECT password_hash FROM member_accounts WHERE member_id = ?').bind(member.id).first<{ password_hash: string }>()
    expect(row!.password_hash).not.toContain(temp)
    expect(row!.password_hash).not.toContain(next)
    expect(storedPassword(row!.password_hash)!.challenge).toMatchObject(PASSWORD_WORK)
  })

  it('setup requires valid client work, rejects reused temporary passwords and stale comparison seeds', async () => {
    const member = await seed()
    await env.DB.prepare('UPDATE member_accounts SET must_change_password = 1 WHERE member_id = ?').bind(member.id).run()
    const response = await login('6501234', MEMBER_PASSWORD)
    const cookie = response.headers.get('Set-Cookie')!.split(';')[0]
    const session = await data(await call('/api/session', { cookie }))
    const c = await challenge('6501234')
    const next = 'Personal-New-Pass-1024'
    const post = (body: unknown) => call('/api/member/password/setup', { method: 'POST', cookie, headers: { 'X-CSRF-Token': session.csrfToken }, body })
    expect((await post({ newPassword: next })).status).toBe(422)
    const reused = await post({ newPassword: MEMBER_PASSWORD, comparisonProof: make(MEMBER_PASSWORD, c), passwordProof: make(MEMBER_PASSWORD) })
    expect(reused.status).toBe(422)
    expect((await data(reused)).field).toBe('newPassword')
    const stale = await post({ newPassword: next, comparisonProof: make(next), passwordProof: make(next) })
    expect(stale.status).toBe(409)
    expect((await data(stale)).error).toBe('password_changed')
  })

  it('enforces Origin and a separate metadata rate limit', async () => {
    expect((await call('/auth/member/challenge', { method: 'POST', body: { studentId: '6501234' }, headers: { Origin: 'https://other.example.test' }, raw: true })).status).toBe(403)
    const keyRow = await challenge('6501234')
    expect(keyRow.m).toBe(PASSWORD_WORK.m)
    await env.DB.prepare("UPDATE login_throttle SET attempts = 120 WHERE key LIKE 'challenge:%'").run()
    expect((await call('/auth/member/challenge', { method: 'POST', body: { studentId: '6501234' } })).status).toBe(429)
  })
})
