import { createContext, useCallback, useContext, useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'
import { CircleAlert, CircleCheck, X } from 'lucide-react'

type Tone = 'success' | 'error'
interface ToastItem {
  id: number
  message: string
  tone: Tone
}

interface ToastApi {
  success(message: string): void
  error(message: string): void
  /**
   * เรียกเมื่อเปิด modal dialog: ปิดข้อความสำเร็จของงานก่อนหน้า และพักการแสดงข้อความไว้จนกว่า dialog จะปิด
   * (ข้อความอยู่นอก dialog จึงถูกฉากมืดบังและกดไม่ได้) คืนฟังก์ชันสำหรับเรียกเมื่อ dialog ปิด
   */
  modalOpened(): () => void
}

const ToastContext = createContext<ToastApi | null>(null)
let nextId = 1

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toast, setToast] = useState<ToastItem | null>(null)
  const [openModals, setOpenModals] = useState(0)

  const show = useCallback((message: string, tone: Tone) => {
    setToast({ id: nextId++, message, tone })
  }, [])

  // ข้อความสำเร็จปิดเอง ส่วนข้อผิดพลาดค้างไว้จนผู้ใช้ปิด
  useEffect(() => {
    if (!toast || toast.tone === 'error') return
    const timer = setTimeout(() => setToast(null), 5000)
    return () => clearTimeout(timer)
  }, [toast])

  const modalOpened = useCallback(() => {
    setToast((current) => (current?.tone === 'success' ? null : current))
    setOpenModals((n) => n + 1)
    return () => setOpenModals((n) => n - 1)
  }, [])

  const api = useMemo<ToastApi>(
    () => ({ success: (m) => show(m, 'success'), error: (m) => show(m, 'error'), modalOpened }),
    [show, modalOpened],
  )

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-region" role="status" aria-live="polite">
        {toast && openModals === 0 && (
          <div key={toast.id} className={`toast toast-${toast.tone}`}>
            {toast.tone === 'success' ? (
              <CircleCheck aria-hidden="true" size={20} />
            ) : (
              <CircleAlert aria-hidden="true" size={20} />
            )}
            <span>{toast.message}</span>
            <button type="button" className="icon-button" aria-label="ปิดข้อความ" onClick={() => setToast(null)}>
              <X aria-hidden="true" size={18} />
            </button>
          </div>
        )}
      </div>
    </ToastContext.Provider>
  )
}

export function useToast() {
  const api = useContext(ToastContext)
  if (!api) throw new Error('useToast ต้องใช้ภายใน ToastProvider')
  return api
}
