import { useEffect, useState } from 'react'
import { CircleAlert, CircleCheck, Clock, Database, ExternalLink, LoaderCircle, Lock, RefreshCw } from 'lucide-react'
import { messageOf } from '../data/errors'
import { STALE_AFTER_MS, useSync } from '../data/sync'
import type { SyncKind, SyncStatus } from '../data/sync'
import { formatTimestamp } from '../lib/datetime'
import { useToast } from './Toast'

const SERVICE: Record<SyncKind, string> = {
  sheets: 'Google Sheets',
  calendar: 'Google Calendar',
  forms: 'Google Forms',
  docs: 'Google Docs',
}

/** ข้อความเมื่อยังไม่ได้เชื่อม: บอกตามจริงว่าข้อมูลชุดนี้อยู่ที่ใด */
const LOCAL_TEXT: Record<SyncKind, string> = {
  sheets: 'ข้อมูลในเว็บ (ยังไม่ได้เชื่อม Google Sheets)',
  calendar: 'ข้อมูลในเว็บ (ยังไม่ได้เชื่อม Google Calendar)',
  forms: 'ยังไม่ได้เชื่อม Google Forms',
  docs: 'Google Docs ของชมรม',
}

type Tone = 'ok' | 'busy' | 'error' | 'stale' | 'idle'

function describe(status: SyncStatus, running: boolean, now: number): { tone: Tone; text: string } {
  if (running || status.syncing) return { tone: 'busy', text: 'กำลังซิงค์…' }
  const last = status.lastSuccessAt ? `อัปเดตสำเร็จล่าสุด ${formatTimestamp(status.lastSuccessAt)}` : 'ยังไม่เคยอัปเดตสำเร็จ'
  if (status.error) return { tone: 'error', text: `ซิงค์ไม่สำเร็จ: ${status.error.message} · ข้อมูลอาจยังไม่ล่าสุด (${last})` }
  if (!status.lastSuccessAt) return { tone: 'idle', text: 'ยังไม่เคยอัปเดตจาก Google' }
  if (now - Date.parse(status.lastSuccessAt) > STALE_AFTER_MS) return { tone: 'stale', text: `ข้อมูลอาจยังไม่ล่าสุด · ${last}` }
  return { tone: 'ok', text: `อัปเดตล่าสุด ${formatTimestamp(status.lastSuccessAt)}` }
}

const ICONS = { ok: CircleCheck, busy: LoaderCircle, error: CircleAlert, stale: Clock, idle: Clock }

/**
 * แถบสถานะแหล่งข้อมูลของหน้า: ที่มาของข้อมูล เวลาที่อัปเดตสำเร็จล่าสุด สถานะกำลังซิงค์/ไม่สำเร็จ/อาจไม่ล่าสุด และปุ่มอัปเดตจาก Google
 * ไม่แสดงในโหมดข้อมูลตัวอย่าง
 */
export function SyncBar({ kinds }: { kinds: SyncKind[] }) {
  const sync = useSync()
  const toast = useToast()
  // ให้ข้อความ "อาจยังไม่ล่าสุด" ตามเวลาจริงแม้ไม่มีคำตอบใหม่จาก server
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 30_000)
    return () => clearInterval(timer)
  }, [])
  if (!sync) return null

  const refresh = async (kind: SyncKind) => {
    try {
      const result = await sync.run(kind, true)
      if (!result) return
      if (result.skipped === 'backoff') {
        toast.error(`Google จำกัดคำขอชั่วคราว ลองได้อีกครั้งหลัง ${result.status.retryAt ? formatTimestamp(result.status.retryAt) : 'อีกสักครู่'}`)
      } else if (result.skipped === 'recent' || result.skipped === 'in_progress') {
        toast.success('เพิ่งอัปเดตจาก Google เมื่อสักครู่ กำลังแสดงผลล่าสุดแล้ว')
      } else if (result.ran && !result.status.error) {
        toast.success(`อัปเดตจาก ${SERVICE[kind]} แล้ว`)
      }
    } catch (error) {
      toast.error(messageOf(error, 'สั่งอัปเดตไม่สำเร็จ ลองอีกครั้ง'))
    }
  }

  return (
    <div className="sync-bar" role="group" aria-label="สถานะแหล่งข้อมูล">
      {kinds.map((kind) => {
        const status = sync.statuses[kind]
        if (!status) return null
        const running = sync.running[kind] === true
        if (!status.linked) {
          return (
            <div key={kind} className="sync-row" data-sync-kind={kind} data-sync-state="local">
              <span className="badge badge-neutral">
                <Database aria-hidden="true" size={14} />
                {LOCAL_TEXT[kind]}
              </span>
            </div>
          )
        }
        const { tone, text } = describe(status, running, now)
        const Icon = ICONS[tone]
        return (
          <div key={kind} className="sync-row" data-sync-kind={kind} data-sync-state={tone}>
            <div className="sync-source">
              <span className="badge badge-source">
                <Database aria-hidden="true" size={14} />
                {SERVICE[kind]}
              </span>
              {status.resource && (
                <a className="sync-origin" href={status.resource.url} target="_blank" rel="noopener noreferrer">
                  {status.resource.name || 'เปิดต้นฉบับ'}
                  <ExternalLink aria-hidden="true" size={14} />
                  <span className="visually-hidden"> (เปิดต้นฉบับใน Google แท็บใหม่)</span>
                </a>
              )}
              {status.resource?.access === 'read' && (
                <span className="badge badge-neutral">
                  <Lock aria-hidden="true" size={14} />
                  อ่านอย่างเดียว
                </span>
              )}
            </div>
            <p className={`sync-state sync-state-${tone}`} role={tone === 'error' ? 'alert' : 'status'}>
              <Icon aria-hidden="true" size={16} className={tone === 'busy' ? 'spin' : undefined} />
              <span>{text}</span>
            </p>
            <button type="button" className="button button-small" onClick={() => refresh(kind)} disabled={running} aria-label={`อัปเดตจาก ${SERVICE[kind]}`}>
              <RefreshCw aria-hidden="true" size={16} />
              อัปเดตจาก Google
            </button>
            {status.issues.length > 0 && (
              <details className="sync-issues">
                <summary>มี {status.issues.length} รายการในต้นฉบับที่ต้องแก้ ระบบยังไม่นำค่าจากรายการเหล่านี้มาใช้</summary>
                <ul>
                  {status.issues.map((issue, index) => (
                    <li key={index}>
                      {issue.where && <strong>{issue.where}: </strong>}
                      {issue.message}
                    </li>
                  ))}
                </ul>
              </details>
            )}
          </div>
        )
      })}
    </div>
  )
}
