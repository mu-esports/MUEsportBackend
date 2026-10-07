export type MemberRole = 'member' | 'staff' | 'admin'
export type MemberStatus = 'active' | 'suspended'

export interface Member {
  id: string
  name: string
  nickname: string
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
}

export type MemberInput = Omit<Member, 'id' | 'addedAt' | 'version' | 'source' | 'sourceState'>

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
