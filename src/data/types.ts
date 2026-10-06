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
}

export type MemberInput = Omit<Member, 'id' | 'addedAt' | 'version'>

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
}

export type ClubEventInput = Omit<ClubEvent, 'id' | 'version'>

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
