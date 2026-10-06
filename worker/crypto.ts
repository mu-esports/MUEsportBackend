import { HttpError } from './http'

const encoder = new TextEncoder()
const decoder = new TextDecoder()

export function toBase64Url(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

export function fromBase64(text: string): Uint8Array {
  const normalized = text.replace(/-/g, '+').replace(/_/g, '/')
  const binary = atob(normalized)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}

/** ค่าสุ่มสำหรับ session, state, nonce และ PKCE verifier */
export function randomToken(bytes = 32): string {
  return toBase64Url(crypto.getRandomValues(new Uint8Array(bytes)))
}

export async function sha256(text: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(text)))
}

export async function sha256Hex(text: string): Promise<string> {
  return Array.from(await sha256(text), (b) => b.toString(16).padStart(2, '0')).join('')
}

/** เทียบค่าลับโดยไม่ให้เวลาที่ใช้บอกตำแหน่งที่ต่างกัน */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const [x, y] = await Promise.all([sha256(a), sha256(b)])
  let diff = 0
  for (let i = 0; i < x.length; i++) diff |= x[i] ^ y[i]
  return diff === 0
}

async function importKey(keyBase64: string | undefined): Promise<CryptoKey> {
  const misconfigured = new HttpError(
    503,
    'encryption_not_configured',
    'เว็บไซต์ยังไม่ได้ตั้งค่ากุญแจเข้ารหัส (TOKEN_ENCRYPTION_KEY) ให้ถูกต้อง',
  )
  if (!keyBase64) throw misconfigured
  let raw: Uint8Array
  try {
    raw = fromBase64(keyBase64.trim())
  } catch {
    throw misconfigured
  }
  if (raw.length !== 32) throw misconfigured
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt', 'decrypt'])
}

export async function isValidEncryptionKey(keyBase64: string | undefined): Promise<boolean> {
  return importKey(keyBase64).then(
    () => true,
    () => false,
  )
}

/** เข้ารหัส AES-256-GCM ด้วย IV ใหม่ทุกครั้ง ผลลัพธ์รูปแบบ v1.<iv>.<ciphertext> */
export async function encryptSecret(keyBase64: string | undefined, plaintext: string): Promise<string> {
  const key = await importKey(keyBase64)
  const iv = crypto.getRandomValues(new Uint8Array(12))
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, key, encoder.encode(plaintext))
  return `v1.${toBase64Url(iv)}.${toBase64Url(new Uint8Array(encrypted))}`
}

export async function decryptSecret(keyBase64: string | undefined, stored: string): Promise<string> {
  const key = await importKey(keyBase64)
  const [version, iv, data] = stored.split('.')
  if (version !== 'v1' || !iv || !data) throw new Error('unknown secret format')
  const decrypted = await crypto.subtle.decrypt({ name: 'AES-GCM', iv: fromBase64(iv) }, key, fromBase64(data))
  return decoder.decode(decrypted)
}

/** PKCE: code_challenge แบบ S256 */
export async function pkceChallenge(verifier: string): Promise<string> {
  return toBase64Url(await sha256(verifier))
}
