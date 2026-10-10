import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CalendarDays, CircleAlert, CircleCheck, ClipboardList, ExternalLink, Info, LoaderCircle, Lock, Table, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { api, createKeyTracker } from '../api/client'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { CLUB_NAME } from '../config'
import { Field } from '../components/ui'
import { AppError, messageOf } from '../data/errors'
import { useSetupInfo } from '../data/setup'
import type { ResourceKind, SetupInfo } from '../data/setup'
import type { SourcesStatus } from '../data/sourcesStatus'
import { useStore } from '../data/store'
import { useSync } from '../data/sync'
import type { SyncStatus } from '../data/sync'
import { formatEventRange, formatTimestamp } from '../lib/datetime'
import { cancelPick, pickFile, preloadPicker } from '../lib/picker'

const KINDS: ResourceKind[] = ['sheets', 'calendar', 'forms']
const META: Record<ResourceKind, { icon: LucideIcon; service: string; use: string; noun: string; defaultName: string; creates: string }> = {
  sheets: {
    icon: Table, service: 'Google Sheets', use: 'ทะเบียนสมาชิก', noun: 'ชีต', defaultName: `${CLUB_NAME} — ทะเบียนสมาชิก`,
    creates: 'ไฟล์ Google Sheets ใหม่ พร้อมแถวหัวตาราง: รหัสสมาชิก ชื่อ ชื่อเล่น บทบาท สถานะ ช่องทางติดต่อ หมายเหตุ วันที่เพิ่ม รหัสนักศึกษา (ระบบจับคู่แถวด้วยคอลัมน์รหัสสมาชิก)',
  },
  calendar: {
    icon: CalendarDays, service: 'Google Calendar', use: 'ปฏิทินชมรม', noun: 'ปฏิทิน', defaultName: `${CLUB_NAME} — กำหนดการ`,
    creates: 'ปฏิทินใหม่ในบัญชีชมรม เขตเวลา Asia/Bangkok (ไม่แชร์ให้ใครและไม่เชิญแขกโดยอัตโนมัติ)',
  },
  forms: {
    icon: ClipboardList, service: 'Google Forms', use: 'แบบฟอร์มของชมรม', noun: 'ฟอร์ม', defaultName: `${CLUB_NAME} — สมัครสมาชิก`,
    creates: 'ฟอร์มใหม่พร้อมคำถามตั้งต้น: ชื่อ-นามสกุล ชื่อเล่น ช่องทางติดต่อ หมายเหตุ (ฟอร์มยังไม่เผยแพร่จนกว่าจะเปิดเองใน Google Forms)',
  },
}
const FIELD_LABELS: Record<string, string> = {
  id: 'รหัสสมาชิก (ใช้จับคู่แถว)', name: 'ชื่อ', nickname: 'ชื่อเล่น', role: 'บทบาท', status: 'สถานะ', contact: 'ช่องทางติดต่อ', note: 'หมายเหตุ', addedAt: 'วันที่เพิ่ม',
  studentId: 'รหัสนักศึกษา',
}
const FIELDS = Object.keys(FIELD_LABELS)
const ACCESS_ROLE: Record<string, string> = { owner: 'เจ้าของ', writer: 'แก้ไขได้', reader: 'อ่านอย่างเดียว', freeBusyReader: 'เห็นเฉพาะว่าง/ไม่ว่าง' }

type Open =
  | { type: 'createSet' }
  | { type: 'sheet'; fileId: string }
  | { type: 'form'; fileId: string }
  | { type: 'calendar' }
  | { type: 'unlink'; kind: ResourceKind }
  | { type: 'push'; kind: 'sheets' | 'calendar' }
  | { type: 'studentId' }

interface Props {
  google: SourcesStatus['google']
  isAdmin: boolean
  /** เริ่มขอสิทธิ์ของบริการเพิ่มผ่านขั้นตอนเชื่อมบัญชี */
  onRequestScope(service: 'calendar_created' | 'calendar_existing'): void
  scopeBusy: boolean
}

/** ส่วนตั้งค่าพื้นที่ข้อมูลชมรม: สถานะของแต่ละแหล่ง และ (เฉพาะผู้ดูแล) การสร้าง เลือก ย้ายข้อมูลเดิม และยกเลิกการเชื่อม */
export function DataSpace({ google, isAdmin, onRequestScope, scopeBusy }: Props) {
  const sync = useSync()
  const toast = useToast()
  const { refresh } = useStore()
  const setup = useSetupInfo(isAdmin)
  const [open, setOpen] = useState<Open | null>(null)
  const [picking, setPicking] = useState<ResourceKind | null>(null)
  const pickerOpener = useRef<HTMLButtonElement | null>(null)
  const restorePickerFocus = useRef(false)
  const [error, setError] = useState('')
  const info = setup.info
  const connected = google.status === 'connected'
  const statusOf = (kind: ResourceKind) => sync?.statuses[kind]

  /** หลังสถานะการเชื่อมเปลี่ยน: โหลดสถานะซิงค์ ข้อมูลตั้งค่า และรายการของหน้าอื่นใหม่ */
  const changed = async () => {
    await Promise.all([sync?.reload(), setup.reload(), refresh()]).catch(() => undefined)
  }

  // โหลดหน้าต่างเลือกไฟล์ของ Google ไว้ล่วงหน้า: ตอนกดปุ่ม คำขอสิทธิ์จะเกิดในจังหวะเดียวกับการกด เบราว์เซอร์จึงไม่บล็อกเป็น popup
  // โหลดไม่สำเร็จตรงนี้ยังไม่แจ้งผู้ใช้ (จะลองใหม่และแจ้งเหตุผลเมื่อกดปุ่ม)
  const pickerConfigured = isAdmin && info?.picker.configured === true
  useEffect(() => {
    if (pickerConfigured) preloadPicker().catch(() => undefined)
  }, [pickerConfigured])
  // ออกจากหน้านี้ขณะหน้าต่างเลือกไฟล์เปิดอยู่: ปิดหน้าต่างนั้นด้วย
  useEffect(() => cancelPick, [])

  // คืน focus หลัง React เปิดให้ปุ่มกดได้แล้วใน DOM เดียวกัน ไม่อาศัยเวลาของ animation frame
  useLayoutEffect(() => {
    if (picking !== null || !restorePickerFocus.current) return
    restorePickerFocus.current = false
    if (open === null && pickerOpener.current?.isConnected) pickerOpener.current.focus()
  }, [picking, open])

  const pick = async (kind: 'sheets' | 'forms', opener: HTMLButtonElement) => {
    if (!info?.picker.configured || picking !== null) return
    pickerOpener.current = opener
    setError('')
    setPicking(kind)
    try {
      const file = await pickFile(info.picker, kind, google.expectedEmail)
      if (file) setOpen({ type: kind === 'sheets' ? 'sheet' : 'form', fileId: file.id })
    } catch (failure) {
      setError(messageOf(failure, 'เปิดหน้าต่างเลือกไฟล์ของ Google ไม่สำเร็จ ลองอีกครั้ง'))
    } finally {
      restorePickerFocus.current = true
      setPicking(null)
    }
  }

  const dismissOperation = async (id: string) => {
    try {
      await api(`/api/setup/operations/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await setup.reload()
      toast.success('นำงานออกจากรายการแล้ว (ไม่ได้ลบอะไรใน Google)')
    } catch (failure) {
      setError(messageOf(failure, 'นำออกจากรายการไม่สำเร็จ'))
    }
  }

  const unlinked = KINDS.filter((kind) => statusOf(kind) && !statusOf(kind)!.linked)

  return (
    <section className="card data-space" aria-labelledby="data-space-title">
      <div className="card-header">
        <h2 id="data-space-title">พื้นที่ข้อมูลชมรม</h2>
        {isAdmin && connected && unlinked.length > 0 && (
          <button type="button" className="button button-primary" onClick={() => setOpen({ type: 'createSet' })}>
            สร้างชุดข้อมูลชมรม
          </button>
        )}
      </div>
      <p className="field-hint">
        Google เป็นแหล่งหลักของข้อมูลที่เชื่อมแล้ว เว็บไซต์เก็บสำเนาไว้แสดงผลและตรวจการเปลี่ยนแปลงประมาณทุก 1 นาทีขณะมีคนเปิดหน้า เว็บไซต์ติดตามเฉพาะแหล่งที่ผู้ดูแลสร้างหรือเลือกไว้ที่นี่
        ไม่สแกนไฟล์อื่นในบัญชี
      </p>

      {!connected && (
        <p className="notice">
          <Info aria-hidden="true" size={18} />
          ต้องเชื่อมบัญชี Google ของชมรมด้านบนให้ใช้งานได้ก่อน จึงจะสร้างหรือเลือกแหล่งข้อมูลได้
        </p>
      )}
      {error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}

      <ul className="resource-list">
        {KINDS.map((kind) => {
          const status = statusOf(kind)
          const meta = META[kind]
          const Icon = meta.icon
          const localCount = kind === 'sheets' ? info?.local.members : kind === 'calendar' ? info?.local.events : 0
          return (
            <li key={kind} className="resource-row" data-resource={kind}>
              <span className="source-icon">
                <Icon aria-hidden="true" size={22} />
              </span>
              <div className="resource-main">
                <h3>
                  {meta.service} <span className="muted">· {meta.use}</span>
                </h3>
                {!status ? (
                  <p className="muted">กำลังโหลดสถานะ…</p>
                ) : status.linked && status.resource ? (
                  <ResourceState status={status} />
                ) : (
                  <p className="resource-state">
                    <span className="badge badge-neutral">ยังไม่ได้เชื่อม</span>
                    {kind === 'forms' ? 'ยังไม่มีฟอร์มที่เว็บไซต์ติดตาม' : `${meta.use}ใช้ข้อมูลในเว็บ ยังไม่อ่านหรือเขียน ${meta.service}`}
                  </p>
                )}
                {isAdmin && connected && status && (
                  <div className="button-row">
                    {status.linked ? (
                      <>
                        {(kind === 'sheets' || kind === 'calendar') && !!localCount && status.resource?.access === 'write' && (
                          <button type="button" className="button button-small" onClick={() => setOpen({ type: 'push', kind })}>
                            ย้าย{kind === 'sheets' ? 'สมาชิก' : 'กำหนดการ'}ในเว็บ {localCount} รายการขึ้น Google
                          </button>
                        )}
                        <button type="button" className="button button-small button-danger-outline" onClick={() => setOpen({ type: 'unlink', kind })}>
                          ยกเลิกการเชื่อม
                        </button>
                      </>
                    ) : kind === 'calendar' ? (
                      <>
                        {info && !info.scopes.calendarExisting ? (
                          <button type="button" className="button button-small" disabled={scopeBusy} onClick={() => onRequestScope('calendar_existing')}>
                            ขอสิทธิ์เพื่อเลือกปฏิทินที่มีอยู่
                          </button>
                        ) : (
                          <button type="button" className="button button-small" onClick={() => setOpen({ type: 'calendar' })}>
                            เลือกปฏิทินที่มีอยู่
                          </button>
                        )}
                        {info && !info.scopes.calendarCreated && (
                          <button type="button" className="button button-small" disabled={scopeBusy} onClick={() => onRequestScope('calendar_created')}>
                            ขอสิทธิ์เพื่อสร้างปฏิทินใหม่
                          </button>
                        )}
                      </>
                    ) : (
                      <>
                        <button type="button" className="button button-small" disabled={!info?.picker.configured || picking !== null} onClick={(event) => pick(kind, event.currentTarget)}>
                          {picking === kind ? 'หน้าต่างเลือกไฟล์ของ Google เปิดอยู่…' : `เลือก${meta.noun}ที่มีอยู่`}
                        </button>
                        {picking === kind && (
                          <button type="button" className="button button-small" onClick={cancelPick}>
                            ปิดหน้าต่างเลือกไฟล์
                          </button>
                        )}
                      </>
                    )}
                  </div>
                )}
                {isAdmin && connected && kind === 'calendar' && status && !status.linked && info && (!info.scopes.calendarCreated || !info.scopes.calendarExisting) && (
                  <p className="field-hint">
                    สิทธิ์ Calendar ขอเพิ่มแยกจากการเข้าสู่ระบบ: “สร้างปฏิทินใหม่” ให้เว็บไซต์เห็นเฉพาะปฏิทินที่เว็บไซต์สร้าง ส่วน “เลือกปฏิทินที่มีอยู่”
                    ให้เว็บไซต์อ่านรายชื่อปฏิทินและอ่าน/แก้กำหนดการของปฏิทินที่บัญชีชมรมเข้าถึงได้ Google จะแสดงหน้าขออนุญาตให้ตรวจก่อน
                  </p>
                )}
              </div>
            </li>
          )
        })}
      </ul>

      {isAdmin && connected && info?.picker.configured && unlinked.some((kind) => kind !== 'calendar') && (
        <p className="field-hint picker-note">
          ปุ่ม “เลือก…ที่มีอยู่” เปิดหน้าต่างเลือกไฟล์ของ Google ทีละหน้าต่าง (ครั้งแรกอาจมีหน้าต่างขออนุญาตของ Google ก่อน) ถ้าหน้าต่างเลือกไฟล์แสดงหน้าเข้าสู่ระบบของ Google
          ซ้อนอยู่หรือเลือกไฟล์ไม่ได้ อาจเกิดจากเบราว์เซอร์ที่บล็อก cookie ของเว็บอื่น (เช่น Brave หรือหน้าต่างส่วนตัว): กด “ปิดหน้าต่างเลือกไฟล์” แล้วลองอนุญาต cookie ของ Google
          สำหรับเว็บไซต์นี้ ใช้เบราว์เซอร์อื่น หรือใช้ “สร้างชุดข้อมูลชมรม” แทน การดูไฟล์ในหน้า “ไฟล์ชมรม” ไม่ใช้หน้าต่างนี้
        </p>
      )}

      {isAdmin && connected && info?.studentIdColumn === '' && (
        <div className="notice notice-warning" data-student-id-column="missing">
          <TriangleAlert aria-hidden="true" size={18} />
          <div>
            <p>
              <strong>ชีตที่เชื่อมยังไม่มีคอลัมน์รหัสนักศึกษา</strong> รหัสนักศึกษาที่กรอกในเว็บจึงเก็บอยู่ในเว็บเท่านั้น และรหัสที่พิมพ์ในชีตยังไม่ถูกอ่าน
            </p>
            <button type="button" className="button button-small" onClick={() => setOpen({ type: 'studentId' })}>
              จับคู่คอลัมน์รหัสนักศึกษา
            </button>
          </div>
        </div>
      )}
      {isAdmin && connected && !!info?.studentIdColumn && (
        <p className="field-hint" data-student-id-column="mapped">
          คอลัมน์รหัสนักศึกษาของชีต: “{info.studentIdColumn}”{' '}
          <button type="button" className="link-button" onClick={() => setOpen({ type: 'studentId' })}>
            เปลี่ยนคอลัมน์
          </button>
        </p>
      )}

      {isAdmin && info && !info.picker.configured && (
        <div className="notice notice-warning">
          <TriangleAlert aria-hidden="true" size={18} />
          <div>
            <p>
              <strong>ยังเลือกไฟล์เดิม (ชีต ฟอร์ม เอกสาร) จากหน้าเว็บไม่ได้</strong> เพราะยังไม่ได้ตั้งค่า Google Picker การสร้างชุดข้อมูลใหม่ยังทำได้ตามปกติ
            </p>
            <p>ค่าที่ยังขาดใน Worker:</p>
            <ul className="bulleted">
              {info.picker.missing.map((name) => (
                <li key={name}>
                  <code>{name}</code>
                </li>
              ))}
            </ul>
            <p>
              ทำตามหัวข้อ “Google Picker” ใน README: เปิด Google Picker API สร้าง API key ที่จำกัดเฉพาะเว็บไซต์นี้ และเพิ่ม{' '}
              <code className="break-word">{window.location.origin}</code> ใน Authorized JavaScript origins ของ OAuth client การวางลิงก์ไฟล์อย่างเดียวไม่ได้ให้สิทธิ์แก่เว็บไซต์
              จึงไม่มีช่องให้วางลิงก์
            </p>
          </div>
        </div>
      )}

      {isAdmin && info && info.operations.length > 0 && (
        <div className="notice notice-warning" role="status">
          <TriangleAlert aria-hidden="true" size={18} />
          <div>
            <p>
              <strong>งานสร้างที่ยังไม่เสร็จ</strong> ระบบไม่สร้างซ้ำเอง เปิด “สร้างชุดข้อมูลชมรม” ด้วยชื่อเดิมเพื่อทำต่อ หรือนำออกจากรายการ
            </p>
            <ul className="pending-list">
              {info.operations.map((op) => (
                <li key={op.id}>
                  <div className="pending-main">
                    <span className="pending-title">
                      {META[op.kind].service}: {op.name}
                    </span>
                    <span className="pending-meta">
                      {op.fileState === 'created' ? 'สร้างใน Google แล้ว แต่ยังผูกกับเว็บไม่เสร็จ' : op.fileState === 'unknown' ? 'ไม่ทราบว่า Google สร้างแล้วหรือยัง' : 'ยังไม่ได้สร้าง'} · เริ่มเมื่อ{' '}
                      {formatTimestamp(op.createdAt)}
                    </span>
                  </div>
                  <div className="pending-actions">
                    <button type="button" className="button button-small" onClick={() => dismissOperation(op.id)}>
                      นำออกจากรายการ
                    </button>
                  </div>
                </li>
              ))}
            </ul>
          </div>
        </div>
      )}

      {!isAdmin && <p className="field-hint">การสร้าง เลือก และยกเลิกการเชื่อมแหล่งข้อมูล ทำได้เฉพาะผู้ดูแลระบบ</p>}

      {open?.type === 'createSet' && info && (
        <CreateSetDialog info={info} kinds={unlinked} onClose={() => (setOpen(null), void changed())} onRequestScope={onRequestScope} onProgress={changed} />
      )}
      {open?.type === 'sheet' && <SheetLinkDialog fileId={open.fileId} onClose={() => setOpen(null)} onLinked={() => (setOpen(null), void changed(), toast.success('เชื่อม Google Sheets กับทะเบียนสมาชิกแล้ว'))} />}
      {open?.type === 'form' && <FormLinkDialog fileId={open.fileId} onClose={() => setOpen(null)} onLinked={() => (setOpen(null), void changed(), toast.success('เชื่อม Google Forms แล้ว'))} />}
      {open?.type === 'calendar' && <CalendarLinkDialog onClose={() => setOpen(null)} onLinked={() => (setOpen(null), void changed(), toast.success('เชื่อม Google Calendar กับปฏิทินชมรมแล้ว'))} />}
      {open?.type === 'push' && statusOf(open.kind)?.resource && (
        <PushDialog kind={open.kind} status={statusOf(open.kind)!} count={(open.kind === 'sheets' ? info?.local.members : info?.local.events) ?? 0} onClose={() => (setOpen(null), void changed())} />
      )}
      {open?.type === 'studentId' && (
        <StudentIdColumnDialog
          onClose={() => setOpen(null)}
          onDone={async (header) => {
            setOpen(null)
            await changed()
            toast.success(`จับคู่คอลัมน์รหัสนักศึกษากับ “${header}” แล้ว`)
          }}
        />
      )}
      {open?.type === 'unlink' && <UnlinkDialog kind={open.kind} status={statusOf(open.kind)} onClose={() => setOpen(null)} onDone={() => (setOpen(null), void changed(), toast.success('ยกเลิกการเชื่อมแล้ว ต้นฉบับใน Google และข้อมูลในเว็บยังอยู่ครบ'))} />}
    </section>
  )
}

function ResourceState({ status }: { status: SyncStatus }) {
  const resource = status.resource!
  return (
    <>
      <p className="resource-state">
        <span className="badge badge-active">
          <CircleCheck aria-hidden="true" size={14} />
          เชื่อมแล้ว
        </span>
        <a href={resource.url} target="_blank" rel="noopener noreferrer" className="break-word">
          {resource.name || 'เปิดต้นฉบับ'}
          <ExternalLink aria-hidden="true" size={14} />
          <span className="visually-hidden"> (เปิดต้นฉบับใน Google แท็บใหม่)</span>
        </a>
        <span className="muted">{resource.origin === 'created' ? 'สร้างจากเว็บไซต์นี้' : 'เลือกจากที่มีอยู่'}</span>
        {resource.access === 'read' && (
          <span className="badge badge-neutral">
            <Lock aria-hidden="true" size={14} />
            อ่านอย่างเดียว
          </span>
        )}
      </p>
      <p className={`field-hint ${status.error ? 'resource-error' : ''}`}>
        {status.error ? (
          <>
            <CircleAlert aria-hidden="true" size={14} /> ซิงค์ไม่สำเร็จ: {status.error.message}
            {status.lastSuccessAt ? ` (สำเร็จล่าสุด ${formatTimestamp(status.lastSuccessAt)})` : ''}
          </>
        ) : status.lastSuccessAt ? (
          `อัปเดตจาก Google สำเร็จล่าสุด ${formatTimestamp(status.lastSuccessAt)}`
        ) : (
          'ยังไม่เคยอัปเดตจาก Google'
        )}
        {status.issues.length > 0 && ` · มี ${status.issues.length} รายการในต้นฉบับที่ต้องแก้`}
      </p>
    </>
  )
}

// ---------- สร้างชุดข้อมูลใหม่ ----------

type CreateResult = { state: 'idle' | 'running' | 'done' } | { state: 'error'; message: string; canConfirm: boolean }

function CreateSetDialog({
  info, kinds: initialKinds, onClose, onRequestScope, onProgress,
}: { info: SetupInfo; kinds: ResourceKind[]; onClose(): void; onRequestScope: Props['onRequestScope']; onProgress(): Promise<void> }) {
  // รายการในกล่องนี้คงตามตอนเปิด: รายการที่สร้างเสร็จแล้วยังแสดงผลอยู่ ไม่หายไปเมื่อสถานะด้านหลังเปลี่ยนเป็นเชื่อมแล้ว
  const [kinds] = useState(initialKinds)
  const allowed = (kind: ResourceKind) => (kind === 'calendar' ? info.scopes.calendarCreated : info.scopes.driveFile)
  const [selected, setSelected] = useState<Record<string, boolean>>(() => Object.fromEntries(kinds.map((k) => [k, allowed(k)])))
  const [names, setNames] = useState<Record<string, string>>(() => Object.fromEntries(kinds.map((k) => [k, META[k].defaultName])))
  const [results, setResults] = useState<Record<string, CreateResult>>({})
  const [running, setRunning] = useState(false)
  // key ผูกกับชนิดและชื่อ: กดลองใหม่ด้วยชื่อเดิมทำต่อจากงานเดิม ไม่สร้างซ้ำ
  const keys = useRef(Object.fromEntries(kinds.map((k) => [k, createKeyTracker()]))).current
  const chosen = kinds.filter((k) => selected[k] && allowed(k))
  const started = Object.keys(results).length > 0
  const finished = started && chosen.every((k) => results[k]?.state === 'done')

  const run = async (only?: ResourceKind, confirmCreate = false) => {
    setRunning(true)
    for (const kind of only ? [only] : chosen) {
      if (results[kind]?.state === 'done' && !only) continue
      const name = names[kind].trim()
      setResults((r) => ({ ...r, [kind]: { state: 'running' } }))
      try {
        await api('/api/setup/create', { method: 'POST', body: { kind, name, ...(confirmCreate ? { confirmCreate: true } : {}) }, idempotencyKey: keys[kind]({ kind, name }) })
        setResults((r) => ({ ...r, [kind]: { state: 'done' } }))
      } catch (failure) {
        setResults((r) => ({
          ...r,
          [kind]: { state: 'error', message: messageOf(failure, 'สร้างไม่สำเร็จ ลองอีกครั้ง'), canConfirm: failure instanceof AppError && failure.data.canConfirmCreate === true },
        }))
      }
    }
    await onProgress()
    setRunning(false)
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (chosen.length === 0 || chosen.some((k) => !names[k].trim())) return
    void run()
  }

  return (
    <Dialog
      title="สร้างชุดข้อมูลชมรม"
      description="ทรัพยากรจะถูกสร้างในบัญชี Google ของชมรมหลังกดยืนยันเท่านั้น"
      onRequestClose={() => !running && onClose()}
      footer={
        finished ? (
          <button type="button" className="button button-primary" onClick={onClose} data-autofocus>
            เสร็จ
          </button>
        ) : (
          <>
            <button type="button" className="button" onClick={onClose} disabled={running}>
              {started ? 'ปิด' : 'ยกเลิก'}
            </button>
            <button type="submit" form="create-set-form" className="button button-primary" disabled={running || chosen.length === 0 || chosen.some((k) => !names[k].trim())}>
              {running ? 'กำลังสร้าง…' : started ? 'ลองรายการที่ยังไม่เสร็จอีกครั้ง' : `สร้าง ${chosen.length} รายการในบัญชีชมรม`}
            </button>
          </>
        )
      }
    >
      <form id="create-set-form" className="form" onSubmit={submit}>
        <p className="notice">
          <Info aria-hidden="true" size={18} />
          ระบบจะสร้างเฉพาะรายการที่ติ๊กไว้ แล้วผูกกับเว็บไซต์ให้อัตโนมัติ ไม่เปลี่ยนการแชร์ ไม่ลบหรือแก้ไฟล์อื่นในบัญชี
        </p>
        {kinds.map((kind, index) => {
          const meta = META[kind]
          const result = results[kind]
          return (
            <fieldset key={kind} className="create-item" data-create={kind}>
              <label className="checkbox">
                <input
                  type="checkbox"
                  checked={!!selected[kind] && allowed(kind)}
                  disabled={!allowed(kind) || running || result?.state === 'done'}
                  data-autofocus={index === 0 ? true : undefined}
                  onChange={(e) => setSelected((s) => ({ ...s, [kind]: e.target.checked }))}
                />
                {meta.service} · {meta.use}
              </label>
              {!allowed(kind) ? (
                <div className="create-note">
                  <p className="field-hint">ยังไม่ได้รับสิทธิ์ที่ต้องใช้สร้าง{meta.noun} จึงยังสร้างไม่ได้</p>
                  {kind === 'calendar' && (
                    <button type="button" className="button button-small" onClick={() => onRequestScope('calendar_created')}>
                      ขอสิทธิ์เพื่อสร้างปฏิทินใหม่
                    </button>
                  )}
                </div>
              ) : (
                selected[kind] && (
                  <>
                    <Field label={`ชื่อ${meta.noun}`} htmlFor={`create-name-${kind}`} hint={`จะสร้าง: ${meta.creates}`}>
                      <input
                        id={`create-name-${kind}`}
                        type="text"
                        value={names[kind]}
                        maxLength={100}
                        disabled={running || result?.state === 'done'}
                        onChange={(e) => setNames((n) => ({ ...n, [kind]: e.target.value }))}
                        aria-describedby={`create-name-${kind}-hint`}
                      />
                    </Field>
                    {result?.state === 'running' && (
                      <p className="create-result" role="status">
                        <LoaderCircle aria-hidden="true" size={16} className="spin" /> กำลังสร้างและผูกกับเว็บไซต์…
                      </p>
                    )}
                    {result?.state === 'done' && (
                      <p className="create-result create-result-ok" role="status">
                        <CircleCheck aria-hidden="true" size={16} /> สร้างและเชื่อมแล้ว
                      </p>
                    )}
                    {result?.state === 'error' && (
                      <div className="form-alert" role="alert">
                        <p>{result.message}</p>
                        {result.canConfirm && (
                          <button type="button" className="button button-small" disabled={running} onClick={() => run(kind, true)}>
                            ตรวจในบัญชี Google แล้วไม่มี — ยืนยันให้สร้างใหม่
                          </button>
                        )}
                      </div>
                    )}
                  </>
                )
              )}
            </fieldset>
          )
        })}
        <div className="create-summary">
          <h3 className="section-label">ข้อมูลเดิมในเว็บ</h3>
          <p>
            สมาชิก {info.local.members} คน และกำหนดการ {info.local.events} รายการที่อยู่ในเว็บตอนนี้<strong>ยังอยู่ครบ</strong>
            และยังไม่ถูกส่งขึ้น Google จากการสร้างนี้ หลังสร้างเสร็จจะมีปุ่ม “ย้าย…ขึ้น Google” ในหน้านี้ ซึ่งแสดงจำนวนและรายการที่อาจซ้ำให้ตรวจก่อนยืนยัน
          </p>
        </div>
      </form>
    </Dialog>
  )
}

// ---------- เลือกแหล่งเดิม ----------

interface SheetPreview {
  name: string
  writable: boolean
  tabs: { sheetId: number; title: string }[]
  sheetId: number
  headerRow: number
  headers: string[]
  columns: Record<string, string>
  stats: { rows: number; withId: number; withoutId: number; invalid: number; duplicateIds: number; matchedLocal: number; newFromSheet: number; localOnly: number } | null
  problem: string | null
  issues: { where?: string; message: string }[]
}

function usePreview<T>(body: Record<string, unknown> | null) {
  const [state, setState] = useState<{ loading: boolean; data: T | null; error: string }>({ loading: true, data: null, error: '' })
  const key = JSON.stringify(body)
  useEffect(() => {
    if (!body) return
    let stopped = false
    setState((s) => ({ ...s, loading: true, error: '' }))
    api<T>('/api/setup/preview', { method: 'POST', body }).then(
      (data) => !stopped && setState({ loading: false, data, error: '' }),
      (failure: unknown) => !stopped && setState((s) => ({ loading: false, data: s.data, error: messageOf(failure, 'ตรวจแหล่งข้อมูลกับ Google ไม่สำเร็จ') })),
    )
    return () => {
      stopped = true
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key])
  return state
}

function LinkFooter({ onClose, busy, disabled, label }: { onClose(): void; busy: boolean; disabled: boolean; label: string }) {
  return (
    <>
      <button type="button" className="button" onClick={onClose} disabled={busy}>
        ยกเลิก
      </button>
      <button type="submit" form="link-form" className="button button-primary" disabled={busy || disabled}>
        {busy ? 'กำลังเชื่อม…' : label}
      </button>
    </>
  )
}

function useLink(onLinked: () => void) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const link = async (body: Record<string, unknown>) => {
    setBusy(true)
    setError('')
    try {
      await api('/api/setup/link', { method: 'POST', body })
      onLinked()
    } catch (failure) {
      setError(messageOf(failure, 'เชื่อมไม่สำเร็จ ลองอีกครั้ง'))
      setBusy(false)
    }
  }
  return { busy, error, link }
}

function SheetLinkDialog({ fileId, onClose, onLinked }: { fileId: string; onClose(): void; onLinked(): void }) {
  const [options, setOptions] = useState<{ sheetId?: number; headerRow: number; columns?: Record<string, string> }>({ headerRow: 1 })
  const [addIdColumn, setAddIdColumn] = useState(false)
  const preview = usePreview<SheetPreview>({ kind: 'sheets', resourceId: fileId, ...options })
  const { busy, error, link } = useLink(onLinked)
  const data = preview.data
  const columns = options.columns ?? data?.columns ?? {}
  const needsId = !!data && !columns.id
  const ready = !!data && !preview.loading && !!columns.name && !data.problem && (!needsId || (addIdColumn && data.writable))

  const submit = (event: FormEvent) => {
    event.preventDefault()
    if (!data || !ready) return
    void link({ kind: 'sheets', resourceId: fileId, sheetId: data.sheetId, headerRow: data.headerRow, columns, ...(needsId ? { addIdColumn: true } : {}) })
  }
  const setColumn = (field: string, header: string) => setOptions((o) => ({ ...o, columns: { ...Object.fromEntries(Object.entries(columns).filter(([f]) => f !== field)), ...(header ? { [field]: header } : {}) } }))

  return (
    <Dialog
      title="เชื่อมชีตที่มีอยู่กับทะเบียนสมาชิก"
      description={data ? `${data.name}${data.writable ? '' : ' · บัญชีชมรมอ่านได้อย่างเดียว'}` : 'กำลังตรวจไฟล์กับ Google…'}
      onRequestClose={() => !busy && onClose()}
      footer={<LinkFooter onClose={onClose} busy={busy} disabled={!ready} label="เชื่อมชีตนี้" />}
    >
      <form id="link-form" className="form" onSubmit={submit}>
        {(error || preview.error) && (
          <p className="form-alert" role="alert">
            {error || preview.error}
          </p>
        )}
        {!data && preview.loading && (
          <p role="status">
            <LoaderCircle aria-hidden="true" size={16} className="spin" /> กำลังอ่านหัวตารางจาก Google Sheets…
          </p>
        )}
        {data && (
          <>
            <div className="form-row">
              <Field label="แท็บที่เก็บรายชื่อ" htmlFor="link-tab">
                <select id="link-tab" value={data.sheetId} data-autofocus onChange={(e) => setOptions({ sheetId: Number(e.target.value), headerRow: options.headerRow })}>
                  {data.tabs.map((tab) => (
                    <option key={tab.sheetId} value={tab.sheetId}>
                      {tab.title}
                    </option>
                  ))}
                </select>
              </Field>
              <Field label="แถวหัวตาราง" htmlFor="link-header-row">
                <input id="link-header-row" type="number" min={1} max={50} value={options.headerRow} onChange={(e) => setOptions({ sheetId: data.sheetId, headerRow: Math.min(50, Math.max(1, Number(e.target.value) || 1)) })} />
              </Field>
            </div>
            <fieldset className="mapping-grid">
              <legend>จับคู่หัวคอลัมน์ในชีตกับข้อมูลสมาชิก</legend>
              {FIELDS.map((field) => (
                <div key={field} className="mapping-row">
                  <label htmlFor={`link-col-${field}`}>{FIELD_LABELS[field]}</label>
                  <select id={`link-col-${field}`} value={columns[field] ?? ''} onChange={(e) => setColumn(field, e.target.value)}>
                    <option value="">{field === 'name' ? 'เลือกคอลัมน์' : 'ไม่ใช้ (ระบบไม่อ่านและไม่เขียนคอลัมน์นี้)'}</option>
                    {data.headers.filter((h) => h).map((header) => (
                      <option key={header} value={header}>
                        {header}
                      </option>
                    ))}
                  </select>
                </div>
              ))}
            </fieldset>
            <p className="field-hint">ระบบจับคู่ด้วยข้อความหัวคอลัมน์ ไม่ใช่ตำแหน่ง จึงย้ายคอลัมน์ในชีตได้ และเขียนเฉพาะคอลัมน์ที่จับคู่ไว้ คอลัมน์อื่นและสูตรไม่ถูกแตะ</p>
            {needsId && (
              <div className="notice notice-warning">
                <TriangleAlert aria-hidden="true" size={18} />
                <div>
                  <p>ชีตนี้ยังไม่มีคอลัมน์รหัสสมาชิก ระบบต้องใช้รหัสจับคู่แถว เพราะการเรียง แทรก หรือลบแถวเปลี่ยนตำแหน่งได้</p>
                  {data.writable ? (
                    <label className="checkbox">
                      <input type="checkbox" checked={addIdColumn} onChange={(e) => setAddIdColumn(e.target.checked)} />
                      ให้ระบบเพิ่มคอลัมน์ “รหัสสมาชิก” ต่อท้ายตาราง และเติมรหัสให้ทุกแถวที่มีชื่อ (ไม่แก้คอลัมน์เดิม)
                    </label>
                  ) : (
                    <p>บัญชีชมรมแก้ไฟล์นี้ไม่ได้ ให้เจ้าของไฟล์เพิ่มสิทธิ์แก้ไข หรือเพิ่มคอลัมน์รหัสเองแล้วกลับมาจับคู่</p>
                  )}
                </div>
              </div>
            )}
            {data.problem && (
              <p className="form-alert" role="alert">
                {data.problem}
              </p>
            )}
            {data.stats && (
              <div className="preview-stats" aria-live="polite">
                <h3 className="section-label">ตรวจก่อนเชื่อม{preview.loading ? ' (กำลังตรวจใหม่…)' : ''}</h3>
                <ul className="bulleted">
                  <li>แถวข้อมูลในชีต {data.stats.rows} แถว (มีรหัสแล้ว {data.stats.withId} · ยังไม่มีรหัส {data.stats.withoutId})</li>
                  <li>ตรงกับสมาชิกในเว็บด้วยรหัสเดียวกัน {data.stats.matchedLocal} คน — จะใช้ค่าจากชีตเป็นหลัก</li>
                  <li>จะเพิ่มเข้าเว็บจากชีต {data.stats.newFromSheet} แถว</li>
                  <li>สมาชิกในเว็บที่ยังไม่อยู่ในชีต {data.stats.localOnly} คน — ยังอยู่ในเว็บและมีป้าย “เฉพาะในเว็บ” ย้ายขึ้นชีตได้หลังเชื่อม</li>
                  {data.stats.duplicateIds > 0 && <li>รหัสซ้ำ {data.stats.duplicateIds} รหัส — ระบบจะไม่นำแถวที่รหัสซ้ำมาใช้จนกว่าจะแก้ในชีต</li>}
                  {data.stats.invalid > 0 && <li>แถวที่ผิดรูปแบบ {data.stats.invalid} แถว — จะแสดงเป็นรายการที่ต้องแก้ ไม่ถูกนำเข้า</li>}
                </ul>
                {data.issues.length > 0 && (
                  <details className="sync-issues">
                    <summary>รายการที่ต้องแก้ในชีต ({data.issues.length})</summary>
                    <ul>
                      {data.issues.map((issue, index) => (
                        <li key={index}>
                          {issue.where && <strong>{issue.where}: </strong>}
                          {issue.message}
                        </li>
                      ))}
                    </ul>
                  </details>
                )}
              </div>
            )}
            {!data.writable && <p className="notice">บัญชี Google ของชมรมอ่านไฟล์นี้ได้อย่างเดียว เว็บจะแสดงข้อมูลจากชีต แต่เพิ่มหรือแก้สมาชิกจากเว็บไม่ได้</p>}
          </>
        )}
      </form>
    </Dialog>
  )
}

function FormLinkDialog({ fileId, onClose, onLinked }: { fileId: string; onClose(): void; onLinked(): void }) {
  const preview = usePreview<{ name: string; title: string; writable: boolean; isQuiz: boolean; itemCount: number; editableCount: number; readOnlyCount: number }>({ kind: 'forms', resourceId: fileId })
  const { busy, error, link } = useLink(onLinked)
  const data = preview.data
  return (
    <Dialog
      title="เชื่อมฟอร์มที่มีอยู่"
      description={data ? data.name : 'กำลังตรวจไฟล์กับ Google…'}
      onRequestClose={() => !busy && onClose()}
      footer={<LinkFooter onClose={onClose} busy={busy} disabled={!data} label="เชื่อมฟอร์มนี้" />}
    >
      <form id="link-form" className="form" onSubmit={(e) => (e.preventDefault(), data && void link({ kind: 'forms', resourceId: fileId }))}>
        {(error || preview.error) && (
          <p className="form-alert" role="alert">
            {error || preview.error}
          </p>
        )}
        {!data && preview.loading && (
          <p role="status">
            <LoaderCircle aria-hidden="true" size={16} className="spin" /> กำลังอ่านโครงสร้างฟอร์มจาก Google Forms…
          </p>
        )}
        {data && (
          <ul className="bulleted">
            <li>หัวเรื่อง: {data.title || '(ไม่มีหัวเรื่อง)'}</li>
            <li>
              มี {data.itemCount} รายการในฟอร์ม — แก้จากเว็บได้ {data.editableCount} ข้อ อ่านอย่างเดียว {data.readOnlyCount} รายการ (แก้ใน Google Forms)
            </li>
            {data.isQuiz && <li>ฟอร์มนี้เป็นแบบทดสอบ (quiz) คำถามทั้งหมดอ่านอย่างเดียวในเว็บ</li>}
            <li>เว็บจะแสดงคำถามและคำตอบที่ได้รับ คำตอบต้นฉบับอ่านอย่างเดียว</li>
            {!data.writable && <li>บัญชี Google ของชมรมอ่านฟอร์มนี้ได้อย่างเดียว จึงแก้จากเว็บไม่ได้</li>}
          </ul>
        )}
      </form>
    </Dialog>
  )
}

interface CalendarOption {
  id: string
  name: string
  accessRole: string
  primary: boolean
  writable: boolean
  selectable: boolean
}
interface CalendarPreview {
  name: string
  accessRole: string
  writable: boolean
  localEvents: number
  upcoming: number
  duplicates: { id: string; title: string; start: string }[]
}

function CalendarLinkDialog({ onClose, onLinked }: { onClose(): void; onLinked(): void }) {
  const [list, setList] = useState<{ loading: boolean; calendars: CalendarOption[]; error: string }>({ loading: true, calendars: [], error: '' })
  const [selected, setSelected] = useState('')
  const preview = usePreview<CalendarPreview>(selected ? { kind: 'calendar', resourceId: selected } : null)
  const { busy, error, link } = useLink(onLinked)
  useEffect(() => {
    api<{ calendars: CalendarOption[] }>('/api/setup/calendars').then(
      ({ calendars }) => setList({ loading: false, calendars, error: '' }),
      (failure: unknown) => setList({ loading: false, calendars: [], error: messageOf(failure, 'อ่านรายชื่อปฏิทินจาก Google ไม่สำเร็จ') }),
    )
  }, [])
  const data = selected ? preview.data : null

  return (
    <Dialog
      title="เลือกปฏิทินที่มีอยู่"
      description="รายชื่อจาก Google Calendar ของบัญชีชมรม เว็บไซต์จะติดตามเฉพาะปฏิทินที่เลือก"
      onRequestClose={() => !busy && onClose()}
      footer={<LinkFooter onClose={onClose} busy={busy} disabled={!selected || !data || preview.loading} label="เชื่อมปฏิทินนี้" />}
    >
      <form id="link-form" className="form" onSubmit={(e) => (e.preventDefault(), selected && void link({ kind: 'calendar', resourceId: selected }))}>
        {(error || list.error || (selected && preview.error)) && (
          <p className="form-alert" role="alert">
            {error || list.error || preview.error}
          </p>
        )}
        {list.loading && (
          <p role="status">
            <LoaderCircle aria-hidden="true" size={16} className="spin" /> กำลังอ่านรายชื่อปฏิทิน…
          </p>
        )}
        {!list.loading && !list.error && list.calendars.length === 0 && <p>ไม่พบปฏิทินที่บัญชีชมรมเข้าถึงได้ตามสิทธิ์ที่ให้ไว้</p>}
        {list.calendars.length > 0 && (
          <fieldset className="calendar-options">
            <legend>ปฏิทิน</legend>
            {list.calendars.map((calendar, index) => (
              <label key={calendar.id} className="checkbox calendar-option">
                <input type="radio" name="calendar" value={calendar.id} checked={selected === calendar.id} disabled={!calendar.selectable} data-autofocus={index === 0 ? true : undefined} onChange={() => setSelected(calendar.id)} />
                <span className="break-word">
                  {calendar.name}
                  {calendar.primary && ' (ปฏิทินหลักของบัญชี)'}
                  <span className="muted"> · {ACCESS_ROLE[calendar.accessRole] ?? calendar.accessRole}</span>
                </span>
              </label>
            ))}
          </fieldset>
        )}
        {selected && preview.loading && (
          <p role="status">
            <LoaderCircle aria-hidden="true" size={16} className="spin" /> กำลังตรวจปฏิทินกับ Google…
          </p>
        )}
        {data && !preview.loading && (
          <div className="preview-stats" aria-live="polite">
            <h3 className="section-label">ตรวจก่อนเชื่อม</h3>
            <ul className="bulleted">
              <li>สิทธิ์ของบัญชีชมรม: {ACCESS_ROLE[data.accessRole] ?? data.accessRole}{data.writable ? '' : ' — เว็บจะแสดงกำหนดการ แต่เพิ่มหรือแก้จากเว็บไม่ได้'}</li>
              <li>กำหนดการที่กำลังจะถึงในปฏิทินนี้ {data.upcoming} รายการ จะแสดงในหน้าปฏิทินและภาพรวม</li>
              <li>กำหนดการในเว็บตอนนี้ {data.localEvents} รายการ ยังอยู่ครบและมีป้าย “เฉพาะในเว็บ” ย้ายขึ้นปฏิทินได้หลังเชื่อม</li>
              {data.duplicates.length > 0 && <li>ในจำนวนนี้ {data.duplicates.length} รายการมีชื่อและเวลาเริ่มตรงกับรายการในปฏิทินอยู่แล้ว (จะให้เลือกตอนย้าย)</li>}
              <li>การซิงค์ไม่ส่งอีเมลเชิญและไม่แก้รายชื่อแขกหรือการแชร์ของปฏิทิน</li>
            </ul>
          </div>
        )}
      </form>
    </Dialog>
  )
}

// ---------- ย้ายข้อมูลเดิมและยกเลิกการเชื่อม ----------

function PushDialog({ kind, status, count, onClose }: { kind: 'sheets' | 'calendar'; status: SyncStatus; count: number; onClose(): void }) {
  const what = kind === 'sheets' ? 'สมาชิก' : 'กำหนดการ'
  // ตรวจกับ Google ก่อนย้าย: จำนวน และรายการที่อาจซ้ำกับของที่มีอยู่แล้วในต้นฉบับ
  const [preview, setPreview] = useState<{ loading: boolean; duplicates: { id: string; title: string; detail: string }[]; error: string }>({ loading: true, duplicates: [], error: '' })
  useEffect(() => {
    api<{ count: number; duplicates: { id: string; title: string; detail: string }[] }>(`/api/sync/${kind}/push-local`).then(
      (data) => setPreview({ loading: false, duplicates: data.duplicates, error: '' }),
      (failure: unknown) => setPreview({ loading: false, duplicates: [], error: messageOf(failure, 'ตรวจรายการที่อาจซ้ำกับ Google ไม่สำเร็จ') }),
    )
  }, [kind])
  const duplicates = preview.duplicates
  const [include, setInclude] = useState<Record<string, boolean>>({})
  const [state, setState] = useState<{ phase: 'confirm' | 'running' | 'done'; pushed: number; remaining: number; error: string }>({ phase: 'confirm', pushed: 0, remaining: count, error: '' })

  const run = async () => {
    const skipIds = duplicates.filter((d) => !include[d.id]).map((d) => d.id)
    let pushed = state.pushed
    setState((s) => ({ ...s, phase: 'running', error: '' }))
    try {
      // ทำทีละชุดเล็กจนครบ แต่ละรอบทำซ้ำได้โดยไม่เกิดรายการซ้ำ
      for (let round = 0; round < 60; round++) {
        const result = await api<{ pushed: number; remaining: number }>(`/api/sync/${kind}/push-local`, { method: 'POST', body: { skipIds } })
        pushed += result.pushed
        setState((s) => ({ ...s, pushed, remaining: result.remaining + skipIds.length }))
        if (result.remaining === 0 || result.pushed === 0) break
      }
      setState((s) => ({ ...s, phase: 'done' }))
    } catch (failure) {
      setState((s) => ({ ...s, phase: 'confirm', pushed, error: `${messageOf(failure, 'ย้ายไม่สำเร็จ')} รายการที่ย้ายไปแล้ว ${pushed} รายการยังอยู่ใน Google กดอีกครั้งเพื่อทำต่อ (ไม่เกิดรายการซ้ำ)` }))
    }
  }

  return (
    <Dialog
      title={`ย้าย${what}ในเว็บขึ้น ${kind === 'sheets' ? 'Google Sheets' : 'Google Calendar'}`}
      description={status.resource?.name}
      onRequestClose={() => state.phase !== 'running' && onClose()}
      footer={
        state.phase === 'done' ? (
          <button type="button" className="button button-primary" onClick={onClose} data-autofocus>
            เสร็จ
          </button>
        ) : (
          <>
            <button type="button" className="button" onClick={onClose} disabled={state.phase === 'running'} data-autofocus>
              ยกเลิก
            </button>
            <button type="button" className="button button-primary" onClick={run} disabled={state.phase === 'running' || preview.loading || !!preview.error}>
              {state.phase === 'running' ? `กำลังย้าย… (${state.pushed} รายการแล้ว)` : 'ย้ายขึ้น Google'}
            </button>
          </>
        )
      }
    >
      {state.error && (
        <p className="form-alert" role="alert">
          {state.error}
        </p>
      )}
      {state.phase === 'done' ? (
        <p role="status">
          ย้ายแล้ว {state.pushed} รายการ{state.remaining > 0 ? ` · ยังอยู่เฉพาะในเว็บ ${state.remaining} รายการ` : ''} ข้อมูลในเว็บอยู่ครบ และรายการที่ย้ายแล้วแก้ที่ใดก็ตามกันทั้งสองฝั่ง
        </p>
      ) : (
        <>
          <ul className="bulleted">
            <li>
              {what}ที่อยู่เฉพาะในเว็บ {count} รายการ จะถูกเพิ่มใน{kind === 'sheets' ? 'ชีตเป็นแถวใหม่ต่อท้าย พร้อมรหัสเดิม' : 'ปฏิทินเป็นรายการใหม่ ไม่ส่งอีเมลเชิญ'}
            </li>
            <li>ไม่มีอะไรถูกลบหรือเขียนทับ ทั้งในเว็บและใน Google</li>
            <li>ถ้าการย้ายหยุดกลางทาง กดย้ายอีกครั้งได้ ระบบไม่สร้างรายการซ้ำ</li>
          </ul>
          {preview.loading && (
            <p role="status">
              <LoaderCircle aria-hidden="true" size={16} className="spin" /> กำลังตรวจรายการที่อาจซ้ำกับต้นฉบับใน Google…
            </p>
          )}
          {preview.error && (
            <p className="form-alert" role="alert">
              {preview.error} จึงยังไม่ย้าย ปิดแล้วลองอีกครั้ง
            </p>
          )}
          {duplicates.length > 0 && (
            <fieldset className="calendar-options">
              <legend>
                {kind === 'sheets' ? 'ชื่อตรงกับแถวที่มีอยู่แล้วในชีต' : 'ชื่อและเวลาเริ่มตรงกับรายการที่มีอยู่แล้วในปฏิทิน'} {duplicates.length} รายการ (ไม่ติ๊ก = ไม่ย้าย คงไว้เฉพาะในเว็บ)
              </legend>
              {duplicates.map((d) => (
                <label key={d.id} className="checkbox calendar-option">
                  <input type="checkbox" checked={!!include[d.id]} onChange={(e) => setInclude((i) => ({ ...i, [d.id]: e.target.checked }))} />
                  <span className="break-word">
                    {d.title} <span className="muted">· {kind === 'sheets' ? d.detail : formatEventRange({ allDay: false, start: d.detail, end: d.detail })}</span>
                  </span>
                </label>
              ))}
            </fieldset>
          )}
        </>
      )}
    </Dialog>
  )
}

function UnlinkDialog({ kind, status, onClose, onDone }: { kind: ResourceKind; status?: SyncStatus; onClose(): void; onDone(): void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const meta = META[kind]
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await api(`/api/setup/link/${kind}`, { method: 'DELETE' })
      onDone()
    } catch (failure) {
      setError(messageOf(failure, 'ยกเลิกการเชื่อมไม่สำเร็จ ลองอีกครั้ง'))
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog title={`ยกเลิกการเชื่อม ${meta.service}?`} confirmLabel="ยกเลิกการเชื่อม" cancelLabel="ไม่ยกเลิก" tone="danger" busy={busy} onConfirm={confirm} onCancel={onClose}>
      {error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}
      <ul>
        <li>
          ต้นฉบับใน Google ({status?.resource?.name || meta.noun}) <strong>ไม่ถูกลบหรือแก้</strong>
        </li>
        {kind === 'forms' ? (
          <li>คำถามและคำตอบที่เก็บสำเนาไว้ยังอยู่ และจะแสดงอีกครั้งเมื่อเชื่อมฟอร์มเดิม</li>
        ) : (
          <li>
            {kind === 'sheets' ? 'รายชื่อสมาชิก' : 'กำหนดการ'}ที่แสดงอยู่ยังอยู่ในเว็บครบ และกลับเป็นข้อมูลของเว็บ (แก้ในเว็บได้ แต่จะไม่ส่งไป Google และไม่ตามการแก้ใน Google อีก)
          </li>
        )}
        <li>เชื่อมแหล่งเดิมหรือแหล่งใหม่ได้ภายหลังจากหน้านี้</li>
      </ul>
    </ConfirmDialog>
  )
}

interface StudentIdColumnInfo {
  mapped: string | null
  headers: string[]
  suggestion: string | null
  writable: boolean
  defaultHeader: string
}

/** จับคู่หรือเพิ่มคอลัมน์รหัสนักศึกษาให้ชีตที่เชื่อมอยู่แล้ว โดยไม่ต้องยกเลิกการเชื่อม รหัสที่กรอกไว้ในเว็บไม่หาย */
function StudentIdColumnDialog({ onClose, onDone }: { onClose(): void; onDone(header: string): void }) {
  const [info, setInfo] = useState<StudentIdColumnInfo | null>(null)
  const [loadError, setLoadError] = useState('')
  const [choice, setChoice] = useState('')
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState('')
  const ADD = '__add__'

  useEffect(() => {
    let cancelled = false
    api<StudentIdColumnInfo>('/api/setup/student-id-column').then(
      (data) => {
        if (cancelled) return
        setInfo(data)
        setChoice(data.mapped ?? data.suggestion ?? (data.writable ? ADD : ''))
      },
      (failure: unknown) => !cancelled && setLoadError(messageOf(failure, 'อ่านหัวคอลัมน์ของชีตไม่สำเร็จ ลองอีกครั้ง')),
    )
    return () => {
      cancelled = true
    }
  }, [])

  const save = async () => {
    if (!choice || saving) return
    setSaving(true)
    setError('')
    try {
      const result = await api<{ mapped: string }>('/api/setup/student-id-column', { method: 'POST', body: choice === ADD ? { add: true } : { header: choice } })
      onDone(result.mapped)
    } catch (failure) {
      setError(messageOf(failure, 'จับคู่คอลัมน์ไม่สำเร็จ ลองอีกครั้ง'))
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="คอลัมน์รหัสนักศึกษาของชีต"
      size="md"
      onRequestClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button type="button" className="button button-primary" onClick={save} disabled={!info || !choice || saving || choice === info.mapped}>
            {saving ? 'กำลังบันทึก…' : 'ใช้คอลัมน์นี้'}
          </button>
        </>
      }
    >
      <div className="form">
        {loadError ? (
          <p className="form-alert" role="alert">
            {loadError}
          </p>
        ) : !info ? (
          <p className="muted" role="status">
            กำลังอ่านหัวคอลัมน์จากชีต…
          </p>
        ) : (
          <>
            {error && (
              <p className="form-alert" role="alert">
                {error}
              </p>
            )}
            <div className="field">
              <label htmlFor="student-id-column">คอลัมน์ที่เก็บรหัสนักศึกษา</label>
              <select id="student-id-column" value={choice} onChange={(e) => setChoice(e.target.value)} data-autofocus>
                <option value="">เลือกคอลัมน์</option>
                {info.headers.map((header) => (
                  <option key={header} value={header}>
                    {header}
                  </option>
                ))}
                {info.writable && !info.headers.some((h) => h.toLowerCase() === info.defaultHeader.toLowerCase()) && (
                  <option value={ADD}>เพิ่มคอลัมน์ใหม่ชื่อ “{info.defaultHeader}” ต่อท้ายตาราง</option>
                )}
              </select>
              <p className="field-hint">แสดงเฉพาะหัวคอลัมน์ที่ยังไม่ได้จับคู่กับฟิลด์อื่น{!info.writable ? ' (เว็บมีสิทธิ์อ่านชีตนี้อย่างเดียว จึงเพิ่มคอลัมน์ให้ไม่ได้)' : ''}</p>
            </div>
            <ul className="bulleted">
              <li>รหัสนักศึกษาที่มีในคอลัมน์นี้จะถูกอ่านเข้าทะเบียน (เก็บเป็นข้อความ คงเลขศูนย์นำหน้า)</li>
              <li>รหัสที่กรอกไว้ในเว็บก่อนหน้านี้ไม่หาย: ระบบเขียนลงช่องที่ยังว่างของแถวสมาชิกคนนั้น ไม่เขียนทับค่าหรือสูตรที่มีอยู่</li>
              <li>รหัสที่ซ้ำกันหรือผิดรูปแบบจะไม่ถูกใช้ และแสดงเป็นรายการที่ต้องแก้ในแถบสถานะของ Google Sheets</li>
              <li>ไม่มีรหัสผ่านหรือข้อมูลบัญชีถูกเขียนลงชีต</li>
            </ul>
          </>
        )}
      </div>
    </Dialog>
  )
}
