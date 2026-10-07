import { nowIso } from './env'
import type { AppEnv } from './env'
import { googleFetch } from './google'
import { HttpError } from './http'

/**
 * แกนกลางของ Google Sync ที่ทุกบริการใช้ร่วมกัน
 * - Google เป็นแหล่งหลักของข้อมูลที่เชื่อมแล้ว D1 เก็บสำเนาไว้แสดงผล
 * - งานซิงค์ของแต่ละบริการทำได้ทีละหนึ่งคำขอ (lease ใน D1) และไม่ถี่กว่าช่วงขั้นต่ำ ไม่ว่าจะมีกี่แท็บหรือกี่อุปกรณ์เปิดอยู่
 * - ซิงค์ล้มเหลว: เก็บสำเนาเดิมไว้ บันทึกสาเหตุ และเว้นระยะก่อนลองใหม่ (backoff)
 */
export type SyncKind = 'sheets' | 'calendar' | 'forms' | 'docs'
export type ResourceKind = Exclude<SyncKind, 'docs'>
export const SYNC_KINDS: SyncKind[] = ['sheets', 'calendar', 'forms', 'docs']
export const RESOURCE_KINDS: ResourceKind[] = ['sheets', 'calendar', 'forms']

/** หน้าเว็บตรวจทุกประมาณ 60 วินาที server รวมคำขอที่มาถี่กว่านี้เป็นงานเดียว */
export const MIN_INTERVAL_MS = 45_000
const FORCED_MIN_INTERVAL_MS = 5_000
const LEASE_MS = 90_000
const MAX_BACKOFF_MS = 30 * 60_000
/** จำนวนคำขอไป Google สูงสุดต่อรอบซิงค์หนึ่งบริการ (Workers จำกัด subrequest ต่อคำขอ) */
export const DEFAULT_BUDGET = 24

export interface SyncResource {
  kind: ResourceKind
  resourceId: string
  name: string
  url: string
  origin: 'created' | 'selected'
  access: 'write' | 'read'
  config: Record<string, unknown>
  linkedAt: string
}

interface ResourceRow {
  kind: ResourceKind
  resource_id: string
  resource_name: string
  resource_url: string
  origin: 'created' | 'selected'
  access: 'write' | 'read'
  config_json: string
  linked_at: string
}

const parseJson = <T>(text: string | null | undefined, fallback: T): T => {
  try {
    return text ? (JSON.parse(text) as T) : fallback
  } catch {
    return fallback
  }
}

const toResource = (row: ResourceRow): SyncResource => ({
  kind: row.kind,
  resourceId: row.resource_id,
  name: row.resource_name,
  url: row.resource_url,
  origin: row.origin,
  access: row.access,
  config: parseJson<Record<string, unknown>>(row.config_json, {}),
  linkedAt: row.linked_at,
})

export async function loadResource(env: AppEnv, kind: ResourceKind): Promise<SyncResource | null> {
  const row = await env.DB.prepare('SELECT * FROM sync_resources WHERE kind = ?').bind(kind).first<ResourceRow>()
  return row ? toResource(row) : null
}

export async function loadResources(env: AppEnv): Promise<Partial<Record<ResourceKind, SyncResource>>> {
  const { results } = await env.DB.prepare('SELECT * FROM sync_resources').all<ResourceRow>()
  return Object.fromEntries(results.map((row) => [row.kind, toResource(row)]))
}

/** ผูกแหล่งข้อมูลกับระบบ และเริ่มสถานะซิงค์ของบริการนั้นใหม่ (ไม่แตะสำเนาของบริการอื่น) */
export async function saveResource(env: AppEnv, resource: Omit<SyncResource, 'linkedAt'>, userId: string): Promise<void> {
  const now = nowIso()
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO sync_resources (kind, resource_id, resource_name, resource_url, origin, access, config_json, linked_by, linked_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (kind) DO UPDATE SET resource_id = excluded.resource_id, resource_name = excluded.resource_name, resource_url = excluded.resource_url,
         origin = excluded.origin, access = excluded.access, config_json = excluded.config_json, linked_by = excluded.linked_by,
         linked_at = excluded.linked_at, updated_at = excluded.updated_at`,
    ).bind(resource.kind, resource.resourceId, resource.name, resource.url, resource.origin, resource.access, JSON.stringify(resource.config), userId, now, now),
    env.DB.prepare(
      `INSERT INTO sync_state (kind, resource_id, updated_at) VALUES (?, ?, ?)
       ON CONFLICT (kind) DO UPDATE SET resource_id = excluded.resource_id, cursor = NULL, remote_version = NULL, last_attempt_at = NULL,
         last_success_at = NULL, last_error_code = NULL, last_error_message = NULL, failure_count = 0, next_attempt_at = NULL,
         issues_json = '[]', lease_owner = NULL, lease_expires_at = NULL, data_version = data_version + 1, updated_at = excluded.updated_at`,
    ).bind(resource.kind, resource.resourceId, now),
  ])
}

export const patchResource = (env: AppEnv, kind: ResourceKind, fields: { name?: string; access?: 'write' | 'read'; config?: Record<string, unknown> }) =>
  env.DB.prepare(
    `UPDATE sync_resources SET resource_name = COALESCE(?, resource_name), access = COALESCE(?, access), config_json = COALESCE(?, config_json), updated_at = ?
      WHERE kind = ?`,
  )
    .bind(fields.name ?? null, fields.access ?? null, fields.config ? JSON.stringify(fields.config) : null, nowIso(), kind)
    .run()

// ---------- เรียก Google ภายในงานซิงค์ ----------

/** Google ตอบผิดพลาด: เก็บเฉพาะสถานะและรหัสเหตุผล ไม่เก็บเนื้อหาคำตอบ */
export class GoogleApiError extends Error {
  constructor(
    public status: number,
    public reason: string,
    public retryAfterSeconds: number | null = null,
  ) {
    super(`google ${status} ${reason}`)
  }
}

/** ข้อมูลจาก Google ผิดรูปแบบจนใช้ต่อไม่ได้ (เช่น คอลัมน์ที่จับคู่ไว้หาย) ข้อความเป็นภาษาไทยสำหรับแสดงผล */
export class SyncDataError extends Error {}

class BudgetError extends Error {}

export interface Gapi {
  /** จำนวนคำขอที่ใช้ไปแล้วในงานนี้ */
  used: number
  remaining(): number
  fetch(url: string, init?: RequestInit): Promise<Response>
  /** คืน JSON เมื่อสำเร็จ ไม่เช่นนั้นโยน GoogleApiError */
  json<T = Record<string, any>>(url: string, init?: RequestInit): Promise<T>
}

const RATE_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded', 'RESOURCE_EXHAUSTED'])
const SCOPE_REASONS = new Set(['insufficientPermissions', 'ACCESS_TOKEN_SCOPE_INSUFFICIENT', 'insufficientScopes'])

async function toApiError(response: Response): Promise<GoogleApiError> {
  const body = (await response.json().catch(() => null)) as { error?: { status?: string; errors?: { reason?: string }[]; details?: { reason?: string }[] } } | null
  const reason = body?.error?.errors?.[0]?.reason ?? body?.error?.details?.find((d) => d.reason)?.reason ?? body?.error?.status ?? `http_${response.status}`
  const retryAfter = Number(response.headers.get('Retry-After'))
  return new GoogleApiError(response.status, reason, Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter : null)
}

export function makeGapi(env: AppEnv, budget = DEFAULT_BUDGET): Gapi {
  const gapi: Gapi = {
    used: 0,
    remaining: () => budget - gapi.used,
    async fetch(url, init) {
      if (gapi.used >= budget) throw new BudgetError()
      gapi.used++
      return googleFetch(env, url, init)
    },
    async json(url, init) {
      const response = await gapi.fetch(url, init)
      if (!response.ok) throw await toApiError(response)
      return (await response.json()) as never
    },
  }
  return gapi
}

export const jsonInit = (method: string, body: unknown, headers: Record<string, string> = {}): RequestInit => ({
  method,
  headers: { 'Content-Type': 'application/json', ...headers },
  body: JSON.stringify(body),
})

/** คำสั่งเขียนที่ Google ตอบ 5xx/429 หรือคำตอบไม่กลับมา: ไม่รู้ว่าถูกใช้ไปแล้วหรือยัง */
export const isUnknownOutcome = (error: unknown) =>
  (error instanceof GoogleApiError && error.status >= 500) || (error instanceof HttpError && error.code === 'google_unavailable')

export const outcomeUnknown = (what: string) =>
  new HttpError(502, 'save_outcome_unknown', `ไม่ทราบว่า Google บันทึก${what}แล้วหรือยัง (คำสั่งไปถึง Google แต่ไม่ได้รับคำตอบที่ยืนยันได้) กด “อัปเดตจาก Google” เพื่อตรวจค่าล่าสุดก่อนบันทึกซ้ำ`)

interface Classified {
  code: string
  message: string
  retryAfterSeconds: number | null
}

/** แปลงข้อผิดพลาดเป็นรหัสและข้อความไทยที่แสดงให้ทีมงานได้ ไม่มีรายละเอียดภายในของ Google */
export function classify(error: unknown): Classified {
  if (error instanceof SyncDataError) return { code: 'malformed', message: error.message, retryAfterSeconds: null }
  if (error instanceof BudgetError) {
    return { code: 'budget', message: 'ข้อมูลมีมากกว่าที่ดึงได้ในหนึ่งรอบ ระบบจะดึงส่วนที่เหลือในรอบถัดไป', retryAfterSeconds: null }
  }
  if (error instanceof HttpError) return { code: error.code, message: error.message, retryAfterSeconds: null }
  if (error instanceof GoogleApiError) {
    if (error.status === 429 || RATE_REASONS.has(error.reason)) {
      return { code: 'rate_limited', message: 'Google จำกัดจำนวนคำขอชั่วคราว ระบบจะเว้นระยะแล้วลองใหม่เอง', retryAfterSeconds: error.retryAfterSeconds }
    }
    if (SCOPE_REASONS.has(error.reason)) {
      return { code: 'missing_scope', message: 'บัญชี Google ของชมรมยังไม่ได้อนุญาตสิทธิ์ของบริการนี้ ให้ผู้ดูแลขอสิทธิ์ที่หน้าแหล่งข้อมูล', retryAfterSeconds: null }
    }
    if (error.status === 403 || error.status === 404 || error.status === 410) {
      return {
        code: 'resource_unavailable',
        message: 'เปิดต้นฉบับใน Google ไม่ได้ อาจถูกลบ ย้ายไปถังขยะ หรือบัญชี Google ของชมรมไม่มีสิทธิ์เข้าถึงแล้ว',
        retryAfterSeconds: null,
      }
    }
    if (error.status >= 500) return { code: 'google_unavailable', message: 'Google ตอบกลับผิดพลาดชั่วคราว ระบบจะลองใหม่เอง', retryAfterSeconds: error.retryAfterSeconds }
    return { code: 'google_error', message: 'Google ไม่รับคำขอของระบบ ลองอีกครั้ง ถ้ายังไม่ได้ให้ผู้ดูแลตรวจการตั้งค่าแหล่งข้อมูล', retryAfterSeconds: null }
  }
  return { code: 'internal_error', message: 'ระบบขัดข้องระหว่างซิงค์ ลองอีกครั้งในอีกสักครู่', retryAfterSeconds: null }
}

/** ใช้ใน handler ของคำสั่งเขียน: แปลงข้อผิดพลาดจาก Google เป็นคำตอบของ API */
export function toHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  const known = classify(error)
  const status = known.code === 'rate_limited' ? 429 : known.code === 'missing_scope' ? 409 : known.code === 'resource_unavailable' ? 409 : 502
  return new HttpError(status, known.code, known.message)
}

// ---------- สถานะและการควบคุมรอบซิงค์ ----------

export interface SyncIssue {
  code: string
  message: string
  /** ตำแหน่งที่ต้นฉบับ เช่น เลขแถวในชีต */
  where?: string
}

interface StateRow {
  kind: SyncKind
  resource_id: string
  cursor: string | null
  remote_version: string | null
  data_version: number
  last_attempt_at: string | null
  last_success_at: string | null
  last_error_code: string | null
  last_error_message: string | null
  failure_count: number
  next_attempt_at: string | null
  issues_json: string
  lease_owner: string | null
  lease_expires_at: string | null
}

async function loadState(env: AppEnv, kind: SyncKind): Promise<StateRow> {
  const select = () => env.DB.prepare('SELECT * FROM sync_state WHERE kind = ?').bind(kind).first<StateRow>()
  const row = await select()
  if (row) return row
  await env.DB.prepare('INSERT INTO sync_state (kind, updated_at) VALUES (?, ?) ON CONFLICT (kind) DO NOTHING').bind(kind, nowIso()).run()
  return (await select())!
}

export interface SyncInput {
  env: AppEnv
  gapi: Gapi
  /** null เฉพาะ docs ซึ่งไม่มีแหล่งเดียว */
  resource: SyncResource | null
  cursor: string | null
  remoteVersion: string | null
}

export interface SyncOutput {
  /** สำเนาใน D1 เปลี่ยนหรือไม่ */
  changed: boolean
  cursor?: string | null
  remoteVersion?: string | null
  issues?: SyncIssue[]
}

export type Syncer = (input: SyncInput) => Promise<SyncOutput>

export interface SyncStatus {
  kind: SyncKind
  linked: boolean
  resource: { id: string; name: string; url: string; origin: string; access: string } | null
  syncing: boolean
  lastSuccessAt: string | null
  lastAttemptAt: string | null
  error: { code: string; message: string } | null
  retryAt: string | null
  issues: SyncIssue[]
  dataVersion: number
}

const leaseActive = (row: StateRow) => row.lease_owner !== null && row.lease_expires_at !== null && row.lease_expires_at > nowIso()

function toStatus(kind: SyncKind, row: StateRow, resource: SyncResource | null): SyncStatus {
  const linked = kind === 'docs' || resource !== null
  // สถานะของแหล่งก่อนหน้าไม่นำมาแสดงกับแหล่งปัจจุบัน
  const current = linked && (kind === 'docs' || row.resource_id === resource?.resourceId)
  return {
    kind,
    linked,
    resource: resource ? { id: resource.resourceId, name: resource.name, url: resource.url, origin: resource.origin, access: resource.access } : null,
    syncing: current && leaseActive(row),
    lastSuccessAt: current ? row.last_success_at : null,
    lastAttemptAt: current ? row.last_attempt_at : null,
    error: current && row.last_error_code ? { code: row.last_error_code, message: row.last_error_message ?? '' } : null,
    retryAt: current ? row.next_attempt_at : null,
    issues: current ? parseJson<SyncIssue[]>(row.issues_json, []) : [],
    dataVersion: row.data_version,
  }
}

export async function syncStatuses(env: AppEnv): Promise<SyncStatus[]> {
  const resources = await loadResources(env)
  return Promise.all(SYNC_KINDS.map(async (kind) => toStatus(kind, await loadState(env, kind), kind === 'docs' ? null : (resources[kind] ?? null))))
}

export async function syncStatus(env: AppEnv, kind: SyncKind): Promise<SyncStatus> {
  return toStatus(kind, await loadState(env, kind), kind === 'docs' ? null : await loadResource(env, kind))
}

/** สำเนาใน D1 เปลี่ยนจากคำสั่งเขียนของเว็บ: ให้แท็บอื่นรู้ว่าต้องโหลดรายการใหม่ */
export const bumpDataVersion = (env: AppEnv, kind: SyncKind) =>
  env.DB.prepare('UPDATE sync_state SET data_version = data_version + 1, updated_at = ? WHERE kind = ?').bind(nowIso(), kind).run()

export type SkipReason = 'not_linked' | 'recent' | 'backoff' | 'in_progress'

export interface RunResult {
  ran: boolean
  /** จำนวนคำขอไป Google ที่รอบนี้ใช้จริง */
  used: number
  skipped?: SkipReason
  status: SyncStatus
}

const syncers: Partial<Record<SyncKind, Syncer>> = {}
/** แต่ละบริการลงทะเบียนตัวซิงค์ของตัวเอง ทุกตัวใช้การควบคุมรอบ สถานะ และ backoff ชุดเดียวกัน */
export const registerSyncer = (kind: SyncKind, syncer: Syncer) => {
  syncers[kind] = syncer
}

/**
 * ซิงค์หนึ่งบริการ ถ้าถึงรอบ
 * - force = ผู้ใช้กดปุ่ม “อัปเดตจาก Google”: ข้ามช่วงขั้นต่ำปกติได้ แต่ยังเคารพ rate limit ของ Google และไม่ทำงานซ้อน
 */
export async function runSync(env: AppEnv, kind: SyncKind, options: { force?: boolean; budget?: number } = {}): Promise<RunResult> {
  const resource = kind === 'docs' ? null : await loadResource(env, kind)
  let state = await loadState(env, kind)
  const skip = (skipped: SkipReason): RunResult => ({ ran: false, used: 0, skipped, status: toStatus(kind, state, resource) })
  if (kind !== 'docs' && !resource) return skip('not_linked')

  const now = Date.now()
  const sameResource = kind === 'docs' || state.resource_id === resource!.resourceId
  if (sameResource) {
    const sinceAttempt = state.last_attempt_at ? now - Date.parse(state.last_attempt_at) : Infinity
    if (sinceAttempt < (options.force ? FORCED_MIN_INTERVAL_MS : MIN_INTERVAL_MS)) return skip('recent')
    const waiting = state.next_attempt_at !== null && Date.parse(state.next_attempt_at) > now
    if (waiting && (!options.force || state.last_error_code === 'rate_limited')) return skip('backoff')
  }

  const owner = crypto.randomUUID()
  const stamp = nowIso()
  const claimed = await env.DB.prepare(
    `UPDATE sync_state SET lease_owner = ?, lease_expires_at = ?, last_attempt_at = ?, updated_at = ?
      WHERE kind = ? AND (lease_owner IS NULL OR lease_expires_at IS NULL OR lease_expires_at <= ?)`,
  )
    .bind(owner, new Date(now + LEASE_MS).toISOString(), stamp, stamp, kind, stamp)
    .run()
  if (claimed.meta.changes !== 1) return skip('in_progress')

  const syncer = syncers[kind]
  const gapi = makeGapi(env, options.budget)
  try {
    if (!syncer) throw new Error(`no syncer for ${kind}`)
    const output = await syncer({
      env,
      gapi,
      resource,
      cursor: sameResource ? state.cursor : null,
      remoteVersion: sameResource ? state.remote_version : null,
    })
    const done = nowIso()
    await env.DB.prepare(
      `UPDATE sync_state SET resource_id = ?, cursor = ?, remote_version = ?, data_version = data_version + ?, last_success_at = ?,
              last_error_code = NULL, last_error_message = NULL, failure_count = 0, next_attempt_at = NULL, issues_json = ?,
              lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE kind = ? AND lease_owner = ?`,
    )
      .bind(
        resource?.resourceId ?? '',
        output.cursor === undefined ? state.cursor : output.cursor,
        output.remoteVersion === undefined ? state.remote_version : output.remoteVersion,
        output.changed ? 1 : 0,
        done,
        JSON.stringify((output.issues ?? []).slice(0, 50)),
        done,
        kind,
        owner,
      )
      .run()
  } catch (error) {
    const known = classify(error)
    // log เฉพาะชนิดงานและรหัส ไม่มี token, เนื้อหา หรือข้อมูลสมาชิก
    console.error('sync failed', kind, known.code)
    const failures = state.failure_count + 1
    // งบคำขอหมดไม่ใช่ความล้มเหลว: รอบถัดไปทำต่อได้ทันทีตามช่วงปกติ
    const delayMs =
      known.code === 'budget'
        ? 0
        : Math.max((known.retryAfterSeconds ?? 0) * 1000, Math.min(MAX_BACKOFF_MS, 60_000 * 2 ** Math.min(failures - 1, 5)))
    const cursorReset = error instanceof CursorInvalid
    await env.DB.prepare(
      `UPDATE sync_state SET last_error_code = ?, last_error_message = ?, failure_count = ?, next_attempt_at = ?,
              cursor = CASE WHEN ? = 1 THEN NULL ELSE cursor END, lease_owner = NULL, lease_expires_at = NULL, updated_at = ?
        WHERE kind = ? AND lease_owner = ?`,
    )
      .bind(known.code, known.message, failures, delayMs ? new Date(Date.now() + delayMs).toISOString() : null, cursorReset ? 1 : 0, nowIso(), kind, owner)
      .run()
  }
  state = await loadState(env, kind)
  return { ran: true, used: gapi.used, status: toStatus(kind, state, kind === 'docs' ? null : await loadResource(env, kind)) }
}

/** cursor ที่เก็บไว้ใช้ไม่ได้แล้ว (เช่น sync token หมดอายุ): ล้างแล้วเริ่มดึงใหม่เฉพาะบริการนี้ในรอบถัดไป */
export class CursorInvalid extends SyncDataError {
  constructor() {
    super('ตัวชี้ตำแหน่งการซิงค์หมดอายุ ระบบจะดึงข้อมูลของแหล่งนี้ใหม่ทั้งชุดในรอบถัดไป')
  }
}

/** งบคำขอไป Google รวมของ Cron หนึ่งรอบ (Workers จำกัด subrequest ต่อการทำงานหนึ่งครั้ง) */
export const SCHEDULED_BUDGET = 40
const ROTATE_EVERY_MS = 5 * 60_000

/**
 * ใช้โดย Cron: ซิงค์ทุกบริการภายในงบคำขอรวมของหนึ่งรอบ โดยไม่มีบริการใดอดทำงาน
 * - แต่ละบริการได้งบ = งบที่เหลือ ÷ จำนวนบริการที่ยังไม่ได้ทำ ทุกบริการจึงได้อย่างน้อย งบรวม ÷ 4 = 10 คำขอเสมอ
 *   ไม่ว่าบริการก่อนหน้าจะใช้เต็มงบ ยังดึงไม่ครบหน้า หรือล้มเหลว
 * - หักตามจำนวนที่ใช้จริง งบที่บริการก่อนหน้าไม่ได้ใช้จึงตกไปให้บริการถัดไป
 * - ลำดับเริ่มต้นหมุนตามช่วงเวลา (กำหนดได้แน่นอน ไม่สุ่ม) เพื่อให้งบส่วนที่เหลือกระจายถึงทุกบริการในสี่รอบ
 * บริการที่ข้อมูลมากกว่างบของรอบเดียวเก็บตำแหน่งไว้และทำต่อในรอบถัดไป
 */
export async function runScheduled(env: AppEnv, now = Date.now()): Promise<{ kind: SyncKind; ran: boolean; budget: number; used: number }[]> {
  const offset = Math.floor(now / ROTATE_EVERY_MS) % SYNC_KINDS.length
  const order = [...SYNC_KINDS.slice(offset), ...SYNC_KINDS.slice(0, offset)]
  const report: { kind: SyncKind; ran: boolean; budget: number; used: number }[] = []
  let left = SCHEDULED_BUDGET
  for (let i = 0; i < order.length; i++) {
    const budget = Math.floor(left / (order.length - i))
    const result = await runSync(env, order[i], { budget }).catch(() => null)
    const used = Math.min(result?.used ?? 0, budget)
    left -= used
    report.push({ kind: order[i], ran: result?.ran === true, budget, used })
  }
  return report
}

/** แบ่งคำสั่ง D1 เป็นชุด เพื่อไม่ให้ batch เดียวใหญ่เกิน */
export async function batchAll(env: AppEnv, statements: D1PreparedStatement[], size = 40): Promise<void> {
  for (let i = 0; i < statements.length; i += size) await env.DB.batch(statements.slice(i, i + size))
}

export const requireWritable = (resource: SyncResource, label: string) => {
  if (resource.access !== 'write') {
    throw new HttpError(403, 'source_read_only', `บัญชี Google ของชมรมมีสิทธิ์อ่าน${label}นี้อย่างเดียว จึงแก้จากเว็บไม่ได้ แก้ที่ต้นฉบับใน Google หรือให้เจ้าของเพิ่มสิทธิ์แก้ไข`)
  }
}

const LOCK_TTL_MS = 45_000
const LOCK_WAIT_MS = 8_000

/**
 * ให้คำสั่งเขียนของเว็บไปแหล่งเดียวกันทำทีละคำขอ (ข้าม Worker instance ได้เพราะอยู่ใน D1)
 * ลดช่วง race ระหว่าง "อ่านแล้วเขียน" ของผู้ใช้เว็บด้วยกัน และทำให้คำขอซ้ำที่มาพร้อมกันเห็นผลของคำขอแรกก่อนตัดสินใจ
 * ไม่ได้กันการแก้จากฝั่ง Google โดยตรง ซึ่งแต่ละบริการตรวจด้วยวิธีของตัวเอง
 */
export async function withLock<T>(env: AppEnv, name: string, run: () => Promise<T>): Promise<T> {
  const owner = crypto.randomUUID()
  const deadline = Date.now() + LOCK_WAIT_MS
  for (;;) {
    const now = nowIso()
    const claimed = await env.DB.prepare(
      `INSERT INTO write_locks (name, owner, expires_at) VALUES (?, ?, ?)
       ON CONFLICT (name) DO UPDATE SET owner = excluded.owner, expires_at = excluded.expires_at WHERE write_locks.expires_at <= ?`,
    )
      .bind(name, owner, new Date(Date.now() + LOCK_TTL_MS).toISOString(), now)
      .run()
    if (claimed.meta.changes === 1) break
    if (Date.now() >= deadline) throw new HttpError(409, 'busy', 'มีการบันทึกรายการอื่นไปยังแหล่งข้อมูลเดียวกันอยู่ ยังไม่ได้บันทึกอะไร รอสักครู่แล้วลองอีกครั้ง')
    await new Promise((resolve) => setTimeout(resolve, 150))
  }
  try {
    return await run()
  } finally {
    await env.DB.prepare('DELETE FROM write_locks WHERE name = ? AND owner = ?').bind(name, owner).run().catch(() => undefined)
  }
}
