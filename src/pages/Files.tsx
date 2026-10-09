import { useCallback, useEffect, useState } from 'react'
import { Link, useNavigate, useParams, useLocation, useSearchParams, Navigate } from 'react-router-dom'
import { ExternalLink, Eye, FilePlus2, FolderOpen, Info, LoaderCircle, TriangleAlert } from 'lucide-react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthProvider'
import { ConfirmDialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import { APP_NAME } from '../config'
import { documentsApi } from '../data/documents'
import type { DocumentInfo, PendingOperation } from '../data/documents'
import { AppError, messageOf } from '../data/errors'
import { FileList } from '../library/FileList'
import { FilePreview } from '../library/FilePreview'
import { formatTimestamp } from '../lib/datetime'

/** ผลของขั้นตอนขออนุญาตที่ Google ส่งกลับมาหน้านี้ */
const CONSENT_RESULT: Record<string, { tone: 'success' | 'error'; text: string }> = {
  connected: { tone: 'success', text: 'บัญชีชมรมอนุญาตแล้ว ระบบกำลังตรวจสิทธิ์อ่านไฟล์จากคำตอบของ Google' },
  cancelled: { tone: 'error', text: 'ยกเลิกการอนุญาตที่ Google แล้ว ยังไม่ได้เปิดใช้คลังไฟล์' },
  failed: { tone: 'error', text: 'ขออนุญาตกับ Google ไม่สำเร็จ ยังไม่ได้เปิดใช้คลังไฟล์ ลองอีกครั้ง' },
  forbidden: { tone: 'error', text: 'ขั้นตอนนี้ต้องทำโดยผู้ดูแลคนเดิมที่เริ่มไว้ ยังไม่ได้เปิดใช้คลังไฟล์' },
  wrong_account: { tone: 'error', text: 'บัญชี Google ที่อนุญาตไม่ใช่บัญชีของชมรม ยังไม่ได้เปิดใช้คลังไฟล์ เลือกบัญชีชมรมแล้วลองอีกครั้ง' },
  missing_scope: { tone: 'error', text: 'Google ไม่ได้ให้สิทธิ์ที่ขอครบ ยังไม่ได้เปิดใช้คลังไฟล์ ลองอีกครั้งและติ๊กอนุญาตทุกข้อ' },
  no_refresh_token: { tone: 'error', text: 'Google ไม่ได้ออกสิทธิ์ใช้งานต่อเนื่องให้ ยังไม่ได้เปิดใช้คลังไฟล์ ลองอีกครั้ง' },
}

/** คลังยังไม่พร้อม (ฝั่งทีมงาน): บอกสาเหตุจริง และให้ผู้ดูแลขอสิทธิ์อ่านไฟล์ของชมรมได้จากตรงนี้ */
function LibraryUnavailable({ message, reason }: { message: string; reason: string }) {
  const { isAdmin } = useAuth()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [documents, setDocuments] = useState<DocumentInfo[] | null>(null)

  // เอกสารที่ลงทะเบียนไว้ในเว็บยังเปิดตัวอย่างได้ด้วยสิทธิ์เดิม แม้ยังไม่ได้เปิดใช้คลังทั้งบัญชี
  useEffect(() => {
    documentsApi.list().then(setDocuments, () => setDocuments([]))
  }, [])

  const enable = async () => {
    if (busy) return
    setBusy(true)
    setError('')
    try {
      const { authUrl } = await api<{ authUrl: string }>('/api/google/connect', { method: 'POST', body: { service: 'library', returnTo: '/files' } })
      window.location.assign(authUrl)
    } catch (failure) {
      setError(messageOf(failure, 'เริ่มขั้นตอนขออนุญาตไม่สำเร็จ ลองอีกครั้ง'))
      setBusy(false)
    }
  }

  const canEnable = isAdmin && reason === 'missing_scope'
  return (
    <>
      <div className="state-block library-setup" role="status">
        <FolderOpen aria-hidden="true" size={28} />
        <p className="empty-state-title">{reason === 'missing_scope' ? 'ยังไม่ได้เปิดใช้คลังไฟล์ Google' : 'คลังไฟล์ยังไม่พร้อมใช้งาน'}</p>
        <p className="empty-state-text">{message}</p>
        {canEnable && (
          <>
            <button type="button" className="button button-primary" onClick={enable} aria-disabled={busy}>
              {busy && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
              {busy ? 'กำลังไปหน้าขออนุญาตของ Google…' : 'เปิดใช้คลังไฟล์ Google'}
            </button>
            <p className="field-hint">
              ระบบจะพาไปหน้าขออนุญาตของ Google ให้เลือกบัญชีชมรม แล้วอนุญาตให้เว็บนี้ “ดูและดาวน์โหลดไฟล์ทั้งหมดใน Google Drive” ของบัญชีชมรม (อ่านอย่างเดียว)
              สิทธิ์เดิมของเอกสาร ชีต ปฏิทิน และฟอร์มไม่เปลี่ยน
            </p>
          </>
        )}
        {!isAdmin && reason === 'missing_scope' && <p className="field-hint">ให้ผู้ดูแลระบบเปิดหน้านี้แล้วกด “เปิดใช้คลังไฟล์ Google”</p>}
        {reason !== 'missing_scope' && (
          <Link to="/sources" className="button">
            ดูสถานะการเชื่อม Google
          </Link>
        )}
        {error && (
          <p className="form-alert" role="alert">
            {error}
          </p>
        )}
      </div>

      {documents && documents.length > 0 && (
        <section aria-labelledby="registered-title" className="registered-docs">
          <h2 id="registered-title">เอกสารที่สร้างจากเว็บนี้</h2>
          <p className="muted">เอกสารเหล่านี้ยังเปิดดูตัวอย่างได้ด้วยสิทธิ์เดิม แม้ยังไม่ได้เปิดใช้คลังไฟล์ทั้งบัญชี</p>
          <ul className="document-list">
            {documents.map((d) => (
              <li key={d.id} className="document-row">
                <div className="document-main">
                  <Link to={`/files/${encodeURIComponent(d.googleId)}`} className="document-title">
                    {d.title}
                  </Link>
                  <p className="document-meta">แก้ในเว็บล่าสุด {formatTimestamp(d.updatedAt)}</p>
                </div>
                <div className="document-actions">
                  <Link to={`/files/${encodeURIComponent(d.googleId)}`} className="button button-small" aria-label={`ดูตัวอย่าง ${d.title}`}>
                    <Eye aria-hidden="true" size={14} />
                    ดูตัวอย่าง
                  </Link>
                </div>
              </li>
            ))}
          </ul>
        </section>
      )}
    </>
  )
}

/** งานสร้างเอกสารที่ทำไม่ครบทุกขั้น: ทำต่อ ยืนยันสร้างใหม่ หรือนำออกจากรายการ (เนื้อหาที่ค้างไม่ถูกลบเองโดยไม่ถาม) */
function PendingOperations() {
  const toast = useToast()
  const navigate = useNavigate()
  const [operations, setOperations] = useState<PendingOperation[]>([])
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<{ id: string; text: string } | null>(null)
  const [dismissTarget, setDismissTarget] = useState<PendingOperation | null>(null)
  const [confirmTarget, setConfirmTarget] = useState<PendingOperation | null>(null)

  const load = useCallback(() => {
    documentsApi.operations().then(setOperations, () => undefined)
  }, [])
  useEffect(load, [load])
  useEffect(() => {
    const onVisible = () => document.visibilityState === 'visible' && load()
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  const resume = async (op: PendingOperation, confirmCreate = false) => {
    setBusy(op.id)
    setError(null)
    setConfirmTarget(null)
    try {
      const { document } = await documentsApi.resume(op.id, confirmCreate)
      toast.success(`สร้างเอกสาร “${document.title}” ครบแล้ว`)
      navigate(`/files/${encodeURIComponent(document.googleId)}`)
    } catch (failure) {
      setError({ id: op.id, text: messageOf(failure, 'ทำต่อไม่สำเร็จ ลองอีกครั้ง') })
      load()
    } finally {
      setBusy(null)
    }
  }

  const dismiss = async (op: PendingOperation) => {
    setBusy(op.id)
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
      setError({ id: op.id, text: messageOf(failure, 'ยกเลิกไม่สำเร็จ ลองอีกครั้ง') })
    } finally {
      setBusy(null)
    }
  }

  if (operations.length === 0) return null
  const fileIdOf = (url: string | null) => (url ? (/\/document\/d\/([^/]+)/.exec(url)?.[1] ?? null) : null)

  return (
    <>
      <section className="card pending-card" aria-labelledby="pending-title">
        <h2 id="pending-title">งานสร้างเอกสารที่ยังไม่เสร็จ</h2>
        <p className="muted">งานเหล่านี้เริ่มสร้างแล้วแต่ทำไม่ครบทุกขั้น ระบบเก็บไว้จนกว่าจะทำต่อหรือสั่งนำออกเอง</p>
        <ul className="pending-list">
          {operations.map((op) => {
            const fileId = fileIdOf(op.googleUrl)
            return (
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
                  {error?.id === op.id && (
                    <p className="form-alert" role="alert">
                      {error.text}
                    </p>
                  )}
                </div>
                <div className="pending-actions">
                  {op.status !== 'failed' && (
                    <button type="button" className="button button-small button-primary" disabled={busy !== null || op.inProgress} onClick={() => resume(op)}>
                      {busy === op.id ? 'กำลังทำต่อ…' : op.fileState === 'unknown' ? 'ค้นหาไฟล์เดิมและทำต่อ' : 'ทำต่อให้เสร็จ'}
                    </button>
                  )}
                  {op.status !== 'failed' && op.fileState === 'unknown' && op.canConfirmCreate && !op.inProgress && (
                    <button type="button" className="button button-small" disabled={busy !== null} onClick={() => setConfirmTarget(op)}>
                      ยืนยันสร้างไฟล์ใหม่
                    </button>
                  )}
                  {fileId && (
                    <Link to={`/files/${encodeURIComponent(fileId)}`} className="button button-small">
                      <Eye aria-hidden="true" size={14} />
                      ดูตัวอย่าง
                    </Link>
                  )}
                  {op.googleUrl && (
                    <a className="button button-small" href={op.googleUrl} target="_blank" rel="noopener noreferrer">
                      เปิดไฟล์ใน Google Docs
                      <ExternalLink aria-hidden="true" size={14} />
                    </a>
                  )}
                  <button type="button" className="button button-small" disabled={busy !== null || op.inProgress} onClick={() => setDismissTarget(op)}>
                    นำออกจากรายการ
                  </button>
                </div>
              </li>
            )
          })}
        </ul>
      </section>

      {dismissTarget && (
        <ConfirmDialog
          title={`นำ “${dismissTarget.title}” ออกจากงานค้าง?`}
          confirmLabel="นำออกจากรายการ"
          tone="danger"
          busy={busy === dismissTarget.id}
          onConfirm={() => dismiss(dismissTarget)}
          onCancel={() => setDismissTarget(null)}
        >
          {dismissTarget.fileState === 'created' ? (
            <p>ไฟล์ที่สร้างไว้ใน Google Docs จะไม่ถูกลบและยังอยู่ใน Google Drive ของชมรม เนื้อหาที่ระบบเก็บไว้และยังไม่ได้เขียนลงไฟล์จะถูกทิ้ง</p>
          ) : dismissTarget.fileState === 'unknown' ? (
            <p>
              ไม่ทราบว่า Google Docs สร้างไฟล์ของงานนี้แล้วหรือยัง ถ้าสร้างแล้ว ไฟล์นั้นจะยังอยู่ใน Google Drive ของชมรม เนื้อหาที่ระบบเก็บไว้สำหรับงานนี้จะถูกทิ้ง
            </p>
          ) : (
            <p>ยังไม่ได้ส่งคำสั่งสร้างไฟล์ไป Google Docs เนื้อหาที่ระบบเก็บไว้สำหรับงานนี้จะถูกทิ้ง</p>
          )}
        </ConfirmDialog>
      )}

      {confirmTarget && (
        <ConfirmDialog
          title={`สร้างไฟล์ใหม่สำหรับ “${confirmTarget.title}”?`}
          confirmLabel="ตรวจแล้ว สร้างไฟล์ใหม่"
          tone="danger"
          busy={busy === confirmTarget.id}
          onConfirm={() => resume(confirmTarget, true)}
          onCancel={() => setConfirmTarget(null)}
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

/** ไฟล์ชมรม (ทีมงาน): คลังไฟล์ทั้งหมดของบัญชี Google ชมรม เปิดดูตัวอย่างในเว็บ และแก้เนื้อหาจริงใน Google */
export function FilesPage() {
  const [params, setParams] = useSearchParams()
  const consent = params.get('google')
  const [result] = useState(() => (consent ? (CONSENT_RESULT[consent] ?? null) : null))

  // ล้างผลของขั้นตอนขออนุญาตออกจาก URL (ข้อความยังแสดงอยู่ในหน้านี้)
  useEffect(() => {
    if (!consent) return
    const next = new URLSearchParams(params)
    next.delete('google')
    setParams(next, { replace: true })
  }, [consent, params, setParams])

  return (
    <>
      <PageHeader
        title="ไฟล์ชมรม"
        description="ไฟล์ทั้งหมดที่บัญชี Google ของชมรมเข้าถึงได้ เปิดดูตัวอย่างในเว็บ ส่วนการแก้เนื้อหาทำใน Google"
        action={
          <Link to="/documents/new" className="button button-primary">
            <FilePlus2 aria-hidden="true" size={18} />
            สร้างเอกสาร
          </Link>
        }
      />

      {result && (
        <p className={result.tone === 'success' ? 'notice notice-success' : 'form-alert'} role={result.tone === 'success' ? 'status' : 'alert'}>
          {result.tone === 'error' && <TriangleAlert aria-hidden="true" size={18} />}
          {result.text}
        </p>
      )}

      <p className="notice library-visibility">
        <Info aria-hidden="true" size={18} />
        <span>
          สมาชิกที่เข้าสู่ระบบด้วยรหัสนักศึกษาเปิดดูไฟล์ทุกไฟล์ในหน้านี้ได้ (อ่านอย่างเดียว) รวมถึงชีตทะเบียนสมาชิกและชีตคำตอบของฟอร์ม ถ้ามีไฟล์ที่ไม่ควรให้สมาชิกเห็น
          อย่าเก็บหรือแชร์ไฟล์นั้นไว้กับบัญชี Google ของชมรม
        </span>
      </p>

      <PendingOperations />

      <section className="card" aria-label="รายการไฟล์ของชมรม">
        <FileList
          basePath="/files"
          unavailable={(info) => <LibraryUnavailable {...info} />}
          categoryNote={(type) =>
            // หมวดนี้เป็นรายการไฟล์ในคลัง ไม่ใช่เครื่องมือฟอร์มที่ซิงค์คำตอบ: บอกให้ชัดและพาไปหน้าที่ถูก
            type === 'form' ? (
              <p className="notice file-category-note">
                <Info aria-hidden="true" size={18} />
                <span>
                  หมวดนี้คือไฟล์ Google Forms ทุกไฟล์ในคลัง เปิดดูคำถามได้อย่างเดียว ส่วนคำตอบของผู้กรอกและการเพิ่มสมาชิกจากฟอร์มที่เชื่อมไว้อยู่ที่หน้า{' '}
                  <Link to="/forms">ฟอร์ม</Link>
                </span>
              </p>
            ) : null
          }
        />
      </section>
    </>
  )
}

/** ตัวอย่างไฟล์ (ทีมงาน): มีปุ่มแก้ไขใน Google และทางไปแก้ข้อความในเว็บสำหรับเอกสารที่ลงทะเบียนไว้ */
export function FileViewPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const search = (location.state as { search?: string } | null)?.search ?? ''
  return (
    <FilePreview
      key={id}
      fileId={id}
      audience="staff"
      siteName={APP_NAME}
      backTo={`/files${search}`}
      extra={(detail) =>
        detail.registered ? (
          <Link to={`/documents/${encodeURIComponent(detail.registered.documentId)}/edit`} className="button">
            แก้ข้อความในเว็บ
          </Link>
        ) : null
      }
    />
  )
}

/** ลิงก์เอกสารเดิม (/documents/<รหัสในเว็บ>): พาไปยังตัวอย่างของไฟล์เดียวกันในหน้าไฟล์ชมรม */
export function DocumentRedirectPage() {
  const { id = '' } = useParams()
  const [state, setState] = useState<{ kind: 'loading' } | { kind: 'found'; googleId: string } | { kind: 'error'; message: string; missing: boolean }>({ kind: 'loading' })
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setState({ kind: 'loading' })
    documentsApi.file(id).then(
      ({ document }) => !cancelled && setState({ kind: 'found', googleId: document.googleId }),
      (failure: unknown) =>
        !cancelled && setState({ kind: 'error', message: messageOf(failure, 'เปิดเอกสารไม่สำเร็จ ลองอีกครั้ง'), missing: failure instanceof AppError && failure.code === 'not_found' }),
    )
    return () => {
      cancelled = true
    }
  }, [id, attempt])

  if (state.kind === 'found') return <Navigate to={`/files/${encodeURIComponent(state.googleId)}`} replace />
  if (state.kind === 'loading') {
    return (
      <div className="state-block" role="status">
        <LoaderCircle aria-hidden="true" size={24} className="spin" />
        <p>กำลังเปิดเอกสาร…</p>
      </div>
    )
  }
  return (
    <div className="state-block state-error" role="alert">
      <TriangleAlert aria-hidden="true" size={28} />
      <h1 className="empty-state-title" tabIndex={-1}>
        {state.missing ? 'ไม่พบเอกสารนี้' : 'เปิดเอกสารไม่สำเร็จ'}
      </h1>
      <p className="empty-state-text">{state.message}</p>
      <div className="button-row button-row-center">
        {!state.missing && (
          <button type="button" className="button button-primary" onClick={() => setAttempt((n) => n + 1)}>
            ลองอีกครั้ง
          </button>
        )}
        <Link to="/files" className="button">
          ไปหน้าไฟล์ชมรม
        </Link>
      </div>
    </div>
  )
}
