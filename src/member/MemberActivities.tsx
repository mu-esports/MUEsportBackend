import { useEffect, useMemo, useState } from 'react'
import { CalendarX2, ChevronRight, LoaderCircle, TriangleAlert } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { messageOf } from '../data/errors'
import { dateOf, formatEventRange, formatMonth, monthOf, sortEvents, WEEKDAYS_SHORT, weekday } from '../lib/datetime'
import { memberApi } from './api'
import type { MemberEvent } from './api'
import { EventSummary, upcoming } from './MemberHome'
import { MemberPageHeader } from './MemberLayout'

type Tab = 'upcoming' | 'past'

/** แสดงลิงก์เฉพาะเมื่อสถานที่เป็น URL ของ http/https ทั้งข้อความ ข้อความอื่นแสดงตามตัวอักษร */
function Location({ value }: { value: string }) {
  if (/^https?:\/\/\S+$/i.test(value)) {
    return (
      <a href={value} target="_blank" rel="noopener noreferrer" className="break-word">
        {value}
      </a>
    )
  }
  return <span className="break-word">{value}</span>
}

function byMonth(events: MemberEvent[]): { month: string; events: MemberEvent[] }[] {
  const groups: { month: string; events: MemberEvent[] }[] = []
  for (const event of events) {
    const month = monthOf(dateOf(event.start))
    const last = groups[groups.length - 1]
    if (last?.month === month) last.events.push(event)
    else groups.push({ month, events: [event] })
  }
  return groups
}

/** กิจกรรมของชมรมแบบรายการ (อ่านอย่างเดียว): ไม่มีเพิ่ม แก้ หรือลบ */
export function MemberActivitiesPage() {
  const [events, setEvents] = useState<MemberEvent[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [tab, setTab] = useState<Tab>('upcoming')
  const [openId, setOpenId] = useState<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setEvents(null)
    setError('')
    memberApi.events().then(
      (list) => !cancelled && setEvents(list),
      (failure: unknown) => !cancelled && setError(messageOf(failure, 'โหลดกิจกรรมไม่สำเร็จ ลองอีกครั้ง')),
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const lists = useMemo(() => {
    if (!events) return { upcoming: [], past: [] }
    const coming = upcoming(events)
    const ids = new Set(coming.map((e) => e.id))
    return { upcoming: coming, past: sortEvents(events.filter((e) => !ids.has(e.id))).reverse() }
  }, [events])

  const shown = lists[tab]
  const open = events?.find((e) => e.id === openId) ?? null

  return (
    <>
      <MemberPageHeader title="กิจกรรม" description="กำหนดการของชมรม เวลาเป็นเวลาประเทศไทย" />

      <div className="m-segment" role="group" aria-label="ช่วงเวลา">
        <button type="button" className="m-segment-button" aria-pressed={tab === 'upcoming'} onClick={() => setTab('upcoming')}>
          กำลังจะมาถึง{events ? ` (${lists.upcoming.length})` : ''}
        </button>
        <button type="button" className="m-segment-button" aria-pressed={tab === 'past'} onClick={() => setTab('past')}>
          ที่ผ่านมา 30 วัน{events ? ` (${lists.past.length})` : ''}
        </button>
      </div>

      {error ? (
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดกิจกรรมไม่สำเร็จ</p>
          <p className="empty-state-text">{error}</p>
          <button type="button" className="button button-primary" onClick={() => setAttempt((n) => n + 1)}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      ) : !events ? (
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดกิจกรรม…</p>
        </div>
      ) : shown.length === 0 ? (
        <div className="empty-state">
          <CalendarX2 aria-hidden="true" size={28} />
          <p className="empty-state-title">{tab === 'upcoming' ? 'ยังไม่มีกิจกรรมที่กำลังจะมาถึง' : 'ไม่มีกิจกรรมในช่วง 30 วันที่ผ่านมา'}</p>
          <p className="empty-state-text">เมื่อทีมงานเพิ่มกำหนดการ รายการจะแสดงที่นี่</p>
        </div>
      ) : (
        byMonth(shown).map((group) => (
          <section key={group.month} className="m-month" aria-label={formatMonth(group.month)}>
            <h2 className="m-month-title">{formatMonth(group.month)}</h2>
            <ul className="m-activity-list">
              {group.events.map((event) => {
                const date = dateOf(event.start)
                return (
                  <li key={event.id}>
                    <button type="button" className="m-activity" onClick={() => setOpenId(event.id)} aria-haspopup="dialog">
                      <span className="m-date-chip" aria-hidden="true">
                        <span className="m-date-weekday">{WEEKDAYS_SHORT[weekday(date)]}</span>
                        <span className="m-date-day">{Number(date.slice(8, 10))}</span>
                      </span>
                      <span className="m-activity-main">
                        <EventSummary event={event} />
                      </span>
                      <ChevronRight aria-hidden="true" size={20} className="m-activity-arrow" />
                      <span className="visually-hidden">ดูรายละเอียด</span>
                    </button>
                  </li>
                )
              })}
            </ul>
          </section>
        ))
      )}

      {open && (
        <Dialog
          title={open.title}
          description={formatEventRange(open)}
          onRequestClose={() => setOpenId(null)}
          footer={
            <button type="button" className="button button-primary" onClick={() => setOpenId(null)} data-autofocus>
              ปิด
            </button>
          }
        >
          <dl className="detail-list">
            <div className="detail-wide">
              <dt>วันและเวลา</dt>
              <dd>{formatEventRange(open)}</dd>
            </div>
            <div className="detail-wide">
              <dt>สถานที่หรือลิงก์</dt>
              <dd>{open.location ? <Location value={open.location} /> : <span className="muted">ไม่ได้ระบุ</span>}</dd>
            </div>
            <div className="detail-wide">
              <dt>รายละเอียด</dt>
              <dd className="pre-line break-word">{open.description || <span className="muted">ไม่มีรายละเอียดเพิ่มเติม</span>}</dd>
            </div>
          </dl>
        </Dialog>
      )}
    </>
  )
}
