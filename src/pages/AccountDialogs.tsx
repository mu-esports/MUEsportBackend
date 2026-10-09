import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { Check, CircleCheck, Copy, Dices, KeyRound, LoaderCircle, TriangleAlert } from 'lucide-react'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { PasswordField } from '../components/PasswordField'
import { ACCOUNT_STATE_LABELS, accountsApi, generatePassword, MAX_PASSWORD_LENGTH, MIN_PASSWORD_LENGTH } from '../data/accounts'
import { AppError, messageOf } from '../data/errors'
import type { Member, MemberAccount } from '../data/types'
import { formatTimestamp } from '../lib/datetime'

const BLOCKED_TEXT: Record<NonNullable<MemberAccount['blocked']>, string> = {
  suspended: 'สมาชิกนี้ถูกพักการใช้งาน จึงเปิดบัญชีหรือตั้งรหัสผ่านไม่ได้ เปิดใช้งานสมาชิกก่อน',
  no_student_id: 'สมาชิกนี้ยังไม่มีรหัสนักศึกษา จึงเปิดบัญชีไม่ได้ กด “แก้ไข” แล้วกรอกรหัสนักศึกษาก่อน',
  student_id_conflict: 'รหัสนักศึกษาของสมาชิกนี้ในชีตซ้ำกับคนอื่นหรือผิดรูปแบบ จึงเปิดบัญชีไม่ได้ แก้ที่ชีตให้ถูกต้องและไม่ซ้ำก่อน',
}

const STATE_BADGE: Record<MemberAccount['state'], string> = { none: 'neutral', must_change: 'warning', active: 'active', disabled: 'suspended' }

export type AccountAction = 'password' | 'disable' | 'login-id' | 'delete'

/** ส่วน “บัญชีสมาชิก” ในรายละเอียดสมาชิก: สถานะตามที่ server รายงาน และปุ่มจัดการสำหรับผู้ดูแล */
export function AccountSection({ member, isAdmin, notice, onAction }: { member: Member; isAdmin: boolean; notice?: string; onAction(action: AccountAction): void }) {
  const account = member.account
  if (!account) return null
  const has = account.state !== 'none'
  return (
    <section className="account-section" aria-labelledby="account-section-title">
      <h3 id="account-section-title">
        <KeyRound aria-hidden="true" size={18} />
        บัญชีสมาชิก
      </h3>
      {notice && (
        <p className="notice notice-success" role="status">
          <CircleCheck aria-hidden="true" size={18} />
          <span>{notice}</span>
        </p>
      )}
      <dl className="detail-list">
        <div>
          <dt>สถานะบัญชี</dt>
          <dd>
            <span className={`badge badge-${STATE_BADGE[account.state]}`}>{ACCOUNT_STATE_LABELS[account.state]}</span>
          </dd>
        </div>
        <div>
          <dt>รหัสที่ใช้เข้าสู่ระบบ</dt>
          <dd className="break-word">{account.loginId ?? <span className="muted">ยังไม่มี (ใช้รหัสนักศึกษาเมื่อเปิดบัญชี)</span>}</dd>
        </div>
        {has && (
          <>
            <div>
              <dt>ตั้งรหัสผ่านล่าสุด</dt>
              <dd>{formatTimestamp(account.passwordSetAt)}</dd>
            </div>
            <div>
              <dt>เข้าสู่ระบบล่าสุด</dt>
              <dd>{account.lastLoginAt ? formatTimestamp(account.lastLoginAt) : <span className="muted">ยังไม่เคยเข้าสู่ระบบ</span>}</dd>
            </div>
          </>
        )}
      </dl>

      {account.state === 'must_change' && <p className="field-hint">สมาชิกยังใช้รหัสผ่านชั่วคราว ต้องเปลี่ยนรหัสผ่านเองเมื่อเข้าสู่ระบบ ก่อนจะใช้งานหน้าสมาชิกได้</p>}
      {account.blocked && (
        <p className="notice notice-warning">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>{BLOCKED_TEXT[account.blocked]}</span>
        </p>
      )}
      {account.loginMismatch && (
        <p className="notice notice-warning">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>
            รหัสนักศึกษาในทะเบียน ({member.studentId || 'ว่าง'}) ไม่ตรงกับรหัสที่บัญชีนี้ใช้เข้าสู่ระบบ ({account.loginId}) สมาชิกยังเข้าสู่ระบบด้วยรหัสเดิมจนกว่าผู้ดูแลจะยืนยันการเปลี่ยน
            บัญชียังเป็นของสมาชิกคนนี้เหมือนเดิม
          </span>
        </p>
      )}

      {isAdmin ? (
        <div className="button-row">
          {account.state === 'none' && (
            <button type="button" className="button button-primary" data-return-focus="account-password" onClick={() => onAction('password')} disabled={account.blocked !== null}>
              <KeyRound aria-hidden="true" size={16} />
              ตั้งรหัสผ่านและเปิดบัญชี
            </button>
          )}
          {(account.state === 'must_change' || account.state === 'active') && (
            <>
              <button type="button" className="button" data-return-focus="account-password" onClick={() => onAction('password')} disabled={account.blocked !== null}>
                <KeyRound aria-hidden="true" size={16} />
                รีเซ็ตรหัสผ่าน
              </button>
            </>
          )}
          {account.state === 'disabled' && (
            <button type="button" className="button" data-return-focus="account-password" onClick={() => onAction('password')} disabled={account.blocked !== null}>
              <KeyRound aria-hidden="true" size={16} />
              ตั้งรหัสผ่านและเปิดบัญชีอีกครั้ง
            </button>
          )}
          {account.loginMismatch && member.studentId && !member.studentIdIssue && (
            <button type="button" className="button" data-return-focus="account-login-id" onClick={() => onAction('login-id')}>
              ยืนยันใช้รหัส {member.studentId} เข้าสู่ระบบ
            </button>
          )}
        </div>
      ) : (
        <p className="field-hint">เปิดบัญชีและรีเซ็ตรหัสผ่าน ทำได้เฉพาะผู้ดูแลระบบ</p>
      )}

    </section>
  )
}

interface DialogProps {
  member: Member
  onClose(): void
  /** บันทึกสำเร็จ: ให้หน้ารายการโหลดสถานะบัญชีล่าสุด */
  onSaved(message: string): void
}

type PasswordErrors = Partial<Record<'password' | 'confirm', string>>
const length = (value: string) => Array.from(value.normalize('NFC')).length

/**
 * กล่องตั้งรหัสผ่านชั่วคราว (เปิดบัญชี รีเซ็ต หรือเปิดบัญชีอีกครั้ง)
 * ผู้ดูแลตรวจชื่อและรหัสนักศึกษาก่อนเสมอ รหัสที่ตั้งดูได้เฉพาะในกล่องนี้ หลังปิดแล้วเรียกดูอีกไม่ได้
 */
export function SetPasswordDialog({ member, onClose, onSaved }: DialogProps) {
  const account = member.account!
  const loginId = account.loginId ?? member.studentId
  const [password, setPassword] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<PasswordErrors>({})
  const [submitError, setSubmitError] = useState('')
  const [saving, setSaving] = useState(false)
  const [done, setDone] = useState(false)
  const [copied, setCopied] = useState<'ok' | 'failed' | null>(null)
  // สร้างรหัสสุ่มแล้ว: แสดงรหัสให้ผู้ดูแลอ่านและคัดลอกได้ทันที
  const [generation, setGeneration] = useState(0)
  const form = useRef<HTMLFormElement>(null)

  const title = account.state === 'none' ? 'ตั้งรหัสผ่านและเปิดบัญชี' : account.state === 'disabled' ? 'ตั้งรหัสผ่านและเปิดบัญชีอีกครั้ง' : 'รีเซ็ตรหัสผ่าน'

  const generate = () => {
    const value = generatePassword()
    setPassword(value)
    setConfirm(value)
    setErrors({})
    setCopied(null)
    setGeneration((n) => n + 1)
  }

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(password)
      setCopied('ok')
    } catch {
      setCopied('failed')
    }
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const found: PasswordErrors = {}
    if (!password) found.password = 'กรอกรหัสผ่านชั่วคราว'
    else if (length(password) < MIN_PASSWORD_LENGTH) found.password = `รหัสผ่านชั่วคราวต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`
    else if (length(password) > MAX_PASSWORD_LENGTH) found.password = `รหัสผ่านชั่วคราวยาวได้ไม่เกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`
    else if (password.trim().toLowerCase() === loginId.trim().toLowerCase()) found.password = 'รหัสผ่านชั่วคราวต้องไม่ใช่รหัสนักศึกษา'
    if (!confirm) found.confirm = 'กรอกรหัสผ่านชั่วคราวอีกครั้ง'
    else if (password && confirm !== password) found.confirm = 'รหัสผ่านสองช่องไม่ตรงกัน'
    setErrors(found)
    setSubmitError('')
    if (found.password) return form.current?.querySelector<HTMLElement>('#account-password')?.focus()
    if (found.confirm) return form.current?.querySelector<HTMLElement>('#account-password-confirm')?.focus()

    setSaving(true)
    try {
      await accountsApi.setPassword(member.id, loginId, password)
      setDone(true)
    } catch (failure) {
      // ค่าที่กรอกยังอยู่ครบ แก้แล้วกดบันทึกอีกครั้งได้
      if (failure instanceof AppError && failure.data.field === 'password') setErrors({ password: failure.message })
      else setSubmitError(`${messageOf(failure, 'ตั้งรหัสผ่านไม่สำเร็จ ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง')} ยังไม่มีการเปลี่ยนแปลงบัญชี`)
    } finally {
      setSaving(false)
    }
  }

  const identity = (
    <dl className="detail-list account-identity">
      <div>
        <dt>ชื่อ</dt>
        <dd className="break-word">
          {member.name}
          {member.nickname ? ` (${member.nickname})` : ''}
        </dd>
      </div>
      <div>
        <dt>รหัสนักศึกษา (ใช้เข้าสู่ระบบ)</dt>
        <dd className="break-word account-login-id">{loginId}</dd>
      </div>
    </dl>
  )

  if (done) {
    return (
      <Dialog
        title="ตั้งรหัสผ่านแล้ว"
        size="md"
        onRequestClose={() => onSaved(account.state === 'none' ? `เปิดบัญชีของ “${member.name}” แล้ว` : `ตั้งรหัสผ่านใหม่ของ “${member.name}” แล้ว`)}
        footer={
          <button
            type="button"
            className="button button-primary"
            data-autofocus
            onClick={() => onSaved(account.state === 'none' ? `เปิดบัญชีของ “${member.name}” แล้ว` : `ตั้งรหัสผ่านใหม่ของ “${member.name}” แล้ว`)}
          >
            เสร็จสิ้น
          </button>
        }
      >
        <div className="form">
          <p className="notice notice-success" role="status">
            <CircleCheck aria-hidden="true" size={18} />
            <span>บันทึกแล้ว สมาชิกเข้าสู่ระบบได้ด้วยรหัสนักศึกษาและรหัสผ่านชั่วคราวนี้ แล้วระบบจะให้ตั้งรหัสผ่านของตัวเองทันที</span>
          </p>
          {identity}
          <div className="account-temp">
            <p className="account-temp-label">รหัสผ่านชั่วคราว</p>
            <p className="account-temp-value break-word">{password}</p>
            <button type="button" className="button button-small" onClick={copy}>
              {copied === 'ok' ? <Check aria-hidden="true" size={16} /> : <Copy aria-hidden="true" size={16} />}
              {copied === 'ok' ? 'คัดลอกแล้ว' : 'คัดลอกรหัสผ่าน'}
            </button>
            {copied === 'failed' && <p className="field-error">คัดลอกไม่สำเร็จ เลือกข้อความแล้วคัดลอกเอง</p>}
          </div>
          <ul className="bulleted">
            <li>ส่งรหัสนี้ให้สมาชิกด้วยตัวเองทางช่องทางที่ปลอดภัย ระบบไม่ส่งข้อความหรืออีเมลให้สมาชิก</li>
            <li>หลังปิดกล่องนี้จะดูรหัสนี้อีกไม่ได้ ถ้าลืมให้รีเซ็ตรหัสผ่านใหม่</li>
            <li>อุปกรณ์ที่สมาชิกเข้าสู่ระบบค้างไว้ถูกออกจากระบบแล้ว</li>
          </ul>
        </div>
      </Dialog>
    )
  }

  return (
    <Dialog
      title={title}
      description="ตรวจว่าเป็นสมาชิกตัวจริงและรหัสนักศึกษาถูกต้องก่อนตั้งรหัส"
      onRequestClose={() => !saving && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={saving}>
            ยกเลิก
          </button>
          <button type="submit" form="account-password-form" className="button button-primary" disabled={saving}>
            {saving ? 'กำลังบันทึก…' : account.state === 'none' ? 'เปิดบัญชี' : 'ตั้งรหัสผ่านใหม่'}
          </button>
        </>
      }
    >
      <form id="account-password-form" ref={form} onSubmit={submit} noValidate className="form">
        {submitError && (
          <p className="form-alert" role="alert">
            {submitError}
          </p>
        )}
        {identity}
        <div className="account-generate">
          <button type="button" className="button" onClick={generate} data-autofocus>
            <Dices aria-hidden="true" size={18} />
            สร้างรหัสสุ่ม
          </button>
          <p className="field-hint">แนะนำให้ใช้รหัสสุ่ม: แต่ละครั้งได้รหัสไม่ซ้ำกัน ห้ามใช้รหัสนักศึกษาหรือรหัสเดียวกันกับสมาชิกคนอื่น</p>
        </div>
        <PasswordField
          key={`password-${generation}`}
          id="account-password"
          label="รหัสผ่านชั่วคราว"
          value={password}
          onChange={(value) => {
            setPassword(value)
            setCopied(null)
            if (errors.password) setErrors((e) => ({ ...e, password: undefined }))
          }}
          error={errors.password}
          hint={`อย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร สมาชิกต้องเปลี่ยนเองเมื่อเข้าสู่ระบบครั้งแรก`}
          autoComplete="new-password"
          initiallyShown={generation > 0}
        />
        <PasswordField
          key={`confirm-${generation}`}
          id="account-password-confirm"
          label="รหัสผ่านชั่วคราวอีกครั้ง"
          value={confirm}
          onChange={(value) => {
            setConfirm(value)
            if (errors.confirm) setErrors((e) => ({ ...e, confirm: undefined }))
          }}
          error={errors.confirm}
          autoComplete="new-password"
          initiallyShown={generation > 0}
        />
        {account.state !== 'none' && <p className="field-hint">การตั้งรหัสใหม่ทำให้รหัสผ่านเดิมใช้ไม่ได้ และออกจากระบบทุกอุปกรณ์ของสมาชิกคนนี้ทันที ผู้ดูแลเรียกดูรหัสผ่านเดิมไม่ได้</p>}
      </form>
    </Dialog>
  )
}

export function DisableAccountDialog({ member, onClose, onSaved }: DialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await accountsApi.disable(member.id)
      onSaved(`ปิดบัญชีของ “${member.name}” แล้ว`)
    } catch (failure) {
      setError(`${messageOf(failure, 'ปิดบัญชีไม่สำเร็จ ลองอีกครั้ง')} บัญชียังเปิดใช้งานอยู่`)
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog title={`ปิดบัญชีของ “${member.name}”?`} confirmLabel="ปิดบัญชี" tone="danger" busy={busy} onConfirm={confirm} onCancel={onClose}>
      {error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}
      <ul className="bulleted">
        <li>สมาชิกคนนี้จะเข้าสู่ระบบไม่ได้ และอุปกรณ์ที่เข้าสู่ระบบค้างไว้ถูกออกจากระบบทันที</li>
        <li>ข้อมูลในทะเบียนสมาชิกไม่ถูกลบหรือแก้ไข</li>
        <li>เปิดบัญชีอีกครั้งได้ภายหลังด้วยการตั้งรหัสผ่านใหม่</li>
      </ul>
    </ConfirmDialog>
  )
}

export function ConfirmLoginIdDialog({ member, onClose, onSaved }: DialogProps) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const confirm = async () => {
    setBusy(true)
    setError('')
    try {
      await accountsApi.confirmLoginId(member.id, member.studentId)
      onSaved(`“${member.name}” ใช้รหัส ${member.studentId} เข้าสู่ระบบแล้ว`)
    } catch (failure) {
      setError(`${messageOf(failure, 'เปลี่ยนรหัสเข้าสู่ระบบไม่สำเร็จ ลองอีกครั้ง')} รหัสเข้าสู่ระบบยังเป็นค่าเดิม`)
      setBusy(false)
    }
  }
  return (
    <ConfirmDialog title="ยืนยันเปลี่ยนรหัสที่ใช้เข้าสู่ระบบ?" confirmLabel={`ใช้รหัส ${member.studentId}`} busy={busy} onConfirm={confirm} onCancel={onClose}>
      {error && (
        <p className="form-alert" role="alert">
          {error}
        </p>
      )}
      <p>
        บัญชีของ <strong>{member.name}</strong> จะเปลี่ยนรหัสที่ใช้เข้าสู่ระบบจาก <strong>{member.account?.loginId}</strong> เป็น <strong>{member.studentId}</strong>
      </p>
      <ul className="bulleted">
        <li>บัญชียังเป็นของสมาชิกคนเดิม รหัสผ่านไม่เปลี่ยน</li>
        <li>สมาชิกต้องเข้าสู่ระบบใหม่ด้วยรหัสนักศึกษาใหม่ (อุปกรณ์ที่เข้าสู่ระบบค้างไว้ถูกออกจากระบบ)</li>
        <li>ระบบไม่แจ้งสมาชิกเอง ให้แจ้งรหัสใหม่กับสมาชิกด้วยตัวเอง</li>
      </ul>
    </ConfirmDialog>
  )
}

type DeletePhase = 'confirm' | 'deleting' | 'checking'

/**
 * กล่องยืนยันลบบัญชีเข้าสู่ระบบของสมาชิก (เฉพาะผู้ดูแล)
 * - แสดงชื่อ รหัสที่ใช้เข้าสู่ระบบ และสถานะบัญชีที่กำลังจะลบ คำสั่งลบส่งรุ่นของบัญชีที่แสดงอยู่ไปด้วย
 *   ถ้าบัญชีถูกเปลี่ยนจากที่อื่นระหว่างนั้น server ไม่ลบ กล่องนี้แสดงสถานะล่าสุดและต้องยืนยันใหม่
 * - คำสั่งที่ไม่ได้คำตอบ (เครือข่ายหลุดหรือระบบขัดข้อง): ไม่บอกว่าสำเร็จหรือไม่สำเร็จจนกว่าจะอ่านสถานะจริงจาก server ได้
 *   การตรวจสถานะเป็นการอ่านอย่างเดียว กดซ้ำได้โดยไม่ลบหรือเปลี่ยนอะไรเพิ่ม
 */
export function DeleteAccountDialog({ member, onClose, onSaved, onRefresh }: DialogProps & { onRefresh(): void }) {
  // สถานะบัญชีล่าสุดที่ผู้ดูแลเห็นและกำลังยืนยัน (อัปเดตเมื่อ server แจ้งว่าบัญชีเปลี่ยน)
  const [account, setAccount] = useState<MemberAccount>(member.account!)
  const [phase, setPhase] = useState<DeletePhase>('confirm')
  const [notice, setNotice] = useState('')
  // ยังไม่รู้ผลของคำสั่งลบครั้งก่อน: ให้ตรวจสถานะก่อน ยังไม่ให้กดลบซ้ำ
  const [unknown, setUnknown] = useState(false)
  const busy = phase !== 'confirm'

  const done = (deleted: boolean, verified = false) =>
    onSaved(
      deleted
        ? `ลบบัญชีเข้าสู่ระบบของ “${member.name}” แล้ว${verified ? ' (ยืนยันจากสถานะล่าสุดของระบบ)' : ''} ข้อมูลในทะเบียนยังอยู่`
        : `บัญชีเข้าสู่ระบบของ “${member.name}” ถูกลบไปก่อนแล้ว ไม่มีอะไรต้องทำเพิ่ม`,
    )

  /** อ่านสถานะบัญชีจริงจาก server แล้วสรุปผลจากสิ่งที่อ่านได้เท่านั้น */
  const verify = async () => {
    setPhase('checking')
    try {
      const latest = await accountsApi.status(member.id)
      onRefresh()
      if (latest.state === 'none') return done(true, true)
      setAccount(latest)
      setUnknown(false)
      setNotice('ตรวจสถานะล่าสุดแล้ว: บัญชียังอยู่ ยังไม่ได้ลบ ตรวจข้อมูลด้านล่างแล้วกด “ยืนยันลบบัญชี” อีกครั้งถ้ายังต้องการลบ')
    } catch (failure) {
      setUnknown(true)
      setNotice(`ยังยืนยันไม่ได้ว่าบัญชีถูกลบหรือไม่: ${messageOf(failure, 'เชื่อมต่อระบบกลางไม่ได้')} กด “ตรวจสถานะอีกครั้ง” เมื่อเชื่อมต่อได้ (การตรวจไม่ลบและไม่เปลี่ยนอะไร)`)
    }
    setPhase('confirm')
  }

  const confirm = async () => {
    if (busy) return
    setPhase('deleting')
    setNotice('')
    try {
      const result = await accountsApi.remove(member.id, account.revision ?? '')
      done(result.deleted)
    } catch (failure) {
      if (failure instanceof AppError && failure.code === 'account_changed') {
        // บัญชีถูกตั้งรหัสใหม่หรือเปลี่ยนสถานะจากที่อื่น: ไม่ได้ลบ แสดงสถานะล่าสุดให้ตรวจก่อนยืนยันใหม่
        const latest = failure.data.account as MemberAccount | undefined
        onRefresh()
        if (latest?.state === 'none') return done(false)
        if (latest) setAccount(latest)
        setNotice('บัญชีนี้ถูกตั้งรหัสผ่านใหม่หรือเปลี่ยนสถานะจากที่อื่นหลังจากเปิดกล่องนี้ ยังไม่ได้ลบบัญชี ด้านล่างเป็นสถานะล่าสุด ตรวจแล้วกด “ยืนยันลบบัญชี” อีกครั้งถ้ายังต้องการลบ')
        setPhase('confirm')
      } else if (failure instanceof AppError && failure.status >= 400 && failure.status < 500) {
        // server ปฏิเสธชัดเจน (เช่น ไม่มีสิทธิ์ หรือไม่พบสมาชิก): ไม่มีอะไรถูกลบ
        setNotice(`ลบบัญชีไม่สำเร็จ: ${failure.message} บัญชียังอยู่เหมือนเดิม`)
        setPhase('confirm')
      } else {
        // ไม่ได้คำตอบที่ยืนยันผล: ตรวจสถานะจริงก่อนสรุป
        await verify()
      }
    }
  }

  return (
    <Dialog
      title={`ลบบัญชีเข้าสู่ระบบของ “${member.name}”?`}
      size="sm"
      onRequestClose={() => !busy && onClose()}
      footer={
        <>
          <button type="button" className="button" onClick={onClose} disabled={busy} data-autofocus>
            ยกเลิก
          </button>
          {unknown ? (
            <button type="button" className="button button-primary" onClick={verify} disabled={busy}>
              {phase === 'checking' && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
              {phase === 'checking' ? 'กำลังตรวจสถานะ…' : 'ตรวจสถานะอีกครั้ง'}
            </button>
          ) : (
            <button type="button" className="button button-danger" onClick={confirm} disabled={busy}>
              {busy && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
              {phase === 'deleting' ? 'กำลังลบบัญชี…' : phase === 'checking' ? 'กำลังตรวจสถานะ…' : 'ยืนยันลบบัญชี'}
            </button>
          )}
        </>
      }
    >
      <div className="confirm-body">
        {notice && (
          <p className="form-alert" role="alert">
            {notice}
          </p>
        )}
        <dl className="detail-list account-identity">
          <div>
            <dt>ชื่อ</dt>
            <dd className="break-word">
              {member.name}
              {member.nickname ? ` (${member.nickname})` : ''}
            </dd>
          </div>
          <div>
            <dt>รหัสที่ใช้เข้าสู่ระบบ</dt>
            <dd className="break-word account-login-id">{account.loginId}</dd>
          </div>
          <div>
            <dt>สถานะบัญชีตอนนี้</dt>
            <dd>
              <span className={`badge badge-${STATE_BADGE[account.state]}`}>{ACCOUNT_STATE_LABELS[account.state]}</span>
            </dd>
          </div>
          <div>
            <dt>ตั้งรหัสผ่านล่าสุด</dt>
            <dd>{account.passwordSetAt ? formatTimestamp(account.passwordSetAt) : '—'}</dd>
          </div>
        </dl>
        <ul className="bulleted">
          <li>สมาชิกคนนี้จะเข้าเว็บด้วยบัญชีเดิมไม่ได้อีก และอุปกรณ์ที่เข้าสู่ระบบค้างไว้ถูกออกจากระบบทันที</li>
          <li>ข้อมูลในทะเบียนสมาชิก รูป และข้อมูลนักกีฬายังอยู่ครบ ไม่มีอะไรถูกลบใน Google Sheets</li>
          <li>ผู้ดูแลเปิดบัญชีใหม่ให้ภายหลังได้ด้วยการตั้งรหัสผ่านใหม่ (รหัสผ่านเดิมจะใช้ไม่ได้)</li>
        </ul>
      </div>
    </Dialog>
  )
}
