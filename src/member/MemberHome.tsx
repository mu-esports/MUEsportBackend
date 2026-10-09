import { Clock, MapPin } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { dateOf, formatDateLong, formatEventRange, now, sortEvents, today } from '../lib/datetime'
import type { MemberEvent } from './api'
import { MemberPageHeader } from './MemberLayout'
import { MemberCalendar } from './MemberCalendar'

/** กำหนดการที่ยังไม่จบ เรียงจากใกล้ที่สุด */
export function upcoming(events: MemberEvent[]): MemberEvent[] {
  const current = now()
  return sortEvents(events.filter((e) => (e.allDay ? dateOf(e.end) >= current.date : e.end >= current.dateTime)))
}

export function EventSummary({ event }: { event: MemberEvent }) {
  return (
    <>
      <p className="m-event-title">{event.title}</p>
      <p className="m-event-meta">
        <Clock aria-hidden="true" size={16} />
        <span>{formatEventRange(event)}</span>
      </p>
      {event.location && (
        <p className="m-event-meta">
          <MapPin aria-hidden="true" size={16} />
          <span className="break-word">{event.location}</span>
        </p>
      )}
    </>
  )
}

export function MemberHomePage() {
  const { member } = useAuth()
  return (
    <>
      <MemberPageHeader
        title={`สวัสดี ${member?.nickname || member?.name || ''}`}
        description={formatDateLong(today())}
      />
      <MemberCalendar />
    </>
  )
}
