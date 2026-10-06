/** ค่าที่ Worker ได้จาก Cloudflare: binding, ค่าตั้งที่ไม่ลับ (vars) และค่าลับ (secrets) */
export interface AppEnv {
  DB: D1Database
  ASSETS: Fetcher
  /** บัญชี Google ของชมรม: เป็นผู้ดูแลคนแรก และเป็นบัญชีเดียวที่เชื่อม Google ของเว็บไซต์ได้ */
  CLUB_GOOGLE_EMAIL: string
  /** OAuth client ID (ไม่ลับ) */
  GOOGLE_CLIENT_ID?: string
  /** OAuth client secret (ค่าลับ) */
  GOOGLE_CLIENT_SECRET?: string
  /** กุญแจ AES-256-GCM แบบ base64 ยาว 32 ไบต์ ใช้เข้ารหัส token ของ Google ใน D1 (ค่าลับ) */
  TOKEN_ENCRYPTION_KEY?: string
}

export type Role = 'staff' | 'admin'

export interface SessionUser {
  id: string
  email: string
  name: string
  role: Role
}

export interface Session {
  user: SessionUser
  tokenHash: string
  csrfToken: string
}

/** สิ่งที่ handler ทุกตัวได้รับ */
export interface Ctx {
  request: Request
  env: AppEnv
  url: URL
  session: Session | null
}

export const nowIso = () => new Date().toISOString()
