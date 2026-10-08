import { decodePasswordBytes, encodePasswordBytes, PASSWORD_WORK } from '../src/lib/password-material'
import type { PasswordChallenge, PasswordMaterial } from '../src/lib/password-material'
import { studentIdKey } from '../src/lib/student-id'
import { fromBase64, safeEqual } from './crypto'
import type { AppEnv } from './env'
import { HttpError } from './http'

// Server relief: Argon2id stays at the OWASP work factor on the client. HMAC with a
// server-only, domain-separated key wraps its output, so a database verifier cannot
// itself be submitted as a login credential. No password or client proof is stored.
// https://libsodium.gitbook.io/doc/password_hashing#server-relief
const encoder = new TextEncoder()
const keys = new Map<string, Promise<CryptoKey>>()
async function pepper(env: AppEnv): Promise<CryptoKey> {
  const source = env.TOKEN_ENCRYPTION_KEY ?? ''
  if (!keys.has(source)) keys.set(source, (async () => {
    let raw: Uint8Array
    try { raw = fromBase64(source) } catch { throw new Error('missing password pepper') }
    if (raw.length !== 32) throw new Error('missing password pepper')
    const root = await crypto.subtle.importKey('raw', raw, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
    const separated = await crypto.subtle.sign('HMAC', root, encoder.encode('mu-member-password-pepper:v1'))
    return crypto.subtle.importKey('raw', separated, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign'])
  })())
  try { return await keys.get(source)! } catch { keys.delete(source); throw new HttpError(503, 'encryption_not_configured', 'ยังไม่ได้ตั้งค่ากุญแจของระบบ กรุณาติดต่อทีมงาน') }
}
const pattern = /^\$(mu-argon2id|argon2id)\$v=(1|19)\$m=(\d{1,7}),t=(\d{1,3}),p=(\d{1,3})\$([A-Za-z0-9+/]{22})\$([A-Za-z0-9+/]{43})$/
export function storedPassword(stored: string): { challenge: PasswordChallenge; hash: string; legacy: boolean } | null {
  const match = pattern.exec(stored)
  if (!match || (match[1] === 'mu-argon2id' ? match[2] !== '1' : match[2] !== '19')) return null
  const [m, t, p] = [Number(match[3]), Number(match[4]), Number(match[5])]
  if (m < 8 || m > 65536 || t < 1 || t > 10 || p < 1 || p > 4) return null
  return { challenge: { algorithm: 'argon2id', salt: match[6], m, t, p }, hash: match[7], legacy: match[1] === 'argon2id' }
}
export function readMaterial(value: unknown, creating = false): PasswordMaterial | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const v = value as Record<string, unknown>
  if (v.algorithm !== 'argon2id' || typeof v.salt !== 'string' || typeof v.hash !== 'string' || !/^[A-Za-z0-9+/]{22}$/.test(v.salt) || !/^[A-Za-z0-9+/]{43}$/.test(v.hash)) return null
  if (![v.m, v.t, v.p].every((n) => typeof n === 'number' && Number.isInteger(n))) return null
  const material = v as unknown as PasswordMaterial
  if (material.m < 8 || material.m > 65536 || material.t < 1 || material.t > 10 || material.p < 1 || material.p > 4) return null
  if (creating && (material.m !== PASSWORD_WORK.m || material.t !== PASSWORD_WORK.t || material.p !== PASSWORD_WORK.p)) return null
  try {
    if (encodePasswordBytes(decodePasswordBytes(material.salt)) !== material.salt || encodePasswordBytes(decodePasswordBytes(material.hash)) !== material.hash) return null
  } catch { return null }
  return material
}
async function mac(env: AppEnv, memberId: string, material: PasswordMaterial): Promise<string> {
  const message = JSON.stringify(['verifier:v1', memberId, material.m, material.t, material.p, material.salt, material.hash])
  return encodePasswordBytes(new Uint8Array(await crypto.subtle.sign('HMAC', await pepper(env), encoder.encode(message))))
}
export async function storeMaterial(env: AppEnv, memberId: string, material: PasswordMaterial): Promise<string> {
  return `$mu-argon2id$v=1$m=${material.m},t=${material.t},p=${material.p}$${material.salt}$${await mac(env, memberId, material)}`
}
/** Convert an old PHC verifier without running Argon2 or knowing the plaintext. */
export async function wrapLegacy(env: AppEnv, memberId: string, stored: string): Promise<string> {
  const parsed = storedPassword(stored)
  if (!parsed?.legacy) return stored
  const wrapped = await storeMaterial(env, memberId, { ...parsed.challenge, hash: parsed.hash })
  await env.DB.prepare('UPDATE member_accounts SET password_hash = ? WHERE member_id = ? AND password_hash = ?').bind(wrapped, memberId, stored).run()
  return wrapped
}
export async function verifyMaterial(env: AppEnv, memberId: string, stored: string, material: PasswordMaterial): Promise<boolean> {
  const parsed = storedPassword(stored)
  if (!parsed) return false
  const c = parsed.challenge
  if (c.salt !== material.salt || c.m !== material.m || c.t !== material.t || c.p !== material.p) return false
  const expected = parsed.legacy ? await mac(env, memberId, { ...c, hash: parsed.hash }) : parsed.hash
  return safeEqual(expected, await mac(env, memberId, material))
}
/** Unknown accounts also receive a stable, pseudorandom salt; aliases receive the same salt. */
export async function dummyChallenge(env: AppEnv, studentId: string): Promise<PasswordChallenge> {
  const value = new Uint8Array(await crypto.subtle.sign('HMAC', await pepper(env), encoder.encode(`unknown-seed:v1:${studentIdKey(studentId)}`)))
  return { algorithm: 'argon2id', ...PASSWORD_WORK, salt: encodePasswordBytes(value.slice(0, 16)) }
}
