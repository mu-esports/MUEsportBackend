import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ClipboardCheck, ExternalLink, FileDown, LoaderCircle, Plus, RefreshCw, Send } from 'lucide-react'
import { Dialog, ConfirmDialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { PageHeader } from '../components/ui'
import { MemberPageHeader } from '../member/MemberLayout'
import { useStore } from '../data/store'
import { messageOf, hasCode } from '../data/errors'
import { formatDateLong, formatTimestamp, now } from '../lib/datetime'
import { tasksApi } from './api'
import { FILE_ACCEPT, MAX_FILE_BYTES, MAX_SUBMISSION_BYTES, taskAvailability } from './types'
import type { Task, TaskInput, TaskUnit } from './types'
import './tasks.css'

const dateLabel = (date: string) => `${formatDateLong(date.slice(0, 10))} ${date.slice(11)} น.`
const sizeLabel = (bytes: number) =>
  bytes < 1024 * 1024 ? `${Math.max(1, Math.ceil(bytes / 1024))} KB` : `${(bytes / 1024 / 1024).toFixed(2)} MB`
const AVAILABILITY = {
  upcoming: 'ยังไม่เริ่ม',
  open: 'ส่งได้ทันเวลา',
  late: 'เลยกำหนด · ยังส่งได้',
  archived: 'ปิดรับการส่ง',
}
function TaskBadges({ task }: { task: Task }) {
  const state = taskAvailability(task)
  return (
    <div className="task-badges">
      <span className="badge badge-neutral">{task.kind === 'group' ? 'งานกลุ่ม' : 'งานเดี่ยว'}</span>
      <span className={`badge badge-${state === 'late' ? 'warning' : state === 'open' ? 'active' : 'neutral'}`}>
        {AVAILABILITY[state]}
      </span>
    </div>
  )
}
export function StaffTasksPage() {
  return <TaskList member={false} />
}
export function MemberTasksPage() {
  return <TaskList member />
}
function TaskList({ member }: { member: boolean }) {
  const [tasks, setTasks] = useState<Task[] | null>(null),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0)
  const [selected, setSelected] = useState<Task | null>(null),
    [form, setForm] = useState<Task | 'new' | null>(null),
    [truncated, setTruncated] = useState(false)
  const [filter, setFilter] = useState('open'),
    [, tick] = useState(0)
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30000)
    return () => clearInterval(timer)
  }, [])
  useEffect(() => {
    const refresh = () => {
      if (document.visibilityState === 'visible') setAttempt((n) => n + 1)
    }
    const timer = setInterval(refresh, 60000)
    window.addEventListener('focus', refresh)
    return () => {
      clearInterval(timer)
      window.removeEventListener('focus', refresh)
    }
  }, [])
  useEffect(() => {
    let cancelled = false
    setError('')
    tasksApi.list(member).then(
      (page) => {
        if (!cancelled) {
          setTasks(page.tasks)
          setTruncated(page.truncated)
        }
      },
      (err) => !cancelled && setError(messageOf(err, 'โหลดงานไม่สำเร็จ')),
    )
    return () => {
      cancelled = true
    }
  }, [member, attempt])
  const actions = (
    <div className="button-row">
      <button className="button" onClick={() => setAttempt((n) => n + 1)}>
        <RefreshCw size={18} />
        อัปเดตงาน
      </button>
      {!member && (
        <button className="button button-primary" onClick={() => setForm('new')}>
          <Plus size={18} />
          มอบหมายงานใหม่
        </button>
      )}
    </div>
  )
  const shown = tasks?.filter((t) => filter === 'all' || t.status === filter)
  return (
    <>
      {member ? (
        <MemberPageHeader title="ส่งงาน" description="งานของคุณและงานกลุ่ม · วันและเวลาไทย" action={actions} />
      ) : (
        <PageHeader
          title="มอบหมายงาน"
          description="กำหนดงานเดี่ยวหรืองานกลุ่ม และตรวจชุดส่งงานของสมาชิก"
          action={actions}
        />
      )}
      <label className="task-filter">
        แสดงงาน
        <select value={filter} onChange={(e) => setFilter(e.target.value)}>
          <option value="open">งานที่เปิดอยู่</option>
          <option value="archived">งานที่ปิดแล้ว</option>
          <option value="all">ทุกงาน</option>
        </select>
      </label>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {!tasks && !error && (
        <p role="status">
          <LoaderCircle size={18} className="spin" />
          กำลังโหลดงาน…
        </p>
      )}
      {shown?.length === 0 && (
        <div className="empty-state">
          <ClipboardCheck size={32} />
          <h2>{member ? 'ยังไม่มีงานที่ได้รับมอบหมาย' : 'ยังไม่มีงานในหมวดนี้'}</h2>
          <p className="muted">{member ? 'งานที่ทีมงานมอบหมายจะแสดงที่นี่' : 'กดมอบหมายงานใหม่เพื่อเริ่มต้น'}</p>
        </div>
      )}
      <div className="task-grid">
        {shown?.map((t) => (
          <article className="task-card" key={t.id}>
            <TaskBadges task={t} />
            <h2>{t.title}</h2>
            <p className="muted">{t.category}</p>
            <dl className="task-dates">
              <div>
                <dt>เริ่ม</dt>
                <dd>{dateLabel(t.start)}</dd>
              </div>
              <div>
                <dt>กำหนดส่ง</dt>
                <dd>{dateLabel(t.due)}</dd>
              </div>
            </dl>
            {t.kind === 'group' && (
              <p className="task-people">{t.assignees.map((m) => m.nickname || m.name).join(' · ')}</p>
            )}
            <div className="task-card-actions">
              <span className={`badge badge-${t.submittedUnits ? 'active' : 'neutral'}`}>
                {member
                  ? t.submittedUnits
                    ? 'ส่งงานแล้ว'
                    : 'ยังไม่ได้ส่ง'
                  : `ส่งแล้ว ${t.submittedUnits}/${t.totalUnits} ชุด`}
              </span>
              <button className="button button-small" onClick={() => setSelected(t)}>
                {member ? 'ดูงาน / ส่งงาน' : 'ดูชุดส่งงาน'}
              </button>
              {!member && (
                <button className="button button-small" onClick={() => setForm(t)}>
                  แก้ไข
                </button>
              )}
            </div>
          </article>
        ))}
      </div>
      {truncated && <p className="muted">แสดงงานล่าสุด 100 งาน</p>}
      {selected && (
        <TaskDetail
          id={selected.id}
          member={member}
          onClose={() => {
            setSelected(null)
            setAttempt((n) => n + 1)
          }}
        />
      )}
      {form && (
        <TaskForm
          task={form === 'new' ? undefined : form}
          onClose={() => setForm(null)}
          onSaved={() => {
            setForm(null)
            setAttempt((n) => n + 1)
          }}
        />
      )}
    </>
  )
}
function TaskForm({ task, onClose, onSaved }: { task?: Task; onClose(): void; onSaved(): void }) {
  const { members, state } = useStore(),
    toast = useToast()
  const [baseTask, setBaseTask] = useState(task)
  const [draft, setDraft] = useState<TaskInput>(() =>
    task
      ? {
          title: task.title,
          category: task.category,
          instructions: task.instructions,
          start: task.start,
          due: task.due,
          kind: task.kind,
          status: task.status,
          assigneeIds: task.assignees.map((m) => m.id),
        }
      : {
          title: '',
          category: '',
          instructions: '',
          start: now().dateTime,
          due: `${now().date}T23:59`,
          kind: 'individual',
          status: 'open',
          assigneeIds: [],
        },
  )
  const initial = useRef(JSON.stringify(draft)),
    key = useRef(crypto.randomUUID())
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [discard, setDiscard] = useState(false)
  const [search, setSearch] = useState(''),
    [latest, setLatest] = useState<Task | null>(null)
  const locked = !!baseTask?.submittedUnits
  const change = <K extends keyof TaskInput>(field: K, value: TaskInput[K]) => {
    setDraft((d) => ({ ...d, [field]: value }))
    key.current = crypto.randomUUID()
  }
  const close = () => {
    if (busy) return
    if (JSON.stringify(draft) !== initial.current) setDiscard(true)
    else onClose()
  }
  useEffect(() => {
    const protect = (e: BeforeUnloadEvent) => {
      if (JSON.stringify(draft) !== initial.current) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [draft])
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (busy) return
    setBusy(true)
    setError('')
    try {
      await tasksApi.save(draft, baseTask, key.current)
      toast.success('บันทึกงานแล้ว')
      onSaved()
    } catch (err) {
      setError(messageOf(err, 'บันทึกงานไม่สำเร็จ'))
      if (baseTask && hasCode(err, 'version_conflict')) setLatest(await tasksApi.get(baseTask.id).catch(() => null))
    } finally {
      setBusy(false)
    }
  }
  const people = members
    .filter((m) => m.status === 'active' || draft.assigneeIds.includes(m.id))
    .filter((m) => `${m.name} ${m.nickname}`.toLowerCase().includes(search.toLowerCase()))
  return (
    <>
      <Dialog title={task ? 'แก้ไขงาน' : 'มอบหมายงานใหม่'} onRequestClose={close} dismissible={!busy}>
        <form onSubmit={(e) => void save(e)} className="task-form">
          <label>
            ชื่องาน
            <input
              data-autofocus
              disabled={busy}
              required
              maxLength={150}
              value={draft.title}
              onChange={(e) => change('title', e.target.value)}
            />
          </label>
          <label>
            ประเภทงาน
            <input
              disabled={busy}
              required
              maxLength={80}
              placeholder="เช่น ออกแบบ / เอกสาร / ประสานงาน"
              value={draft.category}
              onChange={(e) => change('category', e.target.value)}
            />
          </label>
          <label>
            รายละเอียด
            <textarea
              disabled={busy}
              rows={4}
              maxLength={5000}
              value={draft.instructions}
              onChange={(e) => change('instructions', e.target.value)}
            />
          </label>
          <div className="task-form-row">
            <label>
              วันเริ่ม · เวลาไทย
              <input
                disabled={busy}
                required
                type="datetime-local"
                name="start"
                onInput={(e) => change('start', e.currentTarget.value)}
                value={draft.start}
                onChange={(e) => change('start', e.target.value)}
              />
            </label>
            <label>
              กำหนดส่ง · เวลาไทย
              <input
                disabled={busy}
                required
                type="datetime-local"
                name="due"
                onInput={(e) => change('due', e.currentTarget.value)}
                min={draft.start}
                value={draft.due}
                onChange={(e) => change('due', e.target.value)}
              />
            </label>
          </div>
          <div className="task-form-row">
            <label>
              รูปแบบ
              <select
                disabled={locked || busy}
                value={draft.kind}
                onChange={(e) => change('kind', e.target.value as Task['kind'])}
              >
                <option value="individual">งานเดี่ยว · แต่ละคนส่งแยกกัน</option>
                <option value="group">งานกลุ่ม · ส่งร่วมกันหนึ่งชุด</option>
              </select>
            </label>
            <label>
              สถานะ
              <select
                disabled={busy}
                value={draft.status}
                onChange={(e) => change('status', e.target.value as Task['status'])}
              >
                <option value="open">เปิดรับการส่ง</option>
                <option value="archived">ปิดรับการส่ง</option>
              </select>
            </label>
          </div>
          <fieldset disabled={locked || busy}>
            <legend>สมาชิกที่รับงาน ({draft.assigneeIds.length})</legend>
            <label>
              ค้นหาสมาชิก
              <input type="search" value={search} onChange={(e) => setSearch(e.target.value)} />
            </label>
            <div className="task-assignees">
              {people.map((m) => (
                <label className="task-check" key={m.id}>
                  <input
                    type="checkbox"
                    checked={draft.assigneeIds.includes(m.id)}
                    onChange={(e) =>
                      change(
                        'assigneeIds',
                        e.target.checked ? [...draft.assigneeIds, m.id] : draft.assigneeIds.filter((id) => id !== m.id),
                      )
                    }
                  />
                  <span>
                    {m.name} {m.nickname && `(${m.nickname})`}
                  </span>
                </label>
              ))}
            </div>
          </fieldset>
          <p className="field-hint">
            {locked
              ? 'มีการส่งแล้ว จึงเปลี่ยนรูปแบบและผู้รับงานไม่ได้'
              : 'เลือกสมาชิก 1–50 คน · งานกลุ่มใช้ผลส่งชุดเดียวกัน'}{' '}
            · เลยกำหนดยังส่งได้พร้อมป้ายส่งล่าช้า
          </p>
          {error && (
            <p role="alert" className="notice notice-error">
              {error}
            </p>
          )}
          {latest && (
            <button
              type="button"
              className="button"
              disabled={busy}
              onClick={() => {
                const next = {
                  title: latest.title,
                  category: latest.category,
                  instructions: latest.instructions,
                  start: latest.start,
                  due: latest.due,
                  kind: latest.kind,
                  status: latest.status,
                  assigneeIds: latest.assignees.map((m) => m.id),
                }
                setDraft(next)
                initial.current = JSON.stringify(next)
                setBaseTask(latest)
                setLatest(null)
                setError('')
                key.current = crypto.randomUUID()
              }}
            >
              โหลดงานล่าสุด (แทนที่สิ่งที่กรอก)
            </button>
          )}
          <div className="button-row">
            <button type="button" className="button" disabled={busy} onClick={close}>
              ยกเลิก
            </button>
            <button className="button button-primary" disabled={busy || state !== 'ready' || !draft.assigneeIds.length}>
              {busy ? 'กำลังบันทึก…' : 'บันทึกงาน'}
            </button>
          </div>
        </form>
      </Dialog>
      {discard && (
        <ConfirmDialog
          title="ทิ้งการแก้ไขงาน?"
          confirmLabel="ทิ้งการแก้ไข"
          onConfirm={onClose}
          onCancel={() => setDiscard(false)}
        >
          สิ่งที่กรอกยังไม่ได้บันทึก
        </ConfirmDialog>
      )}
    </>
  )
}
function SubmissionView({ unit, task }: { unit: TaskUnit; task: Task }) {
  const submission = unit.submission,
    person = task.assignees.find((m) => m.id === unit.unitKey)
  return (
    <section className="task-submission">
      <h3>{unit.unitKey === 'group' ? 'ชุดส่งงานของกลุ่ม' : person?.name || 'ชุดส่งงานของคุณ'}</h3>
      {!submission ? (
        <p className="muted">ยังไม่ได้ส่งงาน</p>
      ) : (
        <>
          <div className="task-badges">
            <span className={`badge badge-${submission.late ? 'warning' : 'active'}`}>
              {submission.late ? 'ส่งล่าช้า' : 'ส่งทันเวลา'}
            </span>
            <span className="muted">
              ส่งโดย {submission.submittedBy} · {formatTimestamp(submission.submittedAt)}
            </span>
          </div>
          {submission.note && <p className="task-instructions">{submission.note}</p>}
          {submission.mode === 'link' ? (
            <a className="task-file-link" href={submission.linkUrl} target="_blank" rel="noopener noreferrer">
              <ExternalLink size={18} />
              เปิดลิงก์งาน<span className="muted break-word">{submission.linkUrl}</span>
            </a>
          ) : (
            submission.files.map((f) => (
              <a key={f.id} className="task-file-link" href={`/api/task-files/${f.id}`} download={f.name}>
                <FileDown size={18} />
                <span>{f.name}</span>
                <span className="muted">{sizeLabel(f.size)}</span>
              </a>
            ))
          )}
        </>
      )}
    </section>
  )
}
function TaskDetail({ id, member, onClose }: { id: string; member: boolean; onClose(): void }) {
  const [task, setTask] = useState<Task | null>(null),
    [error, setError] = useState(''),
    [loading, setLoading] = useState(false),
    [dirty, setDirty] = useState(false),
    [busy, setBusy] = useState(false),
    [discard, setDiscard] = useState(false)
  const [attempt, setAttempt] = useState(0),
    [sent, setSent] = useState(0)
  useEffect(() => {
    let cancelled = false
    setLoading(true)
    tasksApi
      .get(id, member)
      .then(
        (t) => {
          if (!cancelled) {
            setTask(t)
            setError('')
          }
        },
        (err) => !cancelled && setError(messageOf(err, 'โหลดงานไม่สำเร็จ')),
      )
      .finally(() => !cancelled && setLoading(false))
    return () => {
      cancelled = true
    }
  }, [id, member, attempt])
  const close = () => {
    if (busy) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  return (
    <>
      <Dialog title={task?.title || 'รายละเอียดงาน'} onRequestClose={close} dismissible={!busy}>
        {error && (
          <p role="alert" className="notice notice-error">
            {error}
          </p>
        )}
        {loading && <p role="status">กำลังโหลดข้อมูลล่าสุด…</p>}
        {task && (
          <div className="task-detail">
            <TaskBadges task={task} />
            <p className="muted">{task.category}</p>
            <dl className="task-dates">
              <div>
                <dt>เริ่ม</dt>
                <dd>{dateLabel(task.start)}</dd>
              </div>
              <div>
                <dt>กำหนดส่ง</dt>
                <dd>{dateLabel(task.due)}</dd>
              </div>
            </dl>
            <p className="task-instructions">{task.instructions || 'ไม่มีรายละเอียดเพิ่มเติม'}</p>
            <section>
              <h3>{task.kind === 'group' ? 'สมาชิกในกลุ่ม' : 'สมาชิกที่รับงาน'}</h3>
              <p className="task-people">
                {task.assignees.map((p) => `${p.name}${p.nickname ? ` (${p.nickname})` : ''}`).join(' · ')}
              </p>
            </section>
            {task.units.map((unit) => (
              <SubmissionView unit={unit} task={task} key={unit.id} />
            ))}
            {member && task.units.length === 1 && (
              <SubmitForm
                key={`${task.id}:${sent}`}
                task={task}
                onDirty={setDirty}
                onBusy={setBusy}
                onSubmitted={() => {
                  setDirty(false)
                  setTask(null)
                  setSent((n) => n + 1)
                  setAttempt((n) => n + 1)
                }}
                onRefresh={() => setAttempt((n) => n + 1)}
                loading={loading}
              />
            )}
          </div>
        )}
        {!task && !loading && (
          <button className="button" onClick={() => setAttempt((n) => n + 1)}>
            ลองโหลดอีกครั้ง
          </button>
        )}
      </Dialog>
      {discard && (
        <ConfirmDialog
          title="ทิ้งร่างส่งงาน?"
          confirmLabel="ทิ้งร่าง"
          onConfirm={onClose}
          onCancel={() => setDiscard(false)}
        >
          ไฟล์หรือลิงก์ที่เลือกยังไม่ได้ส่ง
        </ConfirmDialog>
      )}
    </>
  )
}
function SubmitForm({
  task,
  onDirty,
  onBusy,
  onSubmitted,
  onRefresh,
  loading,
}: {
  task: Task
  onDirty(value: boolean): void
  onBusy(value: boolean): void
  onSubmitted(): void
  onRefresh(): void
  loading: boolean
}) {
  const toast = useToast(),
    [mode, setMode] = useState<'link' | 'file'>('file'),
    [link, setLink] = useState(''),
    [note, setNote] = useState(''),
    [files, setFiles] = useState<File[]>([]),
    [error, setError] = useState(''),
    [busy, setBusy] = useState(false),
    [stale, setStale] = useState(false)
  const key = useRef(crypto.randomUUID()),
    baseline = useRef(task.units[0].version),
    [, tick] = useState(0)
  const change = () => {
    key.current = crypto.randomUUID()
    onDirty(true)
  }
  useEffect(() => {
    const timer = setInterval(() => tick((n) => n + 1), 30000)
    return () => clearInterval(timer)
  }, [])
  const available = taskAvailability(task),
    disabled = available === 'upcoming' || available === 'archived' || busy || loading || stale
  useEffect(() => {
    const protect = (e: BeforeUnloadEvent) => {
      if (note || link || files.length) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [note, link, files])
  const submit = async (e: FormEvent) => {
    e.preventDefault()
    if (disabled) return
    setError('')
    if (
      mode === 'file' &&
      (!files.length ||
        files.length > 3 ||
        files.some((f) => !f.size || f.size > MAX_FILE_BYTES) ||
        files.reduce((n, f) => n + f.size, 0) > MAX_SUBMISSION_BYTES)
    ) {
      setError('เลือก 1–3 ไฟล์ แต่ละไฟล์ไม่เกิน 10 MB รวมไม่เกิน 20 MB')
      return
    }
    setBusy(true)
    onBusy(true)
    try {
      await tasksApi.submit({ ...task, units: [{ ...task.units[0], version: baseline.current }] }, key.current, {
        mode,
        linkUrl: link,
        note,
        files,
      })
      toast.success('ส่งงานแล้ว')
      onSubmitted()
    } catch (err) {
      setError(messageOf(err, 'ยังยืนยันผลส่งงานไม่ได้ กดส่งอีกครั้งด้วยข้อมูลเดิมได้'))
      if (hasCode(err, 'version_conflict')) {
        setStale(true)
        onRefresh()
      }
    } finally {
      setBusy(false)
      onBusy(false)
    }
  }
  if (available === 'upcoming' || available === 'archived') return <p className="notice">{AVAILABILITY[available]}</p>
  return (
    <form className="task-form task-submit" onSubmit={(e) => void submit(e)}>
      <h3>
        <Send size={18} /> {task.units[0].submission ? 'ส่งชุดใหม่' : 'ส่งงาน'}
      </h3>
      {task.kind === 'group' && (
        <p className="field-hint">สมาชิกในกลุ่มทุกคนเห็นชุดส่งเดียวกัน การส่งใหม่จะเปลี่ยนชุดล่าสุดของกลุ่ม</p>
      )}
      <fieldset disabled={busy}>
        <legend>รูปแบบการส่ง</legend>
        <div className="button-row">
          <label className="task-check">
            <input
              type="radio"
              name="submission-mode"
              checked={mode === 'file'}
              onChange={() => {
                setMode('file')
                change()
              }}
            />
            ไฟล์
          </label>
          <label className="task-check">
            <input
              type="radio"
              name="submission-mode"
              checked={mode === 'link'}
              onChange={() => {
                setMode('link')
                change()
              }}
            />
            ลิงก์
          </label>
        </div>
      </fieldset>
      {mode === 'file' ? (
        <label>
          เลือกไฟล์
          <input
            type="file"
            accept={FILE_ACCEPT}
            multiple
            disabled={busy}
            onChange={(e) => {
              setFiles(Array.from(e.target.files || []))
              change()
            }}
          />
          <span className="field-hint">
            รูปภาพ PNG/JPG, PDF, Word, Excel, PowerPoint, TXT, CSV, ZIP · สูงสุด 3 ไฟล์ ไฟล์ละ 10 MB รวม 20 MB
          </span>
          {files.map((f, i) => (
            <span className="task-selected-file" key={i}>
              {f.name} ({sizeLabel(f.size)})
            </span>
          ))}
        </label>
      ) : (
        <label>
          ลิงก์งาน
          <input
            required
            type="url"
            placeholder="https://…"
            maxLength={2048}
            disabled={busy}
            value={link}
            onChange={(e) => {
              setLink(e.target.value)
              change()
            }}
          />
        </label>
      )}
      <label>
        หมายเหตุ (ไม่บังคับ)
        <textarea
          rows={2}
          maxLength={2000}
          disabled={busy}
          value={note}
          onChange={(e) => {
            setNote(e.target.value)
            change()
          }}
        />
      </label>
      {error && (
        <p className="notice notice-error" role="alert">
          {error}
        </p>
      )}
      {stale && (
        <button
          type="button"
          className="button"
          disabled={loading}
          onClick={() => {
            baseline.current = task.units[0].version
            setStale(false)
            key.current = crypto.randomUUID()
          }}
        >
          ตรวจชุดล่าสุดแล้ว ใช้รุ่นนี้เพื่อส่งใหม่
        </button>
      )}
      <button className={`button ${available === 'late' ? 'button-danger' : 'button-primary'}`} disabled={disabled}>
        <Send size={18} />
        {busy ? 'กำลังส่ง…' : available === 'late' ? 'ส่งงานล่าช้า' : 'ส่งงาน'}
      </button>
    </form>
  )
}
