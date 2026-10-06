import { useMemo, useRef, useState } from 'react'
import type { ReactNode, RefObject } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, CalendarX, ChevronLeft, ChevronRight, Clock, List, MapPin } from 'lucide-react'
import type { ClubEvent } from '../data/types'
import {
  addMonths, dateOf, eventsOnDate, eventTimeLabel, formatDateLong, formatDateWithWeekday,
  formatEventRange, formatMonth, monthGrid, monthOf, today, WEEKDAYS_SHORT,
} from '../lib/datetime'
import { EmptyState } from './ui'

export type CalendarMode = 'month' | 'list'

// จำนวนกำหนดการที่แสดงในช่องวัน ที่เหลือรวมเป็น “อีก N รายการ”
const MAX_CHIPS = 2
// จอแคบเริ่มที่มุมมองรายการ ต้องตรงกับ breakpoint มือถือใน styles.css
const NARROW_QUERY = '(max-width: 767px)'

/** สถานะของปฏิทิน (เดือน วันที่เลือก มุมมอง) ใช้ร่วมกันทั้งหน้าแรกและหน้าปฏิทิน */
export function useCalendarState() {
  const todayDate = today()
  const [view, setView] = useState<CalendarMode>(() => (window.matchMedia(NARROW_QUERY).matches ? 'list' : 'month'))
  const [month, setMonth] = useState(() => monthOf(todayDate))
  const [selected, setSelected] = useState(todayDate)

  const goToMonth = (next: string) => {
    setMonth(next)
    // คงวันที่เลือกไว้ในเดือนที่กำลังดู: ใช้วันนี้ถ้าอยู่ในเดือนนั้น ไม่เช่นนั้นใช้วันที่ 1
    setSelected(monthOf(todayDate) === next ? todayDate : `${next}-01`)
  }
  const goToday = () => {
    setMonth(monthOf(todayDate))
    setSelected(todayDate)
  }
  const selectDay = (day: string) => {
    setSelected(day)
    setMonth(monthOf(day))
  }

  return { todayDate, view, setView, month, selected, goToMonth, goToday, selectDay }
}

export type CalendarState = ReturnType<typeof useCalendarState>

interface CalendarViewProps {
  calendar: CalendarState
  events: ClubEvent[]
  /** เปิดรายละเอียดในหน้านี้ (กำหนดการเป็นปุ่ม) */
  onOpenEvent?(id: string): void
  /** พาไปหน้าที่แสดงรายละเอียด (กำหนดการเป็นลิงก์) ใช้เมื่อไม่มี onOpenEvent */
  eventHref?(id: string): string
  /** ปุ่มในสถานะว่างของวันที่เลือกและของเดือน */
  emptyDayAction?(day: string): ReactNode
  emptyMonthAction?: ReactNode
  /** ระดับหัวข้อของชื่อเดือน หัวข้อวันอยู่ถัดลงไปหนึ่งระดับ */
  headingLevel?: 2 | 3
  titleRef?: RefObject<HTMLHeadingElement | null>
}

export function CalendarView({
  calendar, events, onOpenEvent, eventHref, emptyDayAction, emptyMonthAction, headingLevel = 2, titleRef,
}: CalendarViewProps) {
  const { todayDate, view, setView, month, selected, goToMonth, goToday, selectDay } = calendar
  const panelRef = useRef<HTMLElement>(null)
  const panelHeadingRef = useRef<HTMLHeadingElement>(null)
  const MonthHeading = headingLevel === 2 ? 'h2' : 'h3'
  const DayHeading = headingLevel === 2 ? 'h3' : 'h4'

  const days = useMemo(() => monthGrid(month), [month])
  const byDay = useMemo(() => {
    const map = new Map<string, ClubEvent[]>()
    for (const day of days) map.set(day, eventsOnDate(events, day))
    return map
  }, [days, events])

  const listDays = days.filter((d) => monthOf(d) === month && (byDay.get(d)?.length ?? 0) > 0)
  const selectedEvents = eventsOnDate(events, selected)

  // แผงรายการของวันอาจอยู่ใต้ตาราง จึงเลื่อนให้เห็นเมื่อเลือกวัน
  const selectDayAndReveal = (day: string) => {
    selectDay(day)
    requestAnimationFrame(() => panelRef.current?.scrollIntoView({ block: 'nearest' }))
  }
  // “อีก N รายการ” พาไปที่รายการของวันนั้นโดยตรง
  const openDayList = (day: string) => {
    selectDay(day)
    requestAnimationFrame(() => panelHeadingRef.current?.focus())
  }

  const eventProps = { onOpenEvent, eventHref }

  return (
    <>
      <div className="calendar-toolbar">
        <button type="button" className="button calendar-today" onClick={goToday}>
          วันนี้
        </button>
        <div className="calendar-nav">
          <button
            type="button"
            className="icon-button calendar-step"
            aria-label="เดือนก่อนหน้า"
            onClick={() => goToMonth(addMonths(month, -1))}
          >
            <ChevronLeft aria-hidden="true" size={26} />
          </button>
          <MonthHeading className="calendar-title" aria-live="polite" tabIndex={-1} ref={titleRef}>
            {formatMonth(month)}
          </MonthHeading>
          <button
            type="button"
            className="icon-button calendar-step"
            aria-label="เดือนถัดไป"
            onClick={() => goToMonth(addMonths(month, 1))}
          >
            <ChevronRight aria-hidden="true" size={26} />
          </button>
        </div>
        <div className="segmented" role="group" aria-label="มุมมองปฏิทิน">
          <button type="button" aria-pressed={view === 'month'} onClick={() => setView('month')}>
            <CalendarDays aria-hidden="true" size={16} />
            เดือน
          </button>
          <button type="button" aria-pressed={view === 'list'} onClick={() => setView('list')}>
            <List aria-hidden="true" size={16} />
            รายการ
          </button>
        </div>
      </div>

      {view === 'month' ? (
        <div className="calendar-layout">
          <div className="month-grid">
            {WEEKDAYS_SHORT.map((w) => (
              <div key={w} className="month-weekday" aria-hidden="true">
                {w}
              </div>
            ))}
            {days.map((day) => {
              const dayEvents = byDay.get(day) ?? []
              const isToday = day === todayDate
              const classes = [
                'month-cell',
                monthOf(day) !== month && 'is-outside',
                isToday && 'is-today',
                day === selected && 'is-selected',
              ]
                .filter(Boolean)
                .join(' ')
              return (
                <div key={day} className={classes}>
                  <button
                    type="button"
                    className="month-day"
                    aria-pressed={day === selected}
                    aria-current={isToday ? 'date' : undefined}
                    aria-label={`${formatDateLong(day)}${isToday ? ' (วันนี้)' : ''} ${
                      dayEvents.length ? `มี ${dayEvents.length} กำหนดการ` : 'ไม่มีกำหนดการ'
                    }`}
                    onClick={() => selectDayAndReveal(day)}
                  >
                    <span className="month-day-number">{Number(day.slice(8))}</span>
                    {isToday && <span className="month-today-label">วันนี้</span>}
                    {dayEvents.length > 0 && <span className="month-day-count">{dayEvents.length} รายการ</span>}
                  </button>
                  <ul className="month-chips">
                    {dayEvents.slice(0, MAX_CHIPS).map((e) => (
                      <li key={e.id}>
                        <EventTarget {...eventProps} id={e.id} className={`chip ${e.allDay ? 'chip-allday' : ''}`}>
                          <span className="chip-time">
                            <span className="chip-dot" aria-hidden="true" />
                            {eventTimeLabel(e, day)}
                          </span>
                          <span className="chip-title">{e.title}</span>
                        </EventTarget>
                      </li>
                    ))}
                    {dayEvents.length > MAX_CHIPS && (
                      <li>
                        <button
                          type="button"
                          className="chip-more"
                          aria-label={`อีก ${dayEvents.length - MAX_CHIPS} รายการ ดูกำหนดการทั้งหมดของ${formatDateLong(day)}`}
                          onClick={() => openDayList(day)}
                        >
                          อีก {dayEvents.length - MAX_CHIPS} รายการ
                        </button>
                      </li>
                    )}
                  </ul>
                </div>
              )
            })}
          </div>

          <section className="day-panel" ref={panelRef} aria-labelledby="day-panel-title">
            <p className="day-panel-label">วันที่เลือก</p>
            <DayHeading id="day-panel-title" className="day-panel-title" ref={panelHeadingRef} tabIndex={-1}>
              {formatDateLong(selected)}
              {selected === todayDate && <span className="today-tag">วันนี้</span>}
            </DayHeading>
            {selectedEvents.length === 0 ? (
              <EmptyState icon={CalendarX} title="ไม่มีกำหนดการในวันที่เลือก" action={emptyDayAction?.(selected)} />
            ) : (
              <>
                <p className="day-panel-count">{selectedEvents.length} กำหนดการ</p>
                <ul className="event-list">
                  {selectedEvents.map((e) => (
                    <EventRow key={e.id} event={e} day={selected} {...eventProps} />
                  ))}
                </ul>
              </>
            )}
          </section>
        </div>
      ) : listDays.length === 0 ? (
        <EmptyState icon={CalendarX} title={`ไม่มีกำหนดการใน${formatMonth(month)}`} action={emptyMonthAction}>
          เลื่อนไปเดือนอื่น หรือเพิ่มกำหนดการใหม่
        </EmptyState>
      ) : (
        <div className="agenda">
          {listDays.map((day) => (
            <section key={day} className="agenda-day">
              <DayHeading className="agenda-day-title">
                {formatDateWithWeekday(day)}
                {day === todayDate && <span className="today-tag">วันนี้</span>}
              </DayHeading>
              <ul className="event-list">
                {(byDay.get(day) ?? []).map((e) => (
                  <EventRow key={e.id} event={e} day={day} {...eventProps} />
                ))}
              </ul>
            </section>
          ))}
        </div>
      )}
    </>
  )
}

interface EventTargetProps {
  id: string
  className: string
  children: ReactNode
  onOpenEvent?(id: string): void
  eventHref?(id: string): string
}

/** กำหนดการหนึ่งรายการ: ปุ่มเมื่อเปิดรายละเอียดในหน้านี้ หรือลิงก์เมื่อรายละเอียดอยู่อีกหน้า */
function EventTarget({ id, className, children, onOpenEvent, eventHref }: EventTargetProps) {
  if (onOpenEvent) {
    return (
      <button type="button" className={className} data-event-id={id} onClick={() => onOpenEvent(id)}>
        {children}
      </button>
    )
  }
  return (
    <Link to={eventHref ? eventHref(id) : '#'} className={className} data-event-id={id}>
      {children}
    </Link>
  )
}

function EventRow({
  event, day, onOpenEvent, eventHref,
}: { event: ClubEvent; day: string } & Pick<EventTargetProps, 'onOpenEvent' | 'eventHref'>) {
  const multiDay = dateOf(event.start) !== dateOf(event.end)
  return (
    <li>
      <EventTarget id={event.id} className="event-row" onOpenEvent={onOpenEvent} eventHref={eventHref}>
        <span className="event-row-time">
          <Clock aria-hidden="true" size={14} />
          {eventTimeLabel(event, day)}
        </span>
        <span className="event-row-main">
          <span className="event-row-title">{event.title}</span>
          {multiDay && <span className="event-row-meta">{formatEventRange(event)}</span>}
          {event.location && (
            <span className="event-row-meta">
              <MapPin aria-hidden="true" size={14} />
              {event.location}
            </span>
          )}
        </span>
      </EventTarget>
    </li>
  )
}
