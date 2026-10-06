import { useEffect, useRef, useState } from 'react'
import { useSearchParams } from 'react-router-dom'
import { CalendarPlus, Pencil, SearchX } from 'lucide-react'
import { CalendarView, useCalendarState } from '../components/CalendarView'
import { Dialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { DataBoundary, PageHeader } from '../components/ui'
import { useStore } from '../data/store'
import { dateOf, formatDate, formatEventRange } from '../lib/datetime'
import { EventForm } from './EventForm'

type FormTarget = { mode: 'add' } | { mode: 'edit'; id: string }

const isLink = (text: string) => /^https?:\/\/\S+$/i.test(text)

export function CalendarPage() {
  const { state, events } = useStore()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()

  const calendar = useCalendarState()
  const { todayDate, selected, goToday, selectDay } = calendar
  const [form, setForm] = useState<FormTarget | null>(null)
  const monthTitleRef = useRef<HTMLHeadingElement>(null)
  // รายละเอียดที่เปิดจากลิงก์ภายนอกหน้า (เช่น หน้าภาพรวม) ไม่มีปุ่มต้นทางในหน้านี้ให้คืน focus
  const openedFromLink = useRef(false)
  // id ที่จัดเดือนและวันที่เลือกให้ตรงแล้ว กันไม่ให้ย้ายวันที่เลือกซ้ำเมื่อข้อมูลเปลี่ยน
  const syncedEvent = useRef<string | null>(null)

  // รายละเอียดที่เปิดอยู่ผูกกับ ?event=<id> ใน URL จึงเปิดรายการเดิมได้เมื่อ refresh หรือเปิดลิงก์โดยตรง
  // id ที่เพิ่งสั่งปิด: ซ่อนทันทีโดยไม่รอ URL เปลี่ยน กัน dialog เปิดแวบกลับมาหลังบันทึก
  const [closedId, setClosedId] = useState<string | null>(null)
  const rawEventParam = searchParams.get('event')
  const eventParam = rawEventParam === closedId ? null : rawEventParam
  const detail = eventParam ? events.find((e) => e.id === eventParam) : undefined
  const missingEvent = eventParam !== null && state === 'ready' && !detail

  // แก้เฉพาะ parameter ที่ระบุ และแทนที่รายการประวัติเดิม เพื่อไม่ให้ Back เปิด dialog วน
  const setParam = (name: string, value: string | null) =>
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        if (value === null) next.delete(name)
        else next.set(name, value)
        return next
      },
      { replace: true },
    )

  // ทางลัดจากหน้าภาพรวม: /calendar?new=1 เปิดฟอร์มเพิ่มกำหนดการทันที
  useEffect(() => {
    if (searchParams.get('new') !== '1' || state !== 'ready') return
    setForm({ mode: 'add' })
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('new')
        return next
      },
      { replace: true },
    )
  }, [searchParams, setSearchParams, state])

  // มาถึง ?event=<id> จากลิงก์ การ refresh หรือ Back/Forward: เลือกเดือนและวันที่ให้ตรงกับรายการนั้น
  useEffect(() => {
    if (!rawEventParam) setClosedId(null)
    if (!eventParam) {
      syncedEvent.current = null
      return
    }
    if (state !== 'ready' || syncedEvent.current === eventParam) return
    const target = events.find((e) => e.id === eventParam)
    if (!target) return
    syncedEvent.current = eventParam
    const start = dateOf(target.start)
    // กำหนดการหลายวันที่กำลังดำเนินอยู่ให้เลือกวันนี้ นอกนั้นเลือกวันเริ่ม
    const day = start <= todayDate && todayDate <= dateOf(target.end) ? todayDate : start
    selectDay(day)
    openedFromLink.current = true
  }, [rawEventParam, eventParam, state, events, todayDate])

  // เปิดจากในหน้านี้: คงวันที่ผู้ใช้เลือกไว้ และคืน focus ไปที่ปุ่มที่กด
  const openDetail = (id: string) => {
    openedFromLink.current = false
    syncedEvent.current = id
    setClosedId(null)
    setParam('event', id)
  }
  const closeDetail = () => {
    setClosedId(rawEventParam)
    setParam('event', null)
  }

  const editTarget = form?.mode === 'edit' ? events.find((e) => e.id === form.id) : undefined
  const openAdd = () => setForm({ mode: 'add' })

  return (
    <>
      <PageHeader
        title="ปฏิทิน"
        description="กำหนดการในระบบของชมรม แสดงตามเวลาประเทศไทย"
        action={
          <button type="button" className="button button-primary" onClick={openAdd}>
            <CalendarPlus aria-hidden="true" size={18} />
            เพิ่มกำหนดการ
          </button>
        }
      />

      <DataBoundary>
        {missingEvent && (
          <div className="notice notice-block notice-warning" role="alert">
            <SearchX aria-hidden="true" size={18} />
            <div>
              <p>
                <strong>ไม่พบกำหนดการที่ต้องการเปิด</strong>
              </p>
              <p>รายการนี้อาจถูกแทนที่ตอนรีเซ็ตข้อมูลตัวอย่าง หรือลิงก์ไม่ถูกต้อง</p>
              <button
                type="button"
                className="button button-small"
                onClick={() => {
                  closeDetail()
                  goToday()
                  // ปุ่มนี้จะหายไปพร้อมข้อความ จึงย้าย focus ไปที่หัวข้อเดือนของปฏิทิน
                  requestAnimationFrame(() => monthTitleRef.current?.focus())
                }}
              >
                กลับไปดูปฏิทินเดือนนี้
              </button>
            </div>
          </div>
        )}

        <section className="card calendar-card" aria-label="ปฏิทินกำหนดการ">
          <CalendarView
            calendar={calendar}
            events={events}
            onOpenEvent={openDetail}
            titleRef={monthTitleRef}
            emptyDayAction={(day) => (
              <button type="button" className="button" onClick={openAdd}>
                เพิ่มกำหนดการวันที่ {formatDate(day)}
              </button>
            )}
            emptyMonthAction={
              <button type="button" className="button" onClick={openAdd}>
                เพิ่มกำหนดการ
              </button>
            }
          />
        </section>
      </DataBoundary>

      {detail && !form && (
        <Dialog
          title={detail.title}
          onRequestClose={closeDetail}
          returnFocus={() =>
            openedFromLink.current
              ? document.querySelector<HTMLElement>(`.event-row[data-event-id="${CSS.escape(detail.id)}"]`)
              : null
          }
          footer={
            <>
              <button type="button" className="button" onClick={closeDetail}>
                ปิด
              </button>
              <button
                type="button"
                className="button button-primary"
                onClick={() => setForm({ mode: 'edit', id: detail.id })}
                data-autofocus
              >
                <Pencil aria-hidden="true" size={16} />
                แก้ไข
              </button>
            </>
          }
        >
          <dl className="detail-list">
            <div className="detail-wide">
              <dt>วันเวลา</dt>
              <dd>{formatEventRange(detail)}</dd>
            </div>
            <div className="detail-wide">
              <dt>สถานที่หรือลิงก์</dt>
              <dd className="break-word">
                {!detail.location ? (
                  <span className="muted">ไม่ได้ระบุ</span>
                ) : isLink(detail.location) ? (
                  <a href={detail.location} target="_blank" rel="noopener noreferrer">
                    {detail.location}
                  </a>
                ) : (
                  detail.location
                )}
              </dd>
            </div>
            <div className="detail-wide">
              <dt>รายละเอียด</dt>
              <dd className="pre-line break-word">
                {detail.description || <span className="muted">ไม่มีรายละเอียด</span>}
              </dd>
            </div>
          </dl>
        </Dialog>
      )}

      {form && (form.mode === 'add' || editTarget) && (
        <EventForm
          event={editTarget}
          defaultDate={selected}
          onClose={() => setForm(null)}
          onSaved={(message, saved) => {
            setForm(null)
            closeDetail()
            // พาไปยังวันที่ของกำหนดการที่เพิ่งบันทึก เพื่อให้เห็นผลทันที
            selectDay(dateOf(saved.start))
            toast.success(message)
          }}
        />
      )}
    </>
  )
}
