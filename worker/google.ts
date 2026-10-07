import { createLocalJWKSet, jwtVerify } from 'jose'
import type { JSONWebKeySet } from 'jose'
import { decryptSecret, encryptSecret, isValidEncryptionKey } from './crypto'
import { nowIso } from './env'
import type { AppEnv } from './env'
import { HttpError } from './http'

export const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth'
export const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token'
export const GOOGLE_JWKS_URL = 'https://www.googleapis.com/oauth2/v3/certs'
export const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke'

export const LOGIN_SCOPES = ['openid', 'email', 'profile']
// ขอเท่าที่ใช้จริง: drive.file เข้าถึงเฉพาะไฟล์ที่แอปนี้สร้าง ไม่ใช่ทั้ง Drive
export const DRIVE_FILE_SCOPE = 'https://www.googleapis.com/auth/drive.file'
export const CONNECT_SCOPES = ['openid', 'email', DRIVE_FILE_SCOPE]
// Sheets/Docs/Forms ใช้ drive.file (เฉพาะไฟล์ที่เว็บสร้างหรือที่ผู้ดูแลเลือกผ่าน Google Picker) ไม่ต้องขอ scope เพิ่ม
// Calendar ขอเพิ่มเฉพาะตอนผู้ดูแลเริ่มตั้งค่าปฏิทิน (incremental consent)
export const CAL_APP_CREATED_SCOPE = 'https://www.googleapis.com/auth/calendar.app.created'
export const CAL_LIST_SCOPE = 'https://www.googleapis.com/auth/calendar.calendarlist.readonly'
export const CAL_EVENTS_SCOPE = 'https://www.googleapis.com/auth/calendar.events'
// คลังไฟล์ชมรม: อ่านรายการและเนื้อหาไฟล์ทั้งหมดที่บัญชีชมรมเข้าถึงได้ (อ่านอย่างเดียว ไม่ขอสิทธิ์เขียนทั้ง Drive)
// เป็น restricted scope ของ Google: ขอเฉพาะเมื่อผู้ดูแลกดเปิดใช้คลังไฟล์ และขอผ่านบัญชีชมรมเท่านั้น ไม่อยู่ในขั้นตอนเข้าสู่ระบบของใคร
export const DRIVE_READONLY_SCOPE = 'https://www.googleapis.com/auth/drive.readonly'
export const SERVICE_SCOPES: Record<string, string[]> = {
  library: [DRIVE_READONLY_SCOPE],
  // ปฏิทินที่เว็บสร้างเอง: เห็นและแก้ได้เฉพาะปฏิทินที่สร้างผ่านเว็บนี้
  calendar_created: [CAL_APP_CREATED_SCOPE],
  // ปฏิทินเดิมที่ผู้ดูแลเลือก: ต้องอ่านรายชื่อปฏิทิน และอ่าน/เขียนกำหนดการของปฏิทินที่บัญชีชมรมเข้าถึงได้
  calendar_existing: [CAL_LIST_SCOPE, CAL_EVENTS_SCOPE],
}

export const CALLBACK_PATH = '/auth/google/callback'
const GOOGLE_TIMEOUT_MS = 20_000

export const clubEmail = (env: AppEnv) => env.CLUB_GOOGLE_EMAIL.trim().toLowerCase()

const isPlaceholder = (value: string | undefined) => !value || value.startsWith('REPLACE_WITH')

/** เข้าสู่ระบบได้เมื่อมี client ID และ secret */
export const isAuthConfigured = (env: AppEnv) => !isPlaceholder(env.GOOGLE_CLIENT_ID) && !isPlaceholder(env.GOOGLE_CLIENT_SECRET)

/** เชื่อม Google ของชมรมได้เมื่อมีกุญแจเข้ารหัสที่ถูกต้องด้วย */
export async function missingConnectConfig(env: AppEnv): Promise<string[]> {
  const missing: string[] = []
  if (isPlaceholder(env.GOOGLE_CLIENT_ID)) missing.push('GOOGLE_CLIENT_ID')
  if (isPlaceholder(env.GOOGLE_CLIENT_SECRET)) missing.push('GOOGLE_CLIENT_SECRET')
  if (!(await isValidEncryptionKey(env.TOKEN_ENCRYPTION_KEY))) missing.push('TOKEN_ENCRYPTION_KEY')
  return missing
}

interface AuthUrlInput {
  origin: string
  state: string
  nonce: string
  codeChallenge: string
  scopes: string[]
  offline: boolean
  loginHint?: string
}

export function buildAuthUrl(env: AppEnv, input: AuthUrlInput): string {
  const params = new URLSearchParams({
    client_id: env.GOOGLE_CLIENT_ID ?? '',
    redirect_uri: input.origin + CALLBACK_PATH,
    response_type: 'code',
    scope: input.scopes.join(' '),
    state: input.state,
    nonce: input.nonce,
    code_challenge: input.codeChallenge,
    code_challenge_method: 'S256',
    // ให้เลือกบัญชีทุกครั้ง; การเชื่อมของชมรมขอ consent เพื่อให้ได้ refresh token
    prompt: input.offline ? 'consent select_account' : 'select_account',
  })
  if (input.offline) {
    params.set('access_type', 'offline')
    params.set('include_granted_scopes', 'true')
  }
  // login_hint ช่วยเลือกบัญชีเท่านั้น ไม่ใช่หลักฐาน: ตรวจอีเมลจาก id_token เสมอ
  if (input.loginHint) params.set('login_hint', input.loginHint)
  return `${GOOGLE_AUTH_URL}?${params}`
}

export interface TokenResponse {
  access_token: string
  expires_in: number
  refresh_token?: string
  scope?: string
  id_token?: string
}

async function tokenRequest(env: AppEnv, body: Record<string, string>): Promise<{ ok: true; data: TokenResponse } | { ok: false; error: string }> {
  let response: Response
  try {
    response = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({
        client_id: env.GOOGLE_CLIENT_ID ?? '',
        client_secret: env.GOOGLE_CLIENT_SECRET ?? '',
        ...body,
      }),
    })
  } catch {
    return { ok: false, error: 'network_error' }
  }
  const data = (await response.json().catch(() => ({}))) as Record<string, unknown>
  if (!response.ok || typeof data.access_token !== 'string') {
    // เก็บเฉพาะรหัสข้อผิดพลาด ไม่เก็บรายละเอียดที่อาจมี token หรือ code
    return { ok: false, error: typeof data.error === 'string' ? data.error : `http_${response.status}` }
  }
  return { ok: true, data: data as unknown as TokenResponse }
}

export async function exchangeCode(env: AppEnv, code: string, codeVerifier: string, origin: string): Promise<TokenResponse> {
  const result = await tokenRequest(env, {
    grant_type: 'authorization_code',
    code,
    code_verifier: codeVerifier,
    redirect_uri: origin + CALLBACK_PATH,
  })
  if (!result.ok) throw new HttpError(502, 'google_token_error', 'Google ไม่ยืนยันการเข้าสู่ระบบ ลองอีกครั้ง', { google: result.error })
  return result.data
}

export interface GoogleIdentity {
  sub: string
  email: string
  emailVerified: boolean
  name: string
}

/** ตรวจ id_token: ลายเซ็น ผู้ออก ผู้รับ วันหมดอายุ และ nonce */
export async function verifyIdToken(env: AppEnv, idToken: string | undefined, nonce: string): Promise<GoogleIdentity> {
  const invalid = new HttpError(401, 'id_token_invalid', 'ตรวจข้อมูลบัญชีจาก Google ไม่ผ่าน ลองเข้าสู่ระบบอีกครั้ง')
  if (!idToken) throw invalid
  let keys: JSONWebKeySet
  try {
    const response = await fetch(GOOGLE_JWKS_URL)
    if (!response.ok) throw new Error('jwks')
    keys = (await response.json()) as JSONWebKeySet
  } catch {
    throw new HttpError(502, 'google_unreachable', 'ติดต่อ Google เพื่อตรวจบัญชีไม่ได้ ลองอีกครั้ง')
  }
  try {
    const { payload } = await jwtVerify(idToken, createLocalJWKSet(keys), {
      issuer: ['https://accounts.google.com', 'accounts.google.com'],
      audience: env.GOOGLE_CLIENT_ID,
      algorithms: ['RS256'],
    })
    if (payload.nonce !== nonce) throw invalid
    if (typeof payload.sub !== 'string' || typeof payload.email !== 'string') throw invalid
    return {
      sub: payload.sub,
      email: payload.email.trim().toLowerCase(),
      emailVerified: payload.email_verified === true,
      name: typeof payload.name === 'string' ? payload.name : '',
    }
  } catch {
    throw invalid
  }
}

// ---------- การเชื่อม Google ของชมรม ----------

export type ConnectionStatus = 'connected' | 'needs_reconnect' | 'error' | 'disconnected'

interface ConnectionRow {
  google_sub: string
  email: string
  scopes: string
  refresh_token_enc: string | null
  access_token_enc: string | null
  access_token_expires_at: string | null
  status: ConnectionStatus
  last_checked_at: string | null
  last_error: string | null
  connected_at: string | null
}

export const loadConnection = (env: AppEnv) =>
  env.DB.prepare(`SELECT * FROM google_connections WHERE id = 'club'`).first<ConnectionRow>()

/** scopes ที่ Google ยืนยันว่าได้รับจริงจากการอนุญาตครั้งล่าสุด (ว่างเมื่อยังไม่เชื่อมหรือต้องเชื่อมใหม่) */
export async function grantedScopes(env: AppEnv): Promise<Set<string>> {
  const row = await loadConnection(env)
  if (!row || row.status === 'disconnected' || row.status === 'needs_reconnect') return new Set()
  return new Set(row.scopes.split(' ').filter(Boolean))
}

/** บันทึกผลการอนุญาตของบัญชีชมรม ถ้า Google ไม่ส่ง refresh token ใหม่ให้คง token เดิมของบัญชีเดียวกันไว้ */
export async function saveConnection(
  env: AppEnv,
  identity: GoogleIdentity,
  tokens: TokenResponse,
  userId: string,
): Promise<'saved' | 'no_refresh_token'> {
  const existing = await loadConnection(env)
  let refreshEnc: string | null = null
  if (tokens.refresh_token) {
    refreshEnc = await encryptSecret(env.TOKEN_ENCRYPTION_KEY, tokens.refresh_token)
  } else if (existing?.refresh_token_enc && existing.google_sub === identity.sub) {
    refreshEnc = existing.refresh_token_enc
  } else {
    return 'no_refresh_token'
  }
  const now = nowIso()
  const accessEnc = await encryptSecret(env.TOKEN_ENCRYPTION_KEY, tokens.access_token)
  const expiresAt = new Date(Date.now() + tokens.expires_in * 1000).toISOString()
  await env.DB.prepare(
    `INSERT INTO google_connections
       (id, google_sub, email, scopes, refresh_token_enc, access_token_enc, access_token_expires_at,
        status, last_checked_at, last_error, connected_by, connected_at, updated_at)
     VALUES ('club', ?, ?, ?, ?, ?, ?, 'connected', ?, NULL, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET
       google_sub = excluded.google_sub, email = excluded.email, scopes = excluded.scopes,
       refresh_token_enc = excluded.refresh_token_enc, access_token_enc = excluded.access_token_enc,
       access_token_expires_at = excluded.access_token_expires_at, status = 'connected',
       last_checked_at = excluded.last_checked_at, last_error = NULL,
       connected_by = excluded.connected_by, connected_at = excluded.connected_at, updated_at = excluded.updated_at`,
  )
    .bind(identity.sub, identity.email, tokens.scope ?? '', refreshEnc, accessEnc, expiresAt, now, userId, now, now)
    .run()
  return 'saved'
}

const notConnected = () =>
  new HttpError(409, 'google_not_connected', 'ยังไม่ได้เชื่อมบัญชี Google ของชมรม ให้ผู้ดูแลเชื่อมที่หน้าแหล่งข้อมูลก่อน')
const needsReconnect = () =>
  new HttpError(409, 'google_needs_reconnect', 'การเชื่อม Google ของชมรมใช้ไม่ได้แล้ว ให้ผู้ดูแลเชื่อมใหม่ที่หน้าแหล่งข้อมูล')

/**
 * access token สำหรับเรียก Google API ในนามบัญชีชมรม
 * ใช้ค่าที่เก็บไว้ถ้ายังไม่หมดอายุ ไม่เช่นนั้นขอใหม่ด้วย refresh token แล้วบันทึกสถานะตามผลจริง
 */
export async function getAccessToken(env: AppEnv, forceRefresh = false): Promise<string> {
  const row = await loadConnection(env)
  if (!row || row.status === 'disconnected' || !row.refresh_token_enc) throw notConnected()
  if (row.status === 'needs_reconnect') throw needsReconnect()

  if (!forceRefresh && row.access_token_enc && row.access_token_expires_at) {
    if (Date.parse(row.access_token_expires_at) - Date.now() > 60_000) {
      return decryptSecret(env.TOKEN_ENCRYPTION_KEY, row.access_token_enc)
    }
  }

  const refreshToken = await decryptSecret(env.TOKEN_ENCRYPTION_KEY, row.refresh_token_enc)
  const result = await tokenRequest(env, { grant_type: 'refresh_token', refresh_token: refreshToken })
  const now = nowIso()
  if (!result.ok) {
    // invalid_grant: token ถูกถอนสิทธิ์หรือหมดอายุ ต้องให้ผู้ดูแลเชื่อมใหม่ ไม่สลับไปใช้บัญชีอื่น
    const status: ConnectionStatus = result.error === 'invalid_grant' ? 'needs_reconnect' : 'error'
    await env.DB.prepare(
      `UPDATE google_connections
          SET status = ?, last_error = ?, last_checked_at = ?, access_token_enc = NULL, access_token_expires_at = NULL, updated_at = ?
        WHERE id = 'club'`,
    )
      .bind(status, result.error, now, now)
      .run()
    if (status === 'needs_reconnect') throw needsReconnect()
    throw new HttpError(502, 'google_unavailable', 'ติดต่อ Google ไม่สำเร็จ ลองอีกครั้งในอีกสักครู่')
  }
  await env.DB.prepare(
    `UPDATE google_connections
        SET status = 'connected', last_error = NULL, last_checked_at = ?, access_token_enc = ?, access_token_expires_at = ?, updated_at = ?
      WHERE id = 'club'`,
  )
    .bind(
      now,
      await encryptSecret(env.TOKEN_ENCRYPTION_KEY, result.data.access_token),
      new Date(Date.now() + result.data.expires_in * 1000).toISOString(),
      now,
    )
    .run()
  return result.data.access_token
}

/** เรียก Google API ด้วย token ของบัญชีชมรม ถ้า token ถูกปฏิเสธจะขอใหม่หนึ่งครั้ง */
export async function googleFetch(env: AppEnv, url: string, init: RequestInit = {}): Promise<Response> {
  const call = async (token: string) => {
    try {
      return await fetch(url, {
        ...init,
        // จำกัดเวลารอ Google ต่อคำขอ เพื่อไม่ให้งานค้างนานเกินอายุ lease ของงานสร้างเอกสาร
        signal: AbortSignal.timeout(GOOGLE_TIMEOUT_MS),
        headers: { ...(init.headers as Record<string, string> | undefined), Authorization: `Bearer ${token}` },
      })
    } catch {
      throw new HttpError(502, 'google_unavailable', 'ติดต่อ Google ไม่สำเร็จ ลองอีกครั้งในอีกสักครู่')
    }
  }
  const response = await call(await getAccessToken(env))
  if (response.status !== 401) return response
  return call(await getAccessToken(env, true))
}

/** ตัดการเชื่อม: ถอน token ที่ Google (ถ้าทำได้) และลบ token ออกจาก D1 ไม่ลบไฟล์ใน Google หรือข้อมูลอื่น */
export async function disconnect(env: AppEnv): Promise<{ revokedAtGoogle: boolean }> {
  const row = await loadConnection(env)
  if (!row) return { revokedAtGoogle: false }
  let revokedAtGoogle = false
  if (row.refresh_token_enc) {
    try {
      const token = await decryptSecret(env.TOKEN_ENCRYPTION_KEY, row.refresh_token_enc)
      const response = await fetch(GOOGLE_REVOKE_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ token }),
      })
      revokedAtGoogle = response.ok
    } catch {
      revokedAtGoogle = false
    }
  }
  const now = nowIso()
  await env.DB.prepare(
    `UPDATE google_connections
        SET status = 'disconnected', refresh_token_enc = NULL, access_token_enc = NULL, access_token_expires_at = NULL,
            last_error = NULL, last_checked_at = ?, updated_at = ?
      WHERE id = 'club'`,
  )
    .bind(now, now)
    .run()
  return { revokedAtGoogle }
}
