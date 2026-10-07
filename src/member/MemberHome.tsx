import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { CalendarDays, ChevronRight, Clock, FolderOpen, LoaderCircle, MapPin, TriangleAlert, UserRound } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { AppError, messageOf } from '../data/errors'
import { libraryApi } from '../library/api'
import type { LibraryFile } from '../library/api'
import { FileCard } from '../library/FileList'
import { dateOf, formatDateLong, formatEventRange, now, sortEvents, today } from '../lib/datetime'
import { memberApi } from './api'
import type { MemberEvent } from './api'
import { MemberPageHeader } from './MemberLayout'

type Loaded<T> = { state: 'loading' } | { state: 'error'; message: string } | { state: 'unavailable'; message: string } | { state: 'ready'; data: T }

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

function SectionState({ loaded, retry, loadingText }: { loaded: Loaded<unknown>; retry(): void; loadingText: string }) {
  if (loaded.state === 'loading') {
    return (
      <p className="m-inline-state" role="status">
        <LoaderCircle aria-hidden="true" size={18} className="spin" />
        {loadingText}
      </p>
    )
  }
  if (loaded.state === 'unavailable') {
    return (
      <p className="m-inline-state" role="status">
        <TriangleAlert aria-hidden="true" size={18} />
        {loaded.message}
      </p>
    )
  }
  if (loaded.state === 'error') {
    return (
      <div className="m-inline-state m-inline-error" role="alert">
        <TriangleAlert aria-hidden="true" size={18} />
        <span>{loaded.message}</span>
        <button type="button" className="button button-small" onClick={retry}>
          ลองอีกครั้ง
        </button>
      </div>
    )
  }
  return null
}

export function MemberHomePage() {
  const { member } = useAuth()
  const [events, setEvents] = useState<Loaded<MemberEvent[]>>({ state: 'loading' })
  const [files, setFiles] = useState<Loaded<LibraryFile[]>>({ state: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setEvents({ state: 'loading' })
    setFiles({ state: 'loading' })
    memberApi.events().then(
      (list) => !cancelled && setEvents({ state: 'ready', data: upcoming(list).slice(0, 5) }),
      (failure: unknown) => !cancelled && setEvents({ state: 'error', message: messageOf(failure, 'โหลดกิจกรรมไม่สำเร็จ') }),
    )
    // ไฟล์ที่แก้ไขล่าสุด 5 รายการจากคลังจริง (ไม่ใช่ข้อมูลตัวอย่าง)
    libraryApi.list({ q: '', type: 'all', sort: 'modified' }, { limit: 5 }).then(
      (page) => !cancelled && setFiles({ state: 'ready', data: page.files }),
      (failure: unknown) => {
        if (cancelled) return
        if (failure instanceof AppError && failure.code === 'library_unavailable') setFiles({ state: 'unavailable', message: failure.message })
        else setFiles({ state: 'error', message: messageOf(failure, 'โหลดรายการไฟล์ไม่สำเร็จ') })
      },
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  const retry = () => setAttempt((n) => n + 1)

  return (
    <>
      <MemberPageHeader title={`สวัสดี ${member?.nickname || member?.name || ''}`.trim()} description={formatDateLong(today())} />

      <div className="m-home">
        <section className="m-card" aria-labelledby="home-events">
          <div className="m-card-head">
            <h2 id="home-events">
              <CalendarDays aria-hidden="true" size={20} />
              กิจกรรมที่จะมาถึง
            </h2>
            <Link to="/member/activities" className="text-link">
              ดูทั้งหมด
              <ChevronRight aria-hidden="true" size={16} />
            </Link>
          </div>
          <SectionState loaded={events} retry={retry} loadingText="กำลังโหลดกิจกรรม…" />
          {events.state === 'ready' &&
            (events.data.length === 0 ? (
              <p className="m-empty">ยังไม่มีกิจกรรมที่กำลังจะมาถึง</p>
            ) : (
              <ul className="m-event-list">
                {events.data.map((event) => (
                  <li key={event.id} className="m-event">
                    <EventSummary event={event} />
                  </li>
                ))}
              </ul>
            ))}
        </section>

        <section className="m-card" aria-labelledby="home-files">
          <div className="m-card-head">
            <h2 id="home-files">
              <FolderOpen aria-hidden="true" size={20} />
              ไฟล์ที่แก้ไขล่าสุด
            </h2>
            <Link to="/member/files" className="text-link">
              ดูทั้งหมด
              <ChevronRight aria-hidden="true" size={16} />
            </Link>
          </div>
          <SectionState loaded={files} retry={retry} loadingText="กำลังโหลดไฟล์…" />
          {files.state === 'ready' &&
            (files.data.length === 0 ? (
              <p className="m-empty">ยังไม่มีไฟล์ในคลังของชมรม</p>
            ) : (
              <ul className="file-grid file-grid-compact">
                {files.data.map((file) => (
                  <FileCard key={file.id} file={file} to={`/member/files/${encodeURIComponent(file.id)}`} state={{ from: '/member' }} />
                ))}
              </ul>
            ))}
        </section>

        <Link to="/member/account" className="m-card m-card-link">
          <span className="m-card-link-icon" aria-hidden="true">
            <UserRound size={22} />
          </span>
          <span>
            <span className="m-card-link-title">บัญชีของฉัน</span>
            <span className="m-card-link-text">ดูข้อมูลของตัวเอง แก้ช่องทางติดต่อ และเปลี่ยนรหัสผ่าน</span>
          </span>
          <ChevronRight aria-hidden="true" size={20} />
        </Link>
      </div>
    </>
  )
}
