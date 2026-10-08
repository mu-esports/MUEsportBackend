import { api } from '../api/client'
import { memberPasswordChallenge, passwordMaterial } from '../auth/member-password'

/** ข้อมูลของสมาชิกที่เข้าสู่ระบบอยู่: มาจาก endpoint ที่ผูกกับ session ของตัวเองเท่านั้น ไม่มีการดึงรายชื่อสมาชิกคนอื่นมากรองที่หน้าเว็บ */
export interface MemberSelf {
  name: string
  nickname: string
  studentId: string
  /** รหัสที่ใช้เข้าสู่ระบบ (ต่างจาก studentId ได้ชั่วคราวระหว่างรอทีมงานยืนยันการเปลี่ยน) */
  loginId: string | null
  status: 'active' | 'suspended'
  contact: string
  version: number
  /** false = ตอนนี้แก้ช่องทางติดต่อจากเว็บไม่ได้ ต้องให้ทีมงานแก้ */
  contactEditable: boolean
  /** เวลาที่สมาชิกเปลี่ยนรหัสผ่านเองครั้งล่าสุด (null = ยังใช้รหัสที่ทีมงานตั้ง) */
  passwordChangedAt: string | null
}

export interface MemberEvent {
  id: string
  title: string
  allDay: boolean
  start: string
  end: string
  location: string
  description: string
}

export const MIN_PASSWORD_LENGTH = 10
export const MAX_PASSWORD_LENGTH = 128

export const memberApi = {
  me: async () => (await api<{ member: MemberSelf }>('/api/member/me')).member,
  updateContact: async (contact: string, expectedVersion: number) =>
    (await api<{ member: MemberSelf }>('/api/member/me', { method: 'PATCH', body: { contact, expectedVersion } })).member,
  changePassword: async (currentPassword: string, newPassword: string) => {
    const session = await api<{ member: { studentId: string } }>('/api/session')
    const challenge = await memberPasswordChallenge(session.member.studentId)
    const currentProof = await passwordMaterial(currentPassword, challenge)
    const passwordProof = await passwordMaterial(newPassword)
    return api<{ ok: true; csrfToken: string }>('/api/member/password', { method: 'POST', body: { currentPassword, newPassword, currentProof, passwordProof } })
  },
  events: async () => (await api<{ events: MemberEvent[] }>('/api/member/events')).events,
}
