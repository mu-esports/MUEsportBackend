import { useEffect, useId, useRef } from 'react'
import type { ReactNode } from 'react'
import { X } from 'lucide-react'
import { focusOrigin } from './focusOrigin'
import { useToast } from './Toast'

interface DialogProps {
  title: string
  /** ถูกเรียกเมื่อผู้ใช้ขอปิด (ปุ่มปิด, Esc, คลิกนอกกรอบ) — ผู้เรียกตัดสินใจเองว่าจะปิดจริงหรือไม่ */
  onRequestClose(): void
  children: ReactNode
  footer?: ReactNode
  size?: 'sm' | 'md'
  description?: string
  /** องค์ประกอบที่ควรได้ focus เมื่อปิด ใช้เมื่อปุ่มที่เปิดไม่ใช่จุดที่เหมาะจะกลับไป */
  returnFocus?(): HTMLElement | null
}

/**
 * Dialog แบบ modal ใช้ <dialog> ของเบราว์เซอร์ จึงกัก focus ไว้ภายในและปิดด้วย Esc ได้
 * focus เริ่มที่องค์ประกอบที่มี data-autofocus และคืนกลับไปยังปุ่มที่เปิดเมื่อปิด
 */
export function Dialog({ title, description, onRequestClose, children, footer, size = 'md', returnFocus }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null)
  const titleId = useId()
  const descId = useId()
  const requestClose = useRef(onRequestClose)
  requestClose.current = onRequestClose
  const focusTarget = useRef(returnFocus)
  focusTarget.current = returnFocus
  const { modalOpened } = useToast()

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    const opener = focusOrigin()
    const modalClosed = modalOpened()
    dialog.showModal()
    dialog.querySelector<HTMLElement>('[data-autofocus]')?.focus()
    return () => {
      dialog.close()
      modalClosed()
      const target = focusTarget.current?.() ?? opener
      if (target?.isConnected) target.focus()
    }
  }, [modalOpened])

  return (
    <dialog
      ref={ref}
      className={`dialog dialog-${size}`}
      aria-labelledby={titleId}
      aria-describedby={description ? descId : undefined}
      onCancel={(e) => {
        e.preventDefault()
        requestClose.current()
      }}
      onClose={() => {
        // เบราว์เซอร์อาจปิด dialog เองเมื่อกด Esc ซ้ำ ให้เปิดกลับแล้วให้ผู้เรียกตัดสินใจ
        const dialog = ref.current
        if (!dialog || dialog.open) return
        dialog.showModal()
        requestClose.current()
      }}
      onMouseDown={(e) => {
        if (e.target === ref.current) requestClose.current()
      }}
    >
      <div className="dialog-panel">
        <header className="dialog-header">
          <div>
            <h2 id={titleId}>{title}</h2>
            {description && <p id={descId}>{description}</p>}
          </div>
          <button type="button" className="icon-button" aria-label="ปิด" onClick={onRequestClose}>
            <X aria-hidden="true" size={20} />
          </button>
        </header>
        <div className="dialog-body">{children}</div>
        {footer && <footer className="dialog-footer">{footer}</footer>}
      </div>
    </dialog>
  )
}

interface ConfirmDialogProps {
  title: string
  children: ReactNode
  confirmLabel: string
  cancelLabel?: string
  tone?: 'primary' | 'danger'
  busy?: boolean
  onConfirm(): void
  onCancel(): void
}

export function ConfirmDialog({
  title, children, confirmLabel, cancelLabel = 'ยกเลิก', tone = 'primary', busy, onConfirm, onCancel,
}: ConfirmDialogProps) {
  return (
    <Dialog
      title={title}
      size="sm"
      onRequestClose={onCancel}
      footer={
        <>
          <button type="button" className="button" onClick={onCancel} data-autofocus>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`button ${tone === 'danger' ? 'button-danger' : 'button-primary'}`}
            onClick={onConfirm}
            disabled={busy}
          >
            {confirmLabel}
          </button>
        </>
      }
    >
      <div className="confirm-body">{children}</div>
    </Dialog>
  )
}
