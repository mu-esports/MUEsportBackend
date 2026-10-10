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
  /** Production always uses client work + server verifier. Only the isolated old test suite may use server-test. */
  PASSWORD_HASH_MODE?: 'client' | 'server-test'
  /** API key ของเบราว์เซอร์สำหรับ Google Picker (ไม่ลับ แต่ต้องจำกัด HTTP referrer และจำกัดให้ใช้ได้เฉพาะ Picker API) */
  GOOGLE_PICKER_API_KEY?: string
  /** เลขโครงการ Google Cloud (project number) ใช้เป็น App ID ของ Picker เพื่อให้ไฟล์ที่เลือกเปิดสิทธิ์ drive.file ให้แอปนี้ */
  GOOGLE_CLOUD_PROJECT_NUMBER?: string
}

export type Role = 'staff' | 'admin'

/** ทีมงานที่เข้าสู่ระบบด้วย Google (อยู่ในตาราง users) */
export interface SessionUser {
  id: string
  email: string
  name: string
  role: Role
}

/**
 * สมาชิกที่เข้าสู่ระบบด้วยรหัสนักศึกษาและรหัสผ่าน (ตาราง member_accounts)
 * ไม่มี role ของหลังบ้าน: บทบาทในทะเบียนสมาชิกเป็นข้อมูลประกอบเท่านั้น ไม่เคยถูกใช้ตัดสินสิทธิ์
 */
export interface SessionMember {
  /** members.id (รหัสสมาชิกที่เสถียร) */
  id: string
  name: string
  nickname: string
  /** รหัสนักศึกษาที่ใช้เข้าสู่ระบบ */
  studentId: string
  /** ยังใช้รหัสผ่านชั่วคราวที่ผู้ดูแลตั้ง: ทำได้เพียงเปลี่ยนรหัสผ่านและออกจากระบบ */
  mustChangePassword: boolean
}

interface SessionBase {
  tokenHash: string
  csrfToken: string
}

export interface StaffSession extends SessionBase {
  kind: 'staff'
  user: SessionUser
}

export interface MemberSession extends SessionBase {
  kind: 'member'
  member: SessionMember
  /** เวลาที่ server ออก session หลังตรวจรหัสผ่าน ใช้ยืนยันการตั้งรหัสแทนการขอรหัสชั่วคราวซ้ำ */
  authenticatedAt: string
}

/** session ระบุชนิดของผู้เข้าสู่ระบบเสมอ handler ต้องเลือก guard ตามชนิดที่ยอมรับ */
export type Session = StaffSession | MemberSession

/** สิ่งที่ handler ทุกตัวได้รับ */
export interface Ctx {
  request: Request
  env: AppEnv
  url: URL
  session: Session | null
}

export const nowIso = () => new Date().toISOString()
