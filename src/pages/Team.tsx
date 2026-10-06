import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Navigate } from 'react-router-dom'
import { CircleCheck, CirclePause, Info, LoaderCircle, TriangleAlert, UserPlus } from 'lucide-react'
import { api } from '../api/client'
import { useAuth } from '../auth/AuthProvider'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { Field, fieldAria, PageHeader } from '../components/ui'
import { AppError, messageOf } from '../data/errors'
import { formatTimestamp } from '../lib/datetime'

type Role = 'staff' | 'admin'

interface TeamUser {
  id: string
  email: string
  name: string
  role: Role
  status: 'active' | 'revoked'
  isClubAccount: boolean
  hasSignedIn: boolean
  createdAt: string
  lastLoginAt: string | null
}

const ROLE_LABELS: Record<Role, string> = { staff: 'ทีมงาน', admin: 'ผู้ดูแลระบบ' }
const ROLE_HINTS: Record<Role, string> = {
  staff: 'ดู เพิ่ม และแก้สมาชิก กำหนดการ และเอกสาร',
  admin: 'ทำได้ทุกอย่างของทีมงาน และจัดการบัญชีทีมงานกับการเชื่อม Google',
}

type LoadState = 'loading' | 'ready' | 'error'
type Change = { user: TeamUser; patch: { role?: Role; status?: 'active' | 'revoked' } }

export function TeamPage() {
  const { isAdmin, user: me } = useAuth()
  const toast = useToast()
  const [state, setState] = useState<LoadState>('loading')
  const [error, setError] = useState('')
  const [users, setUsers] = useState<TeamUser[]>([])
  const [adding, setAdding] = useState(false)
  const [change, setChange] = useState<Change | null>(null)
  const [busy, setBusy] = useState(false)
  const [changeError, setChangeError] = useState('')
  const seq = useRef(0)

  const load = useCallback(() => {
    const current = ++seq.current
    setState('loading')
    api<{ users: TeamUser[] }>('/api/users').then(
      (result) => {
        if (current !== seq.current) return
        setUsers(result.users)
        setState('ready')
      },
      (failure: unknown) => {
        if (current !== seq.current) return
        setError(messageOf(failure, 'โหลดรายชื่อทีมงานไม่สำเร็จ'))
        setState('error')
      },
    )
  }, [])

  useEffect(() => {
    if (isAdmin) load()
  }, [isAdmin, load])

  // หน้านี้สำหรับผู้ดูแล (server ปฏิเสธคำขอของบัญชีอื่นอยู่แล้ว)
  if (!isAdmin) return <Navigate to="/" replace />

  const applyChange = async () => {
    if (!change) return
    setBusy(true)
    setChangeError('')
    try {
      const { user } = await api<{ user: TeamUser }>(`/api/users/${encodeURIComponent(change.user.id)}`, { method: 'PATCH', body: change.patch })
      setUsers((list) => list.map((u) => (u.id === user.id ? user : u)))
      setChange(null)
      toast.success(
        change.patch.status === 'revoked'
          ? `ถอนสิทธิ์ ${user.email} แล้ว`
          : change.patch.status === 'active'
            ? `คืนสิทธิ์ ${user.email} แล้ว`
            : `เปลี่ยนสิทธิ์ ${user.email} เป็น${ROLE_LABELS[user.role]}แล้ว`,
      )
    } catch (failure) {
      setChangeError(messageOf(failure, 'ทำรายการไม่สำเร็จ ลองอีกครั้ง'))
    } finally {
      setBusy(false)
    }
  }

  const closeChange = () => {
    setChange(null)
    setChangeError('')
  }

  return (
    <>
      <PageHeader
        title="ทีมงาน"
        description="บัญชีที่เข้าสู่ระบบหลังบ้านได้ แยกจากรายชื่อสมาชิกชมรม"
        action={
          <button type="button" className="button button-primary" onClick={() => setAdding(true)}>
            <UserPlus aria-hidden="true" size={18} />
            เพิ่มทีมงาน
          </button>
        }
      />

      <p className="notice notice-block">
        <Info aria-hidden="true" size={18} />
        ทีมงานเข้าสู่ระบบด้วยบัญชี Google ของตัวเองที่ใช้อีเมลตรงกับที่เพิ่มไว้ บทบาทและสถานะในหน้า “สมาชิก” ไม่มีผลกับสิทธิ์ในหน้านี้
      </p>

      {state === 'loading' && (
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดรายชื่อทีมงาน…</p>
        </div>
      )}
      {state === 'error' && (
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดรายชื่อทีมงานไม่สำเร็จ</p>
          <p className="empty-state-text">{error}</p>
          <button type="button" className="button button-primary" onClick={load}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      )}

      {state === 'ready' && (
        <section className="card" aria-label="รายชื่อทีมงาน">
          <p className="result-count" role="status">
            ทั้งหมด {users.length} บัญชี
          </p>
          <ul className="team-list">
            {users.map((u) => {
              const locked = u.isClubAccount || u.id === me?.id
              return (
                <li key={u.id} className="team-row">
                  <div className="team-main">
                    <p className="team-email">{u.email}</p>
                    <p className="team-meta">
                      {u.name && `${u.name} · `}
                      {u.hasSignedIn ? `เข้าสู่ระบบล่าสุด ${formatTimestamp(u.lastLoginAt)}` : 'ยังไม่เคยเข้าสู่ระบบ'}
                    </p>
                    {u.isClubAccount && <p className="team-meta">บัญชีชมรม เป็นผู้ดูแลหลัก เปลี่ยนหรือถอนสิทธิ์ไม่ได้</p>}
                    {!u.isClubAccount && u.id === me?.id && <p className="team-meta">บัญชีของคุณ เปลี่ยนสิทธิ์ของตัวเองไม่ได้</p>}
                  </div>
                  <div className="team-badges">
                    <span className="badge badge-neutral">{ROLE_LABELS[u.role]}</span>
                    <span className={`badge badge-${u.status === 'active' ? 'active' : 'suspended'}`}>
                      {u.status === 'active' ? <CircleCheck aria-hidden="true" size={14} /> : <CirclePause aria-hidden="true" size={14} />}
                      {u.status === 'active' ? 'มีสิทธิ์' : 'ถอนสิทธิ์แล้ว'}
                    </span>
                  </div>
                  {!locked && (
                    <div className="team-actions">
                      {u.status === 'active' ? (
                        <>
                          <button
                            type="button"
                            className="button button-small"
                            aria-label={`เปลี่ยน ${u.email} เป็น${ROLE_LABELS[u.role === 'admin' ? 'staff' : 'admin']}`}
                            onClick={() => setChange({ user: u, patch: { role: u.role === 'admin' ? 'staff' : 'admin' } })}
                          >
                            เปลี่ยนเป็น{ROLE_LABELS[u.role === 'admin' ? 'staff' : 'admin']}
                          </button>
                          <button
                            type="button"
                            className="button button-small button-danger-outline"
                            aria-label={`ถอนสิทธิ์ ${u.email}`}
                            onClick={() => setChange({ user: u, patch: { status: 'revoked' } })}
                          >
                            ถอนสิทธิ์
                          </button>
                        </>
                      ) : (
                        <button
                          type="button"
                          className="button button-small"
                          aria-label={`คืนสิทธิ์ ${u.email}`}
                          onClick={() => setChange({ user: u, patch: { status: 'active' } })}
                        >
                          คืนสิทธิ์
                        </button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        </section>
      )}

      {adding && (
        <AddUserDialog
          onClose={() => setAdding(false)}
          onAdded={(user) => {
            setAdding(false)
            setUsers((list) => [...list, user])
            toast.success(`เพิ่ม ${user.email} เป็น${ROLE_LABELS[user.role]}แล้ว`)
          }}
        />
      )}

      {change && (
        <ConfirmDialog
          title={
            change.patch.status === 'revoked'
              ? `ถอนสิทธิ์ ${change.user.email}?`
              : change.patch.status === 'active'
                ? `คืนสิทธิ์ ${change.user.email}?`
                : `เปลี่ยน ${change.user.email} เป็น${ROLE_LABELS[change.patch.role!]}?`
          }
          confirmLabel={change.patch.status === 'revoked' ? 'ถอนสิทธิ์' : change.patch.status === 'active' ? 'คืนสิทธิ์' : 'เปลี่ยนสิทธิ์'}
          tone={change.patch.status === 'revoked' ? 'danger' : 'primary'}
          busy={busy}
          onConfirm={applyChange}
          onCancel={closeChange}
        >
          {change.patch.status === 'revoked' ? (
            <ul>
              <li>บัญชีนี้จะถูกออกจากระบบทันที และเข้าสู่ระบบไม่ได้จนกว่าจะคืนสิทธิ์</li>
              <li>ข้อมูลที่บัญชีนี้เคยเพิ่มหรือแก้ไม่ถูกลบ</li>
              <li>ไม่กระทบรายชื่อในหน้า “สมาชิก” และไม่กระทบสิทธิ์ในไฟล์ Google ของบัญชีนั้น</li>
            </ul>
          ) : change.patch.status === 'active' ? (
            <p>บัญชีนี้จะเข้าสู่ระบบได้อีกครั้งด้วยสิทธิ์{ROLE_LABELS[change.user.role]}</p>
          ) : (
            <>
              <p>
                {ROLE_LABELS[change.patch.role!]}: {ROLE_HINTS[change.patch.role!]}
              </p>
              <p>บัญชีนี้จะถูกออกจากระบบ และต้องเข้าสู่ระบบใหม่เพื่อใช้สิทธิ์ใหม่</p>
            </>
          )}
          {changeError && (
            <p className="form-alert" role="alert">
              {changeError}
            </p>
          )}
        </ConfirmDialog>
      )}
    </>
  )
}

function AddUserDialog({ onClose, onAdded }: { onClose(): void; onAdded(user: TeamUser): void }) {
  const [email, setEmail] = useState('')
  const [role, setRole] = useState<Role>('staff')
  const [emailError, setEmailError] = useState('')
  const [submitError, setSubmitError] = useState('')
  const [saving, setSaving] = useState(false)
  const inputRef = useRef<HTMLInputElement>(null)

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    const value = email.trim().toLowerCase()
    const problem = !value ? 'กรอกอีเมล' : !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value) ? 'รูปแบบอีเมลไม่ถูกต้อง' : ''
    setEmailError(problem)
    if (problem) {
      inputRef.current?.focus()
      return
    }
    setSaving(true)
    setSubmitError('')
    try {
      const { user } = await api<{ user: TeamUser }>('/api/users', { method: 'POST', body: { email: value, role } })
      onAdded(user)
    } catch (failure) {
      // ข้อผิดพลาดของช่องอีเมลแสดงที่ช่อง นอกนั้นแสดงรวมด้านบน ค่าที่กรอกยังอยู่
      if (failure instanceof AppError && failure.data.field === 'email') {
        setEmailError(failure.message)
        inputRef.current?.focus()
      } else {
        setSubmitError(`${messageOf(failure, 'เพิ่มไม่สำเร็จ')} ค่าที่กรอกยังอยู่ กด “เพิ่มทีมงาน” เพื่อลองอีกครั้ง`)
      }
      setSaving(false)
    }
  }

  return (
    <Dialog
      title="เพิ่มทีมงาน"
      description="ให้สิทธิ์เข้าสู่ระบบแก่บัญชี Google ตามอีเมลที่ระบุ"
      onRequestClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={() => !saving && onClose()}>
            ยกเลิก
          </button>
          <button type="submit" form="team-form" className="button button-primary" disabled={saving}>
            {saving ? 'กำลังเพิ่ม…' : 'เพิ่มทีมงาน'}
          </button>
        </>
      }
    >
      <form id="team-form" className="form" onSubmit={submit} noValidate>
        {submitError && (
          <p className="form-alert" role="alert">
            {submitError}
          </p>
        )}
        <Field label="อีเมลบัญชี Google" htmlFor="team-email" error={emailError} hint="ต้องตรงกับอีเมลของบัญชี Google ที่คนนั้นจะใช้เข้าสู่ระบบ">
          <input
            id="team-email"
            ref={inputRef}
            type="email"
            inputMode="email"
            autoComplete="off"
            value={email}
            onChange={(e) => {
              setEmail(e.target.value)
              setEmailError('')
            }}
            data-autofocus
            aria-describedby={emailError ? undefined : 'team-email-hint'}
            {...fieldAria('team-email', emailError)}
          />
        </Field>
        <Field label="สิทธิ์" htmlFor="team-role" hint={ROLE_HINTS[role]}>
          <select id="team-role" value={role} onChange={(e) => setRole(e.target.value as Role)} aria-describedby="team-role-hint">
            <option value="staff">{ROLE_LABELS.staff}</option>
            <option value="admin">{ROLE_LABELS.admin}</option>
          </select>
        </Field>
      </form>
    </Dialog>
  )
}
