import { useState } from 'react'
import { LoaderCircle } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { AppError, messageOf } from '../data/errors'
import { repository } from '../data/repository'
import { useStore } from '../data/store'
import type { Member } from '../data/types'

export function DeleteMemberDialog({ member, onClose, onDeleted }: { member: Member; onClose(): void; onDeleted(): void }) {
  const { deleteMember } = useStore()
  const [target, setTarget] = useState(member)
  const [phase, setPhase] = useState<'confirm' | 'deleting' | 'checking'>('confirm')
  const [message, setMessage] = useState('')
  const [unknown, setUnknown] = useState(false)
  const busy = phase !== 'confirm'

  const verify = async () => {
    setPhase('checking')
    try {
      const latest = (await repository.listMembers()).find((item) => item.id === target.id)
      if (!latest) return onDeleted()
      setTarget(latest)
      setUnknown(false)
      setMessage('ตรวจแล้ว สมาชิกนี้ยังอยู่ในทะเบียน ยังไม่ได้ลบ ข้อมูลด้านล่างเป็นข้อมูลล่าสุด ตรวจแล้วกดยืนยันอีกครั้งถ้าต้องการลบ')
    } catch (error) {
      setUnknown(true)
      setMessage(`ยังยืนยันผลการลบไม่ได้: ${messageOf(error, 'เชื่อมต่อระบบไม่ได้')} กดตรวจสถานะอีกครั้งก่อนสั่งลบซ้ำ`)
    }
    setPhase('confirm')
  }

  const confirm = async () => {
    if (busy || unknown) return
    setPhase('deleting')
    setMessage('')
    try {
      await deleteMember(target)
      onDeleted()
    } catch (error) {
      if (error instanceof AppError && error.code === 'version_conflict') {
        if (error.data.current) setTarget(error.data.current as Member)
        setMessage('ข้อมูลสมาชิกหรือบัญชีถูกเปลี่ยนหลังจากเปิดกล่องนี้ ยังไม่ได้ลบ ข้อมูลด้านล่างเป็นข้อมูลล่าสุด ตรวจแล้วกดยืนยันใหม่ถ้ายังต้องการลบ')
        setPhase('confirm')
      } else if (error instanceof AppError && error.status >= 400 && error.status < 500 && error.status !== 404) {
        setMessage(`ลบข้อมูลไม่สำเร็จ: ${error.message}`)
        setPhase('confirm')
      } else {
        // คำตอบหายไม่ใช่หลักฐานว่าล้มเหลว ตรวจทะเบียนก่อนอนุญาตให้สั่งซ้ำ
        await verify()
      }
    }
  }

  return (
    <Dialog title="ลบข้อมูลสมาชิกออกจากทะเบียน?" size="sm" onRequestClose={() => !busy && onClose()} footer={
      <>
        <button type="button" className="button" disabled={busy} onClick={onClose} data-autofocus>ยกเลิก</button>
        <button type="button" className={`button ${unknown ? 'button-primary' : 'button-danger'}`} disabled={busy} onClick={unknown ? verify : confirm}>
          {busy && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
          {phase === 'deleting' ? 'กำลังลบข้อมูล…' : phase === 'checking' ? 'กำลังตรวจสถานะ…' : unknown ? 'ตรวจสถานะอีกครั้ง' : 'ยืนยันลบข้อมูลสมาชิก'}
        </button>
      </>
    }>
      <div className="confirm-body">
        {message && <p className="form-alert" role="alert">{message}</p>}
        <dl className="detail-list account-identity">
          <div className="detail-wide"><dt>สมาชิกที่จะลบ</dt><dd className="break-word">{target.name}{target.nickname ? ` (${target.nickname})` : ''}</dd></div>
        </dl>
        <ul className="bulleted">
          <li>ลบข้อมูลในทะเบียน บัญชีเข้าสู่ระบบ รูปโปรไฟล์ และข้อมูลนักกีฬาของสมาชิกคนนี้ออกจากเว็บ</li>
          <li>สมาชิกจะเข้าสู่ระบบด้วยบัญชีเดิมไม่ได้ และทุกอุปกรณ์ที่เข้าสู่ระบบอยู่จะถูกออกจากระบบ</li>
          <li>เก็บข้อมูลเดิมใน Google Sheets รวมทั้งคำตอบฟอร์มและไฟล์ Google ไว้ หากมีแถวในชีต ระบบจะไม่ดึงสมาชิก ID เดิมกลับมาเอง</li>
          <li>การลบนี้ไม่สามารถกู้คืนจากหน้าเว็บได้ ถ้าต้องการหยุดใช้งานชั่วคราวให้ใช้ปุ่มพักการใช้งานแทน</li>
        </ul>
      </div>
    </Dialog>
  )
}
