import { useEffect, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { CircleCheck, CirclePause, KeyRound, LoaderCircle, Pencil, TriangleAlert, UserRound } from 'lucide-react'
import { useToast } from '../components/Toast'
import { Field, fieldAria } from '../components/ui'
import { hasCode, messageOf } from '../data/errors'
import { formatTimestamp } from '../lib/datetime'
import { memberApi } from './api'
import type { MemberSelf } from './api'
import { LogoutButton, MemberPageHeader } from './MemberLayout'
import { PasswordForm } from './PasswordForm'

/** บัญชีของฉัน: ข้อมูลของตัวเองเท่านั้น แก้ได้เฉพาะช่องทางติดต่อและรหัสผ่าน ชื่อ รหัสนักศึกษา และสถานะแก้โดยทีมงาน */
export function MemberAccountPage() {
  const toast = useToast()
  const [me, setMe] = useState<MemberSelf | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  const [editing, setEditing] = useState(false)
  const [contact, setContact] = useState('')
  const [contactError, setContactError] = useState('')
  const [saving, setSaving] = useState(false)
  const editButton = useRef<HTMLButtonElement>(null)
  const contactInput = useRef<HTMLInputElement>(null)

  useEffect(() => {
    let cancelled = false
    setMe(null)
    setError('')
    memberApi.me().then(
      (data) => !cancelled && setMe(data),
      (failure: unknown) => !cancelled && setError(messageOf(failure, 'โหลดข้อมูลของคุณไม่สำเร็จ ลองอีกครั้ง')),
    )
    return () => {
      cancelled = true
    }
  }, [attempt])

  useEffect(() => {
    if (editing) contactInput.current?.focus()
  }, [editing])

  const startEdit = () => {
    if (!me) return
    setContact(me.contact)
    setContactError('')
    setEditing(true)
  }
  const stopEdit = () => {
    setEditing(false)
    // คืน focus ไปที่ปุ่มแก้ไขหลังปิดฟอร์ม
    requestAnimationFrame(() => editButton.current?.focus())
  }

  const saveContact = async (event: FormEvent) => {
    event.preventDefault()
    if (!me || saving) return
    const value = contact.trim()
    if (value.length > 200) return setContactError('ช่องทางติดต่อยาวได้ไม่เกิน 200 ตัวอักษร')
    setSaving(true)
    setContactError('')
    try {
      setMe(await memberApi.updateContact(value, me.version))
      toast.success('บันทึกช่องทางติดต่อแล้ว')
      stopEdit()
    } catch (failure) {
      if (hasCode(failure, 'version_conflict')) {
        // ข้อมูลถูกแก้จากที่อื่น: ดึงค่าล่าสุดมาแสดง แต่สิ่งที่พิมพ์ไว้ยังอยู่ในช่อง ให้ตรวจแล้วกดบันทึกอีกครั้ง
        const latest = await memberApi.me().catch(() => null)
        if (latest) setMe(latest)
        setContactError(`${messageOf(failure, '')} ${latest ? `(ค่าล่าสุดในระบบ: ${latest.contact || 'ว่าง'})` : ''}`.trim())
      } else {
        setContactError(messageOf(failure, 'บันทึกไม่สำเร็จ สิ่งที่พิมพ์ไว้ยังอยู่ในช่องนี้ ลองอีกครั้ง'))
      }
    } finally {
      setSaving(false)
    }
  }

  if (error) {
    return (
      <>
        <MemberPageHeader title="บัญชีของฉัน" />
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดข้อมูลไม่สำเร็จ</p>
          <p className="empty-state-text">{error}</p>
          <button type="button" className="button button-primary" onClick={() => setAttempt((n) => n + 1)}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      </>
    )
  }

  if (!me) {
    return (
      <>
        <MemberPageHeader title="บัญชีของฉัน" />
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดข้อมูลของคุณ…</p>
        </div>
      </>
    )
  }

  const StatusIcon = me.status === 'active' ? CircleCheck : CirclePause
  const loginDiffers = me.loginId !== null && me.loginId.toLowerCase() !== me.studentId.toLowerCase()

  return (
    <>
      <MemberPageHeader title="บัญชีของฉัน" description="ข้อมูลของคุณในทะเบียนสมาชิกของชมรม" />

      <div className="m-account">
        <section className="m-card" aria-labelledby="account-profile">
          <div className="m-card-head">
            <h2 id="account-profile">
              <UserRound aria-hidden="true" size={20} />
              ข้อมูลของฉัน
            </h2>
          </div>
          <dl className="m-profile">
            <div>
              <dt>ชื่อ</dt>
              <dd className="break-word">{me.name}</dd>
            </div>
            <div>
              <dt>ชื่อเล่น</dt>
              <dd className="break-word">{me.nickname || <span className="muted">ไม่ได้ระบุ</span>}</dd>
            </div>
            <div>
              <dt>รหัสนักศึกษา</dt>
              <dd className="break-word">
                {me.studentId || <span className="muted">ไม่ได้ระบุ</span>}
                {loginDiffers && <span className="m-profile-note">ตอนนี้ยังเข้าสู่ระบบด้วยรหัส {me.loginId} จนกว่าทีมงานจะยืนยันการเปลี่ยน</span>}
              </dd>
            </div>
            <div>
              <dt>สถานะ</dt>
              <dd>
                <span className={`badge badge-${me.status}`}>
                  <StatusIcon aria-hidden="true" size={14} />
                  {me.status === 'active' ? 'ใช้งาน' : 'พักการใช้งาน'}
                </span>
              </dd>
            </div>
            <div className="m-profile-wide">
              <dt>ช่องทางติดต่อ</dt>
              <dd>
                {editing ? (
                  <form onSubmit={saveContact} noValidate className="m-contact-form">
                    <Field label="ช่องทางติดต่อ" htmlFor="self-contact" optional error={contactError} hint="เช่น ชื่อ Discord, LINE หรืออีเมล ทีมงานของชมรมเห็นข้อมูลนี้">
                      <input
                        id="self-contact"
                        ref={contactInput}
                        type="text"
                        value={contact}
                        maxLength={200}
                        onChange={(e) => {
                          setContact(e.target.value)
                          setContactError('')
                        }}
                        autoComplete="off"
                        aria-describedby={contactError ? 'self-contact-error' : 'self-contact-hint'}
                        {...(contactError ? fieldAria('self-contact', contactError) : {})}
                      />
                    </Field>
                    <div className="m-form-actions">
                      <button type="button" className="button" onClick={stopEdit} disabled={saving}>
                        ยกเลิก
                      </button>
                      <button type="submit" className="button button-primary" aria-disabled={saving}>
                        {saving ? 'กำลังบันทึก…' : 'บันทึก'}
                      </button>
                    </div>
                  </form>
                ) : (
                  <div className="m-contact">
                    <span className="break-word">{me.contact || <span className="muted">ยังไม่ได้ระบุ</span>}</span>
                    {me.contactEditable ? (
                      <button type="button" className="button button-small" onClick={startEdit} ref={editButton}>
                        <Pencil aria-hidden="true" size={16} />
                        แก้ไขช่องทางติดต่อ
                      </button>
                    ) : (
                      <span className="m-profile-note">ตอนนี้แก้จากหน้านี้ไม่ได้ ติดต่อทีมงานให้แก้ให้</span>
                    )}
                  </div>
                )}
              </dd>
            </div>
          </dl>
          <p className="field-hint">ชื่อ ชื่อเล่น รหัสนักศึกษา และสถานะ แก้ได้โดยทีมงานของชมรม ถ้าข้อมูลไม่ถูกต้องให้แจ้งทีมงาน</p>
        </section>

        <section className="m-card" aria-labelledby="account-password">
          <div className="m-card-head">
            <h2 id="account-password">
              <KeyRound aria-hidden="true" size={20} />
              เปลี่ยนรหัสผ่าน
            </h2>
          </div>
          <p className="muted">
            {me.passwordChangedAt ? `เปลี่ยนรหัสผ่านล่าสุดเมื่อ ${formatTimestamp(me.passwordChangedAt)}` : 'เปลี่ยนรหัสผ่านได้ทุกเมื่อ'} หลังเปลี่ยน
            อุปกรณ์อื่นที่เข้าสู่ระบบด้วยบัญชีนี้จะถูกออกจากระบบ
          </p>
          <PasswordForm currentLabel="รหัสผ่านปัจจุบัน" submitLabel="เปลี่ยนรหัสผ่าน" studentId={me.loginId ?? me.studentId} onChanged={() => toast.success('เปลี่ยนรหัสผ่านแล้ว')} />
          <p className="field-hint">ลืมรหัสผ่าน? ติดต่อทีมงานของชมรมเพื่อตั้งรหัสผ่านใหม่</p>
        </section>

        <section className="m-card m-card-row" aria-label="ออกจากระบบ">
          <p className="muted">ใช้เครื่องร่วมกับคนอื่น ออกจากระบบทุกครั้งหลังใช้งาน</p>
          <LogoutButton />
        </section>
      </div>
    </>
  )
}
