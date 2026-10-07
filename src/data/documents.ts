import { api } from '../api/client'

/** ต้องตรงกับขีดจำกัดที่ server ตรวจ (worker/docs.ts) นับเป็น UTF-16 code unit เหมือน length ของ string */
export const MAX_CONTENT_UNITS = 50_000
export const MAX_TITLE_LENGTH = 200

export type DocumentStatus = 'ok' | 'read_only' | 'unavailable'

/** รายการเอกสารที่ลงทะเบียนในระบบ เนื้อหาอยู่ใน Google Docs ไม่ได้อยู่ในรายการนี้ */
export interface DocumentInfo {
  id: string
  title: string
  status: DocumentStatus
  statusDetail: string
  googleUrl: string
  createdAt: string
  updatedAt: string
  lastCheckedAt: string | null
  createdByName: string
  updatedByName: string
  /** created = สร้างผ่านเว็บ, selected = ไฟล์เดิมที่ผู้ดูแลเลือกมาผูก */
  origin?: 'created' | 'selected'
}

/** เนื้อหาที่อ่านจาก Google Docs ณ revision หนึ่ง */
export interface DocumentContent {
  text: string
  revisionId: string
  /** false เมื่อเอกสารมีโครงสร้างที่ editor ในเว็บรักษาไม่ได้ */
  editable: boolean
  reasons: string[]
}

/** none = ยังไม่ได้ส่งคำสั่งสร้างไฟล์, unknown = ส่งแล้วแต่ไม่ทราบผล, created = มีไฟล์แล้ว */
export type FileState = 'none' | 'unknown' | 'created'

export interface PendingOperation {
  id: string
  title: string
  status: 'pending' | 'file_created' | 'failed'
  fileState: FileState
  fileCreated: boolean
  /** มีคำขอกำลังทำงานนี้อยู่ */
  inProgress: boolean
  /** ผ่านเวลารอแล้ว ผู้ใช้ยืนยันให้สร้างไฟล์ใหม่ได้หลังตรวจ Google Drive เอง */
  canConfirmCreate: boolean
  googleUrl: string | null
  lastError: string | null
  createdAt: string
  userName: string
}

export const DOCUMENT_STATUS_LABELS: Record<DocumentStatus, string> = {
  ok: 'แก้ในเว็บได้',
  read_only: 'อ่านอย่างเดียวในเว็บ',
  unavailable: 'เปิดจาก Google ไม่ได้',
}

/** ทำข้อความให้ตรงกับที่ server จะส่งให้ Google Docs เพื่อให้นับความยาวและเทียบผลได้ตรงกัน */
export const normalizeText = (input: string) => input.replace(/\r\n?/g, '\n').replace(/[\u0000-\u0008\u000b-\u001f\ue000-\uf8ff]/g, '')

export const documentsApi = {
  list: async () => (await api<{ documents: DocumentInfo[] }>('/api/documents')).documents,
  read: (id: string) => api<{ document: DocumentInfo; content: DocumentContent }>(`/api/documents/${encodeURIComponent(id)}`),
  create: (input: { title: string; text: string }, key: string) =>
    api<{ document: DocumentInfo }>('/api/documents', { method: 'POST', body: input, idempotencyKey: key }),
  // ไม่ส่งชื่อ: ชื่อเอกสารเปลี่ยนจากเว็บไม่ได้หลังสร้าง (server ปฏิเสธด้วย)
  save: (id: string, input: { text: string; baseRevisionId: string }) =>
    api<{ document: DocumentInfo; content: DocumentContent; verified: boolean }>(`/api/documents/${encodeURIComponent(id)}`, {
      method: 'PUT',
      body: input,
    }),
  /** ตรวจแบบเบาว่า Google มีฉบับใหม่หรือไม่ (ไม่ดึงเนื้อหา) */
  revision: (id: string) => api<{ revisionId: string; title: string }>(`/api/documents/${encodeURIComponent(id)}/revision`),
  /** ผูกเอกสารเดิมที่ผู้ดูแลเลือกผ่าน Google Picker */
  link: (fileId: string) => api<{ document: DocumentInfo }>('/api/documents/link', { method: 'POST', body: { fileId } }),
  operations: async () => (await api<{ operations: PendingOperation[] }>('/api/documents/operations')).operations,
  resume: (id: string, confirmCreate = false) =>
    api<{ document: DocumentInfo }>(`/api/documents/operations/${encodeURIComponent(id)}/resume`, { method: 'POST', body: { confirmCreate } }),
  dismiss: (id: string) =>
    api<{ fileState: FileState; fileRemainsInGoogle: boolean }>(`/api/documents/operations/${encodeURIComponent(id)}`, { method: 'DELETE' }),
}
