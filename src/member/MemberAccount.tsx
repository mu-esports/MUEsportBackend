import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { KeyRound, LoaderCircle, Pencil, Plus, Trash2, UserRound } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Avatar } from '../components/Avatar'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { StatusBadge } from '../components/ui'
import { hasCode, messageOf } from '../data/errors'
import { CONTACT_PLATFORMS } from '../lib/contacts'
import type { ContactChannel, ContactPlatform } from '../lib/contacts'
import { formatTimestamp } from '../lib/datetime'
import { memberApi } from './api'
import type { MemberSelf } from './api'
import { LogoutButton, MemberPageHeader } from './MemberLayout'

export function MemberAccountPage() {
  const { member } = useAuth(),
    [me, setMe] = useState<MemberSelf | null>(null),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0)
  const [editing, setEditing] = useState(false),
    [passwordHelp, setPasswordHelp] = useState(false)
  useEffect(() => {
    let cancelled = false
    setError('')
    memberApi.me().then(
      (m) => !cancelled && setMe(m),
      (err) => !cancelled && setError(messageOf(err, 'โหลดข้อมูลไม่สำเร็จ')),
    )
    return () => {
      cancelled = true
    }
  }, [attempt])
  return (
    <>
      <MemberPageHeader title="บัญชีของฉัน" description="ข้อมูลของคุณในทะเบียนสมาชิกของชมรม" />
      {error && (
        <div className="notice notice-error" role="alert">
          <p>{error}</p>
          <button className="button" onClick={() => setAttempt((n) => n + 1)}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      )}
      {!me && !error && (
        <p role="status">
          <LoaderCircle className="spin" size={18} />
          กำลังโหลดข้อมูล…
        </p>
      )}
      {me && (
        <div className="m-account">
          <section className="m-card">
            <div className="m-card-head">
              <h2>
                <UserRound size={20} />
                ข้อมูลของฉัน
              </h2>
            </div>
            {member && (
              <div className="m-profile-photo">
                <Avatar
                  memberId={member.id}
                  version={me.photoVersion}
                  name={me.nickname || me.name}
                  size="xl"
                  label="รูปโปรไฟล์ของคุณ"
                />
                <p className="field-hint">
                  {me.photoVersion
                    ? 'หากต้องการเปลี่ยนรูป ให้แจ้งทีมงาน'
                    : 'ยังไม่มีรูปโปรไฟล์ ทีมงานเป็นผู้เพิ่มรูปให้'}
                </p>
              </div>
            )}
            <dl className="m-profile">
              <div>
                <dt>ชื่อ</dt>
                <dd>{me.name}</dd>
              </div>
              <div>
                <dt>ชื่อเล่น</dt>
                <dd>{me.nickname || 'ไม่ได้ระบุ'}</dd>
              </div>
              <div>
                <dt>รหัสนักศึกษา</dt>
                <dd>{me.studentId}</dd>
              </div>
              <div>
                <dt>สถานะ</dt>
                <dd>
                  <StatusBadge status={me.status} />
                </dd>
              </div>
              <div className="m-profile-wide">
                <dt>อีเมล</dt>
                <dd className="break-word">{me.email || 'ยังไม่ได้ระบุ'}</dd>
              </div>
              <div className="m-profile-wide">
                <dt>ช่องทางติดต่อ</dt>
                <dd>
                  {me.contacts.length ? (
                    <ul className="profile-contacts">
                      {me.contacts.map((c) => (
                        <li key={c.platform}>
                          <strong>{CONTACT_PLATFORMS[c.platform]}</strong>
                          <span className="break-word">{c.value}</span>
                        </li>
                      ))}
                    </ul>
                  ) : (
                    <span className="muted">ยังไม่ได้ระบุ</span>
                  )}
                </dd>
              </div>
              {me.contact && (
                <div className="m-profile-wide">
                  <dt>ข้อมูลติดต่อเดิมในทะเบียน</dt>
                  <dd className="break-word">{me.contact}</dd>
                </div>
              )}
            </dl>
            <button className="button" onClick={() => setEditing(true)}>
              <Pencil size={18} />
              แก้ไขอีเมลและช่องทางติดต่อ
            </button>
            <p className="field-hint">ชื่อ ชื่อเล่น รหัสนักศึกษา และสถานะ แก้ไขโดยทีมงานของชมรม</p>
          </section>
          <section className="m-card">
            <div className="m-card-head">
              <h2>
                <KeyRound size={20} />
                เปลี่ยนรหัสผ่าน
              </h2>
            </div>
            <p className="muted">
              ติดต่อผู้ดูแลเพื่อรับรหัสผ่านชั่วคราวก่อนเปลี่ยนรหัสผ่าน
              จากนั้นเข้าสู่ระบบด้วยรหัสชั่วคราวเพื่อตั้งรหัสใหม่
            </p>
            {me.passwordChangedAt && (
              <p className="field-hint">เปลี่ยนล่าสุด {formatTimestamp(me.passwordChangedAt)}</p>
            )}
            <button className="button button-danger" onClick={() => setPasswordHelp(true)}>
              <KeyRound size={18} />
              เปลี่ยนรหัสผ่าน
            </button>
          </section>
          <section className="m-card m-card-row">
            <p className="muted">ใช้เครื่องร่วมกับผู้อื่น ออกจากระบบหลังใช้งาน</p>
            <LogoutButton />
          </section>
        </div>
      )}
      {editing && me && (
        <ProfileForm
          me={me}
          onClose={() => setEditing(false)}
          onSaved={(latest) => {
            setMe(latest)
            setEditing(false)
          }}
        />
      )}
      {passwordHelp && (
        <Dialog
          title="รับรหัสชั่วคราวจากผู้ดูแล"
          onRequestClose={() => setPasswordHelp(false)}
          size="sm"
          footer={
            <button className="button button-danger" onClick={() => setPasswordHelp(false)}>
              รับทราบ
            </button>
          }
        >
          <ol className="password-steps">
            <li>ติดต่อผู้ดูแลชมรมเพื่อขอรีเซ็ตรหัสผ่าน</li>
            <li>ผู้ดูแลออกรหัสผ่านชั่วคราวจากหน้าสมาชิก</li>
            <li>เข้าสู่ระบบใหม่ด้วยรหัสชั่วคราว แล้วตั้งรหัสผ่านของคุณ</li>
          </ol>
          <p className="notice notice-warning">
            เมื่อผู้ดูแลรีเซ็ต บัญชีนี้จะถูกออกจากระบบทุกอุปกรณ์ อย่าส่งรหัสผ่านให้บุคคลอื่น
          </p>
        </Dialog>
      )}
    </>
  )
}
function ProfileForm({ me, onClose, onSaved }: { me: MemberSelf; onClose(): void; onSaved(me: MemberSelf): void }) {
  const toast = useToast(),
    [email, setEmail] = useState(me.email),
    [contacts, setContacts] = useState<ContactChannel[]>(me.contacts),
    [platform, setPlatform] = useState<ContactPlatform>('discord')
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [discard, setDiscard] = useState(false),
    [conflict, setConflict] = useState(false)
  const dirty = email !== me.email || JSON.stringify(contacts) !== JSON.stringify(me.contacts),
    initialVersion = useRef(me.profileVersion)
  const close = () => {
    if (busy) return
    if (dirty) setDiscard(true)
    else onClose()
  }
  useEffect(() => {
    const protect = (e: BeforeUnloadEvent) => {
      if (dirty) {
        e.preventDefault()
        e.returnValue = ''
      }
    }
    window.addEventListener('beforeunload', protect)
    return () => window.removeEventListener('beforeunload', protect)
  }, [dirty])
  const available = (Object.keys(CONTACT_PLATFORMS) as ContactPlatform[]).filter(
    (p) => !contacts.some((c) => c.platform === p),
  )
  const save = async (e: FormEvent) => {
    e.preventDefault()
    if (busy || conflict) return
    setBusy(true)
    setError('')
    try {
      await memberApi.updateProfile(email, contacts, initialVersion.current)
      onSaved(await memberApi.me())
      toast.success('บันทึกข้อมูลติดต่อแล้ว')
    } catch (err) {
      setError(messageOf(err, 'บันทึกไม่สำเร็จ'))
      if (hasCode(err, 'version_conflict')) setConflict(true)
    } finally {
      setBusy(false)
    }
  }
  return (
    <>
      <Dialog title="แก้ไขอีเมลและช่องทางติดต่อ" onRequestClose={close} dismissible={!busy}>
        <form onSubmit={(e) => void save(e)} className="task-form">
          <label>
            อีเมล
            <input
              data-autofocus
              type="email"
              maxLength={254}
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              disabled={busy}
            />
          </label>
          <p className="field-hint">
            เลือกเพิ่มเฉพาะช่องทางที่ต้องการ อีเมลนี้ใช้ติดต่อคุณ และไม่เปลี่ยนรหัสเข้าสู่ระบบ
          </p>
          {contacts.map((c, i) => (
            <div className="contact-edit-row" key={c.platform}>
              <label>
                {CONTACT_PLATFORMS[c.platform]}
                <input
                  required
                  maxLength={200}
                  value={c.value}
                  disabled={busy}
                  placeholder={c.platform === 'phone' ? 'เบอร์โทรศัพท์' : 'ชื่อบัญชีหรือ URL'}
                  onChange={(e) =>
                    setContacts((list) => list.map((v, n) => (n === i ? { ...v, value: e.target.value } : v)))
                  }
                />
              </label>
              <button
                type="button"
                className="button button-danger-outline"
                disabled={busy}
                aria-label={`ลบช่องทาง ${CONTACT_PLATFORMS[c.platform]}`}
                onClick={() => setContacts((list) => list.filter((_, n) => n !== i))}
              >
                <Trash2 size={18} />
              </button>
            </div>
          ))}
          {available.length > 0 && (
            <div className="contact-edit-row">
              <label>
                เพิ่มแพลตฟอร์ม
                <select
                  disabled={busy}
                  value={available.includes(platform) ? platform : available[0]}
                  onChange={(e) => setPlatform(e.target.value as ContactPlatform)}
                >
                  {available.map((p) => (
                    <option key={p} value={p}>
                      {CONTACT_PLATFORMS[p]}
                    </option>
                  ))}
                </select>
              </label>
              <button
                type="button"
                className="button"
                disabled={busy}
                onClick={() =>
                  setContacts((list) => [
                    ...list,
                    { platform: available.includes(platform) ? platform : available[0], value: '' },
                  ])
                }
              >
                <Plus size={18} />
                เพิ่ม
              </button>
            </div>
          )}
          {error && (
            <p className="notice notice-error" role="alert">
              {error}
            </p>
          )}
          {conflict && (
            <button
              type="button"
              className="button"
              onClick={() =>
                void memberApi
                  .me()
                  .then((latest) => {
                    setEmail(latest.email)
                    setContacts(latest.contacts)
                    initialVersion.current = latest.profileVersion
                    setConflict(false)
                    setError('')
                  })
                  .catch((err) => setError(messageOf(err, 'โหลดข้อมูลล่าสุดไม่สำเร็จ')))
              }
            >
              โหลดข้อมูลล่าสุด (แทนที่สิ่งที่กรอก)
            </button>
          )}
          <div className="button-row">
            <button type="button" className="button" disabled={busy} onClick={close}>
              ยกเลิก
            </button>
            <button className="button button-primary" disabled={busy || conflict}>
              {busy ? 'กำลังบันทึก…' : 'บันทึกข้อมูลติดต่อ'}
            </button>
          </div>
        </form>
      </Dialog>
      {discard && (
        <ConfirmDialog
          title="ทิ้งการแก้ไขข้อมูลติดต่อ?"
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
