import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Link, useBlocker } from 'react-router-dom'
import { ArrowLeft, CircleCheck, ExternalLink, Eye, FilePlus2, LoaderCircle } from 'lucide-react'
import { createKeyTracker } from '../api/client'
import { ConfirmDialog } from '../components/Dialog'
import { Field, PageHeader } from '../components/ui'
import { documentsApi, MAX_TITLE_LENGTH } from '../data/documents'
import type { DocumentInfo } from '../data/documents'
import { AppError, messageOf } from '../data/errors'

/**
 * สร้างเอกสาร Google Docs ใหม่จากเว็บ: กรอกเฉพาะชื่อ ระบบสร้างไฟล์ครั้งเดียวในบัญชีชมรม แล้วให้ไปเขียนเนื้อหาใน Google Docs
 * การกดซ้ำหรือลองใหม่ด้วยชื่อเดิมใช้คำขอเดิม จึงไม่เกิดไฟล์ซ้ำ (server ควบคุมด้วย operation เดียวกับงานที่ค้าง)
 */
export function DocumentCreatePage() {
  const [title, setTitle] = useState('')
  const [titleError, setTitleError] = useState('')
  const [error, setError] = useState('')
  const [saving, setSaving] = useState(false)
  const [created, setCreated] = useState<DocumentInfo | null>(null)
  const createKey = useRef(createKeyTracker()).current
  const input = useRef<HTMLInputElement>(null)
  const done = useRef<HTMLHeadingElement>(null)
  const dirty = useRef(false)
  dirty.current = created === null && title.trim() !== ''
  const allowLeave = useRef(false)
  const blocker = useBlocker(useCallback(() => dirty.current && !allowLeave.current, []))

  useEffect(() => {
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (dirty.current && !allowLeave.current) event.preventDefault()
    }
    const discard = () => { allowLeave.current = true }
    window.addEventListener('beforeunload', beforeUnload)
    window.addEventListener('mu:discard-drafts', discard)
    return () => {
      window.removeEventListener('beforeunload', beforeUnload)
      window.removeEventListener('mu:discard-drafts', discard)
    }
  }, [])

  useEffect(() => {
    if (created) done.current?.focus()
  }, [created])

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const clean = title.trim()
    const problem = !clean ? 'กรอกชื่อเอกสาร' : clean.length > MAX_TITLE_LENGTH ? `ชื่อเอกสารยาวได้ไม่เกิน ${MAX_TITLE_LENGTH} ตัวอักษร` : ''
    setTitleError(problem)
    setError('')
    if (problem) return input.current?.focus()
    setSaving(true)
    try {
      // เนื้อหาเขียนใน Google Docs: ส่งเอกสารว่างไปสร้าง ลองใหม่ด้วยชื่อเดิมใช้ key เดิมจึงทำต่อจากงานเดิม
      const payload = { title: clean, text: '' }
      const { document } = await documentsApi.create(payload, createKey(payload))
      setCreated(document)
    } catch (failure) {
      if (failure instanceof AppError && failure.code === 'operation_dismissed') {
        // งานเดิมถูกนำออกจากรายการแล้ว: การกดสร้างครั้งถัดไปเป็นงานใหม่โดยตั้งใจ
        createKey.reset()
        setError(failure.message)
      } else if (failure instanceof AppError && failure.code.startsWith('operation_')) {
        // ข้อความจาก server บอกสถานะของงานสร้างตามจริงอยู่แล้ว (กำลังทำ / ไม่ทราบผล / ต้องตรวจเอง)
        setError(`${failure.message} ชื่อที่กรอกยังอยู่ในช่องนี้ และงานนี้อยู่ในรายการ “งานสร้างเอกสารที่ยังไม่เสร็จ” ของหน้าไฟล์ชมรม`)
      } else {
        setError(`${messageOf(failure, 'สร้างเอกสารไม่สำเร็จ')} ชื่อที่กรอกยังอยู่ในช่องนี้ กด “สร้างเอกสาร” เพื่อลองอีกครั้ง (ระบบจะไม่สร้างไฟล์ซ้ำ)`)
      }
    } finally {
      setSaving(false)
    }
  }

  const back = (
    <Link to="/files" className="button">
      <ArrowLeft aria-hidden="true" size={18} />
      ไฟล์ชมรม
    </Link>
  )

  if (created) {
    return (
      <>
        <PageHeader title="สร้างเอกสาร" description="เอกสารถูกสร้างเป็น Google Docs ในบัญชีของชมรม" action={back} />
        <section className="card create-done" aria-labelledby="create-done-title">
          <h2 id="create-done-title" tabIndex={-1} ref={done}>
            <CircleCheck aria-hidden="true" size={20} />
            สร้างเอกสาร “{created.title}” แล้ว
          </h2>
          <p>เอกสารยังว่างอยู่ เปิด Google Docs เพื่อเขียนเนื้อหา การจัดรูปแบบและการแก้ไขทั้งหมดทำใน Google Docs</p>
          <div className="button-row">
            <a className="button button-primary" href={created.googleUrl} target="_blank" rel="noopener noreferrer">
              เปิด Google Docs เพื่อเขียนเนื้อหา
              <ExternalLink aria-hidden="true" size={16} />
              <span className="visually-hidden"> (เปิดแท็บใหม่)</span>
            </a>
            <Link to={`/files/${encodeURIComponent(created.googleId)}`} className="button">
              <Eye aria-hidden="true" size={16} />
              ดูตัวอย่างในเว็บ
            </Link>
          </div>
          <p className="field-hint">
            การเปิดใน Google Docs ใช้สิทธิ์ของบัญชี Google ที่คุณล็อกอินในเบราว์เซอร์ ถ้าบัญชีนั้นไม่มีสิทธิ์ในไฟล์ Google จะให้ขอสิทธิ์จากบัญชีชมรม
          </p>
        </section>
      </>
    )
  }

  return (
    <>
      <PageHeader title="สร้างเอกสาร" description="ตั้งชื่อเอกสาร ระบบจะสร้างเป็น Google Docs ในบัญชีของชมรม แล้วให้ไปเขียนเนื้อหาใน Google Docs" action={back} />
      <form className="card editor-card" onSubmit={submit} noValidate>
        <Field label="ชื่อเอกสาร" htmlFor="document-title" error={titleError} hint="เปลี่ยนชื่อภายหลังได้ใน Google Docs">
          <input
            id="document-title"
            ref={input}
            type="text"
            value={title}
            autoComplete="off"
            maxLength={MAX_TITLE_LENGTH + 20}
            onChange={(e) => {
              setTitle(e.target.value)
              setTitleError('')
            }}
            aria-invalid={titleError ? true : undefined}
            aria-describedby={titleError ? 'document-title-error' : 'document-title-hint'}
          />
        </Field>
        {error && (
          <p className="form-alert" role="alert">
            {error}
          </p>
        )}
        <div className="editor-actions">
          <p className="editor-status editor-status-muted" role="status">
            {saving && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
            {saving ? 'กำลังสร้างใน Google Docs…' : 'ยังไม่ได้สร้าง'}
          </p>
          <div className="button-row">
            <Link to="/files" className="button">
              ยกเลิก
            </Link>
            <button type="submit" className="button button-primary" disabled={saving}>
              <FilePlus2 aria-hidden="true" size={16} />
              {saving ? 'กำลังสร้าง…' : 'สร้างเอกสาร'}
            </button>
          </div>
        </div>
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
          <p>ชื่อเอกสารที่กรอกไว้ยังไม่ได้ใช้สร้างเอกสาร และจะหายเมื่อออกจากหน้านี้</p>
        </ConfirmDialog>
      )}
    </>
  )
}
