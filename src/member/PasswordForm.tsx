import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { LoaderCircle } from 'lucide-react'
import { setCsrfToken } from '../api/client'
import { useAuth } from '../auth/AuthProvider'
import { PasswordField } from '../components/PasswordField'
import { AppError, messageOf } from '../data/errors'
import { MAX_PASSWORD_LENGTH, memberApi, MIN_PASSWORD_LENGTH } from './api'

type Errors = Partial<Record<'newPassword' | 'confirm', string>>

interface Props {
  submitLabel: string
  studentId: string
  onChanged(): void
}

const length = (value: string) => Array.from(value.normalize('NFC')).length

/** ตั้งรหัสส่วนตัวหลัง login ด้วยรหัสชั่วคราวสำเร็จแล้ว ไม่เก็บรหัสชั่วคราวใน browser เพื่อใช้ซ้ำ */
export function PasswordForm({ submitLabel, studentId, onChanged }: Props) {
  const { refresh } = useAuth()
  const [next, setNext] = useState('')
  const [confirm, setConfirm] = useState('')
  const [errors, setErrors] = useState<Errors>({})
  const [submitError, setSubmitError] = useState('')
  const [busy, setBusy] = useState(false)
  const form = useRef<HTMLFormElement>(null)

  const validate = (): Errors => {
    const found: Errors = {}
    if (!next) found.newPassword = 'กรอกรหัสผ่านใหม่'
    else if (length(next) < MIN_PASSWORD_LENGTH) found.newPassword = `รหัสผ่านใหม่ต้องยาวอย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร`
    else if (length(next) > MAX_PASSWORD_LENGTH) found.newPassword = `รหัสผ่านใหม่ยาวได้ไม่เกิน ${MAX_PASSWORD_LENGTH} ตัวอักษร`
    else if (next.trim().toLowerCase() === studentId.trim().toLowerCase()) found.newPassword = 'รหัสผ่านใหม่ต้องไม่ใช่รหัสนักศึกษา'
    if (!confirm) found.confirm = 'กรอกรหัสผ่านใหม่อีกครั้ง'
    else if (next && confirm !== next) found.confirm = 'รหัสผ่านใหม่สองช่องไม่ตรงกัน'
    return found
  }

  const focusFirst = (found: Errors) => {
    const order: [keyof Errors, string][] = [['newPassword', 'password-new'], ['confirm', 'password-confirm']]
    const first = order.find(([key]) => found[key])
    if (first) form.current?.querySelector<HTMLElement>(`#${first[1]}`)?.focus()
  }

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (busy) return
    const found = validate()
    setErrors(found)
    setSubmitError('')
    if (Object.keys(found).length > 0) return focusFirst(found)
    setBusy(true)
    try {
      const result = await memberApi.setupPassword(studentId, next)
      // server ออก session ใหม่ให้เบราว์เซอร์นี้แล้ว: ใช้ CSRF token ใหม่ และอ่านสถานะบัญชีล่าสุด
      setCsrfToken(result.csrfToken)
      setNext('')
      setConfirm('')
      await refresh().catch(() => undefined)
      onChanged()
    } catch (failure) {
      // ค่าที่กรอกยังอยู่ครบ แก้เฉพาะช่องที่ผิดแล้วส่งใหม่ได้
      const field = failure instanceof AppError ? failure.data.field : undefined
      if (field === 'newPassword') {
        const fieldErrors = { [field]: messageOf(failure, '') }
        setErrors(fieldErrors)
        focusFirst(fieldErrors)
      } else {
        setSubmitError(messageOf(failure, 'เปลี่ยนรหัสผ่านไม่สำเร็จ ตรวจการเชื่อมต่ออินเทอร์เน็ตแล้วลองอีกครั้ง'))
      }
    } finally {
      setBusy(false)
    }
  }

  const clear = (key: keyof Errors) => errors[key] && setErrors((e) => ({ ...e, [key]: undefined }))

  return (
    <form ref={form} onSubmit={submit} noValidate className="form">
      {submitError && (
        <p className="form-alert" role="alert">
          {submitError}
        </p>
      )}
      <PasswordField
        id="password-new"
        label="รหัสผ่านใหม่"
        value={next}
        onChange={(value) => {
          setNext(value)
          clear('newPassword')
        }}
        error={errors.newPassword}
        hint={`อย่างน้อย ${MIN_PASSWORD_LENGTH} ตัวอักษร ใช้วลีที่จำได้ง่ายแต่คนอื่นเดายาก และไม่ใช้รหัสนักศึกษา`}
        autoComplete="new-password"
      />
      <PasswordField
        id="password-confirm"
        label="รหัสผ่านใหม่อีกครั้ง"
        value={confirm}
        onChange={(value) => {
          setConfirm(value)
          clear('confirm')
        }}
        error={errors.confirm}
        autoComplete="new-password"
      />
      <div className="m-form-actions">
        <button type="submit" className="button button-danger" aria-disabled={busy}>
          {busy && <LoaderCircle aria-hidden="true" size={18} className="spin" />}
          {busy ? 'กำลังบันทึก…' : submitLabel}
        </button>
      </div>
    </form>
  )
}
