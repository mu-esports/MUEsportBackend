import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import { createKeyTracker } from '../api/client'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Field } from '../components/ui'
import { AppError, messageOf } from '../data/errors'
import { today } from '../lib/datetime'
import { NEWS_STATUS, newsApi } from '../news/api'
import type { NewsInput, NewsStatus, StaffNews } from '../news/api'

const toInput = (p: StaffNews): NewsInput => ({ title: p.title, summary: p.summary, body: p.body, category: p.category, publishedDate: p.publishedDate, imageUrl: p.imageUrl, instagramUrl: p.instagramUrl, sourceUrl: p.sourceUrl, status: p.status })
const blank = (): NewsInput => ({ title: '', summary: '', body: '', category: 'ประกาศ', publishedDate: today(), imageUrl: '', instagramUrl: '', sourceUrl: '', status: 'draft' })

export function NewsForm({ post, onClose, onSaved }: { post?: StaffNews; onClose(): void; onSaved(saved: StaffNews): void }) {
  const [base, setBase] = useState(post)
  const [initial, setInitial] = useState(() => post ? toInput(post) : blank())
  const [value, setValue] = useState(initial)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [fieldError, setFieldError] = useState('')
  const [conflict, setConflict] = useState<StaffNews | null>(null)
  const [discard, setDiscard] = useState(false)
  const keyFor = useRef(createKeyTracker()).current
  const dirty = JSON.stringify(initial) !== JSON.stringify(value)
  const close = () => { if (!busy) { if (dirty) setDiscard(true); else onClose() } }
  const set = <K extends keyof NewsInput>(field: K, next: NewsInput[K]) => { setValue(v => ({ ...v, [field]: next })); setFieldError('') }
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || conflict) return
    setBusy(true); setError(''); setFieldError('')
    try {
      const saved = base ? await newsApi.update(base.id, value, base.version) : await newsApi.create(value, keyFor(value))
      onSaved(saved)
    } catch (failure) {
      if (failure instanceof AppError && failure.code === 'version_conflict') setConflict(failure.data.current as StaffNews)
      setError(messageOf(failure, 'ยังยืนยันผลบันทึกไม่ได้ ลองบันทึกอีกครั้งด้วยข้อมูลเดิมเพื่อไม่สร้างซ้ำ'))
      if (failure instanceof AppError && typeof failure.data.field === 'string') { setFieldError(failure.data.field); requestAnimationFrame(() => document.getElementById(`news-${failure.data.field}`)?.focus()) }
      setBusy(false)
    }
  }
  if (discard) return <ConfirmDialog title="ทิ้งการแก้ไขข่าว?" confirmLabel="ทิ้งการแก้ไข" onConfirm={onClose} onCancel={() => setDiscard(false)}><p>สิ่งที่แก้ยังไม่ได้บันทึก</p></ConfirmDialog>
  const simple = (field: 'title' | 'category' | 'publishedDate' | 'imageUrl' | 'instagramUrl' | 'sourceUrl', label: string, max: number, type = 'text', required = false) => <Field label={label} htmlFor={`news-${field}`} optional={!required} error={fieldError === field ? error : undefined}>
    <input id={`news-${field}`} type={type} value={value[field]} maxLength={max} required={required} disabled={busy} aria-invalid={fieldError === field || undefined} onChange={e => set(field, e.target.value)} {...(field === 'title' ? { 'data-autofocus': true } : {})} />
  </Field>
  return <Dialog title={base ? 'แก้ไขข่าวชมรม' : 'เพิ่มข่าวชมรม'} onRequestClose={close} footer={<>
    <button type="button" className="button" disabled={busy} onClick={close}>ยกเลิก</button>
    <button type="submit" form="news-form" className="button button-primary" disabled={busy || !!conflict}>{busy && <LoaderCircle className="spin" size={16} aria-hidden="true" />}{busy ? 'กำลังบันทึก…' : 'บันทึกข่าว'}</button>
  </>}>
    <form id="news-form" onSubmit={submit} className="news-form">
      {error && <div className="form-alert form-wide" role="alert">{error}</div>}
      {conflict && <div className="form-alert form-wide"><p>ข้อมูลถูกแก้จากที่อื่น ร่างนี้ยังอยู่ ตรวจฉบับล่าสุดก่อนบันทึกใหม่</p><button type="button" className="button" onClick={() => { const next = toInput(conflict); setBase(conflict); setInitial(next); setValue(next); setConflict(null); setError('') }}>ใช้ฉบับล่าสุด (ทิ้งที่ฉันแก้)</button></div>}
      <div className="form-wide">{simple('title', 'หัวข้อข่าว', 200, 'text', true)}</div>
      {simple('category', 'หมวดหมู่', 40, 'text', true)}
      {simple('publishedDate', 'วันที่ข่าว', 10, 'date', true)}
      <div className="form-wide"><Field label="คำโปรย" htmlFor="news-summary" optional><textarea id="news-summary" value={value.summary} maxLength={1000} rows={3} disabled={busy} onChange={e => set('summary', e.target.value)} /></Field></div>
      <div className="form-wide"><Field label="เนื้อหา" htmlFor="news-body" optional><textarea id="news-body" value={value.body} maxLength={12000} rows={7} disabled={busy} onChange={e => set('body', e.target.value)} /></Field></div>
      <div className="form-wide">{simple('imageUrl', 'ลิงก์ภาพโปสเตอร์', 2048, 'url')}</div>
      <div className="form-wide">{simple('instagramUrl', 'ลิงก์โพสต์ Instagram', 2048, 'url')}</div>
      <div className="form-wide">{simple('sourceUrl', 'ลิงก์ต้นทาง', 2048, 'url')}</div>
      <div className="form-wide"><Field label="การแสดงข่าว" htmlFor="news-status"><select id="news-status" value={value.status} disabled={busy} onChange={e => set('status', e.target.value as NewsStatus)}>{Object.entries(NEWS_STATUS).map(([key, label]) => <option key={key} value={key}>{label}</option>)}</select></Field><p className="field-hint">ข่าวร่างและข่าวในคลังจะไม่แสดงให้สมาชิก วันที่ข่าวในอนาคตจะแสดงเมื่อถึงวันนั้น</p></div>
    </form>
  </Dialog>
}
