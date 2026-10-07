import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link } from 'react-router-dom'
import { ClipboardList, ExternalLink, Info, LoaderCircle, Lock, Pencil, Plus, TriangleAlert, UserPlus, X } from 'lucide-react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthProvider'
import { Dialog } from '../components/Dialog'
import { SyncBar } from '../components/SyncBar'
import { useToast } from '../components/Toast'
import { EmptyState, Field, fieldAria, PageHeader } from '../components/ui'
import { AppError, hasCode, messageOf } from '../data/errors'
import { useStore } from '../data/store'
import { useAutoSync } from '../data/sync'
import { formatTimestamp } from '../lib/datetime'

type MappingField = 'name' | 'nickname' | 'contact' | 'note'

interface FormInfo {
  id: string
  name: string
  title: string
  description: string
  revisionId: string
  editUrl: string
  responderUrl: string
  isQuiz: boolean
  published: boolean | null
  acceptingResponses: boolean | null
  writable: boolean
  mapping: Partial<Record<MappingField, string>>
  canConfigure: boolean
}

interface FormItem {
  itemId: string
  kind: string
  title: string
  description: string
  required: boolean
  questions: { id: string; label: string }[]
  options: { value: string; isOther: boolean }[]
  editable: boolean
  editNote: string
  removedAt: string | null
}

interface FormResponse {
  responseId: string
  createTime: string
  lastSubmittedTime: string
  respondentEmail: string
  answers: Record<string, { values: string[]; files: string[] }>
  sourceState: 'ok' | 'missing'
  reviewStatus: 'new' | 'imported' | 'dismissed'
  memberId: string | null
  candidate: Record<MappingField, string>
  duplicates: { id: string; name: string; nickname: string }[]
}

interface FormView {
  form: FormInfo | null
  items: FormItem[]
  responses: FormResponse[]
  responseCount: number
}

const KIND_LABELS: Record<string, string> = {
  short_text: 'คำตอบสั้น',
  paragraph: 'ย่อหน้า',
  radio: 'เลือกข้อเดียว',
  checkbox: 'เลือกได้หลายข้อ',
  dropdown: 'เลื่อนลง',
  scale: 'สเกลเชิงเส้น',
  date: 'วันที่',
  time: 'เวลา',
  rating: 'การให้คะแนน',
  file_upload: 'อัปโหลดไฟล์',
  grid: 'ตาราง',
  section: 'ส่วนของฟอร์ม',
  text: 'ข้อความประกอบ',
  image: 'รูปภาพ',
  video: 'วิดีโอ',
  unknown: 'ชนิดอื่น',
}
const ADDABLE = ['short_text', 'paragraph', 'radio', 'checkbox', 'dropdown'] as const
const isChoice = (kind: string) => kind === 'radio' || kind === 'checkbox' || kind === 'dropdown'
const MAPPING_LABELS: Record<MappingField, string> = { name: 'ชื่อ', nickname: 'ชื่อเล่น', contact: 'ช่องทางติดต่อ', note: 'หมายเหตุ' }
const REVIEW_LABELS: Record<FormResponse['reviewStatus'], string> = { new: 'ยังไม่ได้ตรวจ', imported: 'เพิ่มเป็นสมาชิกแล้ว', dismissed: 'ข้ามแล้ว' }

type Target =
  | { kind: 'info' }
  | { kind: 'item'; item: FormItem }
  | { kind: 'add' }
  | { kind: 'mapping' }
  | { kind: 'response'; id: string }
  | { kind: 'import'; id: string }

export function FormsPage() {
  const { isAdmin } = useAuth()
  const toast = useToast()
  const { refresh: refreshStore } = useStore()
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [error, setError] = useState('')
  const [data, setData] = useState<FormView | null>(null)
  const [target, setTarget] = useState<Target | null>(null)
  const [busyId, setBusyId] = useState<string | null>(null)
  const seq = useRef(0)

  const load = useCallback((silent = false) => {
    const current = ++seq.current
    if (!silent) setState('loading')
    api<FormView>('/api/forms').then(
      (result) => {
        if (current !== seq.current) return
        setData(result)
        setState('ready')
      },
      (failure: unknown) => {
        if (current !== seq.current) return
        if (silent) return
        setError(messageOf(failure, 'โหลดข้อมูลฟอร์มไม่สำเร็จ'))
        setState('error')
      },
    )
  }, [])
  useEffect(() => load(), [load])

  // โครงสร้างหรือคำตอบเปลี่ยนที่ Google: โหลดรายการใหม่เงียบ ๆ กล่องแก้ไขที่เปิดอยู่เก็บค่าของตัวเอง จึงไม่ถูกทับ
  useAutoSync(['forms'], () => load(true))

  const applied = (next: FormView) => {
    seq.current++
    setData(next)
    setState('ready')
  }

  const form = data?.form ?? null
  const items = useMemo(() => (data?.items ?? []).filter((i) => i.removedAt === null), [data])
  const removed = useMemo(() => (data?.items ?? []).filter((i) => i.removedAt !== null), [data])
  const responses = data?.responses ?? []
  const responseOf = (id: string) => responses.find((r) => r.responseId === id)

  const setReview = async (response: FormResponse, action: 'dismiss' | 'restore') => {
    setBusyId(response.responseId)
    try {
      applied(await api<FormView>(`/api/forms/responses/${encodeURIComponent(response.responseId)}/${action}`, { method: 'POST' }))
    } catch (failure) {
      toast.error(messageOf(failure, 'ทำรายการไม่สำเร็จ ลองอีกครั้ง'))
    } finally {
      setBusyId(null)
    }
  }

  return (
    <>
      <PageHeader title="ฟอร์ม" description="คำถามและคำตอบของ Google Forms ที่เชื่อมไว้ คำตอบต้นฉบับอ่านได้อย่างเดียว" />
      <SyncBar kinds={['forms']} />

      {state === 'loading' && (
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดข้อมูลฟอร์ม…</p>
        </div>
      )}
      {state === 'error' && (
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดข้อมูลฟอร์มไม่สำเร็จ</p>
          <p className="empty-state-text">{error}</p>
          <button type="button" className="button button-primary" onClick={() => load()}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      )}

      {state === 'ready' && !form && (
        <section className="card">
          <EmptyState
            icon={ClipboardList}
            title="ยังไม่ได้เชื่อม Google Forms"
            action={
              isAdmin ? (
                <Link to="/sources" className="button button-primary">
                  ไปตั้งค่าที่หน้าแหล่งข้อมูล
                </Link>
              ) : undefined
            }
          >
            {isAdmin ? 'สร้างฟอร์มใหม่ในบัญชีชมรม หรือเลือกฟอร์มที่มีอยู่ ได้ที่หน้าแหล่งข้อมูล' : 'ผู้ดูแลระบบเป็นผู้สร้างหรือเลือกฟอร์มที่จะใช้ที่หน้าแหล่งข้อมูล'}
          </EmptyState>
        </section>
      )}

      {state === 'ready' && form && (
        <>
          <section className="card form-info-card" aria-labelledby="form-info-title">
            <div className="card-header">
              <h2 id="form-info-title" className="break-word">
                {form.title || 'ฟอร์มไม่มีหัวเรื่อง'}
              </h2>
              {form.writable && (
                <button type="button" className="button button-small" onClick={() => setTarget({ kind: 'info' })}>
                  <Pencil aria-hidden="true" size={16} />
                  แก้หัวเรื่องและคำอธิบาย
                </button>
              )}
            </div>
            <p className="pre-line break-word">{form.description || <span className="muted">ไม่มีคำอธิบาย</span>}</p>
            <p className="field-hint">
              {form.published === null
                ? 'Google ไม่ได้ระบุสถานะการเผยแพร่ของฟอร์มนี้ ตรวจได้ใน Google Forms'
                : form.published
                  ? form.acceptingResponses
                    ? 'ฟอร์มเผยแพร่แล้วและกำลังรับคำตอบ'
                    : 'ฟอร์มเผยแพร่แล้วแต่ปิดรับคำตอบอยู่'
                  : 'ฟอร์มยังไม่เผยแพร่ ผู้ตอบยังส่งคำตอบไม่ได้ เปิดเผยแพร่ได้ใน Google Forms เมื่อพร้อม'}
              {' · '}การส่งคำตอบทำผ่านหน้าฟอร์มของ Google เท่านั้น
            </p>
            {!form.writable && (
              <p className="notice">
                <Lock aria-hidden="true" size={18} />
                บัญชี Google ของชมรมมีสิทธิ์อ่านฟอร์มนี้อย่างเดียว จึงแก้จากเว็บไม่ได้
              </p>
            )}
            <div className="button-row">
              <a className="button button-small" href={form.editUrl} target="_blank" rel="noopener noreferrer">
                เปิดแก้ใน Google Forms
                <ExternalLink aria-hidden="true" size={14} />
              </a>
              {form.responderUrl && (
                <a className="button button-small" href={form.responderUrl} target="_blank" rel="noopener noreferrer">
                  เปิดหน้าฟอร์มสำหรับผู้ตอบ
                  <ExternalLink aria-hidden="true" size={14} />
                </a>
              )}
            </div>
          </section>

          <section className="card" aria-labelledby="form-items-title">
            <div className="card-header">
              <h2 id="form-items-title">คำถาม ({items.length})</h2>
              {form.writable && !form.isQuiz && (
                <button type="button" className="button button-small" onClick={() => setTarget({ kind: 'add' })}>
                  <Plus aria-hidden="true" size={16} />
                  เพิ่มคำถาม
                </button>
              )}
            </div>
            <p className="field-hint">แก้จากเว็บได้เฉพาะคำถามข้อความและตัวเลือกแบบพื้นฐาน การจัดลำดับ การลบ และส่วนที่ซับซ้อนกว่านั้นทำใน Google Forms</p>
            {items.length === 0 ? (
              <EmptyState icon={ClipboardList} title="ฟอร์มนี้ยังไม่มีคำถาม" />
            ) : (
              <ol className="form-items">
                {items.map((item) => (
                  <li key={item.itemId} className="form-item" data-item-id={item.itemId}>
                    <div className="form-item-main">
                      <p className="form-item-title break-word">
                        {item.title || <span className="muted">(ไม่มีข้อความ)</span>}
                        {item.required && <span className="badge badge-neutral">บังคับตอบ</span>}
                      </p>
                      <p className="form-item-meta">{KIND_LABELS[item.kind] ?? KIND_LABELS.unknown}</p>
                      {item.description && <p className="form-item-description pre-line break-word">{item.description}</p>}
                      {item.questions.some((q) => q.label) && <p className="form-item-meta break-word">แถว: {item.questions.map((q) => q.label).join(' · ')}</p>}
                      {item.options.length > 0 && (
                        <p className="form-item-meta break-word">ตัวเลือก: {item.options.map((o) => (o.isOther ? 'อื่น ๆ (ผู้ตอบพิมพ์เอง)' : o.value)).join(' · ')}</p>
                      )}
                      {!item.editable && item.editNote && (
                        <p className="form-item-lock">
                          <Lock aria-hidden="true" size={14} />
                          {item.editNote}
                        </p>
                      )}
                    </div>
                    {item.editable && (
                      <button type="button" className="button button-small" onClick={() => setTarget({ kind: 'item', item })} aria-label={`แก้ไขคำถาม ${item.title}`}>
                        <Pencil aria-hidden="true" size={16} />
                        แก้ไข
                      </button>
                    )}
                  </li>
                ))}
              </ol>
            )}
            {removed.length > 0 && (
              <details className="sync-issues">
                <summary>คำถามที่ถูกลบจากฟอร์มแล้ว {removed.length} ข้อ (เก็บไว้เพื่ออ่านคำตอบเก่า)</summary>
                <ul>
                  {removed.map((item) => (
                    <li key={item.itemId} className="break-word">
                      {item.title || '(ไม่มีข้อความ)'} — {KIND_LABELS[item.kind] ?? KIND_LABELS.unknown}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </section>

          <section className="card" aria-labelledby="form-responses-title">
            <div className="card-header">
              <h2 id="form-responses-title">คำตอบที่ได้รับ ({data!.responseCount})</h2>
              {form.canConfigure && (
                <button type="button" className="button button-small" onClick={() => setTarget({ kind: 'mapping' })}>
                  จับคู่คำถามกับทะเบียนสมาชิก
                </button>
              )}
            </div>
            <p className="notice">
              <Info aria-hidden="true" size={18} />
              คำตอบเป็นข้อมูลต้นฉบับจากผู้ตอบ เว็บไซต์แก้หรือส่งคำตอบแทนผู้ตอบไม่ได้ การเพิ่มเป็นสมาชิกสร้างข้อมูลในทะเบียนสมาชิกแยกต่างหาก ไม่เปลี่ยนคำตอบใน Google Forms
              และไม่ให้สิทธิ์เข้าหลังบ้าน
            </p>
            {responses.length === 0 ? (
              <EmptyState icon={ClipboardList} title="ยังไม่มีคำตอบ">
                คำตอบใหม่จะแสดงที่นี่หลังรอบอัปเดตจาก Google
              </EmptyState>
            ) : (
              <ul className="response-list">
                {responses.map((r) => (
                  <li key={r.responseId} className="response-row" data-response-id={r.responseId}>
                    <div className="response-main">
                      <p className="response-title break-word">{r.candidate.name || r.respondentEmail || 'คำตอบ'}</p>
                      <p className="form-item-meta">
                        ส่งเมื่อ {formatTimestamp(r.lastSubmittedTime)}
                        {r.lastSubmittedTime !== r.createTime && ' (ผู้ตอบแก้คำตอบ)'}
                      </p>
                      <div className="response-badges">
                        <span className={`badge ${r.reviewStatus === 'imported' ? 'badge-active' : 'badge-neutral'}`}>{REVIEW_LABELS[r.reviewStatus]}</span>
                        {r.sourceState === 'missing' && <span className="badge badge-warning">ถูกลบที่ Google Forms แล้ว</span>}
                        {r.duplicates.length > 0 && <span className="badge badge-warning">อาจซ้ำกับสมาชิกเดิม</span>}
                      </div>
                    </div>
                    <div className="response-actions">
                      <button type="button" className="button button-small" onClick={() => setTarget({ kind: 'response', id: r.responseId })}>
                        ดูคำตอบ
                      </button>
                      {r.reviewStatus === 'new' && form.mapping.name && (
                        <button type="button" className="button button-small" onClick={() => setTarget({ kind: 'import', id: r.responseId })}>
                          <UserPlus aria-hidden="true" size={16} />
                          ตรวจและเพิ่มเป็นสมาชิก
                        </button>
                      )}
                      {r.reviewStatus === 'new' && (
                        <button type="button" className="button button-small" disabled={busyId === r.responseId} onClick={() => setReview(r, 'dismiss')}>
                          ข้าม
                        </button>
                      )}
                      {r.reviewStatus === 'dismissed' && (
                        <button type="button" className="button button-small" disabled={busyId === r.responseId} onClick={() => setReview(r, 'restore')}>
                          นำกลับมาตรวจ
                        </button>
                      )}
                    </div>
                  </li>
                ))}
              </ul>
            )}
            {data!.responseCount > responses.length && (
              <p className="field-hint">
                แสดง {responses.length} คำตอบล่าสุดจากทั้งหมด {data!.responseCount} คำตอบ ดูทั้งหมดได้ใน Google Forms
              </p>
            )}
            {!form.mapping.name && responses.length > 0 && (
              <p className="field-hint">
                {form.canConfigure ? 'ยังไม่ได้จับคู่คำถามกับทะเบียนสมาชิก จึงยังเพิ่มสมาชิกจากคำตอบไม่ได้' : 'ผู้ดูแลยังไม่ได้จับคู่คำถามกับทะเบียนสมาชิก จึงยังเพิ่มสมาชิกจากคำตอบไม่ได้'}
              </p>
            )}
          </section>
        </>
      )}

      {form && target?.kind === 'info' && <InfoDialog form={form} latest={data!.form!} onConflict={() => load(true)} onClose={() => setTarget(null)} onSaved={(next, message) => (applied(next), setTarget(null), toast.success(message))} />}
      {form && (target?.kind === 'item' || target?.kind === 'add') && (
        <QuestionDialog
          item={target.kind === 'item' ? target.item : null}
          latest={target.kind === 'item' ? (data!.items.find((i) => i.itemId === target.item.itemId) ?? null) : null}
          revisionId={form.revisionId}
          onConflict={() => load(true)}
          onClose={() => setTarget(null)}
          onSaved={(next, message) => (applied(next), setTarget(null), toast.success(message))}
        />
      )}
      {form && target?.kind === 'mapping' && <MappingDialog form={form} items={items} onClose={() => setTarget(null)} onSaved={(next) => (applied(next), setTarget(null), toast.success('บันทึกการจับคู่คำถามแล้ว'))} />}
      {target?.kind === 'response' && responseOf(target.id) && <ResponseDialog response={responseOf(target.id)!} items={data!.items} onClose={() => setTarget(null)} />}
      {target?.kind === 'import' && responseOf(target.id) && (
        <ImportDialog
          response={responseOf(target.id)!}
          onClose={() => setTarget(null)}
          onSaved={(next, name) => {
            applied(next)
            setTarget(null)
            refreshStore().catch(() => undefined)
            toast.success(`เพิ่ม “${name}” เป็นสมาชิกแล้ว`)
          }}
        />
      )}
    </>
  )
}

function saveFailure(failure: unknown, what: string) {
  if (failure instanceof AppError && failure.code === 'save_outcome_unknown') return failure.message
  return `บันทึกไม่สำเร็จ: ${messageOf(failure, 'ระบบขัดข้อง')} ${failure instanceof AppError && failure.code === 'revision_conflict' ? '' : `ยังไม่มีการเปลี่ยนแปลง${what} `}สิ่งที่กรอกไว้ยังอยู่ครบ`
}

function InfoDialog({ form, latest, onConflict, onClose, onSaved }: { form: FormInfo; latest: FormInfo; onConflict(): void; onClose(): void; onSaved(next: FormView, message: string): void }) {
  // ค่าตั้งต้นและ revision ที่กล่องนี้เริ่มแก้ คงไว้แม้หน้าด้านหลังจะได้ฉบับใหม่จาก Google
  const [base, setBase] = useState({ title: form.title, description: form.description, revisionId: form.revisionId })
  const [title, setTitle] = useState(form.title)
  const [description, setDescription] = useState(form.description)
  const [error, setError] = useState('')
  const [titleError, setTitleError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)

  const submit = async (event?: FormEvent, revision = base.revisionId) => {
    event?.preventDefault()
    if (!title.trim()) return setTitleError('กรอกหัวเรื่องฟอร์ม')
    setSaving(true)
    setError('')
    try {
      const next = await api<FormView & { verified: boolean }>('/api/forms/info', { method: 'PATCH', body: { title: title.trim(), description: description.trim(), expectedRevision: revision } })
      onSaved(next, next.verified ? 'บันทึกหัวเรื่องและคำอธิบายไป Google Forms แล้ว' : 'Google Forms รับการแก้ไขแล้ว แต่ค่าที่อ่านกลับไม่ตรงกับที่ส่งทุกตัวอักษร ตรวจในหน้านี้อีกครั้ง')
    } catch (failure) {
      // server อ่านฉบับล่าสุดจาก Google มาแล้ว: ให้หน้าด้านหลังโหลดมาแสดงและใช้เทียบ โดยค่าที่กรอกในกล่องนี้ยังอยู่
      if (hasCode(failure, 'revision_conflict')) onConflict()
      setConflict(hasCode(failure, 'revision_conflict'))
      setError(saveFailure(failure, 'ในฟอร์ม'))
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="แก้หัวเรื่องและคำอธิบายฟอร์ม"
      description="บันทึกแล้วจะเปลี่ยนใน Google Forms ทันที"
      onRequestClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button type="submit" form="form-info-form" className="button button-primary" disabled={saving || conflict}>
            {saving ? 'กำลังบันทึก…' : 'บันทึกไป Google Forms'}
          </button>
        </>
      }
    >
      <form id="form-info-form" className="form" onSubmit={submit} noValidate>
        {error && (
          <div className="form-alert" role="alert">
            <p>{error}</p>
            {conflict && (
              <>
                <p className="break-word">ฉบับล่าสุดใน Google Forms: “{latest.title}”</p>
                <div className="button-row">
                  <button
                    type="button"
                    className="button button-small"
                    onClick={() => {
                      setBase({ title: latest.title, description: latest.description, revisionId: latest.revisionId })
                      setTitle(latest.title)
                      setDescription(latest.description)
                      setConflict(false)
                      setError('')
                    }}
                  >
                    โหลดค่าล่าสุด (แทนที่ค่าที่กรอกไว้)
                  </button>
                  <button type="button" className="button button-small" onClick={() => (setConflict(false), void submit(undefined, latest.revisionId))}>
                    บันทึกค่าที่ฉันกรอกทับฉบับล่าสุด
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        <Field label="หัวเรื่องฟอร์ม" htmlFor="form-title" error={titleError}>
          <input id="form-title" type="text" value={title} maxLength={300} data-autofocus onChange={(e) => (setTitle(e.target.value), setTitleError(''))} {...fieldAria('form-title', titleError)} />
        </Field>
        <Field label="คำอธิบาย" htmlFor="form-description" optional>
          <textarea id="form-description" rows={4} value={description} maxLength={4000} onChange={(e) => setDescription(e.target.value)} />
        </Field>
      </form>
    </Dialog>
  )
}

interface QuestionValues {
  kind: string
  title: string
  description: string
  required: boolean
  options: string[]
}

const valuesOf = (item: FormItem | null): QuestionValues =>
  item
    ? { kind: item.kind, title: item.title, description: item.description, required: item.required, options: item.options.filter((o) => !o.isOther).map((o) => o.value) }
    : { kind: 'short_text', title: '', description: '', required: false, options: ['ตัวเลือก 1'] }

function QuestionDialog({
  item, latest, revisionId, onConflict, onClose, onSaved,
}: { item: FormItem | null; latest: FormItem | null; revisionId: string; onConflict(): void; onClose(): void; onSaved(next: FormView, message: string): void }) {
  const [baseRevision, setBaseRevision] = useState(revisionId)
  const [values, setValues] = useState<QuestionValues>(() => valuesOf(item))
  const [errors, setErrors] = useState<{ title?: string; options?: string }>({})
  const [error, setError] = useState('')
  const [conflict, setConflict] = useState(false)
  const [saving, setSaving] = useState(false)
  const hasOther = item?.options.some((o) => o.isOther) ?? false
  const choice = isChoice(values.kind)
  const latestRevision = useRef(revisionId)
  latestRevision.current = revisionId

  const setOption = (index: number, value: string) => {
    setValues((v) => ({ ...v, options: v.options.map((o, i) => (i === index ? value : o)) }))
    setErrors((e) => ({ ...e, options: undefined }))
  }

  const submit = async (event?: FormEvent, revision = baseRevision) => {
    event?.preventDefault()
    const found: typeof errors = {}
    const options = values.options.map((o) => o.trim())
    if (!values.title.trim()) found.title = 'กรอกคำถาม'
    if (choice) {
      if (options.length === 0) found.options = 'ต้องมีตัวเลือกอย่างน้อยหนึ่งข้อ'
      else if (options.some((o) => !o)) found.options = 'ตัวเลือกต้องไม่ว่าง'
      else if (new Set(options).size !== options.length) found.options = 'ตัวเลือกต้องไม่ซ้ำกัน'
    }
    setErrors(found)
    if (found.title || found.options) return
    setSaving(true)
    setError('')
    const body = { title: values.title.trim(), description: values.description.trim(), required: values.required, ...(choice ? { options } : {}), expectedRevision: revision }
    try {
      const next = item
        ? await api<FormView & { verified: boolean }>(`/api/forms/items/${encodeURIComponent(item.itemId)}`, { method: 'PATCH', body })
        : await api<FormView & { verified: boolean }>('/api/forms/items', { method: 'POST', body: { ...body, kind: values.kind } })
      onSaved(next, next.verified ? (item ? 'บันทึกคำถามไป Google Forms แล้ว' : 'เพิ่มคำถามใน Google Forms แล้ว') : 'Google Forms รับการแก้ไขแล้ว แต่ค่าที่อ่านกลับไม่ตรงกับที่ส่งทุกส่วน ตรวจในหน้านี้อีกครั้ง')
    } catch (failure) {
      // server อ่านฉบับล่าสุดจาก Google มาแล้ว: ให้หน้าด้านหลังโหลดมาแสดงและใช้เทียบ โดยค่าที่กรอกในกล่องนี้ยังอยู่
      if (hasCode(failure, 'revision_conflict')) onConflict()
      setConflict(hasCode(failure, 'revision_conflict'))
      setError(saveFailure(failure, 'ในฟอร์ม'))
      setSaving(false)
    }
  }

  return (
    <Dialog
      title={item ? 'แก้ไขคำถาม' : 'เพิ่มคำถาม'}
      description={item ? `${KIND_LABELS[item.kind]} · บันทึกแล้วจะเปลี่ยนใน Google Forms ทันที` : 'คำถามใหม่จะถูกเพิ่มต่อท้ายฟอร์มใน Google Forms'}
      onRequestClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button type="submit" form="question-form" className="button button-primary" disabled={saving || conflict}>
            {saving ? 'กำลังบันทึก…' : item ? 'บันทึกไป Google Forms' : 'เพิ่มคำถาม'}
          </button>
        </>
      }
    >
      <form id="question-form" className="form" onSubmit={submit} noValidate>
        {error && (
          <div className="form-alert" role="alert">
            <p>{error}</p>
            {conflict && (
              <>
                {item && <p className="break-word">{latest && latest.removedAt === null ? `คำถามนี้ในฉบับล่าสุด: “${latest.title}”` : 'คำถามนี้ไม่อยู่ในฟอร์มฉบับล่าสุดแล้ว'}</p>}
                <div className="button-row">
                  {item && latest && latest.removedAt === null && (
                    <button
                      type="button"
                      className="button button-small"
                      onClick={() => {
                        setValues(valuesOf(latest))
                        setBaseRevision(latestRevision.current)
                        setConflict(false)
                        setError('')
                      }}
                    >
                      โหลดค่าล่าสุด (แทนที่ค่าที่กรอกไว้)
                    </button>
                  )}
                  <button type="button" className="button button-small" onClick={() => (setConflict(false), void submit(undefined, latestRevision.current))}>
                    {item ? 'บันทึกค่าที่ฉันกรอกทับฉบับล่าสุด' : 'เพิ่มคำถามในฉบับล่าสุด'}
                  </button>
                </div>
              </>
            )}
          </div>
        )}
        {!item && (
          <Field label="ชนิดคำถาม" htmlFor="question-kind">
            <select id="question-kind" value={values.kind} onChange={(e) => setValues((v) => ({ ...v, kind: e.target.value }))}>
              {ADDABLE.map((kind) => (
                <option key={kind} value={kind}>
                  {KIND_LABELS[kind]}
                </option>
              ))}
            </select>
          </Field>
        )}
        <Field label="คำถาม" htmlFor="question-title" error={errors.title}>
          <input
            id="question-title"
            type="text"
            value={values.title}
            maxLength={500}
            data-autofocus
            onChange={(e) => (setValues((v) => ({ ...v, title: e.target.value })), setErrors((x) => ({ ...x, title: undefined })))}
            {...fieldAria('question-title', errors.title)}
          />
        </Field>
        <Field label="คำอธิบายใต้คำถาม" htmlFor="question-description" optional>
          <textarea id="question-description" rows={2} value={values.description} maxLength={2000} onChange={(e) => setValues((v) => ({ ...v, description: e.target.value }))} />
        </Field>
        <label className="checkbox">
          <input type="checkbox" checked={values.required} onChange={(e) => setValues((v) => ({ ...v, required: e.target.checked }))} />
          บังคับตอบ
        </label>
        {choice && (
          <fieldset className="option-editor">
            <legend>ตัวเลือก</legend>
            {values.options.map((option, index) => (
              <div key={index} className="option-row">
                <label htmlFor={`question-option-${index}`} className="visually-hidden">
                  ตัวเลือกที่ {index + 1}
                </label>
                <input id={`question-option-${index}`} type="text" value={option} maxLength={500} onChange={(e) => setOption(index, e.target.value)} aria-invalid={errors.options ? true : undefined} />
                <button
                  type="button"
                  className="icon-button"
                  aria-label={`ลบตัวเลือกที่ ${index + 1}`}
                  disabled={values.options.length <= 1}
                  onClick={() => setValues((v) => ({ ...v, options: v.options.filter((_, i) => i !== index) }))}
                >
                  <X aria-hidden="true" size={18} />
                </button>
              </div>
            ))}
            {hasOther && <p className="field-hint">ตัวเลือก “อื่น ๆ (ผู้ตอบพิมพ์เอง)” ของฟอร์มนี้ยังอยู่ตามเดิม</p>}
            {errors.options && (
              <p className="field-error" role="alert">
                {errors.options}
              </p>
            )}
            <button type="button" className="button button-small" onClick={() => setValues((v) => ({ ...v, options: [...v.options, ''] }))} disabled={values.options.length >= 100}>
              <Plus aria-hidden="true" size={16} />
              เพิ่มตัวเลือก
            </button>
          </fieldset>
        )}
      </form>
    </Dialog>
  )
}

function MappingDialog({ form, items, onClose, onSaved }: { form: FormInfo; items: FormItem[]; onClose(): void; onSaved(next: FormView): void }) {
  const [mapping, setMapping] = useState(form.mapping)
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  // เลือกได้เฉพาะคำถามที่มีคำตอบเป็นข้อความหนึ่งค่า หรือเลือกจากตัวเลือก
  const candidates = items.filter((i) => i.questions.length === 1 && ['short_text', 'paragraph', 'radio', 'dropdown', 'checkbox'].includes(i.kind))

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    setSaving(true)
    setError('')
    try {
      onSaved(await api<FormView>('/api/forms/mapping', { method: 'PUT', body: { mapping } }))
    } catch (failure) {
      setError(messageOf(failure, 'บันทึกไม่สำเร็จ ลองอีกครั้ง'))
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="จับคู่คำถามกับทะเบียนสมาชิก"
      description="ใช้เสนอค่าตอนตรวจคำตอบก่อนเพิ่มเป็นสมาชิก ไม่เปลี่ยนฟอร์มหรือคำตอบใน Google"
      onRequestClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button type="submit" form="mapping-form" className="button button-primary" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : 'บันทึกการจับคู่'}
          </button>
        </>
      }
    >
      <form id="mapping-form" className="form" onSubmit={submit}>
        {error && (
          <p className="form-alert" role="alert">
            {error}
          </p>
        )}
        {(Object.keys(MAPPING_LABELS) as MappingField[]).map((field, index) => (
          <Field key={field} label={`${MAPPING_LABELS[field]}ของสมาชิกมาจากคำถาม`} htmlFor={`mapping-${field}`} optional={field !== 'name'}>
            <select id={`mapping-${field}`} value={mapping[field] ?? ''} data-autofocus={index === 0 ? true : undefined} onChange={(e) => setMapping((m) => ({ ...m, [field]: e.target.value || undefined }))}>
              <option value="">ไม่ใช้</option>
              {candidates.map((item) => (
                <option key={item.itemId} value={item.questions[0].id}>
                  {item.title || '(ไม่มีข้อความ)'}
                </option>
              ))}
            </select>
          </Field>
        ))}
        <p className="field-hint">บทบาทของสมาชิกที่เพิ่มจากคำตอบเป็น “สมาชิก” เสมอ และไม่เกี่ยวกับสิทธิ์เข้าหลังบ้าน</p>
      </form>
    </Dialog>
  )
}

function ResponseDialog({ response, items, onClose }: { response: FormResponse; items: FormItem[]; onClose(): void }) {
  // จับคู่คำตอบกับคำถามด้วย question ID คำถามที่ถูกลบยังแสดงชื่อเดิมได้จากสำเนาที่เก็บไว้
  const byQuestion = new Map<string, { item: FormItem; label: string }>()
  for (const item of items) for (const q of item.questions) byQuestion.set(q.id, { item, label: q.label })
  const ordered = items.flatMap((item) => item.questions.map((q) => q.id)).filter((id) => response.answers[id])
  const unknown = Object.keys(response.answers).filter((id) => !byQuestion.has(id))

  return (
    <Dialog
      title="คำตอบต้นฉบับ"
      description={`ส่งเมื่อ ${formatTimestamp(response.lastSubmittedTime)}${response.respondentEmail ? ` · ${response.respondentEmail}` : ''}`}
      onRequestClose={onClose}
      footer={
        <button type="button" className="button button-primary" onClick={onClose} data-autofocus>
          ปิด
        </button>
      }
    >
      <p className="field-hint">อ่านอย่างเดียว ตรงกับที่ผู้ตอบส่งใน Google Forms</p>
      <dl className="answer-list">
        {[...ordered, ...unknown].map((id) => {
          const known = byQuestion.get(id)
          const answer = response.answers[id]
          return (
            <div key={id}>
              <dt className="break-word">
                {known ? `${known.item.title || '(ไม่มีข้อความ)'}${known.label ? ` — ${known.label}` : ''}` : 'คำถามที่ไม่อยู่ในฟอร์มแล้ว'}
                {known?.item.removedAt && <span className="badge badge-neutral">คำถามถูกลบแล้ว</span>}
              </dt>
              <dd className="pre-line break-word">
                {[...answer.values, ...answer.files.map((f) => `ไฟล์แนบ: ${f}`)].join('\n') || <span className="muted">ไม่ได้ตอบ</span>}
              </dd>
            </div>
          )
        })}
        {ordered.length + unknown.length === 0 && <p className="muted">คำตอบนี้ไม่มีข้อมูล</p>}
      </dl>
    </Dialog>
  )
}

function ImportDialog({ response, onClose, onSaved }: { response: FormResponse; onClose(): void; onSaved(next: FormView, name: string): void }) {
  const [values, setValues] = useState(response.candidate)
  const [errors, setErrors] = useState<Partial<Record<'name' | 'nickname', string>>>({})
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const set = (key: MappingField, value: string) => {
    setValues((v) => ({ ...v, [key]: value }))
    setErrors((e) => ({ ...e, [key]: undefined }))
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const found: typeof errors = {}
    if (!values.name.trim()) found.name = 'กรอกชื่อสมาชิก'
    else if (values.name.trim().length > 100) found.name = 'ชื่อยาวได้ไม่เกิน 100 ตัวอักษร'
    if (!values.nickname.trim()) found.nickname = 'กรอกชื่อเล่น'
    else if (values.nickname.trim().length > 40) found.nickname = 'ชื่อเล่นยาวได้ไม่เกิน 40 ตัวอักษร'
    setErrors(found)
    if (found.name || found.nickname) return
    setSaving(true)
    setError('')
    try {
      const body = { name: values.name.trim(), nickname: values.nickname.trim(), contact: values.contact.trim(), note: values.note.trim() }
      onSaved(await api<FormView>(`/api/forms/responses/${encodeURIComponent(response.responseId)}/import`, { method: 'POST', body }), body.name)
    } catch (failure) {
      setError(
        failure instanceof AppError && failure.code === 'save_outcome_unknown'
          ? failure.message
          : `เพิ่มสมาชิกไม่สำเร็จ: ${messageOf(failure, 'ระบบขัดข้อง')} ค่าที่กรอกยังอยู่ครบ`,
      )
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="ตรวจก่อนเพิ่มเป็นสมาชิก"
      description="ค่าด้านล่างมาจากคำตอบตามการจับคู่คำถาม แก้ได้ก่อนเพิ่ม คำตอบต้นฉบับไม่ถูกเปลี่ยน"
      onRequestClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button type="submit" form="import-form" className="button button-primary" disabled={saving}>
            {saving ? 'กำลังเพิ่ม…' : 'เพิ่มเป็นสมาชิก'}
          </button>
        </>
      }
    >
      <form id="import-form" className="form" onSubmit={submit} noValidate>
        {error && (
          <p className="form-alert" role="alert">
            {error}
          </p>
        )}
        {response.duplicates.length > 0 && (
          <div className="notice notice-warning" role="status">
            <TriangleAlert aria-hidden="true" size={18} />
            <div>
              <p>
                <strong>อาจซ้ำกับสมาชิกที่มีอยู่</strong> (ชื่อหรือช่องทางติดต่อตรงกัน) ตรวจก่อนเพิ่ม:
              </p>
              <ul className="bulleted">
                {response.duplicates.map((m) => (
                  <li key={m.id}>
                    {m.name} ({m.nickname})
                  </li>
                ))}
              </ul>
            </div>
          </div>
        )}
        <div className="form-row">
          <Field label="ชื่อ" htmlFor="import-name" error={errors.name}>
            <input id="import-name" type="text" value={values.name} data-autofocus onChange={(e) => set('name', e.target.value)} {...fieldAria('import-name', errors.name)} />
          </Field>
          <Field label="ชื่อเล่น" htmlFor="import-nickname" error={errors.nickname}>
            <input id="import-nickname" type="text" value={values.nickname} onChange={(e) => set('nickname', e.target.value)} {...fieldAria('import-nickname', errors.nickname)} />
          </Field>
        </div>
        <Field label="ช่องทางติดต่อ" htmlFor="import-contact" optional>
          <input id="import-contact" type="text" value={values.contact} maxLength={200} onChange={(e) => set('contact', e.target.value)} />
        </Field>
        <Field label="หมายเหตุ" htmlFor="import-note" optional>
          <textarea id="import-note" rows={3} value={values.note} maxLength={2000} onChange={(e) => set('note', e.target.value)} />
        </Field>
        <p className="field-hint">สมาชิกใหม่มีบทบาท “สมาชิก” และสถานะ “ใช้งาน” แก้ภายหลังได้ที่หน้าสมาชิก การเพิ่มนี้ไม่ให้สิทธิ์เข้าหลังบ้าน</p>
      </form>
    </Dialog>
  )
}
