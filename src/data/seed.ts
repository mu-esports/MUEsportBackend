import { addDays, today } from '../lib/datetime'
import type { AppData, ClubEvent, Member } from './types'

// ข้อมูลตัวอย่างทั้งหมดเป็นข้อมูลสมมติ ไม่ใช่บุคคลหรือช่องทางติดต่อจริง
// วันที่อ้างอิงจากวันที่สร้างข้อมูล เพื่อให้มีกำหนดการที่กำลังจะมาถึงเสมอ

type SeedMember = Omit<Member, 'id' | 'addedAt' | 'version'> & { daysAgo: number }
type SeedEvent = Omit<ClubEvent, 'id' | 'start' | 'end' | 'version'> & {
  startDay: number
  endDay?: number
  startTime?: string
  endTime?: string
}

const MEMBERS: SeedMember[] = [
  { name: 'ธนกร สมมติวงศ์', nickname: 'ต้น', role: 'admin', status: 'active', contact: 'Discord: ton_sample', note: 'ดูแลภาพรวมทีมงาน (ข้อมูลตัวอย่าง)', daysAgo: 210 },
  { name: 'พิมพ์ชนก ตัวอย่างดี', nickname: 'พิม', role: 'admin', status: 'active', contact: 'pim@example.com', note: '', daysAgo: 205 },
  { name: 'ภูริ ทดสอบกิจ', nickname: 'ภู', role: 'staff', status: 'active', contact: 'Discord: phu_sample', note: 'ประสานงานสถานที่', daysAgo: 160 },
  { name: 'กานต์ธิดา สมมตินาม', nickname: 'กานต์', role: 'staff', status: 'active', contact: '', note: 'ดูแลการรับสมัคร', daysAgo: 152 },
  { name: 'ศุภวิชญ์ ลองเล่น', nickname: 'วิน', role: 'staff', status: 'suspended', contact: 'win@example.com', note: 'พักช่วงฝึกงาน', daysAgo: 140 },
  { name: 'ณิชา ตัวอย่างสุข', nickname: 'มายด์', role: 'member', status: 'active', contact: 'Discord: mind_sample', note: '', daysAgo: 96 },
  { name: 'ปัณณวัฒน์ สมมติชัย', nickname: 'ปัน', role: 'member', status: 'active', contact: '', note: '', daysAgo: 90 },
  { name: 'ชลธิชา ทดลองใจ', nickname: 'น้ำ', role: 'member', status: 'active', contact: 'nam@example.com', note: '', daysAgo: 61 },
  { name: 'กฤตเมธ ตัวอย่างเกม', nickname: 'เมธ', role: 'member', status: 'active', contact: '', note: 'สนใจช่วยงานถ่ายทอดสด', daysAgo: 45 },
  { name: 'วริศรา สมมติพร', nickname: 'ออม', role: 'member', status: 'suspended', contact: '', note: '', daysAgo: 44 },
  { name: 'ธีรภัทร ทดสอบศิลป์', nickname: 'บอส', role: 'member', status: 'active', contact: 'Discord: boss_sample', note: '', daysAgo: 12 },
  { name: 'อริสา ลองดู', nickname: 'ฟ้า', role: 'member', status: 'active', contact: '', note: '', daysAgo: 3 },
]

const EVENTS: SeedEvent[] = [
  { title: 'ประชุมทีมงานประจำเดือน', allDay: false, startDay: -6, startTime: '18:00', endTime: '19:30', location: 'ห้องชมรม (ตัวอย่าง)', description: 'สรุปงานเดือนที่ผ่านมาและแบ่งงานเดือนถัดไป' },
  { title: 'ประชุมเตรียมงานแข่งภายใน', allDay: false, startDay: 1, startTime: '18:00', endTime: '19:00', location: 'https://example.com/meeting', description: 'ยืนยันตารางแข่ง ผู้ตัดสิน และอุปกรณ์' },
  { title: 'เปิดรับสมัครสมาชิกใหม่', allDay: true, startDay: 3, endDay: 9, location: '', description: 'เปิดรับตลอดสัปดาห์ผ่านแบบฟอร์มของชมรม' },
  { title: 'กิจกรรมพบปะสมาชิก', allDay: false, startDay: 5, startTime: '17:00', endTime: '20:00', location: 'ลานกิจกรรม (ตัวอย่าง)', description: '' },
  { title: 'ตรวจอุปกรณ์และจัดห้อง', allDay: false, startDay: 11, startTime: '13:00', endTime: '15:00', location: 'ห้องชมรม (ตัวอย่าง)', description: 'ตรวจเครื่อง สายสัญญาณ และจอ ก่อนวันแข่ง' },
  { title: 'แข่งขันภายในชมรม', allDay: true, startDay: 12, endDay: 13, location: 'ห้องชมรม (ตัวอย่าง)', description: 'แข่งสองวัน รอบแบ่งกลุ่มและรอบชิง' },
  { title: 'สรุปผลงานแข่งและเก็บข้อเสนอแนะ', allDay: false, startDay: 16, startTime: '18:30', endTime: '19:30', location: 'https://example.com/meeting', description: '' },
]

export function createSeedData(): AppData {
  const base = today()
  return {
    members: MEMBERS.map(({ daysAgo, ...m }, i) => ({
      ...m,
      id: `seed-member-${i + 1}`,
      addedAt: addDays(base, -daysAgo),
      version: 1,
    })),
    events: EVENTS.map(({ startDay, endDay, startTime, endTime, ...e }, i) => ({
      ...e,
      id: `seed-event-${i + 1}`,
      start: `${addDays(base, startDay)}T${e.allDay ? '00:00' : startTime}`,
      end: `${addDays(base, endDay ?? startDay)}T${e.allDay ? '23:59' : endTime}`,
      version: 1,
    })),
  }
}
