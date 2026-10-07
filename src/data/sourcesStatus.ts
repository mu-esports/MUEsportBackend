import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client'
import { messageOf } from './errors'

export type GoogleStatus = 'not_configured' | 'not_connected' | 'connected' | 'needs_reconnect' | 'error'
export type ResourceId = 'docs' | 'sheets' | 'calendar' | 'forms' | 'excel'
export type ResourceStatus = 'ready' | 'needs_connection' | 'missing_scope' | 'not_selected' | 'selected' | 'disabled'

/** สถานะจาก server: การเชื่อมบัญชี Google แยกจากการเลือกแหล่งข้อมูลแต่ละชนิด */
export interface SourcesStatus {
  google: {
    status: GoogleStatus
    expectedEmail: string
    email: string | null
    connectedAt: string | null
    lastCheckedAt: string | null
    lastError: string | null
    missingConfig: string[]
  }
  resources: { id: ResourceId; status: ResourceStatus; resourceName?: string | null }[]
}

export const GOOGLE_STATUS_LABELS: Record<GoogleStatus, string> = {
  not_configured: 'ยังไม่ได้ตั้งค่า',
  not_connected: 'ยังไม่ได้เชื่อม',
  connected: 'เชื่อมแล้ว',
  needs_reconnect: 'ต้องเชื่อมใหม่',
  error: 'ตรวจล่าสุดผิดพลาด',
}

export const RESOURCE_NAMES: Record<ResourceId, string> = {
  docs: 'Google Docs',
  sheets: 'Google Sheets',
  calendar: 'Google Calendar',
  forms: 'Google Forms',
  excel: 'Excel',
}

export function resourceStatusLabel(id: ResourceId, status: ResourceStatus): string {
  if (status === 'ready') return 'พร้อมใช้งาน'
  if (status === 'needs_connection') return 'รอเชื่อมบัญชี Google'
  if (status === 'missing_scope') return 'ยังไม่ได้รับสิทธิ์ที่ต้องใช้'
  if (status === 'not_selected') return id === 'sheets' ? 'ยังไม่ได้เลือกชีต' : id === 'forms' ? 'ยังไม่ได้เลือกฟอร์ม' : 'ยังไม่ได้เลือกปฏิทิน'
  if (status === 'selected') return 'เชื่อมแหล่งข้อมูลแล้ว'
  return 'ยังไม่เปิดใช้'
}

type State = 'loading' | 'ready' | 'error'

export function useSourcesStatus() {
  const [state, setState] = useState<State>('loading')
  const [data, setData] = useState<SourcesStatus | null>(null)
  const [error, setError] = useState('')
  const seq = useRef(0)

  const reload = useCallback(() => {
    const current = ++seq.current
    setState('loading')
    api<SourcesStatus>('/api/sources').then(
      (result) => {
        if (current !== seq.current) return
        setData(result)
        setState('ready')
      },
      (failure: unknown) => {
        if (current !== seq.current) return
        setError(messageOf(failure, 'โหลดสถานะแหล่งข้อมูลไม่สำเร็จ'))
        setState('error')
      },
    )
  }, [])

  useEffect(reload, [reload])

  /** ใช้ผลที่ server ตอบจากคำสั่งตรวจ/ตัดการเชื่อม */
  const apply = useCallback((result: SourcesStatus) => {
    seq.current++
    setData(result)
    setState('ready')
  }, [])

  return { state, data, error, reload, apply }
}
