export type MemberRole = 'member' | 'staff' | 'admin'
export type MemberStatus = 'active' | 'suspended'

/** สถานะบัญชีเข้าสู่ระบบของสมาชิก (รหัสนักศึกษา + รหัสผ่าน) ตามที่ server รายงาน ไม่มีรหัสผ่านหรือ hash */
export interface MemberAccount {
  /** none = ยังไม่ได้เปิดบัญชี, must_change = ต้องเปลี่ยนรหัสผ่านชั่วคราว, active = เปิดใช้งาน, disabled = ปิดบัญชี */
  state: 'none' | 'must_change' | 'active' | 'disabled'
  /** รหัสนักศึกษาที่บัญชีใช้เข้าสู่ระบบ */
  loginId: string | null
  /** รหัสในทะเบียนไม่ตรงกับรหัสที่บัญชีใช้อยู่ รอผู้ดูแลยืนยัน */
  loginMismatch: boolean
  passwordSetAt: string | null
  lastLoginAt: string | null
  /** เหตุผลที่ยังเปิดบัญชีหรือตั้งรหัสผ่านไม่ได้ */
  blocked: null | 'suspended' | 'no_student_id' | 'student_id_conflict'
  /** รุ่นของบัญชีที่กำลังแสดง (null = ยังไม่มีบัญชี) ส่งกลับไปตอนลบบัญชี เพื่อไม่ลบบัญชีที่ถูกเปลี่ยนหรือสร้างใหม่จากที่อื่น */
  revision?: string | null
}

export type AthleteStatus = 'active' | 'inactive'

export interface Member {
  id: string
  name: string
  nickname: string
  /** รหัสนักศึกษา เก็บเป็นข้อความตามที่กรอก (คงเลขศูนย์นำหน้า) ว่าง = ยังไม่ได้กรอก */
  studentId: string
  /** ค่าที่ชีตระบุแต่ระบบยังไม่ใช้ เพราะซ้ำหรือผิดรูปแบบ (ไม่มีในโหมดตัวอย่าง) */
  studentIdIssue?: { code: 'invalid' | 'duplicate' | 'taken'; claimed: string } | null
  account?: MemberAccount
  role: MemberRole
  status: MemberStatus
  contact: string
  note: string
  /** วันที่เพิ่ม รูปแบบ YYYY-MM-DD ตามเวลา Asia/Bangkok */
  addedAt: string
  /** รุ่นของข้อมูล เพิ่มทุกครั้งที่แก้ ใช้กันการเขียนทับการแก้ของคนอื่น */
  version: number
  /** sheets = สำเนาจาก Google Sheets ที่เชื่อม, local = อยู่เฉพาะในเว็บ (ไม่มีในโหมดตัวอย่าง) */
  source?: 'local' | 'sheets'
  /** missing = เคยมาจากชีตแต่ไม่พบแถวแล้ว */
  sourceState?: 'ok' | 'missing'
  /** รุ่นของรูปโปรไฟล์ (null = ไม่มีรูป) ตัวรูปโหลดแยกจาก /api/members/:id/photo (ไม่มีในโหมดตัวอย่าง) */
  photoVersion?: string | null
  /** โปรไฟล์นักกีฬาของคนนี้ (null = ไม่ได้เป็นนักกีฬา) เป็นข้อมูลประกอบ ไม่ใช่สิทธิ์ของระบบ */
  athlete?: { game: string; status: AthleteStatus } | null
}

export type MemberInput = Omit<Member, 'id' | 'addedAt' | 'version' | 'source' | 'sourceState' | 'studentIdIssue' | 'account' | 'photoVersion' | 'athlete'>

/** โปรไฟล์นักกีฬา: ข้อมูลเพิ่มเติมของคนในทะเบียนสมาชิก ชื่อ ชื่อเล่น รหัสนักศึกษา และรูปมาจากทะเบียนเสมอ */
export interface Athlete {
  /** รหัสสมาชิกในทะเบียน (ตัวตนของนักกีฬา) */
  memberId: string
  name: string
  nickname: string
  studentId: string
  memberStatus: MemberStatus
  memberSourceState: 'ok' | 'missing'
  photoVersion: string | null
  game: string
  team: string
  position: string
  /** ชื่อในเกม */
  ign: string
  status: AthleteStatus
  note: string
  version: number
  createdAt: string
  updatedAt: string
}

export type AthleteInput = Pick<Athlete, 'game' | 'team' | 'position' | 'ign' | 'status' | 'note'>

export const ATHLETE_STATUS_LABELS: Record<AthleteStatus, string> = {
  active: 'ลงแข่งอยู่',
  inactive: 'ไม่ได้ลงแข่ง',
}
export const ATHLETE_STATUSES = Object.keys(ATHLETE_STATUS_LABELS) as AthleteStatus[]

/** รูปแบบรหัสนักศึกษาที่ระบบรับ ต้องตรงกับที่ server ตรวจ (worker/validation.ts) */
export const STUDENT_ID_PATTERN = /^[A-Za-z0-9](?:[A-Za-z0-9._-]{0,30}[A-Za-z0-9])?$/

export interface ClubEvent {
  id: string
  title: string
  allDay: boolean
  /** เวลาท้องถิ่น Asia/Bangkok รูปแบบ YYYY-MM-DDTHH:mm (ทั้งวัน: 00:00) */
  start: string
  /** เวลาท้องถิ่น Asia/Bangkok รูปแบบ YYYY-MM-DDTHH:mm (ทั้งวัน: 23:59) */
  end: string
  location: string
  description: string
  /** รุ่นของข้อมูล เพิ่มทุกครั้งที่แก้ */
  version: number
  /** calendar = สำเนาจาก Google Calendar ที่เชื่อม, local = อยู่เฉพาะในเว็บ */
  source?: 'local' | 'calendar'
  /** เป็นรายการย่อยของกำหนดการซ้ำ */
  recurring?: boolean
  /** false = แก้จากเว็บไม่ได้ ให้เปิด Google Calendar (เหตุผลอยู่ใน editNote) */
  editable?: boolean
  editNote?: string
  googleUrl?: string | null
}

export type ClubEventInput = Pick<ClubEvent, 'title' | 'allDay' | 'start' | 'end' | 'location' | 'description'>

export interface AppData {
  members: Member[]
  events: ClubEvent[]
}

// บทบาทของสมาชิกเป็นข้อมูลประกอบเท่านั้น ไม่ใช่สิทธิ์ของผู้เข้าสู่ระบบ (สิทธิ์ทีมงานตรวจที่ server แยกต่างหาก)
export const ROLE_LABELS: Record<MemberRole, string> = {
  member: 'สมาชิก',
  staff: 'ทีมงาน',
  admin: 'ผู้ดูแล',
}

export const STATUS_LABELS: Record<MemberStatus, string> = {
  active: 'ใช้งาน',
  suspended: 'พักการใช้งาน',
}

export const ROLES = Object.keys(ROLE_LABELS) as MemberRole[]
export const STATUSES = Object.keys(STATUS_LABELS) as MemberStatus[]
