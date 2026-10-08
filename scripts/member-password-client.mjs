import { argon2id } from '@noble/hashes/argon2.js'
import { randomBytes } from 'node:crypto'

/** Test client using the same Argon2id work as the browser Web Worker. No server secret. */
export const makePasswordMaterial = (password, challenge = { algorithm: 'argon2id', m: 19456, t: 2, p: 1, salt: randomBytes(16).toString('base64').replace(/=+$/, '') }) => ({
  ...challenge,
  hash: Buffer.from(argon2id(Buffer.from(password.normalize('NFC')), Buffer.from(challenge.salt, 'base64'), {
    m: challenge.m, t: challenge.t, p: challenge.p, dkLen: 32,
  })).toString('base64').replace(/=+$/, ''),
})
export async function loginWithPassword(request, base, studentId, password) {
  const seed = await request.post(`${base}/auth/member/challenge`, { data: { studentId }, headers: { Origin: base } })
  if (!seed.ok()) throw new Error(`Password metadata request failed: ${seed.status()}`)
  const passwordProof = makePasswordMaterial(password, await seed.json())
  return request.post(`${base}/auth/member/login`, { data: { studentId, passwordProof }, headers: { Origin: base } })
}
