import { useMemo, useRef, useState } from 'react'
import type { FormEvent } from 'react'
import { UserPlus } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { Field, fieldAria } from '../components/ui'
import { athletesApi } from '../data/athletes'
import { AppError, hasCode, messageOf } from '../data/errors'
import { ATHLETE_STATUS_LABELS, ATHLETE_STATUSES } from '../data/types'
import type { Athlete, AthleteInput, Member } from '../data/types'
import { MemberForm } from './MemberForm'

type Errors = Partial<Record<'memberId' | keyof AthleteInput, string>>

const BLANK: AthleteInput = { game: '', team: '', position: '', ign: '', status: 'active', note: '' }
const LIMITS: Record<'game' | 'team' | 'position' | 'ign', [string, number]> = { game: ['เกม', 60], team: ['ทีม', 60], position: ['ตำแหน่ง', 60], ign: ['ชื่อในเกม', 60] }

const toInput = (a: Athlete): AthleteInput => ({ game: a.game, team: a.team, position: a.position, ign: a.ign, status: a.status, note: a.note })
const trimmed = (v: AthleteInput): AthleteInput => ({ ...v, game: v.game.trim(), team: v.team.trim(), position: v.position.trim(), ign: v.ign.trim(), note: v.note.trim() })

function validate(memberId: string, v: AthleteInput, adding: boolean): Errors {
  const errors: Errors = {}
  if (adding && !memberId) errors.memberId = 'เลือกสมาชิกที่จะเพิ่มเป็นนักกีฬา'
  if (!v.game.trim()) errors.game = 'กรอกเกมที่ลงแข่ง'
  for (const key of ['game', 'team', 'position', 'ign'] as const) {
    if (!errors[key] && v[key].trim().length > LIMITS[key][1]) errors[key] = `${LIMITS[key][0]}ยาวได้ไม่เกิน ${LIMITS[key][1]} ตัวอักษร`
  }
  if (v.note.trim().length > 2000) errors.note = 'หมายเหตุยาวได้ไม่เกิน 2000 ตัวอักษร'
  return errors
}

interface Props {
  /** โปรไฟล์ที่กำลังแก้ (ไม่มี = เพิ่มนักกีฬา) */
  athlete?: Athlete
  /** คนในทะเบียนสมาชิกทั้งหมด (ใช้เลือกคนที่จะเพิ่ม และแสดงข้อมูลบุคคลล่าสุด) */
  members: Member[]
  /** รหัสสมาชิกของคนที่เป็นนักกีฬาอยู่แล้ว (ไม่ให้เลือกซ้ำ) */
  takenIds: Set<string>
  /** เกมที่มีในรายชื่อนักกีฬาแล้ว ใช้เป็นตัวเลือกช่วยพิมพ์ให้สะกดตรงกัน */
  games: string[]
  /** false = เพิ่มคนใหม่ในทะเบียนจากหน้านี้ไม่ได้ (เช่น ชีตต้นฉบับอ่านได้อย่างเดียว) */
  canAddPerson: boolean
  onClose(): void
  onSaved(message: string, saved: Athlete): void
  /** มีการเปลี่ยนแปลงที่หน้ารายการควรโหลดใหม่ (เช่น พบว่ามีโปรไฟล์อยู่แล้ว) */
  onStale(): void
}

/**
 * ฟอร์มเพิ่ม/แก้โปรไฟล์นักกีฬา
 * - เพิ่ม: เลือกคนจากทะเบียนสมาชิก (ด้วยรหัสสมาชิก ไม่จับคู่จากชื่อ) หรือเพิ่มคนใหม่ผ่านฟอร์มสมาชิกเดิมแล้วเลือกคนนั้นให้
 * - ชื่อ ชื่อเล่น รหัสนักศึกษา และรูปของบุคคลแก้ที่ทะเบียนสมาชิก ฟอร์มนี้แก้เฉพาะข้อมูลนักกีฬา
 */
export function AthleteForm({ athlete, members, takenIds, games, canAddPerson, onClose, onSaved, onStale }: Props) {
  const adding = !athlete
  const [base, setBase] = useState(athlete)
  const [memberId, setMemberId] = useState('')
  const [filter, setFilter] = useState('')
  const [initial, setInitial] = useState<AthleteInput>(() => (athlete ? toInput(athlete) : BLANK))
  const [values, setValues] = useState(initial)
  const [errors, setErrors] = useState<Errors>({})
  const [submitError, setSubmitError] = useState('')
  const [conflict, setConflict] = useState<Athlete | null>(null)
  const [saving, setSaving] = useState(false)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const [addingPerson, setAddingPerson] = useState(false)
  const [personNotice, setPersonNotice] = useState('')
  const formRef = useRef<HTMLFormElement>(null)

  const dirty = JSON.stringify(values) !== JSON.stringify(initial) || (adding && memberId !== '')
  const set = <K extends keyof AthleteInput>(key: K, value: AthleteInput[K]) => {
    setValues((v) => ({ ...v, [key]: value }))
    if (errors[key]) setErrors((e) => ({ ...e, [key]: undefined }))
  }

  // คนที่ยังไม่มีโปรไฟล์นักกีฬา เรียงตามชื่อ กรองด้วยคำค้น (ชื่อ ชื่อเล่น หรือรหัสนักศึกษา) คนที่เลือกอยู่ไม่หายจากรายการแม้ไม่ตรงคำค้น
  const candidates = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return members
      .filter((m) => !takenIds.has(m.id))
      .filter((m) => m.id === memberId || !q || [m.name, m.nickname, m.studentId ?? ''].some((text) => text.toLowerCase().includes(q)))
      .sort((a, b) => a.name.localeCompare(b.name, 'th'))
  }, [members, takenIds, filter, memberId])
  const available = members.some((m) => !takenIds.has(m.id))
  const person = members.find((m) => m.id === (athlete?.memberId ?? memberId))

  const requestClose = () => {
    if (saving) return
    if (dirty) setConfirmDiscard(true)
    else onClose()
  }

  const focusField = (key: keyof Errors) => formRef.current?.querySelector<HTMLElement>(`#athlete-${key === 'memberId' ? 'member' : key}`)?.focus()

  const submit = async (event: FormEvent) => {
    event.preventDefault()
    if (saving) return
    const found = validate(memberId, values, adding)
    setErrors(found)
    setSubmitError('')
    setConflict(null)
    const first = (['memberId', 'game', 'team', 'position', 'ign', 'note'] as const).find((key) => found[key])
    if (first) return focusField(first)

    const input = trimmed(values)
    setSaving(true)
    try {
      const saved = base ? await athletesApi.update(base.memberId, input, base.version) : await athletesApi.add(memberId, input)
      onSaved(base ? `บันทึกข้อมูลนักกีฬาของ “${saved.name}” แล้ว` : `เพิ่ม “${saved.name}” เป็นนักกีฬาแล้ว`, saved)
    } catch (failure) {
      const current = failure instanceof AppError ? (failure.data.current as Athlete | undefined) : undefined
      if (hasCode(failure, 'already_athlete') && current) {
        // คำขอเพิ่มครั้งก่อนอาจสำเร็จไปแล้วโดยไม่ได้คำตอบ: ถ้าโปรไฟล์ที่มีอยู่ตรงกับที่กรอกทุกช่อง ถือว่าเพิ่มแล้ว ไม่แจ้งเป็นข้อผิดพลาด
        if (JSON.stringify(toInput(current)) === JSON.stringify(input)) return onSaved(`เพิ่ม “${current.name}” เป็นนักกีฬาแล้ว`, current)
        onStale()
        // คนนี้ไม่อยู่ในตัวเลือกแล้ว: ล้างค่าที่เลือกให้ตรงกับที่ช่องแสดง ข้อมูลนักกีฬาที่กรอกยังอยู่ครบ
        setMemberId('')
        setErrors({ memberId: `“${current.name}” เป็นนักกีฬาอยู่แล้ว ยังไม่ได้บันทึกสิ่งที่กรอก เลือกคนอื่น หรือปิดฟอร์มนี้แล้วเปิดโปรไฟล์เดิมของคนนี้เพื่อแก้ไข` })
        focusField('memberId')
      } else if (hasCode(failure, 'version_conflict') && current) {
        setConflict(current)
        setSubmitError(messageOf(failure, ''))
      } else if (hasCode(failure, 'member_not_found')) {
        onStale()
        setMemberId('')
        setErrors({ memberId: messageOf(failure, '') })
        focusField('memberId')
      } else if (failure instanceof AppError && typeof failure.data.field === 'string' && failure.data.field in values) {
        // server ตรวจพบช่องที่ไม่ถูกต้อง: บอกที่ช่องนั้น ค่าที่กรอกยังอยู่ครบ
        const field = failure.data.field as keyof AthleteInput
        setErrors({ [field]: failure.message })
        focusField(field)
      } else {
        setSubmitError(
          `บันทึกไม่สำเร็จ: ${messageOf(failure, 'ระบบขัดข้อง')} ข้อมูลที่กรอกยังอยู่ครบ กด “${base ? 'บันทึกการแก้ไข' : 'เพิ่มนักกีฬา'}” เพื่อลองอีกครั้ง (ระบบจะไม่เพิ่มคนเดิมซ้ำ)`,
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
    onStale()
  }

  return (
    <>
      <Dialog
        title={adding ? 'เพิ่มนักกีฬา' : 'แก้ไขข้อมูลนักกีฬา'}
        description={adding ? 'นักกีฬาคือคนในทะเบียนสมาชิกที่มีข้อมูลการแข่งขันเพิ่ม ไม่ได้เพิ่มสิทธิ์ใช้ระบบ' : undefined}
        onRequestClose={requestClose}
        footer={
          <>
            <button type="button" className="button" onClick={requestClose}>
              ยกเลิก
            </button>
            <button type="submit" form="athlete-form" className="button button-primary" disabled={saving}>
              {saving ? 'กำลังบันทึก…' : adding ? 'เพิ่มนักกีฬา' : 'บันทึกการแก้ไข'}
            </button>
          </>
        }
      >
        <form id="athlete-form" ref={formRef} onSubmit={submit} noValidate className="form">
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

          {adding ? (
            <fieldset className="athlete-person">
              <legend>สมาชิกที่จะเพิ่มเป็นนักกีฬา</legend>
              {personNotice && (
                <p className="notice notice-success" role="status">
                  {personNotice}
                </p>
              )}
              {available ? (
                <>
                  <div className="field">
                    <label htmlFor="athlete-member-filter">ค้นหาในทะเบียนสมาชิก</label>
                    <input
                      id="athlete-member-filter"
                      type="search"
                      placeholder="ชื่อ ชื่อเล่น หรือรหัสนักศึกษา"
                      value={filter}
                      onChange={(e) => setFilter(e.target.value)}
                      autoComplete="off"
                      data-autofocus
                    />
                  </div>
                  <Field label="สมาชิก" htmlFor="athlete-member" error={errors.memberId} hint={`เลือกได้ ${candidates.length} คน (ไม่รวมคนที่เป็นนักกีฬาอยู่แล้ว)`}>
                    <select
                      id="athlete-member"
                      value={memberId}
                      onChange={(e) => {
                        setMemberId(e.target.value)
                        if (errors.memberId) setErrors((x) => ({ ...x, memberId: undefined }))
                      }}
                      aria-describedby={errors.memberId ? 'athlete-member-error' : 'athlete-member-hint'}
                      aria-invalid={errors.memberId ? true : undefined}
                    >
                      <option value="">เลือกสมาชิก…</option>
                      {candidates.map((m) => (
                        <option key={m.id} value={m.id}>
                          {m.name}
                          {m.nickname ? ` (${m.nickname})` : ''}
                          {m.studentId ? ` · ${m.studentId}` : ''}
                        </option>
                      ))}
                    </select>
                  </Field>
                </>
              ) : (
                <p className="notice" id="athlete-member">
                  {members.length === 0 ? 'ยังไม่มีสมาชิกในทะเบียน เพิ่มคนในทะเบียนสมาชิกก่อน' : 'ทุกคนในทะเบียนสมาชิกเป็นนักกีฬาแล้ว เพิ่มคนใหม่ในทะเบียนก่อนถ้าต้องการเพิ่มนักกีฬา'}
                </p>
              )}
              {!available && errors.memberId && (
                <p className="field-error" role="alert">
                  {errors.memberId}
                </p>
              )}
              {canAddPerson ? (
                <button type="button" className="button button-small" onClick={() => setAddingPerson(true)}>
                  <UserPlus aria-hidden="true" size={16} />
                  เพิ่มคนใหม่ในทะเบียนสมาชิก
                </button>
              ) : (
                <p className="field-hint">คนที่ยังไม่อยู่ในทะเบียนต้องเพิ่มที่ชีตต้นฉบับก่อน (บัญชีชมรมอ่านชีตได้อย่างเดียว)</p>
              )}
            </fieldset>
          ) : (
            person && (
              <div className="athlete-identity">
                <Avatar memberId={person.id} version={person.photoVersion} name={person.nickname || person.name} size="lg" />
                <div>
                  <p className="athlete-identity-name break-word">{person.name}</p>
                  <p className="muted break-word">
                    {person.nickname}
                    {person.studentId ? ` · รหัสนักศึกษา ${person.studentId}` : ''}
                  </p>
                  <p className="field-hint">ชื่อ ชื่อเล่น รหัสนักศึกษา และรูป แก้ที่หน้าสมาชิก</p>
                </div>
              </div>
            )
          )}

          <div className="form-row">
            <Field label="เกม" htmlFor="athlete-game" error={errors.game} hint="เช่น ชื่อเกมที่ลงแข่ง พิมพ์ให้ตรงกับที่มีอยู่เพื่อให้กรองรวมกันได้">
              <input
                id="athlete-game"
                type="text"
                list="athlete-game-options"
                value={values.game}
                onChange={(e) => set('game', e.target.value)}
                autoComplete="off"
                maxLength={80}
                aria-describedby={errors.game ? 'athlete-game-error' : 'athlete-game-hint'}
                aria-invalid={errors.game ? true : undefined}
                {...(adding ? {} : { 'data-autofocus': true })}
              />
              <datalist id="athlete-game-options">
                {games.map((game) => (
                  <option key={game} value={game} />
                ))}
              </datalist>
            </Field>
            <Field label="สถานะนักกีฬา" htmlFor="athlete-status">
              <select id="athlete-status" value={values.status} onChange={(e) => set('status', e.target.value as AthleteInput['status'])}>
                {ATHLETE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ATHLETE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </Field>
          </div>
          <div className="form-row">
            <Field label="ทีม" htmlFor="athlete-team" optional error={errors.team}>
              <input id="athlete-team" type="text" value={values.team} onChange={(e) => set('team', e.target.value)} autoComplete="off" maxLength={80} {...fieldAria('athlete-team', errors.team)} />
            </Field>
            <Field label="ตำแหน่ง" htmlFor="athlete-position" optional error={errors.position}>
              <input id="athlete-position" type="text" value={values.position} onChange={(e) => set('position', e.target.value)} autoComplete="off" maxLength={80} {...fieldAria('athlete-position', errors.position)} />
            </Field>
          </div>
          <Field label="ชื่อในเกม (IGN)" htmlFor="athlete-ign" optional error={errors.ign}>
            <input id="athlete-ign" type="text" value={values.ign} onChange={(e) => set('ign', e.target.value)} autoComplete="off" autoCapitalize="none" spellCheck={false} maxLength={80} {...fieldAria('athlete-ign', errors.ign)} />
          </Field>
          <Field label="หมายเหตุของนักกีฬา" htmlFor="athlete-note" optional error={errors.note}>
            <textarea id="athlete-note" rows={3} value={values.note} onChange={(e) => set('note', e.target.value)} {...fieldAria('athlete-note', errors.note)} />
          </Field>
        </form>
      </Dialog>

      {addingPerson && (
        <MemberForm
          onClose={() => setAddingPerson(false)}
          onSaved={(_message, saved) => {
            // คนใหม่อยู่ในทะเบียนแล้ว: เลือกให้ในฟอร์มนี้ทันที (ยังต้องกด “เพิ่มนักกีฬา” เพื่อบันทึกโปรไฟล์)
            setAddingPerson(false)
            setFilter('')
            setMemberId(saved.id)
            setErrors((x) => ({ ...x, memberId: undefined }))
            setPersonNotice(`เพิ่ม “${saved.name}” ในทะเบียนสมาชิกแล้ว และเลือกให้ด้านล่าง กรอกข้อมูลนักกีฬาแล้วกด “เพิ่มนักกีฬา”`)
          }}
        />
      )}

      {confirmDiscard && (
        <ConfirmDialog title="ทิ้งข้อมูลที่ยังไม่บันทึก?" confirmLabel="ทิ้งข้อมูลที่กรอก" cancelLabel="กลับไปแก้ไขต่อ" tone="danger" onConfirm={onClose} onCancel={() => setConfirmDiscard(false)}>
          <p>ข้อมูลนักกีฬาที่กรอกไว้ในฟอร์มนี้จะหายไป{personNotice ? ' ส่วนคนที่เพิ่มในทะเบียนสมาชิกแล้วยังอยู่' : ''}</p>
        </ConfirmDialog>
      )}
    </>
  )
}
