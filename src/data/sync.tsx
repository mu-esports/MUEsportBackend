import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { api } from '../api/client'
import { IS_DEMO } from '../mode'
import { AppError } from './errors'

export type SyncKind = 'sheets' | 'calendar' | 'forms' | 'docs'

export interface SyncIssue {
  code: string
  message: string
  where?: string
}

/** สถานะการซิงค์ของบริการหนึ่งตามที่ server บันทึกจากผลจริง */
export interface SyncStatus {
  kind: SyncKind
  linked: boolean
  resource: { id: string; name: string; url: string; origin: 'created' | 'selected'; access: 'write' | 'read' } | null
  syncing: boolean
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  error: { code: string; message: string } | null
  retryAt: string | null
  issues: SyncIssue[]
  /** เพิ่มทุกครั้งที่สำเนาของ server เปลี่ยน ใช้ตัดสินว่าต้องโหลดรายการใหม่หรือไม่ */
  dataVersion: number
}

export interface SyncRun {
  ran: boolean
  skipped: 'not_linked' | 'recent' | 'backoff' | 'in_progress' | null
  status: SyncStatus
}

/** ตรวจอัตโนมัติประมาณทุก 60 วินาทีขณะหน้าเปิดและมองเห็นอยู่ เป็นเป้าหมาย ไม่ใช่การรับประกัน (Google อาจช้าหรือจำกัดคำขอ) */
export const AUTO_SYNC_MS = 60_000
/** เกินเวลานี้โดยไม่มีรอบที่สำเร็จ ถือว่าข้อมูลอาจยังไม่ล่าสุด */
export const STALE_AFTER_MS = 5 * 60_000
const SHARED_WINDOW_MS = 45_000
/** เวลาที่แท็บใหม่รอฟังว่าแท็บอื่นเพิ่งสั่งซิงค์ไปหรือยัง ก่อนสั่งรอบแรกของตัวเอง */
const HANDSHAKE_MS = 250

interface SyncApi {
  statuses: Partial<Record<SyncKind, SyncStatus>>
  /** กำลังรอผลของคำสั่งซิงค์จากแท็บนี้ */
  running: Partial<Record<SyncKind, boolean>>
  /** สั่งซิงค์ force = ผู้ใช้กดปุ่มเอง */
  run(kind: SyncKind, force?: boolean): Promise<SyncRun | null>
  /** อ่านสถานะล่าสุดจาก server โดยไม่เรียก Google */
  reload(): Promise<void>
  apply(status: SyncStatus): void
}

const SyncContext = createContext<SyncApi | null>(null)

// แท็บของเบราว์เซอร์เดียวกันบอกกันผ่าน BroadcastChannel ว่าเพิ่งสั่งซิงค์บริการใดไป แท็บอื่นจึงอ่านสถานะจาก server แทนการสั่งซ้ำ
// เก็บในหน่วยความจำของแต่ละแท็บเท่านั้น ไม่เขียนลง storage ของเบราว์เซอร์ (server ยังรวมคำขอที่ซ้ำจากอุปกรณ์อื่นให้อีกชั้น)
type TabMessage = { type: 'hello' } | { type: 'state'; times: Partial<Record<SyncKind, number>> } | { type: 'triggered'; kind: SyncKind; at: number }
const lastTriggered: Partial<Record<SyncKind, number>> = {}
const noteTriggered = (kind: SyncKind, at: number) => {
  lastTriggered[kind] = Math.max(lastTriggered[kind] ?? 0, at)
}
const channel = !IS_DEMO && typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel('mu-esport-staff:sync') : null
if (channel) {
  channel.onmessage = (event: MessageEvent<TabMessage>) => {
    const message = event.data
    if (message.type === 'hello') channel.postMessage({ type: 'state', times: lastTriggered } satisfies TabMessage)
    else if (message.type === 'state') for (const [kind, at] of Object.entries(message.times)) noteTriggered(kind as SyncKind, at)
    else if (message.type === 'triggered') noteTriggered(message.kind, message.at)
  }
  channel.postMessage({ type: 'hello' } satisfies TabMessage)
}

const recentlyTriggeredElsewhere = (kind: SyncKind) => Date.now() - (lastTriggered[kind] ?? 0) < SHARED_WINDOW_MS
function markTriggered(kind: SyncKind) {
  const at = Date.now()
  noteTriggered(kind, at)
  channel?.postMessage({ type: 'triggered', kind, at } satisfies TabMessage)
}

export function SyncProvider({ children }: { children: ReactNode }) {
  const [statuses, setStatuses] = useState<Partial<Record<SyncKind, SyncStatus>>>({})
  const [running, setRunning] = useState<Partial<Record<SyncKind, boolean>>>({})
  const inFlight = useRef<Partial<Record<SyncKind, Promise<SyncRun | null>>>>({})

  const apply = useCallback((status: SyncStatus) => setStatuses((all) => ({ ...all, [status.kind]: status })), [])

  const reload = useCallback(async () => {
    const { sync } = await api<{ sync: SyncStatus[] }>('/api/sync')
    setStatuses(Object.fromEntries(sync.map((s) => [s.kind, s])))
  }, [])

  const run = useCallback(
    (kind: SyncKind, force = false): Promise<SyncRun | null> => {
      // คำขอที่ยังไม่จบของบริการเดียวกันใช้ร่วมกัน ไม่ส่งซ้ำ
      const pending = inFlight.current[kind]
      if (pending) return pending
      // แท็บนี้หรือแท็บอื่นเพิ่งสั่งไป: อ่านสถานะจาก server แทน (ไม่เรียก Google)
      if (!force && recentlyTriggeredElsewhere(kind)) return reload().then(() => null)
      markTriggered(kind)
      setRunning((all) => ({ ...all, [kind]: true }))
      const request = api<SyncRun>(`/api/sync/${kind}`, { method: 'POST', body: { force } })
        .then((result) => {
          apply(result.status)
          return result
        })
        .finally(() => {
          inFlight.current[kind] = undefined
          setRunning((all) => ({ ...all, [kind]: false }))
        })
      inFlight.current[kind] = request
      return request
    },
    [apply, reload],
  )

  useEffect(() => {
    reload().catch(() => undefined)
  }, [reload])

  const value = useMemo(() => ({ statuses, running, run, reload, apply }), [statuses, running, run, reload, apply])
  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>
}

/** null ในโหมดข้อมูลตัวอย่าง ซึ่งไม่มีการเชื่อมต่อใด ๆ */
export const useSync = () => useContext(SyncContext)

/**
 * ให้หน้าที่เปิดอยู่ตามข้อมูลจาก Google: ซิงค์เมื่อเปิดหน้า เมื่อกลับมาที่แท็บ และเป็นระยะขณะหน้ามองเห็นอยู่
 * onChanged ถูกเรียกเมื่อสำเนาของ server เปลี่ยน (รวมถึงจากอุปกรณ์อื่น) หน้าที่มีร่างค้างตัดสินเองว่าจะโหลดใหม่หรือไม่
 */
export function useAutoSync(kinds: SyncKind[], onChanged?: (kind: SyncKind) => void) {
  const sync = useSync()
  const run = sync?.run
  const key = kinds.join(',')
  const changed = useRef(onChanged)
  changed.current = onChanged
  const seen = useRef<Partial<Record<SyncKind, number>>>({})

  useEffect(() => {
    if (IS_DEMO || !run) return
    let stopped = false
    const tick = () => {
      if (document.visibilityState !== 'visible') return
      for (const kind of key.split(',') as SyncKind[]) {
        // ข้อผิดพลาดของรอบอัตโนมัติแสดงผ่านสถานะของบริการ ไม่รบกวนงานที่ผู้ใช้ทำอยู่
        run(kind).catch((error: unknown) => {
          if (!(error instanceof AppError) && !stopped) console.warn('sync request failed')
        })
      }
    }
    // รอบแรกรอช่วงสั้น ๆ ให้แท็บอื่นตอบก่อนว่าเพิ่งสั่งซิงค์ไปหรือยัง
    const first = setTimeout(tick, HANDSHAKE_MS)
    const timer = setInterval(tick, AUTO_SYNC_MS)
    document.addEventListener('visibilitychange', tick)
    return () => {
      stopped = true
      clearTimeout(first)
      clearInterval(timer)
      document.removeEventListener('visibilitychange', tick)
    }
  }, [run, key])

  // แจ้งเมื่อรุ่นของสำเนาเปลี่ยนจากค่าที่หน้านี้เห็นครั้งก่อน
  const statuses = sync?.statuses
  useEffect(() => {
    if (!statuses) return
    for (const kind of key.split(',') as SyncKind[]) {
      const version = statuses[kind]?.dataVersion
      if (version === undefined) continue
      const previous = seen.current[kind]
      seen.current[kind] = version
      if (previous !== undefined && previous !== version) changed.current?.(kind)
    }
  }, [statuses, key])
}
