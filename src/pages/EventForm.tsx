import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Field, fieldAria } from '../components/ui'
import { createKeyTracker } from '../api/client'
import { hasCode, messageOf } from '../data/errors'
import { useStore } from '../data/store'
import type { ClubEvent, ClubEventInput } from '../data/types'
import { dateOf, formatEventRange, timeOf } from '../lib/datetime'

interface Values {
  title: string
  allDay: boolean
  startDate: string
  startTime: string
  endDate: string
  endTime: string
  location: string
  description: string
}

type ErrorKey = 'title' | 'startDate' | 'startTime' | 'endDate' | 'endTime'
type Errors = Partial<Record<ErrorKey, string>>
const ERROR_ORDER: ErrorKey[] = ['title', 'startDate', 'startTime', 'endDate', 'endTime']

function validate(v: Values): Errors {
  const errors: Errors = {}
  if (!v.title.trim()) errors.title = 'กรอกชื่อกำหนดการ'
  else if (v.title.trim().length > 120) errors.title = 'ชื่อยาวได้ไม่เกิน 120 ตัวอักษร'
  if (!v.startDate) errors.startDate = 'เลือกวันที่เริ่ม'
  if (!v.endDate) errors.endDate = 'เลือกวันที่สิ้นสุด'
  if (!v.allDay) {
    if (!v.startTime) errors.startTime = 'เลือกเวลาเริ่ม'
    if (!v.endTime) errors.endTime = 'เลือกเวลาสิ้นสุด'
  }
  if (Object.keys(errors).some((k) => k !== 'title')) return errors

  if (v.endDate < v.startDate) {
    errors.endDate = 'วันที่สิ้นสุดต้องไม่อยู่ก่อนวันที่เริ่ม'
  } else if (!v.allDay && v.endDate === v.startDate && v.endTime <= v.startTime) {
    errors.endTime = 'เวลาสิ้นสุดต้องอยู่หลังเวลาเริ่ม'
  }
  return errors
}

const toValues = (event: ClubEvent): Values => ({
  title: event.title,
  allDay: event.allDay,
  startDate: dateOf(event.start),
  startTime: event.allDay ? '18:00' : timeOf(event.start),
  endDate: dateOf(event.end),
  endTime: event.allDay ? '20:00' : timeOf(event.end),
  location: event.location,
  description: event.description,
})

interface Props {
  event?: ClubEvent
  /** วันที่ตั้งต้นเมื่อเพิ่มกำหนดการใหม่ */
  defaultDate: string
  onClose(): void
  onSaved(message: string, event: ClubEventInput): void
}

export function EventForm({ event, defaultDate, onClose, onSaved }: Props) {
  const { addEvent, updateEvent, refresh } = useStore()
  // รุ่นของข้อมูลที่ฟอร์มนี้เริ่มแก้ ใช้ให้ server ตรวจว่ามีคนแก้ไปก่อนหรือไม่
  const [base, setBase] = useState(event)
  const [initial, setInitial] = useState<Values>(() =>
    event
      ? toValues(event)
      : {
          title: '', allDay: false,
          startDate: defaultDate, startTime: '18:00',
          endDate: defaultDate, endTime: '20:00',
          location: '', description: '',
        },
  )
  const [values, setValues] = useState(initial)
  const [conflict, setConflict] = useState<ClubEvent | null>(null)
  const createKey = useRef(createKeyTracker()).current
  const [errors, setErrors] = useState<Errors>({})
  const [submitError, setSubmitError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const formRef = useRef<HTMLFormElement>(null)

  const dirty = JSON.stringify(values) !== JSON.stringify(initial)

  // ช่องวันที่และเวลาแสดงตามภาษาของเบราว์เซอร์ จึงสรุปเป็นรูปแบบเดียวกับที่ใช้ทั้งระบบให้ตรวจก่อนบันทึก
  const { title: _title, ...dateErrors } = validate(values)
  const preview =
    Object.keys(dateErrors).length === 0
      ? formatEventRange({
          allDay: values.allDay,
          start: `${values.startDate}T${values.startTime}`,
          end: `${values.endDate}T${values.endTime}`,
        })
      : null

  const set = <K extends keyof Values>(key: K, value: Values[K]) => {
    setValues((v) => {
      const next = { ...v, [key]: value }
      // เลื่อนวันสิ้นสุดตามเมื่อเดิมเป็นวันเดียวกับวันเริ่ม
      if (key === 'startDate' && v.endDate === v.startDate) next.endDate = value as string
      return next
    })
    // ข้อผิดพลาดของวันเวลาเกี่ยวข้องกัน จึงล้างพร้อมกันเมื่อแก้ช่องวันเวลาช่องใดช่องหนึ่ง
    if (key === 'title') setErrors((e) => ({ ...e, title: undefined }))
    else if (key !== 'location' && key !== 'description') setErrors((e) => ({ title: e.title }))
  }

  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const found = validate(values)
    setErrors(found)
    const firstInvalid = ERROR_ORDER.find((k) => found[k])
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLElement>(`#event-${firstInvalid}`)?.focus()
      return
    }
    const input: ClubEventInput = {
      title: values.title.trim(),
      allDay: values.allDay,
      start: `${values.startDate}T${values.allDay ? '00:00' : values.startTime}`,
      end: `${values.endDate}T${values.allDay ? '23:59' : values.endTime}`,
      location: values.location.trim(),
      description: values.description.trim(),
    }
    setSaving(true)
    setSubmitError('')
    setConflict(null)
    try {
      if (base) await updateEvent(base.id, input, base.version)
      else await addEvent(input, createKey(input))
      onSaved(event ? `บันทึกการแก้ไข “${input.title}” แล้ว` : `เพิ่มกำหนดการ “${input.title}” แล้ว`, input)
    } catch (error) {
      if (hasCode(error, 'version_conflict')) {
        setConflict((error as { data: { current: ClubEvent } }).data.current)
        setSubmitError(messageOf(error, ''))
      } else {
        setSubmitError(
          `บันทึกไม่สำเร็จ: ${messageOf(error, 'ระบบขัดข้อง')} ข้อมูลที่กรอกยังอยู่ครบ กด “${event ? 'บันทึกการแก้ไข' : 'เพิ่มกำหนดการ'}” เพื่อลองอีกครั้ง`,
        )
      }
      setSaving(false)
    }
  }

  const loadLatest = () => {
    if (!conflict) return
    const latest = toValues(conflict)
    setBase(conflict)
    setInitial(latest)
    setValues(latest)
    setErrors({})
    setConflict(null)
    setSubmitError('')
    refresh().catch(() => undefined)
  }

  return (
    <>
      <Dialog
        title={event ? 'แก้ไขกำหนดการ' : 'เพิ่มกำหนดการ'}
        description="เวลาทั้งหมดเป็นเวลาประเทศไทย (Asia/Bangkok)"
        onRequestClose={requestClose}
        footer={
          <>
            <button type="button" className="button" onClick={requestClose}>
              ยกเลิก
            </button>
            <button type="submit" form="event-form" className="button button-primary" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : event ? 'บันทึกการแก้ไข' : 'เพิ่มกำหนดการ'}
            </button>
          </>
        }
      >
        <form id="event-form" ref={formRef} onSubmit={submit} noValidate className="form">
          {submitError && (
            <div className="form-alert" role="alert">
              <p>{submitError}</p>
              {conflict && (
                <button type="button" className="button button-small" onClick={loadLatest}>
                  โหลดค่าล่าสุด (แทนที่ค่าที่กรอกไว้)
                </button>
              )}
            </div>
          )}
          <Field label="ชื่อกำหนดการ" htmlFor="event-title" error={errors.title}>
            <input
              id="event-title"
              type="text"
              value={values.title}
              onChange={(e) => set('title', e.target.value)}
              autoComplete="off"
              data-autofocus
              {...fieldAria('event-title', errors.title)}
            />
          </Field>

          <label className="checkbox">
            <input type="checkbox" checked={values.allDay} onChange={(e) => set('allDay', e.target.checked)} />
            ทั้งวัน
          </label>

          <div className="form-row">
            <Field label="วันที่เริ่ม" htmlFor="event-startDate" error={errors.startDate}>
              <input
                id="event-startDate"
                type="date"
                value={values.startDate}
                onChange={(e) => set('startDate', e.target.value)}
                aria-invalid={errors.startDate ? true : undefined}
                  aria-describedby={`${errors.startDate ? 'event-startDate-error ' : ''}event-datetime-hint`}
              />
            </Field>
            {!values.allDay && (
              <Field label="เวลาเริ่ม" htmlFor="event-startTime" error={errors.startTime}>
                <input
                  id="event-startTime"
                  type="time"
                  value={values.startTime}
                  onChange={(e) => set('startTime', e.target.value)}
                  aria-invalid={errors.startTime ? true : undefined}
                  aria-describedby={`${errors.startTime ? 'event-startTime-error ' : ''}event-datetime-hint`}
                />
              </Field>
            )}
          </div>

          <div className="form-row">
            <Field label="วันที่สิ้นสุด" htmlFor="event-endDate" error={errors.endDate}>
              <input
                id="event-endDate"
                type="date"
                value={values.endDate}
                onChange={(e) => set('endDate', e.target.value)}
                aria-invalid={errors.endDate ? true : undefined}
                  aria-describedby={`${errors.endDate ? 'event-endDate-error ' : ''}event-datetime-hint`}
              />
            </Field>
            {!values.allDay && (
              <Field label="เวลาสิ้นสุด" htmlFor="event-endTime" error={errors.endTime}>
                <input
                  id="event-endTime"
                  type="time"
                  value={values.endTime}
                  onChange={(e) => set('endTime', e.target.value)}
                  aria-invalid={errors.endTime ? true : undefined}
                  aria-describedby={`${errors.endTime ? 'event-endTime-error ' : ''}event-datetime-hint`}
                />
              </Field>
            )}
          </div>

          <p className="field-hint" id="event-datetime-hint">
            รูปแบบวันที่และเวลาในช่องกรอกขึ้นกับการตั้งค่าของเบราว์เซอร์ที่ใช้
            ส่วนสรุปด้านล่างแสดงตามเวลาประเทศไทยในรูปแบบเดียวกับทั้งระบบ
          </p>

          {preview && (
            <p className="form-preview">
              <span className="muted">จะแสดงเป็น</span> {preview}
            </p>
          )}

          <Field label="สถานที่หรือลิงก์" htmlFor="event-location" optional>
            <input
              id="event-location"
              type="text"
              value={values.location}
              onChange={(e) => set('location', e.target.value)}
              autoComplete="off"
            />
          </Field>
          <Field label="รายละเอียด" htmlFor="event-description" optional>
            <textarea
              id="event-description"
              rows={3}
              value={values.description}
              onChange={(e) => set('description', e.target.value)}
            />
          </Field>
        </form>
      </Dialog>

      {confirmDiscard && (
        <ConfirmDialog
          title="ทิ้งการแก้ไขที่ยังไม่บันทึก?"
          confirmLabel="ทิ้งการแก้ไข"
          cancelLabel="กลับไปแก้ไขต่อ"
          tone="danger"
          onConfirm={onClose}
          onCancel={() => setConfirmDiscard(false)}
        >
          <p>ข้อมูลที่กรอกไว้ในฟอร์มนี้จะหายไป</p>
        </ConfirmDialog>
      )}
    </>
  )
}
