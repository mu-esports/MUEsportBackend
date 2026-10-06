import { useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Field, fieldAria } from '../components/ui'
import { createKeyTracker } from '../api/client'
import { hasCode, messageOf } from '../data/errors'
import { useStore } from '../data/store'
import { ROLE_LABELS, ROLES, STATUS_LABELS, STATUSES } from '../data/types'
import type { Member, MemberInput } from '../data/types'
import { SuspendConfirm } from './SuspendConfirm'

type Errors = Partial<Record<'name' | 'nickname', string>>

const BLANK: MemberInput = { name: '', nickname: '', role: 'member', status: 'active', contact: '', note: '' }

function validate(v: MemberInput): Errors {
  const errors: Errors = {}
  if (!v.name.trim()) errors.name = 'กรอกชื่อสมาชิก'
  else if (v.name.trim().length > 100) errors.name = 'ชื่อยาวได้ไม่เกิน 100 ตัวอักษร'
  if (!v.nickname.trim()) errors.nickname = 'กรอกชื่อเล่น'
  else if (v.nickname.trim().length > 40) errors.nickname = 'ชื่อเล่นยาวได้ไม่เกิน 40 ตัวอักษร'
  return errors
}

const toInput = (m: Member): MemberInput => ({
  name: m.name, nickname: m.nickname, role: m.role, status: m.status, contact: m.contact, note: m.note,
})

interface Props {
  member?: Member
  onClose(): void
  onSaved(message: string): void
}

export function MemberForm({ member, onClose, onSaved }: Props) {
  const { addMember, updateMember, refresh } = useStore()
  // รุ่นของข้อมูลที่ฟอร์มนี้เริ่มแก้ คงไว้แม้รายการด้านหลังจะถูกโหลดใหม่ เพื่อให้ server ตรวจได้ว่ามีคนแก้ไปก่อนหรือไม่
  const [base, setBase] = useState(member)
  const [initial, setInitial] = useState<MemberInput>(() => (member ? toInput(member) : BLANK))
  const [values, setValues] = useState(initial)
  const [conflict, setConflict] = useState<Member | null>(null)
  const createKey = useRef(createKeyTracker()).current
  const [errors, setErrors] = useState<Errors>({})
  const [submitError, setSubmitError] = useState('')
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  // ค่าที่ผ่าน validation แล้วและรอยืนยันพักการใช้งาน ยังไม่ถูกบันทึกจนกว่าจะยืนยัน
  const [pendingSuspend, setPendingSuspend] = useState<MemberInput | null>(null)
  const formRef = useRef<HTMLFormElement>(null)

  const dirty = JSON.stringify(values) !== JSON.stringify(initial)
  const set = <K extends keyof MemberInput>(key: K, value: MemberInput[K]) => {
    setValues((v) => ({ ...v, [key]: value }))
    if (key in errors) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  const submit = async (e: FormEvent) => {
    e.preventDefault()
    const found = validate(values)
    setErrors(found)
    const firstInvalid = (['name', 'nickname'] as const).find((k) => found[k])
    if (firstInvalid) {
      formRef.current?.querySelector<HTMLElement>(`#member-${firstInvalid}`)?.focus()
      return
    }
    const input: MemberInput = {
      ...values,
      name: values.name.trim(),
      nickname: values.nickname.trim(),
      contact: values.contact.trim(),
      note: values.note.trim(),
    }
    // เปลี่ยนสมาชิกที่ใช้งานอยู่เป็นพักการใช้งาน: อธิบายผลและขอยืนยันก่อนบันทึก
    if (base?.status === 'active' && input.status === 'suspended') {
      setSubmitError('')
      setPendingSuspend(input)
      return
    }
    await save(input)
  }

  const save = async (input: MemberInput) => {
    const suspending = base?.status === 'active' && input.status === 'suspended'
    setSaving(true)
    setSubmitError('')
    setConflict(null)
    try {
      if (base) await updateMember(base.id, input, base.version)
      else await addMember(input, createKey(input))
      onSaved(
        !member
          ? `เพิ่มสมาชิก “${input.name}” แล้ว`
          : suspending
            ? `บันทึกการแก้ไขและพักการใช้งาน “${input.name}” แล้ว`
            : `บันทึกการแก้ไข “${input.name}” แล้ว`,
      )
    } catch (error) {
      setPendingSuspend(null)
      if (hasCode(error, 'version_conflict')) {
        setConflict((error as { data: { current: Member } }).data.current)
        setSubmitError(messageOf(error, ''))
      } else {
        setSubmitError(
          `บันทึกไม่สำเร็จ: ${messageOf(error, 'ระบบขัดข้อง')} ยังไม่มีการเปลี่ยนแปลงข้อมูล และข้อมูลที่กรอกยังอยู่ครบ กด “${member ? 'บันทึกการแก้ไข' : 'เพิ่มสมาชิก'}” เพื่อลองอีกครั้ง`,
        )
      }
      setSaving(false)
    }
  }

  // ผู้ใช้เลือกเอง: แทนค่าที่กรอกด้วยค่าล่าสุด แล้วแก้ต่อจากรุ่นล่าสุด
  const loadLatest = () => {
    if (!conflict) return
    const latest = toInput(conflict)
    setBase(conflict)
    setInitial(latest)
    setValues(latest)
    setErrors({})
    setConflict(null)
    setSubmitError('')
    refresh().catch(() => undefined)
  }

  return (
    <>
      <Dialog
        title={member ? 'แก้ไขสมาชิก' : 'เพิ่มสมาชิก'}
        onRequestClose={requestClose}
        footer={
          <>
            <button type="button" className="button" onClick={requestClose}>
              ยกเลิก
            </button>
            <button type="submit" form="member-form" className="button button-primary" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : member ? 'บันทึกการแก้ไข' : 'เพิ่มสมาชิก'}
            </button>
          </>
        }
      >
        <form id="member-form" ref={formRef} onSubmit={submit} noValidate className="form">
          {submitError && (
            <div className="form-alert" role="alert">
              <p>{submitError}</p>
              {conflict && (
                <button type="button" className="button button-small" onClick={loadLatest}>
                  โหลดค่าล่าสุด (แทนที่ค่าที่กรอกไว้)
                </button>
              )}
            </div>
          )}
          <div className="form-row">
            <Field label="ชื่อ" htmlFor="member-name" error={errors.name}>
              <input
                id="member-name"
                type="text"
                value={values.name}
                onChange={(e) => set('name', e.target.value)}
                autoComplete="off"
                data-autofocus
                {...fieldAria('member-name', errors.name)}
              />
            </Field>
            <Field label="ชื่อเล่น" htmlFor="member-nickname" error={errors.nickname}>
              <input
                id="member-nickname"
                type="text"
                value={values.nickname}
                onChange={(e) => set('nickname', e.target.value)}
                autoComplete="off"
                {...fieldAria('member-nickname', errors.nickname)}
              />
            </Field>
          </div>
          <div className="form-row">
            <Field label="บทบาท" htmlFor="member-role" hint="ใช้ประกอบการแสดงผล ไม่ใช่สิทธิ์เข้าสู่ระบบ">
              <select
                id="member-role"
                value={values.role}
                onChange={(e) => set('role', e.target.value as MemberInput['role'])}
                aria-describedby="member-role-hint"
              >
                {ROLES.map((r) => (
                  <option key={r} value={r}>
                    {ROLE_LABELS[r]}
                  </option>
                ))}
              </select>
            </Field>
            <Field label="สถานะ" htmlFor="member-status">
              <select
                id="member-status"
                value={values.status}
                onChange={(e) => set('status', e.target.value as MemberInput['status'])}
              >
                {STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <Field label="ช่องทางติดต่อ" htmlFor="member-contact" optional hint="เช่น ชื่อ Discord หรืออีเมล">
            <input
              id="member-contact"
              type="text"
              value={values.contact}
              onChange={(e) => set('contact', e.target.value)}
              autoComplete="off"
              aria-describedby="member-contact-hint"
            />
          </Field>
          <Field label="หมายเหตุ" htmlFor="member-note" optional>
            <textarea id="member-note" rows={3} value={values.note} onChange={(e) => set('note', e.target.value)} />
          </Field>
        </form>
      </Dialog>

      {pendingSuspend && (
        <SuspendConfirm
          name={pendingSuspend.name}
          busy={saving}
          onConfirm={() => save(pendingSuspend)}
          onCancel={() => setPendingSuspend(null)}
        />
      )}

      {confirmDiscard && (
        <ConfirmDialog
          title="ทิ้งการแก้ไขที่ยังไม่บันทึก?"
          confirmLabel="ทิ้งการแก้ไข"
          cancelLabel="กลับไปแก้ไขต่อ"
          tone="danger"
          onConfirm={onClose}
          onCancel={() => setConfirmDiscard(false)}
        >
          <p>ข้อมูลที่กรอกไว้ในฟอร์มนี้จะหายไป</p>
        </ConfirmDialog>
      )}
    </>
  )
}
