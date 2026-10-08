/** Public parameters only. The second, keyed hash is calculated exclusively by the server. */
export const PASSWORD_WORK = { m: 19456, t: 2, p: 1 } as const
export interface PasswordChallenge {
  algorithm: 'argon2id'
  salt: string
  m: number
  t: number
  p: number
}
export interface PasswordMaterial extends PasswordChallenge {
  hash: string
}
export const encodePasswordBytes = (bytes: Uint8Array): string => {
  let out = ''
  for (const byte of bytes) out += String.fromCharCode(byte)
  return btoa(out).replace(/=+$/, '')
}
export const decodePasswordBytes = (text: string): Uint8Array => Uint8Array.from(atob(text), (c) => c.charCodeAt(0))
export const freshPasswordChallenge = (): PasswordChallenge => ({
  algorithm: 'argon2id', ...PASSWORD_WORK, salt: encodePasswordBytes(crypto.getRandomValues(new Uint8Array(16))),
})
