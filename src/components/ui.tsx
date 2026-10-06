import type { ReactNode } from 'react'
import { CircleCheck, CirclePause, LoaderCircle, TriangleAlert } from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { useStore } from '../data/store'
import { IS_DEMO } from '../mode'
import { STATUS_LABELS } from '../data/types'
import type { MemberStatus } from '../data/types'

export function PageHeader({ title, description, action }: { title: string; description: string; action?: ReactNode }) {
  return (
    <header className="page-header">
      <div>
        <h1 tabIndex={-1}>{title}</h1>
        <p>{description}</p>
      </div>
      {action && <div className="page-header-action">{action}</div>}
    </header>
  )
}

// สถานะสื่อด้วยไอคอนและข้อความ ไม่พึ่งสีอย่างเดียว
export function StatusBadge({ status }: { status: MemberStatus }) {
  const Icon = status === 'active' ? CircleCheck : CirclePause
  return (
    <span className={`badge badge-${status}`}>
      <Icon aria-hidden="true" size={14} />
      {STATUS_LABELS[status]}
    </span>
  )
}

export function EmptyState({
  icon: Icon, title, children, action,
}: { icon: LucideIcon; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="empty-state">
      <Icon aria-hidden="true" size={28} />
      <p className="empty-state-title">{title}</p>
      {children && <p className="empty-state-text">{children}</p>}
      {action}
    </div>
  )
}

/** ครอบเนื้อหาที่ต้องใช้ข้อมูล: แสดงสถานะกำลังโหลดหรือข้อผิดพลาดแทนจนกว่าข้อมูลจะพร้อม */
export function DataBoundary({ children }: { children: ReactNode }) {
  const { state, loadError, reload } = useStore()

  if (state === 'loading') {
    return (
      <div className="state-block" role="status">
        <LoaderCircle aria-hidden="true" size={24} className="spin" />
        <p>กำลังโหลดข้อมูล…</p>
      </div>
    )
  }

  if (state === 'error') {
    return (
      <div className="state-block state-error" role="alert">
        <TriangleAlert aria-hidden="true" size={28} />
        <p className="empty-state-title">โหลดข้อมูลไม่สำเร็จ</p>
        <p className="empty-state-text">
          {IS_DEMO
            ? 'อ่านข้อมูลที่เก็บไว้ในเบราว์เซอร์นี้ไม่ได้ ลองโหลดอีกครั้ง หากยังไม่ได้ ให้กด “รีเซ็ตข้อมูลตัวอย่าง” ที่แถบด้านบนเพื่อเริ่มใหม่'
            : loadError || 'โหลดข้อมูลจากระบบกลางไม่ได้ ลองอีกครั้งในอีกสักครู่'}
        </p>
        <button type="button" className="button button-primary" onClick={reload}>
          ลองโหลดอีกครั้ง
        </button>
      </div>
    )
  }

  return <>{children}</>
}

export function Field({
  label, htmlFor, optional, error, hint, children,
}: { label: string; htmlFor: string; optional?: boolean; error?: string; hint?: string; children: ReactNode }) {
  return (
    <div className="field">
      <label htmlFor={htmlFor}>
        {label}
        {optional && <span className="field-optional"> (ไม่บังคับ)</span>}
      </label>
      {children}
      {hint && !error && (
        <p className="field-hint" id={`${htmlFor}-hint`}>
          {hint}
        </p>
      )}
      {error && (
        <p className="field-error" id={`${htmlFor}-error`}>
          {error}
        </p>
      )}
    </div>
  )
}

/** aria สำหรับช่องกรอกที่อาจมีข้อผิดพลาด */
export function fieldAria(id: string, error?: string) {
  return error ? { 'aria-invalid': true, 'aria-describedby': `${id}-error` } : {}
}
