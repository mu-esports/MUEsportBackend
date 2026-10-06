import { ConfirmDialog } from '../components/Dialog'

interface Props {
  name: string
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}

/** คำอธิบายและการยืนยันก่อนพักการใช้งาน ใช้ชุดเดียวกันทั้งจากหน้ารายละเอียดและฟอร์มแก้ไข */
export function SuspendConfirm({ name, busy, onConfirm, onCancel }: Props) {
  return (
    <ConfirmDialog
      title={`พักการใช้งาน “${name}”?`}
      confirmLabel="พักการใช้งาน"
      tone="danger"
      busy={busy}
      onConfirm={onConfirm}
      onCancel={onCancel}
    >
      <ul>
        <li>สมาชิกยังอยู่ในรายชื่อ และข้อมูลทั้งหมดไม่ถูกลบ</li>
        <li>สถานะจะเปลี่ยนเป็น “พักการใช้งาน” และไม่ถูกนับเป็นสมาชิกที่ใช้งานในหน้าภาพรวม</li>
        <li>เปิดใช้งานกลับได้ทุกเมื่อจากหน้ารายละเอียดสมาชิก</li>
      </ul>
    </ConfirmDialog>
  )
}
