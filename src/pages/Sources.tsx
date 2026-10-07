import { useEffect, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  CalendarDays, CircleAlert, CircleCheck, ClipboardList, FileSpreadsheet, FileText, FolderOpen, Info, Link2, LoaderCircle, RefreshCw, Table, TriangleAlert, Unplug,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthProvider'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import { messageOf } from '../data/errors'
import { DATA_SOURCES, SOURCE_STATUS_LABELS } from '../data/sources'
import type { DataSource, SourceId } from '../data/sources'
import { GOOGLE_STATUS_LABELS, resourceStatusLabel, useSourcesStatus } from '../data/sourcesStatus'
import type { GoogleStatus, ResourceId, SourcesStatus } from '../data/sourcesStatus'
import { libraryApi } from '../library/api'
import type { LibraryStatus } from '../library/api'
import { formatTimestamp } from '../lib/datetime'
import { IS_DEMO } from '../mode'
import { DataSpace } from './SourcesSetup'

const ICONS: Record<ResourceId, LucideIcon> = {
  docs: FileText,
  sheets: Table,
  forms: ClipboardList,
  calendar: CalendarDays,
  excel: FileSpreadsheet,
}

// ---------- โหมดข้อมูลตัวอย่าง: รายการคงที่ ไม่มีการเชื่อมต่อใด ๆ ----------

function DemoSourcesPage() {
  const [openId, setOpenId] = useState<SourceId | null>(null)
  const open = DATA_SOURCES.find((s) => s.id === openId)

  return (
    <>
      <PageHeader title="แหล่งข้อมูล" description="แหล่งข้อมูลที่วางแผนจะรองรับ ตอนนี้ยังไม่มีแหล่งใดเชื่อมต่อ" />

      <p className="notice notice-block">
        <Info aria-hidden="true" size={18} />
        การเชื่อมต่อและการนำเข้าข้อมูลยังไม่เปิดใช้งานในต้นแบบนี้ หน้านี้แสดงสิ่งที่ต้องกำหนดเมื่อเปิดใช้งานจริง
      </p>

      <ul className="source-grid">
        {DATA_SOURCES.map((s) => (
          <SourceCard key={s.id} source={s} statusLabel={SOURCE_STATUS_LABELS[s.status]} onOpen={() => setOpenId(s.id)} />
        ))}
      </ul>

      {open && <SetupDialog source={open} statusLabel={SOURCE_STATUS_LABELS[open.status]} onClose={() => setOpenId(null)} />}
    </>
  )
}

function SourceCard({ source, statusLabel, tone = 'neutral', onOpen }: { source: Pick<DataSource, 'id' | 'name' | 'kind' | 'summary'> | LiveSource; statusLabel: string; tone?: 'neutral' | 'active'; onOpen(): void }) {
  const Icon = ICONS[source.id]
  return (
    <li className="card source-card">
      <div className="source-card-head">
        <span className="source-icon">
          <Icon aria-hidden="true" size={22} />
        </span>
        <div>
          <h2>{source.name}</h2>
          <p className="source-kind">{source.kind}</p>
        </div>
      </div>
      <p className="source-summary-text">{source.summary}</p>
      <div className="source-card-foot">
        <span className={`badge badge-${tone}`}>{statusLabel}</span>
        <button type="button" className="button button-small" onClick={onOpen} aria-label={`ดูรายละเอียด ${source.name}`}>
          ดูรายละเอียด
        </button>
      </div>
    </li>
  )
}

function SetupDialog({ source, statusLabel, onClose, note }: { source: Pick<DataSource, 'name' | 'kind' | 'setup'>; statusLabel: string; onClose(): void; note?: string }) {
  return (
    <Dialog
      title={source.name}
      description={`${source.kind} · ${statusLabel}`}
      onRequestClose={onClose}
      footer={
        <button type="button" className="button button-primary" onClick={onClose} data-autofocus>
          ปิด
        </button>
      }
    >
      <p className="notice">
        <Info aria-hidden="true" size={18} />
        {note ?? 'ฟีเจอร์นี้ยังไม่เปิดใช้งาน ยังไม่มีการเชื่อมต่อ ส่ง หรือรับข้อมูลใด ๆ'}
      </p>
      <h3 className="section-label">สิ่งที่ต้องกำหนดเมื่อเปิดใช้งาน</h3>
      <dl className="setup-list">
        {source.setup.map((item) => (
          <div key={item.label}>
            <dt>{item.label}</dt>
            <dd>{item.detail}</dd>
          </div>
        ))}
      </dl>
    </Dialog>
  )
}

// ---------- โหมดใช้งานจริง: สถานะจาก server ----------

interface LiveSource {
  id: ResourceId
  name: string
  kind: string
  summary: string
  setup: { label: string; detail: string }[]
  note: string
}

const fromPlanned = (id: SourceId, note: string, summary?: string): LiveSource => {
  const planned = DATA_SOURCES.find((s) => s.id === id)!
  return { id, name: planned.name, kind: planned.kind, summary: summary ?? planned.summary, setup: planned.setup, note }
}

const LIVE_SOURCES: LiveSource[] = [
  {
    id: 'docs',
    name: 'Google Docs',
    kind: 'เอกสารของชมรม',
    summary: 'สร้างเอกสารใหม่จากหน้า “ไฟล์ชมรม” (ตั้งชื่อแล้วไปเขียนใน Google Docs) เนื้อหาเก็บเป็นไฟล์ Google Docs ในบัญชีของชมรม เว็บตามการเปลี่ยนชื่อใน Google',
    setup: [
      { label: 'บัญชีที่ใช้', detail: 'ไฟล์ถูกสร้างใน Google Drive ของบัญชีชมรมที่เชื่อมไว้ด้านบน' },
      { label: 'ขอบเขตสิทธิ์', detail: 'เว็บไซต์เข้าถึงได้เฉพาะไฟล์ที่สร้างผ่านเว็บไซต์นี้ และไฟล์เดิมที่ผู้ดูแลเลือกผ่านหน้าต่างเลือกไฟล์ของ Google (สิทธิ์ drive.file) ไม่เห็นไฟล์อื่นใน Drive' },
      { label: 'การแชร์', detail: 'เว็บไซต์ไม่เปลี่ยนการแชร์ของไฟล์ ทีมงานแก้ผ่านเว็บได้ตามสิทธิ์ในเว็บ ส่วนการเปิดใน Google Docs โดยตรงต้องมีสิทธิ์ใน Google ของตัวเอง' },
    ],
    note: 'ใช้ได้เมื่อเชื่อมบัญชี Google ของชมรมแล้ว เอกสารเปิดดูตัวอย่างในเว็บได้จากหน้า “ไฟล์ชมรม” การแก้เนื้อหาทำใน Google Docs (เอกสารข้อความล้วนที่สร้างจากเว็บยังแก้ข้อความในเว็บได้จากหน้าตัวอย่าง)',
  },
  fromPlanned('excel', 'Excel อยู่นอกงานซิงค์กับ Google ยังไม่เปิดใช้งาน ยังไม่มีการเชื่อมต่อ ส่ง หรือรับข้อมูลใด ๆ'),
]

const CALLBACK_MESSAGES: Record<string, { ok: boolean; text: string }> = {
  connected: { ok: true, text: 'เชื่อมบัญชี Google ของชมรมแล้ว' },
  cancelled: { ok: false, text: 'ยกเลิกการอนุญาตที่ Google ยังไม่ได้เชื่อมบัญชี' },
  wrong_account: { ok: false, text: 'บัญชีที่อนุญาตไม่ใช่บัญชีของชมรม จึงไม่ได้เชื่อมและไม่ได้เก็บข้อมูลของบัญชีนั้น เลือกบัญชีชมรมแล้วลองอีกครั้ง' },
  missing_scope: { ok: false, text: 'ไม่ได้ติ๊กอนุญาตสิทธิ์จัดการไฟล์ที่เว็บไซต์สร้าง จึงยังไม่ได้เชื่อม ลองอีกครั้งและอนุญาตสิทธิ์ที่ขอ' },
  no_refresh_token: { ok: false, text: 'Google ไม่ได้ให้สิทธิ์ใช้งานต่อเนื่อง จึงยังไม่ได้เชื่อม ลองเชื่อมอีกครั้ง' },
  forbidden: { ok: false, text: 'ต้องเป็นผู้ดูแลคนเดียวกับที่เริ่มขั้นตอนจึงจะเชื่อมได้' },
  failed: { ok: false, text: 'ตรวจการอนุญาตกับ Google ไม่สำเร็จ ยังไม่ได้เชื่อม ลองอีกครั้ง' },
}

const STATUS_ICONS: Record<GoogleStatus, LucideIcon> = {
  not_configured: TriangleAlert,
  not_connected: Unplug,
  connected: CircleCheck,
  needs_reconnect: CircleAlert,
  error: CircleAlert,
}

function LiveSourcesPage() {
  const { isAdmin } = useAuth()
  const toast = useToast()
  const sources = useSourcesStatus()
  const [params, setParams] = useSearchParams()
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null)
  const [openId, setOpenId] = useState<ResourceId | null>(null)
  const [busy, setBusy] = useState<'connect' | 'check' | 'disconnect' | null>(null)
  const [actionError, setActionError] = useState('')
  const [confirmDisconnect, setConfirmDisconnect] = useState(false)

  // ผลจากการกลับมาจากหน้าอนุญาตของ Google อ่านครั้งเดียวแล้วลบออกจาก URL สถานะจริงยังมาจาก server เสมอ
  useEffect(() => {
    const code = params.get('google')
    if (!code) return
    setResult(CALLBACK_MESSAGES[code] ?? CALLBACK_MESSAGES.failed)
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('google')
        return next
      },
      { replace: true },
    )
  }, [params, setParams])

  const run = async (kind: 'connect' | 'check' | 'disconnect', service?: 'calendar_created' | 'calendar_existing' | 'library') => {
    setBusy(kind)
    setActionError('')
    setResult(null)
    try {
      if (kind === 'connect') {
        // service = ขอสิทธิ์ของบริการเพิ่ม (Google แสดงหน้าขออนุญาตให้ตรวจ และคงสิทธิ์เดิมที่ให้ไว้)
        const { authUrl } = await api<{ authUrl: string }>('/api/google/connect', { method: 'POST', body: service ? { service } : undefined })
        window.location.assign(authUrl)
        return
      }
      const response = await api<SourcesStatus & { problem?: string | null; revokedAtGoogle?: boolean }>(`/api/google/${kind}`, { method: 'POST' })
      sources.apply(response)
      if (kind === 'check') {
        if (response.problem) setActionError(response.problem)
        else toast.success('ตรวจแล้ว: การเชื่อม Google ใช้งานได้')
      } else {
        setConfirmDisconnect(false)
        toast.success(
          response.revokedAtGoogle
            ? 'ตัดการเชื่อมแล้ว และถอนสิทธิ์ของเว็บไซต์ที่ Google แล้ว'
            : 'ตัดการเชื่อมในเว็บไซต์แล้ว แต่ถอนสิทธิ์ที่ Google ไม่สำเร็จ ถอนเองได้ที่หน้าความปลอดภัยของบัญชี Google',
        )
      }
    } catch (error) {
      setConfirmDisconnect(false)
      setActionError(messageOf(error, 'ทำรายการไม่สำเร็จ ลองอีกครั้ง'))
    } finally {
      setBusy(null)
    }
  }

  const google = sources.data?.google
  const open = LIVE_SOURCES.find((s) => s.id === openId)
  const statusOf = (id: ResourceId) => sources.data?.resources.find((r) => r.id === id)?.status ?? 'disabled'

  return (
    <>
      <PageHeader title="แหล่งข้อมูล" description="การเชื่อมบัญชี Google ของชมรม และสถานะของแหล่งข้อมูลแต่ละชนิด" />

      {result && (
        <p className={`notice notice-block ${result.ok ? 'notice-success' : 'notice-warning'}`} role={result.ok ? 'status' : 'alert'}>
          {result.ok ? <CircleCheck aria-hidden="true" size={18} /> : <TriangleAlert aria-hidden="true" size={18} />}
          {result.text}
        </p>
      )}

      {sources.state === 'loading' && (
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดสถานะแหล่งข้อมูล…</p>
        </div>
      )}
      {sources.state === 'error' && (
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดสถานะแหล่งข้อมูลไม่สำเร็จ</p>
          <p className="empty-state-text">{sources.error}</p>
          <button type="button" className="button button-primary" onClick={sources.reload}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      )}

      {sources.state === 'ready' && google && (
        <>
          <section className="card connection-card" aria-labelledby="connection-title">
            <div className="card-header">
              <h2 id="connection-title">บัญชี Google ของชมรม</h2>
              <ConnectionBadge status={google.status} />
            </div>

            <dl className="detail-list">
              <div>
                <dt>บัญชีที่ต้องใช้เชื่อม</dt>
                <dd className="break-word">{google.expectedEmail}</dd>
              </div>
              <div>
                <dt>บัญชีที่เชื่อมอยู่</dt>
                <dd className="break-word">{google.email ?? <span className="muted">ยังไม่มี</span>}</dd>
              </div>
              <div>
                <dt>ตรวจกับ Google ล่าสุด</dt>
                <dd>{google.lastCheckedAt ? formatTimestamp(google.lastCheckedAt) : <span className="muted">ยังไม่เคยตรวจ</span>}</dd>
              </div>
              <div>
                <dt>เชื่อมเมื่อ</dt>
                <dd>{google.connectedAt ? formatTimestamp(google.connectedAt) : <span className="muted">—</span>}</dd>
              </div>
            </dl>

            <ConnectionExplanation google={google} isAdmin={isAdmin} />

            {actionError && (
              <p className="form-alert" role="alert">
                {actionError}
              </p>
            )}

            {isAdmin ? (
              google.status !== 'not_configured' && (
                <div className="button-row">
                  {google.status === 'not_connected' ? (
                    <button type="button" className="button button-primary" disabled={busy !== null} onClick={() => run('connect')}>
                      <Link2 aria-hidden="true" size={18} />
                      {busy === 'connect' ? 'กำลังไปที่ Google…' : 'เชื่อมบัญชี Google ของชมรม'}
                    </button>
                  ) : (
                    <>
                      <button
                        type="button"
                        className={`button ${google.status === 'connected' ? '' : 'button-primary'}`}
                        disabled={busy !== null}
                        onClick={() => run('connect')}
                      >
                        <Link2 aria-hidden="true" size={18} />
                        {busy === 'connect' ? 'กำลังไปที่ Google…' : 'เชื่อมใหม่'}
                      </button>
                      <button type="button" className="button" disabled={busy !== null} onClick={() => run('check')}>
                        <RefreshCw aria-hidden="true" size={18} />
                        {busy === 'check' ? 'กำลังตรวจ…' : 'ตรวจการเชื่อมต่อ'}
                      </button>
                      <button type="button" className="button button-danger-outline" disabled={busy !== null} onClick={() => setConfirmDisconnect(true)}>
                        <Unplug aria-hidden="true" size={18} />
                        ตัดการเชื่อม
                      </button>
                    </>
                  )}
                </div>
              )
            ) : (
              <p className="field-hint">การเชื่อม เชื่อมใหม่ และตัดการเชื่อม ทำได้เฉพาะผู้ดูแลระบบ</p>
            )}
          </section>

          <LibraryCard isAdmin={isAdmin} busy={busy !== null} onEnable={() => run('connect', 'library')} />

          <DataSpace google={google} isAdmin={isAdmin} onRequestScope={(service) => run('connect', service)} scopeBusy={busy !== null} />

          <ul className="source-grid">
            {LIVE_SOURCES.map((s) => {
              const status = statusOf(s.id)
              return (
                <SourceCard
                  key={s.id}
                  source={s}
                  statusLabel={resourceStatusLabel(s.id, status)}
                  tone={status === 'ready' ? 'active' : 'neutral'}
                  onOpen={() => setOpenId(s.id)}
                />
              )
            })}
          </ul>
        </>
      )}

      {open && (
        <SetupDialog source={open} statusLabel={resourceStatusLabel(open.id, statusOf(open.id))} note={open.note} onClose={() => setOpenId(null)} />
      )}

      {confirmDisconnect && (
        <ConfirmDialog
          title="ตัดการเชื่อมบัญชี Google ของชมรม?"
          confirmLabel="ตัดการเชื่อม"
          tone="danger"
          busy={busy === 'disconnect'}
          onConfirm={() => run('disconnect')}
          onCancel={() => setConfirmDisconnect(false)}
        >
          <ul>
            <li>เว็บไซต์จะสร้าง เปิด และแก้เอกสารไม่ได้ และจะหยุดซิงค์กับ Google Sheets, Calendar และ Forms จนกว่าผู้ดูแลจะเชื่อมใหม่</li>
            <li>ไฟล์ ปฏิทิน และฟอร์มใน Google ของชมรมไม่ถูกลบ รายการเอกสาร สมาชิก กำหนดการในเว็บยังอยู่ครบ (แสดงค่าที่อัปเดตสำเร็จล่าสุด)</li>
            <li>ทีมงานยังเข้าสู่ระบบและใช้ส่วนอื่นได้ตามปกติ</li>
          </ul>
        </ConfirmDialog>
      )}
    </>
  )
}

/**
 * คลังไฟล์ชมรม: สิทธิ์อ่านไฟล์ทั้งหมดของบัญชีชมรม (drive.readonly) ขอแยกจากการเชื่อมบัญชีและจากแหล่งข้อมูลที่ซิงค์
 * สถานะมาจากสิทธิ์ที่ Google ยืนยันว่าให้แล้วจริง ไม่ใช่จากการที่เชื่อมบัญชีแล้ว
 */
function LibraryCard({ isAdmin, busy, onEnable }: { isAdmin: boolean; busy: boolean; onEnable(): void }) {
  const [status, setStatus] = useState<LibraryStatus | null>(null)
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    libraryApi.status().then(setStatus, () => setFailed(true))
  }, [])

  return (
    <section className="card library-card" aria-labelledby="library-card-title">
      <div className="card-header">
        <h2 id="library-card-title">
          <FolderOpen aria-hidden="true" size={20} />
          คลังไฟล์ชมรม
        </h2>
        {status && <span className={`badge badge-${status.enabled ? 'active' : 'neutral'}`}>{status.enabled ? 'เปิดใช้แล้ว' : 'ยังไม่ได้เปิดใช้'}</span>}
      </div>
      <p className="field-hint">
        หน้า “ไฟล์ชมรม” ของทีมงานและของสมาชิกแสดงไฟล์ทั้งหมดที่บัญชี Google ของชมรมเข้าถึงได้ (อ่านอย่างเดียว) โดยไม่ต้องเลือกหรือนำเข้าทีละไฟล์
        แยกจากชีต ปฏิทิน และฟอร์มที่ซิงค์ด้านล่าง: การเห็นไฟล์ในคลังไม่ทำให้ไฟล์นั้นถูกนำไปสร้างสมาชิกหรือกำหนดการ
      </p>
      {failed && <p className="muted">อ่านสถานะคลังไฟล์ไม่ได้ในตอนนี้ โหลดหน้านี้ใหม่เพื่อลองอีกครั้ง</p>}
      {status && !status.enabled && (
        <>
          <p className="notice">
            <Info aria-hidden="true" size={18} />
            <span>{status.message}</span>
          </p>
          {status.canEnable && (
            <>
              <div className="button-row">
                <button type="button" className="button button-primary" disabled={busy} onClick={onEnable}>
                  <FolderOpen aria-hidden="true" size={18} />
                  เปิดใช้คลังไฟล์ Google
                </button>
              </div>
              <p className="field-hint">
                ระบบจะพาไปหน้าขออนุญาตของ Google ให้เลือกบัญชีชมรม แล้วอนุญาตให้เว็บนี้ “ดูและดาวน์โหลดไฟล์ทั้งหมดใน Google Drive” ของบัญชีชมรม (อ่านอย่างเดียว
                ไม่ขอสิทธิ์แก้หรือลบไฟล์) สิทธิ์นี้เป็นสิทธิ์ระดับ restricted ของ Google: ต้องเพิ่มในหน้า OAuth consent screen ของโครงการก่อน (ดู README)
              </p>
            </>
          )}
          {!isAdmin && status.reason === 'missing_scope' && <p className="field-hint">การเปิดใช้คลังไฟล์ทำได้เฉพาะผู้ดูแลระบบ</p>}
        </>
      )}
      {status?.enabled && (
        <>
          <p>
            <CircleCheck aria-hidden="true" size={18} className="inline-icon" /> บัญชีชมรมอนุญาตให้เว็บอ่านไฟล์แล้ว
            {status.lastSuccessAt ? ` อ่านรายการจาก Google สำเร็จล่าสุดเมื่อ ${formatTimestamp(status.lastSuccessAt)}` : ' ยังไม่มีการอ่านรายการจาก Google'}
          </p>
          <p className="notice">
            <Info aria-hidden="true" size={18} />
            <span>
              สมาชิกที่เข้าสู่ระบบด้วยรหัสนักศึกษาเปิดดูไฟล์ทุกไฟล์ในคลังได้ รวมถึงชีตทะเบียนสมาชิกและชีตคำตอบของฟอร์ม ถ้ามีไฟล์ที่ไม่ควรให้สมาชิกเห็น
              อย่าเก็บหรือแชร์ไฟล์นั้นไว้กับบัญชี Google ของชมรม
            </span>
          </p>
          <div className="button-row">
            <Link to="/files" className="button">
              ไปหน้าไฟล์ชมรม
            </Link>
          </div>
        </>
      )}
    </section>
  )
}

function ConnectionBadge({ status }: { status: GoogleStatus }) {
  const Icon = STATUS_ICONS[status]
  const tone = status === 'connected' ? 'active' : status === 'needs_reconnect' || status === 'error' ? 'suspended' : 'neutral'
  return (
    <span className={`badge badge-${tone}`}>
      <Icon aria-hidden="true" size={14} />
      {GOOGLE_STATUS_LABELS[status]}
    </span>
  )
}

function ConnectionExplanation({ google, isAdmin }: { google: SourcesStatus['google']; isAdmin: boolean }) {
  if (google.status === 'not_configured') {
    return (
      <div className="notice notice-warning">
        <TriangleAlert aria-hidden="true" size={18} />
        <div>
          <p>
            <strong>เว็บไซต์ยังไม่ได้ตั้งค่าการเชื่อม Google จริง</strong> ส่วนสมาชิกและกำหนดการใช้งานได้ตามปกติ แต่หน้าเอกสารจะยังสร้างหรือแก้ไม่ได้
          </p>
          {isAdmin && google.missingConfig.length > 0 && (
            <>
              <p>ค่าที่ยังขาดใน Worker:</p>
              <ul className="bulleted">
                {google.missingConfig.map((name) => (
                  <li key={name}>
                    <code>{name}</code>
                  </li>
                ))}
              </ul>
              <p>
                ทำตามหัวข้อ “ตั้งค่า Google Cloud” และ “ค่าลับของ Worker” ใน README: สร้าง OAuth client แบบ Web application ใส่ redirect URI เป็น{' '}
                <code className="break-word">{window.location.origin}/auth/google/callback</code> แล้วตั้งค่าทั้งสามตัวให้ครบ
              </p>
            </>
          )}
        </div>
      </div>
    )
  }
  if (google.status === 'not_connected') {
    return (
      <p className="notice">
        <Info aria-hidden="true" size={18} />
        ยังไม่ได้เชื่อม เมื่อกดเชื่อมจะไปหน้าอนุญาตของ Google ให้เลือกบัญชี {google.expectedEmail} เท่านั้น
        เว็บไซต์ขอสิทธิ์จัดการเฉพาะไฟล์ที่เว็บไซต์นี้สร้าง
      </p>
    )
  }
  if (google.status === 'needs_reconnect') {
    return (
      <p className="notice notice-warning" role="alert">
        <TriangleAlert aria-hidden="true" size={18} />
        Google ไม่รับสิทธิ์ที่เก็บไว้แล้ว (ถูกถอนสิทธิ์หรือหมดอายุ) เอกสารจะเปิดและแก้ไม่ได้ และการซิงค์กับ Google หยุดอยู่ (หน้าเว็บแสดงข้อมูลที่อัปเดตสำเร็จล่าสุด) จนกว่าผู้ดูแลจะกด “เชื่อมใหม่” ด้วยบัญชีชมรม
      </p>
    )
  }
  if (google.status === 'error') {
    return (
      <p className="notice notice-warning" role="alert">
        <TriangleAlert aria-hidden="true" size={18} />
        ตรวจกับ Google ครั้งล่าสุดไม่สำเร็จ{google.lastError ? ` (${google.lastError})` : ''} อาจเป็นปัญหาชั่วคราว กด “ตรวจการเชื่อมต่อ” เพื่อลองอีกครั้ง
      </p>
    )
  }
  return (
    <div className="notice">
      <Info aria-hidden="true" size={18} />
      <div>
        <p>การออกจากระบบของทีมงานไม่กระทบการเชื่อมนี้ เว็บไซต์เข้าถึงได้เฉพาะไฟล์ที่สร้างผ่านเว็บไซต์นี้หรือที่ผู้ดูแลเลือกไว้ และปฏิทินตามสิทธิ์ที่อนุญาต</p>
        {isAdmin && (
          <p>
            ถ้าหน้าจอขออนุญาตของ Google (OAuth consent screen) ยังอยู่ในสถานะ Testing Google จะยกเลิกการอนุญาตเองภายในประมาณ 7 วัน การซิงค์จะหยุดและต้องกด “เชื่อมใหม่”
            จนกว่าจะเปลี่ยนสถานะการเผยแพร่ (ดู README)
          </p>
        )}
      </div>
    </div>
  )
}

export const SourcesPage = IS_DEMO ? DemoSourcesPage : LiveSourcesPage
