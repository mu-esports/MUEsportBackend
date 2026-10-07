import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useBlocker, useNavigate, useParams } from 'react-router-dom'
import { ArrowLeft, CircleCheck, ExternalLink, Info, LoaderCircle, Lock, RefreshCw, Save, TriangleAlert } from 'lucide-react'
import { createKeyTracker } from '../api/client'
import { ConfirmDialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { Field, PageHeader } from '../components/ui'
import { documentsApi, MAX_CONTENT_UNITS, MAX_TITLE_LENGTH, normalizeText } from '../data/documents'
import type { DocumentContent, DocumentInfo } from '../data/documents'
import { AppError, messageOf } from '../data/errors'
import { AUTO_SYNC_MS } from '../data/sync'
import { formatTimestamp } from '../lib/datetime'

interface Base {
  title: string
  text: string
  revisionId: string
}
type Latest = DocumentContent & { title: string }
type Load = { kind: 'loading' } | { kind: 'ready' } | { kind: 'error'; message: string; code: string }

export function DocumentEditorPage() {
  const { id } = useParams()
  // เปลี่ยนเอกสาร (รวมถึงจากหน้าสร้างไปหน้าแก้) เริ่ม editor ใหม่ทั้งชุด ไม่ให้ค้างข้อความของเอกสารก่อนหน้า
  return <Editor key={id ?? 'new'} id={id} />
}

function Editor({ id }: { id?: string }) {
  const isNew = !id
  const toast = useToast()
  const navigate = useNavigate()

  const [load, setLoad] = useState<Load>(isNew ? { kind: 'ready' } : { kind: 'loading' })
  const [info, setInfo] = useState<DocumentInfo | null>(null)
  // ฉบับที่ Google ยืนยันล่าสุด ใช้เทียบว่ามีการแก้ที่ยังไม่บันทึกหรือไม่ และเป็น revision ที่อ้างตอนบันทึก
  const [base, setBase] = useState<Base | null>(null)
  const [editable, setEditable] = useState(true)
  const [reasons, setReasons] = useState<string[]>([])
  const [title, setTitle] = useState('')
  const [text, setText] = useState('')
  const [titleError, setTitleError] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [warning, setWarning] = useState('')
  const [conflict, setConflict] = useState<Latest | null>(null)
  const [savedAt, setSavedAt] = useState<string | null>(null)
  const [confirmLatest, setConfirmLatest] = useState(false)
  // ผลการบันทึกไม่แน่ชัด: ต้องตรวจฉบับล่าสุดก่อนบันทึกซ้ำ
  const [needsCheck, setNeedsCheck] = useState(false)
  const [checking, setChecking] = useState(false)
  const createKey = useRef(createKeyTracker()).current
  const titleRef = useRef<HTMLInputElement>(null)
  const seq = useRef(0)

  const normalized = normalizeText(text)
  const length = normalized.length
  const tooLong = length > MAX_CONTENT_UNITS
  // เอกสารที่สร้างแล้วแก้ได้เฉพาะเนื้อหา ชื่อเปลี่ยนใน Google Docs
  const dirty = isNew ? title.trim() !== '' || text !== '' : base !== null && normalized !== base.text

  // การนำทางและการปิดหน้าอ่านค่าล่าสุดผ่าน ref
  const dirtyRef = useRef(dirty)
  dirtyRef.current = dirty
  const baseRef = useRef(base)
  baseRef.current = base
  const savingRef = useRef(saving)
  savingRef.current = saving

  // ฉบับใหม่ใน Google ที่ตรวจพบระหว่างเปิดหน้านี้ ขณะมีร่างที่ยังไม่บันทึก (ไม่โหลดทับร่าง)
  const [remoteRevision, setRemoteRevision] = useState<string | null>(null)
  // revision ที่ผู้ใช้เลือกเก็บร่างไว้ก่อน: ไม่เตือนซ้ำจนกว่า Google จะมีฉบับใหม่กว่านั้น
  const keptRevision = useRef<string | null>(null)
  const [checkedAt, setCheckedAt] = useState<string | null>(null)
  const [autoLoadedAt, setAutoLoadedAt] = useState<string | null>(null)
  const [comparing, setComparing] = useState(false)
  const allowLeave = useRef(false)

  const applyLoaded = useCallback((document: DocumentInfo, content: DocumentContent) => {
    setInfo(document)
    setBase({ title: document.title, text: content.text, revisionId: content.revisionId })
    setTitle(document.title)
    setText(content.text)
    setEditable(content.editable)
    setReasons(content.reasons)
  }, [])

  const fetchDocument = useCallback(() => {
    if (!id) return
    const current = ++seq.current
    setLoad({ kind: 'loading' })
    documentsApi.read(id).then(
      ({ document, content }) => {
        if (current !== seq.current) return
        applyLoaded(document, content)
        setConflict(null)
        setSaveError('')
        setWarning('')
        setNeedsCheck(false)
        setLoad({ kind: 'ready' })
      },
      (failure: unknown) => {
        if (current !== seq.current) return
        setLoad({
          kind: 'error',
          message: messageOf(failure, 'เปิดเอกสารไม่สำเร็จ ลองอีกครั้ง'),
          code: failure instanceof AppError ? failure.code : 'unknown',
        })
      },
    )
  }, [id, applyLoaded])

  useEffect(fetchDocument, [fetchDocument])

  // ตรวจเป็นระยะว่า Google Docs มีฉบับใหม่หรือไม่ (ตรวจเฉพาะ revision ไม่ดึงเนื้อหา)
  // ไม่มีร่างค้าง → โหลดฉบับใหม่ให้เอง; มีร่างค้าง → แจ้งและให้ผู้ใช้เลือก ไม่ทับสิ่งที่พิมพ์
  const ready = load.kind === 'ready'
  useEffect(() => {
    if (!id || !ready) return
    let stopped = false
    const check = async () => {
      if (document.visibilityState !== 'visible' || savingRef.current || !baseRef.current) return
      try {
        const latest = await documentsApi.revision(id)
        if (stopped || savingRef.current) return
        setCheckedAt(new Date().toISOString())
        if (latest.revisionId === baseRef.current?.revisionId) {
          setRemoteRevision(null)
          return
        }
        if (dirtyRef.current) {
          if (keptRevision.current !== latest.revisionId) setRemoteRevision(latest.revisionId)
          return
        }
        const fresh = await documentsApi.read(id)
        // ระหว่างรอ ผู้ใช้อาจเริ่มพิมพ์แล้ว: ไม่ทับ
        if (stopped || dirtyRef.current || savingRef.current) return
        applyLoaded(fresh.document, fresh.content)
        setRemoteRevision(null)
        setAutoLoadedAt(new Date().toISOString())
      } catch {
        // ตรวจไม่ได้รอบนี้ (เช่น เครือข่ายหลุด): ไม่รบกวนงานที่พิมพ์อยู่ การบันทึกยังให้ Google ตรวจ revision เสมอ
      }
    }
    const timer = setInterval(check, AUTO_SYNC_MS)
    document.addEventListener('visibilitychange', check)
    return () => {
      stopped = true
      clearInterval(timer)
      document.removeEventListener('visibilitychange', check)
    }
  }, [id, ready, applyLoaded])

  /** ดึงฉบับล่าสุดมาเทียบกับร่าง (ร่างยังอยู่ในช่องเนื้อหา) */
  const compareLatest = async (thenConfirmLoad = false) => {
    if (!id) return
    setComparing(true)
    try {
      const { document: doc, content } = await documentsApi.read(id)
      setInfo(doc)
      setRemoteRevision(null)
      if (content.text === normalizeText(text)) {
        // ฉบับใน Google ตรงกับที่พิมพ์อยู่แล้ว
        setBase({ title: doc.title, text: content.text, revisionId: content.revisionId })
        setTitle(doc.title)
      } else {
        setConflict({ ...content, title: doc.title })
        if (thenConfirmLoad) setConfirmLatest(true)
      }
    } catch (failure) {
      setSaveError(`${messageOf(failure, 'โหลดฉบับล่าสุดไม่สำเร็จ')} สิ่งที่พิมพ์ไว้ยังอยู่ครบในหน้านี้`)
    } finally {
      setComparing(false)
    }
  }

  // เตือนก่อนปิดหรือโหลดหน้าใหม่เมื่อมีการแก้ที่ยังไม่บันทึก
  useEffect(() => {
    const onBeforeUnload = (event: BeforeUnloadEvent) => {
      if (dirtyRef.current && !allowLeave.current) event.preventDefault()
    }
    // ออกจากระบบหรือสลับบัญชี: ทิ้งงานค้างโดยไม่ถามซ้ำ และไม่ส่งต่อไปยังบัญชีอื่น
    const onDiscard = () => {
      allowLeave.current = true
    }
    window.addEventListener('beforeunload', onBeforeUnload)
    window.addEventListener('mu:discard-drafts', onDiscard)
    return () => {
      window.removeEventListener('beforeunload', onBeforeUnload)
      window.removeEventListener('mu:discard-drafts', onDiscard)
    }
  }, [])

  // เตือนก่อนไปหน้าอื่นในเว็บ (เมนู ลิงก์ หรือปุ่มย้อนกลับของเบราว์เซอร์)
  const blocker = useBlocker(useCallback(() => dirtyRef.current && !allowLeave.current, []))

  const save = async (event?: FormEvent, revisionOverride?: string) => {
    event?.preventDefault()
    if (saving || !editable) return
    const cleanTitle = title.trim()
    if (isNew && !cleanTitle) {
      setTitleError('กรอกชื่อเอกสาร')
      titleRef.current?.focus()
      return
    }
    if (isNew && cleanTitle.length > MAX_TITLE_LENGTH) {
      setTitleError(`ชื่อเอกสารยาวได้ไม่เกิน ${MAX_TITLE_LENGTH} ตัวอักษร`)
      titleRef.current?.focus()
      return
    }
    if (tooLong) return

    setSaving(true)
    setSaveError('')
    setWarning('')
    try {
      if (isNew) {
        const input = { title: cleanTitle, text: normalized }
        // ลองใหม่ด้วยข้อมูลเดิมใช้ key เดิม server จึงทำต่อจากขั้นที่ค้างและไม่สร้างไฟล์ซ้ำ
        const { document } = await documentsApi.create(input, createKey(input))
        allowLeave.current = true
        toast.success(`สร้างเอกสาร “${document.title}” ใน Google Docs แล้ว`)
        navigate(`/documents/${document.id}`, { replace: true })
        return
      }
      const result = await documentsApi.save(id!, { text: normalized, baseRevisionId: revisionOverride ?? base!.revisionId })
      setInfo(result.document)
      setEditable(result.content.editable)
      setReasons(result.content.reasons)
      setConflict(null)
      if (result.verified) {
        // ยืนยันจากการอ่านกลับของ Google แล้วจึงถือว่าบันทึก
        setBase({ title: result.document.title, text: result.content.text, revisionId: result.content.revisionId })
        setText(result.content.text)
        setSavedAt(new Date().toISOString())
        // ชื่อตามที่ Google มีอยู่จริง (อาจถูกเปลี่ยนจาก Google Docs)
        setTitle(result.document.title)
      } else {
        // Google รับคำสั่งแล้วแต่เนื้อหาที่อ่านกลับไม่ตรงกับที่ส่ง: ไม่บอกว่าบันทึกแล้ว และเก็บสิ่งที่พิมพ์ไว้
        setBase({ title: result.document.title, text: result.content.text, revisionId: result.content.revisionId })
        setWarning(
          'Google Docs รับการบันทึกแล้ว แต่เนื้อหาที่อ่านกลับมาไม่ตรงกับที่พิมพ์ทุกตัวอักษร สิ่งที่พิมพ์ยังอยู่ในช่องนี้ ตรวจเอกสารใน Google Docs แล้วกดบันทึกอีกครั้งถ้าต้องการ',
        )
      }
    } catch (failure) {
      if (failure instanceof AppError && failure.code === 'revision_conflict') {
        setConflict(failure.data.latest as Latest)
      } else if (failure instanceof AppError && failure.code === 'document_not_editable') {
        setEditable(false)
        setReasons((failure.data.reasons as string[] | undefined) ?? [])
        setSaveError(failure.message)
      } else if (failure instanceof AppError && (failure.code === 'save_outcome_unknown' || failure.code === 'saved_unverified')) {
        // Google อาจบันทึกไปแล้ว: ไม่บอกว่าไม่สำเร็จ ไม่บอกว่าสำเร็จ และให้ตรวจฉบับล่าสุดก่อน
        setNeedsCheck(true)
        setSaveError(`${failure.message} สิ่งที่พิมพ์ไว้ยังอยู่ครบในหน้านี้`)
      } else if (failure instanceof AppError && failure.code === 'operation_dismissed') {
        // งานเดิมถูกนำออกจากรายการแล้ว: การกดสร้างครั้งถัดไปเป็นงานใหม่โดยตั้งใจ
        createKey.reset()
        setSaveError(failure.message)
      } else if (failure instanceof AppError && failure.code.startsWith('operation_')) {
        // ข้อความจาก server บอกสถานะของงานสร้างตามจริงอยู่แล้ว (กำลังทำ / ไม่ทราบผล / ต้องตรวจเอง)
        setSaveError(`${failure.message} สิ่งที่พิมพ์ไว้ยังอยู่ครบในหน้านี้`)
      } else {
        setSaveError(
          `${messageOf(failure, 'บันทึกไม่สำเร็จ')} สิ่งที่พิมพ์ไว้ยังอยู่ครบในหน้านี้ กด “${isNew ? 'สร้างเอกสาร' : 'บันทึก'}” เพื่อลองอีกครั้ง`,
        )
      }
    } finally {
      setSaving(false)
    }
  }

  /** อ่านฉบับล่าสุดจาก Google หลังผลการบันทึกไม่แน่ชัด: ถ้าตรงกับที่พิมพ์ถือว่าบันทึกแล้ว ถ้าไม่ตรงให้เทียบและเลือกเอง */
  const checkLatest = async () => {
    if (!id) return
    setChecking(true)
    try {
      const { document, content } = await documentsApi.read(id)
      setInfo(document)
      setNeedsCheck(false)
      setSaveError('')
      if (content.text === normalizeText(text)) {
        setBase({ title: document.title, text: content.text, revisionId: content.revisionId })
        setTitle(document.title)
        setEditable(content.editable)
        setReasons(content.reasons)
        setSavedAt(new Date().toISOString())
      } else {
        setConflict({ ...content, title: document.title })
      }
    } catch (failure) {
      setSaveError(`${messageOf(failure, 'ตรวจฉบับล่าสุดไม่สำเร็จ')} สิ่งที่พิมพ์ไว้ยังอยู่ครบในหน้านี้ กด “ตรวจฉบับล่าสุด” เพื่อลองอีกครั้ง`)
    } finally {
      setChecking(false)
    }
  }

  const applyLatest = () => {
    if (!conflict) return
    setBase({ title: conflict.title, text: conflict.text, revisionId: conflict.revisionId })
    setTitle(conflict.title)
    setText(conflict.text)
    setEditable(conflict.editable)
    setReasons(conflict.reasons)
    setConflict(null)
    setConfirmLatest(false)
  }

  const overwriteLatest = () => {
    if (!conflict) return
    const latest = conflict
    // อ้าง revision ล่าสุดที่เพิ่งตรวจ ถ้ามีคนแก้อีกระหว่างนี้ Google จะปฏิเสธและกลับมาที่ขั้นตอนนี้อีกครั้ง
    setBase((current) => (current ? { ...current, revisionId: latest.revisionId, text: latest.text, title: latest.title } : current))
    setTitle(latest.title)
    setConflict(null)
    void save(undefined, latest.revisionId)
  }

  const header = (
    <PageHeader
      title={isNew ? 'สร้างเอกสาร' : (info?.title ?? 'เอกสาร')}
      description={isNew ? 'เอกสารข้อความพื้นฐาน จะถูกสร้างเป็น Google Docs ในบัญชีของชมรม' : 'เนื้อหาโหลดจาก Google Docs ของชมรม'}
      action={
        <Link to="/documents" className="button">
          <ArrowLeft aria-hidden="true" size={18} />
          รายการเอกสาร
        </Link>
      }
    />
  )

  if (load.kind === 'loading') {
    return (
      <>
        {header}
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดเนื้อหาล่าสุดจาก Google Docs…</p>
        </div>
      </>
    )
  }

  if (load.kind === 'error') {
    const needsAdmin = load.code === 'google_not_connected' || load.code === 'google_needs_reconnect'
    return (
      <>
        {header}
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">{load.code === 'not_found' ? 'ไม่พบเอกสารนี้' : 'เปิดเอกสารไม่สำเร็จ'}</p>
          <p className="empty-state-text">{load.message}</p>
          <div className="button-row button-row-center">
            {load.code !== 'not_found' && (
              <button type="button" className="button button-primary" onClick={fetchDocument}>
                ลองโหลดอีกครั้ง
              </button>
            )}
            {needsAdmin && (
              <Link to="/sources" className="button">
                ดูสถานะการเชื่อม Google
              </Link>
            )}
            <Link to="/documents" className="button">
              กลับไปรายการเอกสาร
            </Link>
          </div>
        </div>
      </>
    )
  }

  const status = saving
    ? { icon: LoaderCircle, text: isNew ? 'กำลังสร้างใน Google Docs…' : 'กำลังบันทึกไป Google Docs…', tone: 'muted', spin: true }
    : !editable
      ? { icon: Lock, text: 'อ่านอย่างเดียว', tone: 'muted', spin: false }
      : dirty
        ? { icon: Info, text: isNew ? 'ยังไม่ได้สร้าง' : 'มีการแก้ไขที่ยังไม่ได้บันทึก', tone: 'warning', spin: false }
        : savedAt
          ? { icon: CircleCheck, text: `บันทึกแล้วเมื่อ ${formatTimestamp(savedAt)} (Google ยืนยัน)`, tone: 'success', spin: false }
          : autoLoadedAt
            ? { icon: CircleCheck, text: `โหลดฉบับใหม่จาก Google Docs ให้แล้วเมื่อ ${formatTimestamp(autoLoadedAt)}`, tone: 'success', spin: false }
            : { icon: CircleCheck, text: isNew ? 'ยังไม่ได้กรอก' : `ตรงกับฉบับใน Google Docs ที่โหลดมา${checkedAt ? ` (ตรวจล่าสุด ${formatTimestamp(checkedAt)})` : ''}`, tone: 'muted', spin: false }
  const StatusIcon = status.icon

  return (
    <>
      {header}

      {!editable && (
        <div className="notice notice-block notice-warning" role="status">
          <Lock aria-hidden="true" size={18} />
          <div>
            <p>
              <strong>เอกสารนี้แก้ในเว็บไม่ได้ เปิดอ่านได้อย่างเดียว</strong>
            </p>
            <p>editor ในเว็บรองรับเฉพาะข้อความพื้นฐาน การบันทึกจากเว็บจะทำให้โครงสร้างต่อไปนี้เสียหาย จึงปิดการแก้ไว้:</p>
            <ul className="bulleted">
              {reasons.map((reason) => (
                <li key={reason}>{reason}</li>
              ))}
            </ul>
            {info && (
              <a className="button button-small" href={info.googleUrl} target="_blank" rel="noopener noreferrer">
                เปิดแก้ใน Google Docs
                <ExternalLink aria-hidden="true" size={14} />
              </a>
            )}
          </div>
        </div>
      )}

      {remoteRevision && dirty && !conflict && (
        <section className="card conflict-card remote-card" role="alert" aria-labelledby="remote-title">
          <h2 id="remote-title">
            <Info aria-hidden="true" size={20} />
            มีฉบับใหม่ใน Google Docs
          </h2>
          <p>เอกสารนี้ถูกแก้จากที่อื่นระหว่างที่คุณพิมพ์ ระบบยังไม่ได้โหลดฉบับใหม่มาทับ สิ่งที่คุณพิมพ์อยู่ครบในช่องเนื้อหา</p>
          <div className="button-row">
            <button type="button" className="button button-primary" onClick={() => compareLatest()} disabled={comparing}>
              {comparing ? 'กำลังโหลด…' : 'เปรียบเทียบกับฉบับล่าสุด'}
            </button>
            <button
              type="button"
              className="button"
              onClick={() => {
                keptRevision.current = remoteRevision
                setRemoteRevision(null)
              }}
            >
              เก็บร่างของฉันไว้ก่อน
            </button>
            <button type="button" className="button" onClick={() => compareLatest(true)} disabled={comparing}>
              โหลดฉบับล่าสุด
            </button>
          </div>
          <p className="field-hint">ถ้าเก็บร่างไว้ก่อน ตอนกดบันทึก Google จะปฏิเสธการเขียนทับ และระบบจะให้เทียบกับฉบับล่าสุดอีกครั้ง</p>
        </section>
      )}

      {conflict && (
        <section className="card conflict-card" role="alert" aria-labelledby="conflict-title">
          <h2 id="conflict-title">
            <TriangleAlert aria-hidden="true" size={20} />
            เอกสารถูกแก้ไขจากที่อื่นหลังจากที่คุณเปิด
          </h2>
          <p>ฉบับใน Google Docs ไม่ตรงกับที่คุณพิมพ์ สิ่งที่คุณพิมพ์ยังอยู่ในช่องเนื้อหาด้านล่างครบ ตรวจฉบับล่าสุดจาก Google Docs ก่อนเลือก</p>
          <Field label={`ฉบับล่าสุดใน Google Docs${conflict.title !== title.trim() ? ` (ชื่อ: ${conflict.title})` : ''}`} htmlFor="document-latest">
            <textarea id="document-latest" className="editor-text editor-text-latest" readOnly rows={8} value={conflict.text} />
          </Field>
          <div className="button-row">
            <button type="button" className="button" onClick={() => setConfirmLatest(true)}>
              ใช้ฉบับล่าสุด (ทิ้งที่ฉันแก้)
            </button>
            {conflict.editable && (
              <button type="button" className="button button-danger-outline" onClick={overwriteLatest} disabled={saving}>
                บันทึกฉบับของฉันทับฉบับล่าสุด
              </button>
            )}
          </div>
          <p className="field-hint">หรือคัดลอกส่วนที่ต้องการจากฉบับล่าสุดมาใส่ในเนื้อหาของคุณก่อน แล้วค่อยเลือกบันทึกทับ</p>
        </section>
      )}

      <form className="card editor-card" onSubmit={save} noValidate>
        <Field
          label="ชื่อเอกสาร"
          htmlFor="document-title"
          error={titleError}
          hint={isNew ? undefined : 'ชื่อเปลี่ยนจากเว็บนี้ไม่ได้หลังสร้าง เปลี่ยนได้ใน Google Docs แล้วชื่อที่นี่จะตามเมื่อโหลดเอกสารใหม่'}
        >
          <input
            id="document-title"
            ref={titleRef}
            type="text"
            value={title}
            readOnly={!isNew}
            autoComplete="off"
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleError('')
            }}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? 'document-title-error' : isNew ? undefined : 'document-title-hint'}
          />
        </Field>

        <div className="field">
          <label htmlFor="document-text">เนื้อหา</label>
          <textarea
            id="document-text"
            className="editor-text"
            rows={16}
            value={text}
            readOnly={!editable}
            onChange={(e) => setText(e.target.value)}
            aria-invalid={tooLong ? true : undefined}
            aria-describedby="document-text-hint document-text-count"
          />
          <div className="editor-meta">
            <p className="field-hint" id="document-text-hint">
              ข้อความล้วน กด Enter เพื่อขึ้นย่อหน้าใหม่ ยังไม่รองรับตัวหนา หัวข้อ รูป หรือตาราง
            </p>
            <p className={tooLong ? 'field-error' : 'field-hint'} id="document-text-count" role={tooLong ? 'alert' : undefined}>
              {length.toLocaleString('en-US')} / {MAX_CONTENT_UNITS.toLocaleString('en-US')} ตัวอักษร
              {tooLong && ` — ยาวเกิน ${(length - MAX_CONTENT_UNITS).toLocaleString('en-US')} ตัวอักษร ตัดให้สั้นลงก่อนบันทึก`}
            </p>
          </div>
        </div>

        {saveError && (
          <div className="form-alert" role="alert">
            <p>{saveError}</p>
            {needsCheck && (
              <button type="button" className="button button-small" onClick={checkLatest} disabled={checking}>
                {checking ? 'กำลังตรวจ…' : 'ตรวจฉบับล่าสุดจาก Google Docs'}
              </button>
            )}
          </div>
        )}
        {warning && (
          <p className="notice notice-warning" role="alert">
            <TriangleAlert aria-hidden="true" size={18} />
            {warning}
          </p>
        )}

        <div className="editor-actions">
          <p className={`editor-status editor-status-${status.tone}`} role="status">
            <StatusIcon aria-hidden="true" size={16} className={status.spin ? 'spin' : undefined} />
            {status.text}
          </p>
          <div className="button-row">
            {!isNew && !dirty && (
              <button type="button" className="button" onClick={fetchDocument} disabled={saving}>
                <RefreshCw aria-hidden="true" size={16} />
                โหลดฉบับล่าสุด
              </button>
            )}
            <Link to="/documents" className="button">
              {dirty ? 'ยกเลิก' : 'กลับ'}
            </Link>
            {editable && (
              <button type="submit" className="button button-primary" disabled={saving || tooLong || (!isNew && !dirty) || conflict !== null || needsCheck}>
                <Save aria-hidden="true" size={16} />
                {saving ? (isNew ? 'กำลังสร้าง…' : 'กำลังบันทึก…') : isNew ? 'สร้างเอกสาร' : 'บันทึก'}
              </button>
            )}
          </div>
        </div>
        {!isNew && info && (
          <div className="editor-external">
            <a className="button button-small" href={info.googleUrl} target="_blank" rel="noopener noreferrer">
              เปิดใน Google Docs
              <ExternalLink aria-hidden="true" size={14} />
            </a>
            <p className="field-hint">
              ใช้สิทธิ์ของบัญชี Google ที่คุณล็อกอินในเบราว์เซอร์ ถ้าบัญชีนั้นไม่มีสิทธิ์ในไฟล์ Google จะให้ขอสิทธิ์จากบัญชีชมรม
            </p>
          </div>
        )}
      </form>

      {blocker.state === 'blocked' && (
        <ConfirmDialog
          title="ออกจากหน้านี้โดยไม่บันทึก?"
          confirmLabel="ออกโดยไม่บันทึก"
          cancelLabel="กลับไปแก้ไขต่อ"
          tone="danger"
          onConfirm={() => blocker.proceed()}
          onCancel={() => blocker.reset()}
        >
          <p>{isNew ? 'เอกสารนี้ยังไม่ได้สร้าง สิ่งที่พิมพ์ไว้จะหายไป' : 'การแก้ไขที่ยังไม่ได้บันทึกไป Google Docs จะหายไป'}</p>
        </ConfirmDialog>
      )}

      {confirmLatest && (
        <ConfirmDialog
          title="ใช้ฉบับล่าสุดและทิ้งสิ่งที่คุณแก้?"
          confirmLabel="ทิ้งที่ฉันแก้"
          cancelLabel="กลับไปตรวจต่อ"
          tone="danger"
          onConfirm={applyLatest}
          onCancel={() => setConfirmLatest(false)}
        >
          <p>ช่องชื่อและเนื้อหาจะถูกแทนด้วยฉบับล่าสุดจาก Google Docs สิ่งที่คุณพิมพ์ไว้และยังไม่ได้บันทึกจะหายไป</p>
        </ConfirmDialog>
      )}
    </>
  )
}
