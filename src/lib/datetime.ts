import { TIME_ZONE, USE_BUDDHIST_YEAR } from '../config'
import type { ClubEvent } from '../data/types'

// วันที่ใช้รูปแบบ YYYY-MM-DD และวันเวลาใช้ YYYY-MM-DDTHH:mm ตามเวลา Asia/Bangkok
// เทียบลำดับก่อนหลังได้ด้วยการเทียบ string โดยตรง

const MONTHS = [
  'มกราคม', 'กุมภาพันธ์', 'มีนาคม', 'เมษายน', 'พฤษภาคม', 'มิถุนายน',
  'กรกฎาคม', 'สิงหาคม', 'กันยายน', 'ตุลาคม', 'พฤศจิกายน', 'ธันวาคม',
]
const MONTHS_SHORT = [
  'ม.ค.', 'ก.พ.', 'มี.ค.', 'เม.ย.', 'พ.ค.', 'มิ.ย.',
  'ก.ค.', 'ส.ค.', 'ก.ย.', 'ต.ค.', 'พ.ย.', 'ธ.ค.',
]
export const WEEKDAYS_SHORT = ['อา.', 'จ.', 'อ.', 'พ.', 'พฤ.', 'ศ.', 'ส.']
const WEEKDAYS = ['อาทิตย์', 'จันทร์', 'อังคาร', 'พุธ', 'พฤหัสบดี', 'ศุกร์', 'เสาร์']

const pad = (n: number) => String(n).padStart(2, '0')
const displayYear = (y: number) => (USE_BUDDHIST_YEAR ? y + 543 : y)

function parts(date: string) {
  const [y, m, d] = date.split('-').map(Number)
  return { y, m, d }
}

function toUtc(date: string) {
  const { y, m, d } = parts(date)
  return new Date(Date.UTC(y, m - 1, d))
}

function fromUtc(dt: Date) {
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}-${pad(dt.getUTCDate())}`
}

/** วันและเวลาปัจจุบันตามเขตเวลาของระบบ ไม่ขึ้นกับเขตเวลาของเครื่องผู้ใช้ */
export function now(): { date: string; time: string; dateTime: string } {
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date())
  const get = (type: string) => f.find((p) => p.type === type)?.value ?? '00'
  const date = `${get('year')}-${get('month')}-${get('day')}`
  const time = `${get('hour')}:${get('minute')}`
  return { date, time, dateTime: `${date}T${time}` }
}

export const today = () => now().date

export function addDays(date: string, n: number) {
  const dt = toUtc(date)
  dt.setUTCDate(dt.getUTCDate() + n)
  return fromUtc(dt)
}

export const weekday = (date: string) => toUtc(date).getUTCDay()
export const monthOf = (date: string) => date.slice(0, 7)
export const dateOf = (dateTime: string) => dateTime.slice(0, 10)
export const timeOf = (dateTime: string) => dateTime.slice(11, 16)

export function addMonths(month: string, n: number) {
  const [y, m] = month.split('-').map(Number)
  const dt = new Date(Date.UTC(y, m - 1 + n, 1))
  return `${dt.getUTCFullYear()}-${pad(dt.getUTCMonth() + 1)}`
}

/** วันทั้งหมดที่ต้องแสดงในตารางเดือน เริ่มวันอาทิตย์ ครบสัปดาห์ */
export function monthGrid(month: string): string[] {
  const first = `${month}-01`
  const start = addDays(first, -weekday(first))
  const lastOfMonth = addDays(`${addMonths(month, 1)}-01`, -1)
  const end = addDays(lastOfMonth, 6 - weekday(lastOfMonth))
  const days: string[] = []
  for (let d = start; d <= end; d = addDays(d, 1)) days.push(d)
  return days
}

// ---------- การแสดงผล ----------

/** 10 ต.ค. 2569 */
export function formatDate(date: string) {
  const { y, m, d } = parts(date)
  return `${d} ${MONTHS_SHORT[m - 1]} ${displayYear(y)}`
}

/** วันเสาร์ที่ 10 ตุลาคม 2569 */
export function formatDateLong(date: string) {
  const { y, m, d } = parts(date)
  return `วัน${WEEKDAYS[weekday(date)]}ที่ ${d} ${MONTHS[m - 1]} ${displayYear(y)}`
}

/** ส. 10 ต.ค. 2569 */
export function formatDateWithWeekday(date: string) {
  return `${WEEKDAYS_SHORT[weekday(date)]} ${formatDate(date)}`
}

/** ตุลาคม 2569 */
export function formatMonth(month: string) {
  const [y, m] = month.split('-').map(Number)
  return `${MONTHS[m - 1]} ${displayYear(y)}`
}

/** 18:00 น. */
export const formatTime = (time: string) => `${time} น.`

/** ช่วงวันเวลาเต็มของกำหนดการ ใช้รูปแบบเดียวกันทุกหน้า */
export function formatEventRange(e: Pick<ClubEvent, 'allDay' | 'start' | 'end'>) {
  const sd = dateOf(e.start)
  const ed = dateOf(e.end)
  if (e.allDay) {
    return sd === ed
      ? `${formatDateWithWeekday(sd)} · ทั้งวัน`
      : `${formatDateWithWeekday(sd)} – ${formatDateWithWeekday(ed)} · ทั้งวัน`
  }
  if (sd === ed) {
    return `${formatDateWithWeekday(sd)} · ${timeOf(e.start)}–${formatTime(timeOf(e.end))}`
  }
  return `${formatDateWithWeekday(sd)} ${formatTime(timeOf(e.start))} – ${formatDateWithWeekday(ed)} ${formatTime(timeOf(e.end))}`
}

/** ป้ายเวลาสั้นของกำหนดการสำหรับวันที่ระบุ เช่น "18:00" "ทั้งวัน" "ต่อเนื่อง" */
export function eventTimeLabel(e: Pick<ClubEvent, 'allDay' | 'start' | 'end'>, date: string) {
  if (e.allDay) return 'ทั้งวัน'
  if (dateOf(e.start) === date) return timeOf(e.start)
  return 'ต่อเนื่อง'
}

// ---------- การจัดกลุ่มกำหนดการ ----------

export function sortEvents<T extends Pick<ClubEvent, 'start' | 'allDay' | 'title'>>(events: T[]) {
  return [...events].sort(
    (a, b) =>
      a.start.localeCompare(b.start) ||
      Number(b.allDay) - Number(a.allDay) ||
      a.title.localeCompare(b.title, 'th'),
  )
}

export function eventsOnDate(events: ClubEvent[], date: string) {
  return sortEvents(events.filter((e) => dateOf(e.start) <= date && date <= dateOf(e.end)))
}

/** กำหนดการที่ยังไม่จบ เรียงจากใกล้ที่สุด */
export function upcomingEvents(events: ClubEvent[], limit: number) {
  const current = now()
  return sortEvents(
    events.filter((e) => (e.allDay ? dateOf(e.end) >= current.date : e.end >= current.dateTime)),
  ).slice(0, limit)
}

/** เวลาที่ระบบกลางบันทึก (ISO 8601 UTC) แสดงเป็นวันและเวลาตามเขตเวลาของระบบ เช่น 4 ต.ค. 2569 18:05 น. */
export function formatTimestamp(iso: string | null | undefined): string {
  if (!iso) return '—'
  const at = new Date(iso)
  if (Number.isNaN(at.getTime())) return '—'
  const f = new Intl.DateTimeFormat('en-CA', {
    timeZone: TIME_ZONE,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
  }).formatToParts(at)
  const get = (type: string) => f.find((p) => p.type === type)?.value ?? '00'
  return `${formatDate(`${get('year')}-${get('month')}-${get('day')}`)} ${get('hour')}:${get('minute')} น.`
}
