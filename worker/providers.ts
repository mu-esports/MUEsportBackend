import type { AppEnv } from './env'

/**
 * จุดต่อสำหรับแหล่งข้อมูลภายนอกที่จะเปิดใช้ในรอบถัดไป (Google Sheets / Google Calendar)
 * รอบนี้ยังไม่มีการเลือกแหล่งข้อมูล จึงไม่มี provider ใดอ่านหรือเขียนข้อมูลจริง
 * และยังไม่ขอ scope ของ Sheets/Calendar จาก Google
 */
export type ResourceKind = 'sheets' | 'calendar'

/** การตั้งค่าที่ผู้ดูแลเลือกไว้ เก็บในตาราง resource_configs */
export interface ResourceConfig {
  kind: ResourceKind
  resourceId: string
  resourceName: string
  config: Record<string, unknown>
  updatedAt: string
}

export interface ResourceMetadata {
  id: string
  name: string
  /** เช่น ชื่อแท็บของชีต หรือเขตเวลาของปฏิทิน */
  details: Record<string, unknown>
}

export interface ResourceProvider {
  kind: ResourceKind
  /** scope ที่ต้องขอเพิ่ม (incremental consent) เมื่อเริ่มตั้งค่าแหล่งข้อมูลนี้ */
  requiredScopes: string[]
  /** อ่านข้อมูลกำกับของแหล่งข้อมูลเพื่อให้ผู้ดูแลตรวจก่อนยืนยัน */
  describe(env: AppEnv, resourceId: string): Promise<ResourceMetadata>
}

const notEnabled = (name: string) => () => Promise.reject(new Error(`${name} provider ยังไม่เปิดใช้ในรอบนี้`))

export const PROVIDERS: Record<ResourceKind, ResourceProvider> = {
  sheets: {
    kind: 'sheets',
    requiredScopes: ['https://www.googleapis.com/auth/spreadsheets.readonly'],
    describe: notEnabled('Google Sheets'),
  },
  calendar: {
    kind: 'calendar',
    requiredScopes: ['https://www.googleapis.com/auth/calendar.readonly'],
    describe: notEnabled('Google Calendar'),
  },
}

export async function loadResourceConfigs(env: AppEnv): Promise<Partial<Record<ResourceKind, ResourceConfig>>> {
  const { results } = await env.DB.prepare('SELECT * FROM resource_configs').all<{
    kind: ResourceKind
    resource_id: string
    resource_name: string
    config_json: string
    updated_at: string
  }>()
  const out: Partial<Record<ResourceKind, ResourceConfig>> = {}
  for (const row of results) {
    let config: Record<string, unknown> = {}
    try {
      config = JSON.parse(row.config_json) as Record<string, unknown>
    } catch {
      config = {}
    }
    out[row.kind] = { kind: row.kind, resourceId: row.resource_id, resourceName: row.resource_name, config, updatedAt: row.updated_at }
  }
  return out
}
