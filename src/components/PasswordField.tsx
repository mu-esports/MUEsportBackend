import { useState } from 'react'
import type { Ref } from 'react'
import { Eye, EyeOff } from 'lucide-react'
import { Field } from './ui'

interface Props {
  id: string
  label: string
  value: string
  onChange(value: string): void
  error?: string
  hint?: string
  autoComplete: 'current-password' | 'new-password' | 'off'
  inputRef?: Ref<HTMLInputElement>
  autoFocus?: boolean
  /** เริ่มต้นแบบแสดงรหัส (ใช้กับรหัสชั่วคราวที่ผู้ดูแลต้องอ่านเพื่อส่งต่อ) */
  initiallyShown?: boolean
}

/** ช่องรหัสผ่านพร้อมปุ่มแสดง/ซ่อน ปุ่มบอกสถานะด้วยข้อความสำหรับโปรแกรมอ่านหน้าจอ ไม่พึ่งไอคอนอย่างเดียว */
export function PasswordField({ id, label, value, onChange, error, hint, autoComplete, inputRef, autoFocus, initiallyShown = false }: Props) {
  const [shown, setShown] = useState(initiallyShown)
  const describedBy = error ? `${id}-error` : hint ? `${id}-hint` : undefined
  return (
    <Field label={label} htmlFor={id} error={error} hint={hint}>
      <div className="password-input">
        <input
          id={id}
          ref={inputRef}
          type={shown ? 'text' : 'password'}
          value={value}
          onChange={(e) => onChange(e.target.value)}
          autoComplete={autoComplete}
          autoCapitalize="none"
          autoCorrect="off"
          spellCheck={false}
          aria-invalid={error ? true : undefined}
          aria-describedby={describedBy}
          {...(autoFocus ? { 'data-autofocus': true } : {})}
        />
        <button type="button" className="password-toggle" aria-pressed={shown} aria-label={shown ? `ซ่อน${label}` : `แสดง${label}`} onClick={() => setShown((v) => !v)}>
          {shown ? <EyeOff aria-hidden="true" size={20} /> : <Eye aria-hidden="true" size={20} />}
        </button>
      </div>
    </Field>
  )
}
