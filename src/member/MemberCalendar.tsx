import { useEffect, useState } from 'react'
import { CalendarDays, LoaderCircle, RefreshCw } from 'lucide-react'
import { CalendarView, useCalendarState } from '../components/CalendarView'
import { messageOf } from '../data/errors'
import { memberApi } from './api'
import type { MemberEvent } from './api'
import { MemberEventDialog } from './MemberEventDialog'

/** อ่านสำเนาปฏิทินเดียวกับหลังบ้านตามเดือน ไม่โหลด Google/ข้อมูลทีมงานใน browser สมาชิก */
export function MemberCalendar() {
  const calendar = useCalendarState()
  const [page, setPage] = useState<{ month: string; events: MemberEvent[]; truncated: boolean } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState<MemberEvent | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setBusy(true); setError('')
    memberApi.calendar(calendar.month, controller.signal).then(value => {
      if (!controller.signal.aborted) { setPage(value); setBusy(false) }
    }, failure => { if (!controller.signal.aborted) { setError(messageOf(failure, 'โหลดปฏิทินไม่สำเร็จ')); setBusy(false) } })
    return () => controller.abort()
  }, [calendar.month, attempt])
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setAttempt(n => n + 1) }
    const timer = window.setInterval(refresh, 60_000)
    window.addEventListener('focus', refresh)
    document.addEventListener('visibilitychange', refresh)
    return () => { window.clearInterval(timer); window.removeEventListener('focus', refresh); document.removeEventListener('visibilitychange', refresh) }
  }, [])
  const current = page?.month === calendar.month ? page : null
  return <section className="m-card calendar-card m-home-calendar" aria-labelledby="member-calendar-title" aria-busy={busy}>
    <div className="m-card-head"><div><h2 id="member-calendar-title"><CalendarDays size={20} aria-hidden="true" />ปฏิทินชมรม</h2><p className="muted">กำหนดการจากทีมงาน · เวลาไทย</p></div><button type="button" className="button button-small" disabled={busy} onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} aria-hidden="true" className={busy ? 'spin' : undefined} />อัปเดตปฏิทิน</button></div>
    {error && <p className="form-alert" role="alert">{error}{current && ' กำลังแสดงข้อมูลที่โหลดไว้ก่อนหน้า'}</p>}
    <CalendarView calendar={calendar} events={current?.events ?? []} onOpenEvent={id => setOpen(current?.events.find(event => event.id === id) ?? null)} headingLevel={3} readOnly contentState={current ? undefined : busy ? <p className="m-inline-state" role="status"><LoaderCircle className="spin" size={18} aria-hidden="true" />กำลังโหลดปฏิทิน…</p> : <p className="muted">ยังโหลดกำหนดการไม่ได้ กดอัปเดตปฏิทินเพื่อลองอีกครั้ง</p>} />
    {current?.truncated && <p className="muted">เดือนนี้มีมากกว่า 500 กำหนดการ กำลังแสดง 500 รายการแรก</p>}
    {open && <MemberEventDialog event={open} onClose={() => setOpen(null)} />}
  </section>
}
