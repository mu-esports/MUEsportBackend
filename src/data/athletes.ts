import { api } from '../api/client'
import type { Athlete, AthleteInput } from './types'

/** โปรไฟล์นักกีฬา (หลังบ้าน): ทีมงานจัดการได้ server ตรวจสิทธิ์ทุกคำขอ ตัวตนของนักกีฬาคือรหัสสมาชิกในทะเบียน */
const path = (memberId: string, action = '') => `/api/athletes/${encodeURIComponent(memberId)}${action}`

export const athletesApi = {
  list: async () => (await api<{ athletes: Athlete[] }>('/api/athletes')).athletes,
  /** เพิ่มโปรไฟล์นักกีฬาให้คนที่อยู่ในทะเบียนแล้ว คนที่เป็นนักกีฬาอยู่แล้วได้ข้อผิดพลาด already_athlete พร้อมโปรไฟล์ปัจจุบัน */
  add: async (memberId: string, input: AthleteInput) => (await api<{ athlete: Athlete }>('/api/athletes', { method: 'POST', body: { memberId, ...input } })).athlete,
  update: async (memberId: string, input: AthleteInput, expectedVersion: number) =>
    (await api<{ athlete: Athlete }>(path(memberId), { method: 'PATCH', body: { ...input, expectedVersion } })).athlete,
  /** ถอดโปรไฟล์นักกีฬา (ทะเบียน รูป และบัญชีเข้าสู่ระบบของคนนั้นไม่ถูกแตะ) removed: false = ไม่มีโปรไฟล์ให้ถอดแล้ว */
  remove: (memberId: string, expectedVersion: number) => api<{ removed: boolean }>(path(memberId, '/remove'), { method: 'POST', body: { expectedVersion } }),
}
