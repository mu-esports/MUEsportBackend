import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client'
import type { PickerConfig } from '../lib/picker'
import type { SyncKind, SyncStatus } from './sync'

export type ResourceKind = Exclude<SyncKind, 'docs'>

export interface SetupOperation {
  id: string
  kind: ResourceKind
  name: string
  status: 'pending' | 'resource_created' | 'failed'
  fileState: 'none' | 'unknown' | 'created'
  canConfirmCreate: boolean
  lastError: string | null
  createdAt: string
}

/** สถานะการตั้งค่าพื้นที่ข้อมูลชมรม (เฉพาะผู้ดูแล) */
export interface SetupInfo {
  scopes: { driveFile: boolean; calendarCreated: boolean; calendarExisting: boolean; library: boolean }
  /** หัวคอลัมน์รหัสนักศึกษาที่จับคู่ไว้ของชีตที่เชื่อม ('' = เชื่อมแล้วแต่ยังไม่มีคอลัมน์นี้, null = ยังไม่ได้เชื่อมชีต) */
  studentIdColumn: string | null
  picker: PickerConfig & { configured: boolean; missing: string[] }
  local: { members: number; events: number }
  operations: SetupOperation[]
  sync: SyncStatus[]
}

export function useSetupInfo(enabled: boolean) {
  const [info, setInfo] = useState<SetupInfo | null>(null)
  const reload = useCallback(async () => {
    const next = await api<SetupInfo>('/api/setup')
    setInfo(next)
    return next
  }, [])
  useEffect(() => {
    if (enabled) reload().catch(() => undefined)
  }, [enabled, reload])
  return { info, reload }
}
