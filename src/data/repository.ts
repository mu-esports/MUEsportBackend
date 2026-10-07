import { api } from '../api/client'
import { STORAGE_KEY } from '../config'
import { today } from '../lib/datetime'
import { IS_DEMO } from '../mode'
import { AppError } from './errors'
import { createSeedData } from './seed'
import type { AppData, ClubEvent, ClubEventInput, Member, MemberInput, MemberStatus } from './types'

/**
 * ชั้นจัดเก็บข้อมูล — ส่วนแสดงผลเรียกผ่าน interface นี้เท่านั้น
 * ทุกคำสั่งทำกับรายการเดียว ไม่มีการเขียนข้อมูลทั้งชุด เพื่อไม่ทับการแก้ของคนอื่น
 * - การแก้ไขส่ง expectedVersion: ถ้าข้อมูลถูกแก้ไปแล้วจะได้ AppError รหัส version_conflict
 * - การสร้างส่ง key กันสร้างซ้ำ: ลองใหม่ด้วย key เดิมจะได้รายการเดิม
 */
export interface DataRepository {
  listMembers(): Promise<Member[]>
  listEvents(): Promise<ClubEvent[]>
  createMember(input: MemberInput, key: string): Promise<Member>
  updateMember(id: string, input: MemberInput, expectedVersion: number): Promise<Member>
  setMemberStatus(id: string, status: MemberStatus, expectedVersion: number): Promise<Member>
  createEvent(input: ClubEventInput, key: string): Promise<ClubEvent>
  updateEvent(id: string, input: ClubEventInput, expectedVersion: number): Promise<ClubEvent>
  /** มีเฉพาะโหมดตัวอย่าง: แทนที่ข้อมูลด้วยชุดเริ่มต้น */
  reset?(): Promise<void>
}

// ---------- โหมดใช้งานจริง: ข้อมูลกลางผ่าน API ----------

const apiRepository: DataRepository = {
  listMembers: async () => (await api<{ members: Member[] }>('/api/members')).members,
  listEvents: async () => (await api<{ events: ClubEvent[] }>('/api/events')).events,
  createMember: async (input, key) =>
    (await api<{ member: Member }>('/api/members', { method: 'POST', body: input, idempotencyKey: key })).member,
  updateMember: async (id, input, expectedVersion) =>
    (await api<{ member: Member }>(`/api/members/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...input, expectedVersion } })).member,
  setMemberStatus: async (id, status, expectedVersion) =>
    (await api<{ member: Member }>(`/api/members/${encodeURIComponent(id)}/status`, { method: 'POST', body: { status, expectedVersion } })).member,
  createEvent: async (input, key) =>
    (await api<{ event: ClubEvent }>('/api/events', { method: 'POST', body: input, idempotencyKey: key })).event,
  updateEvent: async (id, input, expectedVersion) =>
    (await api<{ event: ClubEvent }>(`/api/events/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...input, expectedVersion } })).event,
}

// ---------- โหมดตัวอย่าง: localStorage ของเบราว์เซอร์นี้ ----------

function isAppData(value: unknown): value is AppData {
  if (!value || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  return Array.isArray(v.members) && Array.isArray(v.events)
}

const STORAGE_FAILED = 'เบราว์เซอร์ไม่ยอมให้เก็บข้อมูลตัวอย่าง ตรวจว่าเบราว์เซอร์อนุญาตให้เก็บข้อมูลของเว็บนี้'

function readDemo(): AppData {
  const raw = localStorage.getItem(STORAGE_KEY)
  if (raw === null) {
    const seed = createSeedData()
    localStorage.setItem(STORAGE_KEY, JSON.stringify(seed))
    return seed
  }
  const parsed: unknown = JSON.parse(raw)
  if (!isAppData(parsed)) throw new Error('รูปแบบข้อมูลที่เก็บไว้ไม่ถูกต้อง')
  // ข้อมูลที่เก็บไว้ก่อนมี version ถือเป็นรุ่น 1
  return {
    // ข้อมูลที่เก็บไว้ก่อนมีรหัสนักศึกษาถือว่ายังไม่ได้กรอก
    members: parsed.members.map((m) => ({ ...m, version: m.version ?? 1, studentId: m.studentId ?? '' })),
    events: parsed.events.map((e) => ({ ...e, version: e.version ?? 1 })),
  }
}

function writeDemo(data: AppData) {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(data))
  } catch {
    throw new AppError('storage_failed', 0, STORAGE_FAILED)
  }
}

function replaceItem<T extends { id: string; version: number }>(items: T[], id: string, expectedVersion: number, change: (item: T) => T): [T[], T] {
  const current = items.find((item) => item.id === id)
  if (!current) throw new AppError('not_found', 404, 'ไม่พบรายการนี้')
  if (current.version !== expectedVersion) {
    throw new AppError('version_conflict', 409, 'ข้อมูลนี้ถูกแก้ไขจากแท็บอื่นหลังจากที่คุณเปิด โหลดค่าล่าสุดเพื่อตรวจก่อนบันทึกอีกครั้ง', { current })
  }
  const next = { ...change(current), version: current.version + 1 }
  return [items.map((item) => (item.id === id ? next : item)), next]
}

/** รหัสนักศึกษาต้องไม่ซ้ำกับสมาชิกคนอื่น (เหมือนที่ระบบกลางตรวจ) */
function assertStudentIdFree(members: Member[], studentId: string, exceptId = '') {
  if (!studentId) return
  const other = members.find((m) => m.id !== exceptId && m.studentId.toLowerCase() === studentId.toLowerCase())
  if (other) throw new AppError('student_id_taken', 409, `รหัสนักศึกษานี้มีสมาชิกคนอื่นใช้อยู่แล้ว (${other.name}) ยังไม่ได้บันทึก ตรวจรหัสให้ถูกต้องก่อนบันทึกอีกครั้ง`, { field: 'studentId' })
}

const demoRepository: DataRepository = {
  listMembers: async () => readDemo().members,
  listEvents: async () => readDemo().events,
  async createMember(input) {
    const data = readDemo()
    assertStudentIdFree(data.members, input.studentId)
    const member: Member = { ...input, id: crypto.randomUUID(), addedAt: today(), version: 1 }
    writeDemo({ ...data, members: [...data.members, member] })
    return member
  },
  async updateMember(id, input, expectedVersion) {
    const data = readDemo()
    assertStudentIdFree(data.members, input.studentId, id)
    const [members, member] = replaceItem(data.members, id, expectedVersion, (m) => ({ ...m, ...input }))
    writeDemo({ ...data, members })
    return member
  },
  async setMemberStatus(id, status, expectedVersion) {
    const data = readDemo()
    const [members, member] = replaceItem(data.members, id, expectedVersion, (m) => ({ ...m, status }))
    writeDemo({ ...data, members })
    return member
  },
  async createEvent(input) {
    const data = readDemo()
    const event: ClubEvent = { ...input, id: crypto.randomUUID(), version: 1 }
    writeDemo({ ...data, events: [...data.events, event] })
    return event
  },
  async updateEvent(id, input, expectedVersion) {
    const data = readDemo()
    const [events, event] = replaceItem(data.events, id, expectedVersion, (e) => ({ ...e, ...input }))
    writeDemo({ ...data, events })
    return event
  },
  async reset() {
    writeDemo(createSeedData())
  },
}

export const repository: DataRepository = IS_DEMO ? demoRepository : apiRepository
