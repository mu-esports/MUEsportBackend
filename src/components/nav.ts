import { CalendarDays, ClipboardList, Database, FolderOpen, LayoutDashboard, ShieldCheck, Users } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { IS_DEMO } from '../mode'

export interface NavItem {
  to: string
  label: string
  icon: LucideIcon
  /** ชื่อบนทางลัดของหน้าแรก (ไม่มี = ไม่เป็นทางลัด) */
  shortcut?: string
  /** แสดงเฉพาะโหมดใช้งานจริง */
  liveOnly?: boolean
  /** แสดงเฉพาะผู้ดูแล (สิทธิ์จริงตรวจที่ server) */
  adminOnly?: boolean
  /** setup = เครื่องมือตั้งค่า แยกกลุ่มจากเมนูที่ใช้งานประจำ */
  group?: 'setup'
  /** path อื่นที่ถือว่าอยู่ในเมนูนี้ (เช่น ลิงก์เอกสารเดิม) */
  also?: string[]
}

/** path นี้อยู่ในเมนูนี้หรือไม่ */
export const inNav = (item: NavItem, pathname: string) =>
  item.to === '/' ? pathname === '/' : [item.to, ...(item.also ?? [])].some((base) => pathname === base || pathname.startsWith(`${base}/`))

export const NAV: NavItem[] = [
  { to: '/', label: 'ภาพรวม', icon: LayoutDashboard },
  { to: '/members', label: 'สมาชิก', icon: Users, shortcut: 'สมาชิก' },
  { to: '/calendar', label: 'ปฏิทิน', icon: CalendarDays, shortcut: 'ปฏิทินชมรม' },
  { to: '/files', label: 'ไฟล์ชมรม', icon: FolderOpen, liveOnly: true, shortcut: 'ไฟล์ชมรม', also: ['/documents'] },
  { to: '/forms', label: 'ฟอร์ม', icon: ClipboardList, liveOnly: true },
  { to: '/sources', label: 'แหล่งข้อมูล', icon: Database, shortcut: 'แหล่งข้อมูล', group: 'setup' },
  { to: '/team', label: 'ทีมงาน', icon: ShieldCheck, liveOnly: true, adminOnly: true, group: 'setup' },
]

// ลำดับการ์ดทางลัดบนหน้าแรก
const SHORTCUT_ORDER = ['/members', '/files', '/calendar', '/sources']

/** เมนูที่ผู้ใช้คนนี้เปิดได้จริงในโหมดปัจจุบัน ทางลัดหน้าแรกใช้กฎเดียวกัน */
export function useNavItems(): NavItem[] {
  const { isAdmin } = useAuth()
  return NAV.filter((item) => (!item.liveOnly || !IS_DEMO) && (!item.adminOnly || isAdmin))
}

export function useShortcuts(): NavItem[] {
  const items = useNavItems()
  return SHORTCUT_ORDER.flatMap((to) => items.filter((item) => item.to === to && item.shortcut))
}
