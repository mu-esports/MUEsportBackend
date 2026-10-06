import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router-dom'
import { ExternalLink, FilePlus2, FileText, LoaderCircle, SearchX, Search, TriangleAlert } from 'lucide-react'
import { ConfirmDialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { EmptyState, PageHeader } from '../components/ui'
import { DOCUMENT_STATUS_LABELS, documentsApi } from '../data/documents'
import type { DocumentInfo, PendingOperation } from '../data/documents'
import { messageOf } from '../data/errors'
import { formatTimestamp } from '../lib/datetime'

type LoadState = 'loading' | 'ready' | 'error'

export function DocumentsPage() {
  const toast = useToast()
  const navigate = useNavigate()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [documents, setDocuments] = useState<DocumentInfo[]>([])
  const [operations, setOperations] = useState<PendingOperation[]>([])
  const [query, setQuery] = useState('')
  const [busyOperation, setBusyOperation] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<{ id: string; text: string } | null>(null)
  const [dismissTarget, setDismissTarget] = useState<PendingOperation | null>(null)
  const [confirmCreateTarget, setConfirmCreateTarget] = useState<PendingOperation | null>(null)
  const seq = useRef(0)

  const load = useCallback((silent = false) => {
    const current = ++seq.current
    if (!silent) setState('loading')
    Promise.all([documentsApi.list(), documentsApi.operations()]).then(
      ([docs, ops]) => {
        if (current !== seq.current) return
        setDocuments(docs)
        setOperations(ops)
        setState('ready')
      },
      (failure: unknown) => {
        if (current !== seq.current || silent) return
        setError(messageOf(failure, 'โหลดรายการเอกสารไม่สำเร็จ'))
        setState('error')
      },
    )
  }, [])

  useEffect(() => load(), [load])

  // กลับมาที่แท็บนี้: ดึงรายการล่าสุดที่คนอื่นอาจสร้างหรือแก้ไว้
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && load(true)
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return q ? documents.filter((d) => d.title.toLowerCase().includes(q)) : documents
  }, [documents, query])

  const resume = async (op: PendingOperation, confirmCreate = false) => {
    setBusyOperation(op.id)
    setOperationError(null)
    setConfirmCreateTarget(null)
    try {
      const { document } = await documentsApi.resume(op.id, confirmCreate)
      toast.success(`สร้างเอกสาร “${document.title}” ครบแล้ว`)
      navigate(`/documents/${document.id}`)
    } catch (failure) {
      setOperationError({ id: op.id, text: messageOf(failure, 'ทำต่อไม่สำเร็จ ลองอีกครั้ง') })
      load(true)
    } finally {
      setBusyOperation(null)
    }
  }

  const dismiss = async (op: PendingOperation) => {
    setBusyOperation(op.id)
    try {
      const result = await documentsApi.dismiss(op.id)
      setDismissTarget(null)
      setOperations((list) => list.filter((o) => o.id !== op.id))
      toast.success(
        result.fileState === 'created'
          ? 'นำงานค้างออกจากรายการแล้ว ไฟล์ที่สร้างไว้ยังอยู่ใน Google Drive ของชมรม'
          : result.fileState === 'unknown'
            ? 'นำงานค้างออกจากรายการแล้ว ถ้า Google สร้างไฟล์ไว้ ไฟล์นั้นยังอยู่ใน Google Drive ของชมรม'
            : 'นำงานค้างออกจากรายการแล้ว',
      )
    } catch (failure) {
      setDismissTarget(null)
      setOperationError({ id: op.id, text: messageOf(failure, 'ยกเลิกไม่สำเร็จ ลองอีกครั้ง') })
    } finally {
      setBusyOperation(null)
    }
  }

  return (
    <>
      <PageHeader
        title="เอกสาร"
        description="เอกสารข้อความที่สร้างจากเว็บนี้ เนื้อหาเก็บเป็น Google Docs ในบัญชีของชมรม"
        action={
          <Link to="/documents/new" className="button button-primary">
            <FilePlus2 aria-hidden="true" size={18} />
            สร้างเอกสาร
          </Link>
        }
      />

      {state === 'loading' && (
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดรายการเอกสาร…</p>
        </div>
      )}

      {state === 'error' && (
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดรายการเอกสารไม่สำเร็จ</p>
          <p className="empty-state-text">{error}</p>
          <button type="button" className="button button-primary" onClick={() => load()}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      )}

      {state === 'ready' && (
        <>
          {operations.length > 0 && (
            <section className="card pending-card" aria-labelledby="pending-title">
              <h2 id="pending-title">งานสร้างเอกสารที่ยังไม่เสร็จ</h2>
              <p className="muted">งานเหล่านี้เริ่มสร้างแล้วแต่ทำไม่ครบทุกขั้น ยังไม่อยู่ในรายการเอกสาร</p>
              <ul className="pending-list">
                {operations.map((op) => (
                  <li key={op.id}>
                    <div className="pending-main">
                      <p className="pending-title">{op.title}</p>
                      <p className="pending-meta">
                        {op.inProgress
                          ? 'กำลังทำอยู่จากคำขอก่อนหน้า'
                          : op.status === 'failed'
                            ? 'ต้องเปิดตรวจไฟล์ใน Google เอง ระบบไม่ทำต่อเพื่อไม่ให้เขียนทับหรือสร้างซ้ำ'
                            : op.fileState === 'created'
                              ? 'สร้างไฟล์ใน Google Docs แล้ว แต่ยังเขียนเนื้อหาหรือลงทะเบียนไม่ครบ'
                              : op.fileState === 'unknown'
                                ? 'ไม่ทราบว่า Google Docs สร้างไฟล์แล้วหรือยัง ระบบจะค้นหาไฟล์เดิมก่อน และไม่สร้างใหม่เอง'
                                : 'ยังไม่ได้ส่งคำสั่งสร้างไฟล์ไป Google Docs'}
                        {' · '}
                        {formatTimestamp(op.createdAt)}
                        {op.userName && ` · ${op.userName}`}
                      </p>
                      {operationError?.id === op.id && (
                        <p className="form-alert" role="alert">
                          {operationError.text}
                        </p>
                      )}
                    </div>
                    <div className="pending-actions">
                      {op.status !== 'failed' && (
                        <button
                          type="button"
                          className="button button-small button-primary"
                          disabled={busyOperation !== null || op.inProgress}
                          onClick={() => resume(op)}
                        >
                          {busyOperation === op.id ? 'กำลังทำต่อ…' : op.fileState === 'unknown' ? 'ค้นหาไฟล์เดิมและทำต่อ' : 'ทำต่อให้เสร็จ'}
                        </button>
                      )}
                      {op.status !== 'failed' && op.fileState === 'unknown' && op.canConfirmCreate && !op.inProgress && (
                        <button type="button" className="button button-small" disabled={busyOperation !== null} onClick={() => setConfirmCreateTarget(op)}>
                          ยืนยันสร้างไฟล์ใหม่
                        </button>
                      )}
                      {op.googleUrl && (
                        <a className="button button-small" href={op.googleUrl} target="_blank" rel="noopener noreferrer">
                          เปิดไฟล์ใน Google Docs
                          <ExternalLink aria-hidden="true" size={14} />
                        </a>
                      )}
                      <button
                        type="button"
                        className="button button-small"
                        disabled={busyOperation !== null || op.inProgress}
                        onClick={() => setDismissTarget(op)}
                      >
                        นำออกจากรายการ
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          )}

          {documents.length === 0 ? (
            <section className="card">
              <EmptyState
                icon={FileText}
                title="ยังไม่มีเอกสาร"
                action={
                  <Link to="/documents/new" className="button button-primary">
                    สร้างเอกสารแรก
                  </Link>
                }
              >
                เอกสารที่สร้างจากเว็บนี้จะแสดงที่นี่ เอกสารอื่นใน Google Drive ของชมรมจะไม่ถูกดึงเข้ามา
              </EmptyState>
            </section>
          ) : (
            <section className="card" aria-label="รายการเอกสาร">
              <div className="toolbar" role="search">
                <div className="search-field">
                  <Search aria-hidden="true" size={18} />
                  <label htmlFor="document-search" className="visually-hidden">
                    ค้นหาชื่อเอกสาร
                  </label>
                  <input id="document-search" type="search" placeholder="ค้นหาชื่อเอกสาร" value={query} onChange={(e) => setQuery(e.target.value)} />
                </div>
              </div>
              <p className="result-count" role="status">
                {query.trim() ? `พบ ${filtered.length} จาก ${documents.length} ฉบับ` : `ทั้งหมด ${documents.length} ฉบับ เรียงจากที่แก้ล่าสุด`}
              </p>

              {filtered.length === 0 ? (
                <EmptyState
                  icon={SearchX}
                  title="ไม่พบเอกสารที่ชื่อตรงกับคำค้นหา"
                  action={
                    <button type="button" className="button" onClick={() => setQuery('')}>
                      ล้างคำค้นหา
                    </button>
                  }
                />
              ) : (
                <ul className="document-list">
                  {filtered.map((d) => (
                    <li key={d.id} className="document-row">
                      <div className="document-main">
                        <Link to={`/documents/${d.id}`} className="document-title">
                          {d.title}
                        </Link>
                        <p className="document-meta">
                          แก้ในเว็บล่าสุด {formatTimestamp(d.updatedAt)}
                          {d.updatedByName && ` · โดย ${d.updatedByName}`}
                        </p>
                      </div>
                      <span className={`badge badge-${d.status === 'ok' ? 'active' : d.status === 'read_only' ? 'neutral' : 'suspended'}`}>
                        {DOCUMENT_STATUS_LABELS[d.status]}
                      </span>
                      <div className="document-actions">
                        <Link to={`/documents/${d.id}`} className="button button-small" aria-label={`เปิด ${d.title} ในเว็บ`}>
                          เปิดในเว็บ
                        </Link>
                        <a
                          className="button button-small"
                          href={d.googleUrl}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`เปิด ${d.title} ใน Google Docs (แท็บใหม่)`}
                        >
                          Google Docs
                          <ExternalLink aria-hidden="true" size={14} />
                        </a>
                      </div>
                    </li>
                  ))}
                </ul>
              )}
              <p className="field-hint list-footnote">
                การเปิดใน Google Docs ใช้สิทธิ์ของบัญชี Google ที่คุณล็อกอินในเบราว์เซอร์ เว็บนี้ไม่ได้แชร์ไฟล์ให้อัตโนมัติ
              </p>
            </section>
          )}
        </>
      )}

      {dismissTarget && (
        <ConfirmDialog
          title={`นำ “${dismissTarget.title}” ออกจากงานค้าง?`}
          confirmLabel="นำออกจากรายการ"
          tone="danger"
          busy={busyOperation === dismissTarget.id}
          onConfirm={() => dismiss(dismissTarget)}
          onCancel={() => setDismissTarget(null)}
        >
          {dismissTarget.fileState === 'created' ? (
            <p>
              ไฟล์ที่สร้างไว้ใน Google Docs จะไม่ถูกลบและยังอยู่ใน Google Drive ของชมรม แต่จะไม่อยู่ในรายการเอกสารของเว็บนี้ และเนื้อหาที่ยังไม่ได้เขียนลงไฟล์จะถูกทิ้ง
            </p>
          ) : dismissTarget.fileState === 'unknown' ? (
            <p>
              ไม่ทราบว่า Google Docs สร้างไฟล์ของงานนี้แล้วหรือยัง ถ้าสร้างแล้ว ไฟล์นั้นจะยังอยู่ใน Google Drive ของชมรมโดยไม่อยู่ในรายการเอกสารของเว็บนี้
              เนื้อหาที่กรอกไว้สำหรับงานนี้จะถูกทิ้ง
            </p>
          ) : (
            <p>ยังไม่ได้ส่งคำสั่งสร้างไฟล์ไป Google Docs เนื้อหาที่กรอกไว้สำหรับงานนี้จะถูกทิ้ง</p>
          )}
        </ConfirmDialog>
      )}

      {confirmCreateTarget && (
        <ConfirmDialog
          title={`สร้างไฟล์ใหม่สำหรับ “${confirmCreateTarget.title}”?`}
          confirmLabel="ตรวจแล้ว สร้างไฟล์ใหม่"
          tone="danger"
          busy={busyOperation === confirmCreateTarget.id}
          onConfirm={() => resume(confirmCreateTarget, true)}
          onCancel={() => setConfirmCreateTarget(null)}
        >
          <ul>
            <li>ระบบเคยส่งคำสั่งสร้างไฟล์นี้ไป Google แล้วแต่ไม่ได้รับคำตอบ และค้นหาไม่พบไฟล์เดิม</li>
            <li>ก่อนยืนยัน ให้ตรวจ Google Drive ของบัญชีชมรมว่าไม่มีไฟล์ชื่อนี้ที่เพิ่งถูกสร้าง ถ้ามีอยู่แล้ว การสร้างใหม่จะทำให้มีไฟล์ซ้ำ</li>
            <li>ระบบจะค้นหาไฟล์เดิมอีกครั้งก่อนสร้าง ถ้าพบจะใช้ไฟล์เดิม</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  )
}
