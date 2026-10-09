import { useEffect, useRef, useState } from 'react'
import type { ChangeEvent } from 'react'
import { ImagePlus, LoaderCircle, Trash2 } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { hasCode, messageOf } from '../data/errors'
import { MAX_INPUT_BYTES, PhotoError, photosApi, PHOTO_INPUT_TYPES, preparePhoto } from '../data/photos'

interface Person {
  id: string
  name: string
  nickname: string
  photoVersion?: string | null
}

interface Props {
  person: Person
  onClose(): void
  /** รูปเปลี่ยนแล้ว (server ยืนยัน): ให้หน้ารายการโหลดข้อมูลล่าสุด */
  onChanged(message: string): void
  /** คำขอไม่ได้คำตอบ: ให้หน้ารายการโหลดสถานะจริงล่าสุดมาแสดง */
  onRefresh(): void
}

type Phase = 'idle' | 'preparing' | 'saving' | 'removing'

/**
 * กล่องจัดการรูปโปรไฟล์ของคนในทะเบียน (ทีมงาน): เลือกรูป ดูตัวอย่างก่อนบันทึก เปลี่ยนรูป และลบรูป
 * - รูปถูกตัดเป็นสี่เหลี่ยมจัตุรัสตรงกลางและย่อในเบราว์เซอร์ก่อนส่ง รูปใหม่ยังไม่ถูกบันทึกจนกว่าจะกด “บันทึกรูป”
 * - ยกเลิกหรือปิดกล่อง: ไม่บันทึกรูปที่เลือก คืนหน่วยความจำของตัวอย่าง และยกเลิกคำขอที่ยังส่งไม่เสร็จ
 * - บันทึกไม่สำเร็จ: รูปเดิมยังอยู่ และรูปที่เลือกยังอยู่ในกล่องให้ลองอีกครั้ง
 */
export function PhotoDialog({ person, onClose, onChanged, onRefresh }: Props) {
  const [selected, setSelected] = useState<{ blob: Blob; url: string } | null>(null)
  const [phase, setPhase] = useState<Phase>('idle')
  const [error, setError] = useState('')
  const [confirm, setConfirm] = useState<'discard' | 'remove' | null>(null)
  const picker = useRef<HTMLInputElement>(null)
  const request = useRef<AbortController | null>(null)
  const preview = useRef<string | null>(null)
  const alive = useRef(true)

  const forget = () => {
    if (preview.current) URL.revokeObjectURL(preview.current)
    preview.current = null
  }

  // ปิดกล่อง (ทุกทาง): คืนหน่วยความจำของตัวอย่าง และยกเลิกคำขอที่ค้าง
  useEffect(() => {
    alive.current = true
    return () => {
      alive.current = false
      request.current?.abort()
      forget()
    }
  }, [])

  const busy = phase !== 'idle'
  const label = person.nickname || person.name

  const choose = async (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0]
    // ล้างค่าของช่องเลือกไฟล์ เพื่อให้เลือกไฟล์เดิมซ้ำได้หลังแก้ปัญหา
    event.target.value = ''
    if (!file) return
    setError('')
    setPhase('preparing')
    try {
      const prepared = await preparePhoto(file)
      if (!alive.current) return
      forget()
      const url = URL.createObjectURL(prepared.blob)
      preview.current = url
      setSelected({ blob: prepared.blob, url })
    } catch (failure) {
      if (!alive.current) return
      // เลือกไฟล์ไม่ผ่าน: รูปที่เลือกไว้ก่อนหน้า (ถ้ามี) และรูปปัจจุบันไม่เปลี่ยน
      setError(failure instanceof PhotoError ? failure.message : 'เตรียมรูปไม่สำเร็จ เลือกไฟล์อื่นแล้วลองอีกครั้ง')
    } finally {
      if (alive.current) setPhase('idle')
    }
  }

  const save = async () => {
    if (!selected || busy) return
    setError('')
    setPhase('saving')
    const controller = new AbortController()
    request.current = controller
    try {
      await photosApi.upload(person.id, selected.blob, controller.signal)
      if (!alive.current) return
      onChanged(person.photoVersion ? `เปลี่ยนรูปของ “${person.name}” แล้ว` : `บันทึกรูปของ “${person.name}” แล้ว`)
    } catch (failure) {
      if (!alive.current || hasCode(failure, 'aborted')) return
      if (hasCode(failure, 'network')) {
        // ไม่ได้คำตอบ: ยังไม่รู้ว่า server ได้รับรูปหรือไม่ โหลดสถานะจริงมาแสดง การกดบันทึกรูปเดิมซ้ำไม่ทำให้เกิดอะไรเพิ่ม
        onRefresh()
        setError('ยังยืนยันไม่ได้ว่ารูปถูกบันทึกหรือไม่ เพราะเชื่อมต่อระบบกลางไม่ได้ รูปที่เลือกยังอยู่ในกล่องนี้ ตรวจการเชื่อมต่อแล้วกด “บันทึกรูป” อีกครั้งได้')
      } else {
        setError(`บันทึกรูปไม่สำเร็จ: ${messageOf(failure, 'ระบบขัดข้อง')} ${person.photoVersion ? 'รูปเดิมยังอยู่' : 'ยังไม่มีรูปถูกบันทึก'} และรูปที่เลือกยังอยู่ในกล่องนี้`)
      }
      setPhase('idle')
    } finally {
      request.current = null
    }
  }

  const remove = async () => {
    setConfirm(null)
    setError('')
    setPhase('removing')
    try {
      await photosApi.remove(person.id)
      if (!alive.current) return
      onChanged(`ลบรูปของ “${person.name}” แล้ว`)
    } catch (failure) {
      if (!alive.current) return
      if (hasCode(failure, 'network')) onRefresh()
      setError(`ลบรูปไม่สำเร็จ: ${messageOf(failure, 'ระบบขัดข้อง')} ${hasCode(failure, 'network') ? 'ตรวจรูปปัจจุบันแล้วลองอีกครั้ง' : 'รูปเดิมยังอยู่'}`)
      setPhase('idle')
    }
  }

  const requestClose = () => {
    if (phase === 'saving') {
      // ยกเลิกระหว่างส่ง: หยุดคำขอ แล้วให้รายการโหลดสถานะจริง (server อาจได้รับรูปไปแล้วหรือยังก็ได้)
      request.current?.abort()
      onRefresh()
      onClose()
      return
    }
    if (busy) return
    if (selected) setConfirm('discard')
    else onClose()
  }

  return (
    <>
      <Dialog
        title="รูปโปรไฟล์"
        description={`${person.name}${person.nickname ? ` (${person.nickname})` : ''}`}
        size="sm"
        onRequestClose={requestClose}
        footer={
          <>
            <button type="button" className="button" onClick={requestClose} disabled={phase === 'preparing' || phase === 'removing'}>
              {phase === 'saving' ? 'ยกเลิกการส่ง' : selected ? 'ยกเลิก' : 'ปิด'}
            </button>
            {selected && (
              <button type="button" className="button button-primary" onClick={save} disabled={busy}>
                {phase === 'saving' && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
                {phase === 'saving' ? 'กำลังบันทึก…' : 'บันทึกรูป'}
              </button>
            )}
          </>
        }
      >
        <div className="photo-editor">
          {error && (
            <p className="form-alert" role="alert">
              {error}
            </p>
          )}
          <div className="photo-preview">
            <Avatar
              memberId={person.id}
              version={person.photoVersion}
              name={label}
              size="xl"
              previewUrl={selected?.url}
              label={selected ? `ตัวอย่างรูปใหม่ของ ${person.name}` : person.photoVersion ? `รูปปัจจุบันของ ${person.name}` : `${person.name} ยังไม่มีรูป`}
            />
            <p className="photo-status" role="status">
              {phase === 'preparing' ? (
                <>
                  <LoaderCircle aria-hidden="true" size={16} className="spin" /> กำลังเตรียมรูป…
                </>
              ) : selected ? (
                'ตัวอย่างรูปใหม่ ยังไม่ได้บันทึก'
              ) : person.photoVersion ? (
                'รูปปัจจุบัน'
              ) : (
                'ยังไม่มีรูป'
              )}
            </p>
          </div>

          <input
            ref={picker}
            id="photo-file"
            className="visually-hidden"
            type="file"
            accept={PHOTO_INPUT_TYPES.join(',')}
            onChange={choose}
            tabIndex={-1}
            aria-hidden="true"
          />
          <div className="button-row photo-actions">
            <button type="button" className="button" onClick={() => picker.current?.click()} disabled={busy} data-autofocus>
              <ImagePlus aria-hidden="true" size={16} />
              {selected ? 'เลือกรูปอื่น' : person.photoVersion ? 'เปลี่ยนรูป' : 'เลือกรูป'}
            </button>
            {person.photoVersion && !selected && (
              <button type="button" className="button button-danger-outline" onClick={() => setConfirm('remove')} disabled={busy}>
                {phase === 'removing' ? <LoaderCircle aria-hidden="true" size={16} className="spin" /> : <Trash2 aria-hidden="true" size={16} />}
                {phase === 'removing' ? 'กำลังลบ…' : 'ลบรูป'}
              </button>
            )}
          </div>
          <p className="field-hint">
            ใช้ไฟล์ JPEG, PNG หรือ WebP ขนาดไม่เกิน {MAX_INPUT_BYTES / 1024 / 1024} MB ระบบตัดเป็นสี่เหลี่ยมจัตุรัสตรงกลางรูปและย่อให้เล็กก่อนบันทึก รูปนี้ใช้ร่วมกันทั้งหน้าสมาชิก
            หน้านักกีฬา และบัญชีของสมาชิกคนนี้
          </p>
        </div>
      </Dialog>

      {confirm === 'discard' && (
        <ConfirmDialog title="ทิ้งรูปที่ยังไม่บันทึก?" confirmLabel="ทิ้งรูปที่เลือก" cancelLabel="กลับไปบันทึก" tone="danger" onConfirm={onClose} onCancel={() => setConfirm(null)}>
          <p>รูปที่เลือกไว้ยังไม่ถูกบันทึก ถ้าปิดกล่องนี้{person.photoVersion ? 'จะยังใช้รูปเดิม' : 'จะยังไม่มีรูป'}</p>
        </ConfirmDialog>
      )}
      {confirm === 'remove' && (
        <ConfirmDialog title={`ลบรูปของ “${person.name}”?`} confirmLabel="ลบรูป" tone="danger" onConfirm={remove} onCancel={() => setConfirm(null)}>
          <p>รูปนี้จะหายจากหน้าสมาชิก หน้านักกีฬา และบัญชีของสมาชิกคนนี้ ข้อมูลอื่นไม่เปลี่ยน และเพิ่มรูปใหม่ได้ภายหลัง</p>
        </ConfirmDialog>
      )}
    </>
  )
}
