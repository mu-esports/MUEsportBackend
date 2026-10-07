import { useLocation, useParams } from 'react-router-dom'
import { CLUB_NAME } from '../config'
import { FileList } from '../library/FileList'
import { FilePreview } from '../library/FilePreview'
import { MemberPageHeader } from './MemberLayout'

/** ไฟล์ชมรมสำหรับสมาชิก: ดูรายการและตัวอย่างได้อย่างเดียว ไม่มีปุ่มจัดการ สร้าง หรือแก้ไข */
export function MemberFilesPage() {
  return (
    <>
      <MemberPageHeader title="ไฟล์ชมรม" description="ไฟล์ของชมรมจาก Google เปิดดูตัวอย่างได้ในเว็บนี้โดยไม่ต้องเข้าสู่ระบบ Google" />
      <FileList basePath="/member/files" />
    </>
  )
}

export function MemberFileViewPage() {
  const { id = '' } = useParams()
  const location = useLocation()
  const from = (location.state as { from?: string; search?: string } | null) ?? null
  // กลับไปยังหน้าที่มา (รายการพร้อมคำค้นเดิม หรือหน้าแรก)
  const home = from?.from === '/member'
  return (
    <FilePreview
      key={id}
      fileId={id}
      audience="member"
      siteName={CLUB_NAME}
      backTo={home ? '/member' : `/member/files${from?.search ?? ''}`}
      backLabel={home ? 'กลับไปหน้าแรก' : 'กลับไปรายการไฟล์'}
    />
  )
}
