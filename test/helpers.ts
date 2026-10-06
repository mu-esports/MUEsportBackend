import { env as rawEnv } from 'cloudflare:workers'
import { applyD1Migrations } from 'cloudflare:test'
import type { D1Migration } from 'cloudflare:test'
import { exportJWK, generateKeyPair, SignJWT } from 'jose'
import { vi } from 'vitest'
import { randomToken, sha256Hex } from '../worker/crypto'
import type { AppEnv, Role } from '../worker/env'
import worker from '../worker/index'

export const env = rawEnv as unknown as AppEnv & { TEST_MIGRATIONS: D1Migration[] }
export const ORIGIN = 'https://staff.example.test'
export const CLUB_EMAIL = 'muesport2567@gmail.com'

const TABLES = [
  'audit_log', 'resource_configs', 'document_operations', 'documents', 'google_connections',
  'idempotency_keys', 'events', 'members', 'oauth_states', 'sessions', 'users',
]

/** ฐานข้อมูลทดสอบ: ใช้ migrations ชุดเดียวกับของจริง แล้วล้างข้อมูลก่อนแต่ละ test */
export async function resetDb(): Promise<void> {
  await applyD1Migrations(env.DB, env.TEST_MIGRATIONS)
  await env.DB.batch(TABLES.map((table) => env.DB.prepare(`DELETE FROM ${table}`)))
}

export interface Actor {
  id: string
  cookie: string
  csrf: string
}

/** สร้างผู้ใช้และ session ในฐานทดสอบโดยตรง (ใช้เฉพาะใน test ไม่มีเส้นทางลัดแบบนี้ใน Worker) */
export async function seedUser(email: string, role: Role, options: { expiresInMs?: number; status?: string } = {}): Promise<Actor> {
  const id = crypto.randomUUID()
  const now = new Date().toISOString()
  await env.DB.prepare(
    `INSERT INTO users (id, email, google_sub, name, role, status, is_bootstrap, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  )
    .bind(id, email, `sub-${id}`, email.split('@')[0], role, options.status ?? 'active', email === CLUB_EMAIL ? 1 : 0, now, now)
    .run()
  return { id, ...(await seedSession(id, options.expiresInMs)) }
}

export async function seedSession(userId: string, expiresInMs = 3_600_000): Promise<{ cookie: string; csrf: string }> {
  const token = randomToken()
  await env.DB.prepare('INSERT INTO sessions (token_hash, user_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
    .bind(await sha256Hex(token), userId, new Date().toISOString(), new Date(Date.now() + expiresInMs).toISOString())
    .run()
  return { cookie: `mu_session=${token}`, csrf: await sha256Hex(`csrf:${token}`) }
}

interface CallOptions {
  method?: string
  body?: unknown
  as?: Actor | null
  headers?: Record<string, string>
  /** ไม่ใส่ Origin/CSRF ให้อัตโนมัติ ใช้ทดสอบการป้องกัน */
  raw?: boolean
  cookie?: string
  env?: AppEnv
}

export async function call(path: string, options: CallOptions = {}): Promise<Response> {
  const method = options.method ?? 'GET'
  const headers = new Headers(options.headers)
  const cookies = [options.as?.cookie, options.cookie].filter(Boolean).join('; ')
  if (cookies) headers.set('Cookie', cookies)
  if (method !== 'GET' && !options.raw) {
    headers.set('Origin', ORIGIN)
    if (options.as) headers.set('X-CSRF-Token', options.as.csrf)
  }
  let body: string | undefined
  if (options.body !== undefined) {
    body = typeof options.body === 'string' ? options.body : JSON.stringify(options.body)
    if (!headers.has('Content-Type')) headers.set('Content-Type', 'application/json')
  }
  return worker.fetch(new Request(ORIGIN + path, { method, headers, body, redirect: 'manual' }) as never, options.env ?? env)
}

export const key = () => randomToken(16)

export async function data<T = Record<string, any>>(response: Response): Promise<T> {
  return (await response.json()) as T
}

// ---------- Google จำลอง ----------

interface FakeDoc {
  id: string
  title: string
  /** เนื้อหาทั้งหมดรวม newline สุดท้าย */
  text: string
  revision: number
  appProperties: Record<string, string>
  /** โครงสร้างเพิ่มที่ editor ไม่รองรับ ใช้ทดสอบ */
  rich?: 'table' | 'image' | 'tabs' | 'header' | 'heading' | 'bold' | 'suggestion' | 'list'
}

interface Identity {
  sub: string
  email: string
  email_verified?: boolean
  name?: string
}

interface CodeGrant {
  identity: Identity
  nonce: string
  refreshToken?: string
  scope?: string
}

type Interceptor = (url: URL, init: RequestInit | undefined) => Response | undefined | Promise<Response | undefined>

const jsonResponse = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })

/** Google จำลองที่ตอบแทน endpoint จริงผ่าน global fetch ของ test เท่านั้น */
export class FakeGoogle {
  docs = new Map<string, FakeDoc>()
  codes = new Map<string, CodeGrant>()
  refreshTokens = new Map<string, 'valid' | 'invalid_grant'>()
  calls: { method: string; url: string }[] = []
  interceptors: Interceptor[] = []
  private keys!: { privateKey: CryptoKey; jwk: Record<string, unknown> }
  private counter = 0

  static async start(): Promise<FakeGoogle> {
    const google = new FakeGoogle()
    const { privateKey, publicKey } = await generateKeyPair('RS256', { extractable: true })
    google.keys = { privateKey: privateKey as CryptoKey, jwk: { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' } }
    vi.stubGlobal('fetch', (input: RequestInfo | URL, init?: RequestInit) => google.handle(input, init))
    return google
  }

  /** ให้คำขอถัดไปที่ตรงเงื่อนไขล้มเหลวหนึ่งครั้ง */
  failOnce(match: (url: URL, method: string) => boolean, status = 500, body: unknown = { error: 'injected' }) {
    let used = false
    this.interceptors.push((url, init) => {
      if (used || !match(url, init?.method ?? 'GET')) return undefined
      used = true
      return jsonResponse(body, status)
    })
  }

  grant(code: string, grant: CodeGrant) {
    this.codes.set(code, grant)
  }

  async idToken(identity: Identity, nonce: string, overrides: Record<string, unknown> = {}): Promise<string> {
    return new SignJWT({ email_verified: true, ...identity, nonce, ...overrides })
      .setProtectedHeader({ alg: 'RS256', kid: 'test-key' })
      .setIssuer((overrides.iss as string) ?? 'https://accounts.google.com')
      .setAudience((overrides.aud as string) ?? 'test-client-id')
      .setIssuedAt()
      .setExpirationTime(overrides.expired ? Math.floor(Date.now() / 1000) - 60 : '5m')
      .sign(this.keys.privateKey)
  }

  addDoc(title: string, text: string, rich?: FakeDoc['rich']): FakeDoc {
    const doc: FakeDoc = { id: `gdoc-${++this.counter}`, title, text: `${text}\n`, revision: 1, appProperties: {}, rich }
    this.docs.set(doc.id, doc)
    return doc
  }

  /** จำลองการแก้จากฝั่ง Google Docs โดยตรง */
  editExternally(id: string, text: string) {
    const doc = this.docs.get(id)!
    doc.text = `${text}\n`
    doc.revision++
  }

  private async handle(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const url = new URL(typeof input === 'string' ? input : input instanceof URL ? input.href : input.url)
    const method = init?.method ?? 'GET'
    this.calls.push({ method, url: url.href })
    for (const interceptor of this.interceptors) {
      const response = await interceptor(url, init)
      if (response) return response
    }

    if (url.href.startsWith('https://www.googleapis.com/oauth2/v3/certs')) return jsonResponse({ keys: [this.keys.jwk] })
    if (url.href === 'https://oauth2.googleapis.com/token') return this.token(new URLSearchParams(init?.body as URLSearchParams))
    if (url.href === 'https://oauth2.googleapis.com/revoke') return jsonResponse({})

    const auth = new Headers(init?.headers).get('Authorization') ?? ''
    if (!auth.startsWith('Bearer access-')) return jsonResponse({ error: { code: 401 } }, 401)

    if (url.origin === 'https://www.googleapis.com' && url.pathname.startsWith('/drive/v3/files')) return this.drive(url, method, init)
    if (url.origin === 'https://docs.googleapis.com') return this.docsApi(url, method, init)
    return jsonResponse({ error: 'unknown endpoint' }, 404)
  }

  private async token(params: URLSearchParams): Promise<Response> {
    if (params.get('client_secret') !== 'test-client-secret') return jsonResponse({ error: 'invalid_client' }, 401)
    if (params.get('grant_type') === 'authorization_code') {
      const grant = this.codes.get(params.get('code') ?? '')
      if (!grant || !params.get('code_verifier')) return jsonResponse({ error: 'invalid_grant' }, 400)
      this.codes.delete(params.get('code')!)
      if (grant.refreshToken) this.refreshTokens.set(grant.refreshToken, 'valid')
      return jsonResponse({
        access_token: `access-${++this.counter}`,
        expires_in: 3600,
        scope: grant.scope ?? 'openid email profile',
        id_token: await this.idToken(grant.identity, grant.nonce),
        ...(grant.refreshToken ? { refresh_token: grant.refreshToken } : {}),
      })
    }
    const state = this.refreshTokens.get(params.get('refresh_token') ?? '')
    if (state !== 'valid') return jsonResponse({ error: 'invalid_grant' }, 400)
    return jsonResponse({ access_token: `access-${++this.counter}`, expires_in: 3600 })
  }

  private drive(url: URL, method: string, init?: RequestInit): Response {
    const id = url.pathname.split('/')[4]
    if (method === 'POST' && !id) {
      const body = JSON.parse(init?.body as string) as { name: string; appProperties?: Record<string, string> }
      const doc = this.addDoc(body.name, '')
      doc.appProperties = body.appProperties ?? {}
      return jsonResponse({ id: doc.id })
    }
    if (method === 'GET' && !id) {
      const match = /value='([^']+)'/.exec(url.searchParams.get('q') ?? '')
      const files = [...this.docs.values()].filter((d) => d.appProperties.muOperation === match?.[1]).map((d) => ({ id: d.id }))
      return jsonResponse({ files })
    }
    const doc = this.docs.get(id)
    if (!doc) return jsonResponse({ error: { code: 404 } }, 404)
    if (method === 'PATCH') {
      doc.title = (JSON.parse(init?.body as string) as { name: string }).name
      doc.revision++
      return jsonResponse({ id: doc.id })
    }
    return jsonResponse({ error: 'unsupported' }, 400)
  }

  private docsApi(url: URL, method: string, init?: RequestInit): Response {
    const [, , , rawId] = url.pathname.split('/')
    const [id, action] = decodeURIComponent(rawId).split(':')
    const doc = this.docs.get(id)
    if (!doc) return jsonResponse({ error: { code: 404 } }, 404)
    if (method === 'GET') {
      if (url.searchParams.get('includeTabsContent') !== 'true') return jsonResponse({ error: 'test requires includeTabsContent' }, 400)
      return jsonResponse(toDocsJson(doc))
    }
    if (method === 'POST' && action === 'batchUpdate') {
      const body = JSON.parse(init?.body as string) as {
        requests: Record<string, any>[]
        writeControl?: { requiredRevisionId?: string }
      }
      if (body.writeControl?.requiredRevisionId !== `rev-${doc.revision}`) return jsonResponse({ error: { code: 400, status: 'FAILED_PRECONDITION' } }, 400)
      let text = doc.text
      for (const request of body.requests) {
        if (request.deleteContentRange) {
          const { startIndex, endIndex, tabId } = request.deleteContentRange.range
          // เหมือน Google: ลบ newline สุดท้ายของเอกสารไม่ได้ และต้องระบุแท็บที่มีจริง
          if (tabId !== 't.0' || startIndex < 1 || endIndex > text.length || endIndex <= startIndex) return jsonResponse({ error: { code: 400 } }, 400)
          text = text.slice(0, startIndex - 1) + text.slice(endIndex - 1)
        } else if (request.insertText) {
          const { index, tabId } = request.insertText.location
          if (tabId !== 't.0' || index < 1 || index > text.length) return jsonResponse({ error: { code: 400 } }, 400)
          text = text.slice(0, index - 1) + request.insertText.text + text.slice(index - 1)
        } else {
          return jsonResponse({ error: { code: 400 } }, 400)
        }
      }
      doc.text = text
      doc.revision++
      return jsonResponse({ documentId: doc.id })
    }
    return jsonResponse({ error: 'unsupported' }, 400)
  }
}

/** คำตอบ documents.get ตามรูปแบบของ Google Docs API (ย่อเฉพาะส่วนที่ระบบใช้) */
export function toDocsJson(doc: Pick<FakeDoc, 'id' | 'title' | 'text' | 'revision' | 'rich'>): Record<string, any> {
  const content: Record<string, any>[] = [{ endIndex: 1, sectionBreak: { sectionStyle: {} } }]
  let index = 1
  for (const line of doc.text.match(/[^\n]*\n/g) ?? []) {
    content.push({
      startIndex: index,
      endIndex: index + line.length,
      paragraph: {
        elements: [{ startIndex: index, endIndex: index + line.length, textRun: { content: line, textStyle: {} } }],
        paragraphStyle: { namedStyleType: 'NORMAL_TEXT', direction: 'LEFT_TO_RIGHT' },
      },
    })
    index += line.length
  }
  const documentTab: Record<string, any> = { body: { content }, documentStyle: {}, namedStyles: {} }
  const tabs: Record<string, any>[] = [{ tabProperties: { tabId: 't.0', title: 'Tab 1', index: 0 }, documentTab }]
  const first = content[1].paragraph

  if (doc.rich === 'table') content.push({ startIndex: index, endIndex: index + 10, table: { rows: 1, columns: 1, tableRows: [] } })
  if (doc.rich === 'image') {
    first.elements.push({ startIndex: 1, endIndex: 2, inlineObjectElement: { inlineObjectId: 'kix.1' } })
    documentTab.inlineObjects = { 'kix.1': {} }
  }
  if (doc.rich === 'tabs') tabs.push({ tabProperties: { tabId: 't.1', title: 'Tab 2', index: 1 }, documentTab: { body: { content: [] } } })
  if (doc.rich === 'header') documentTab.headers = { 'kix.h': { content: [] } }
  if (doc.rich === 'heading') first.paragraphStyle.namedStyleType = 'HEADING_1'
  if (doc.rich === 'bold') first.elements[0].textRun.textStyle = { bold: true }
  if (doc.rich === 'suggestion') first.elements[0].textRun.suggestedInsertionIds = ['suggest.1']
  if (doc.rich === 'list') {
    first.bullet = { listId: 'kix.list' }
    documentTab.lists = { 'kix.list': {} }
  }
  return { documentId: doc.id, title: doc.title, revisionId: `rev-${doc.revision}`, tabs }
}
