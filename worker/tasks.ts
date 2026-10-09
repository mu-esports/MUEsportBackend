import type { Ctx } from './env'
import { nowIso } from './env'
import { HttpError, json, readJson } from './http'
import { requireMember, requireMemberMutation, requireMutation, requireUser, requireViewer } from './session'
import {
  expectedVersion,
  findIdempotent,
  hashPayload,
  idempotencyInsert,
  idempotencyKey,
  invalid,
  oneOf,
  text,
} from './validation'
import { MAX_FILE_BYTES, MAX_SUBMISSION_BYTES, taskAvailability, taskTime } from '../src/tasks/types'
import type { Task, TaskFile, TaskInput, TaskUnit } from '../src/tasks/types'

interface Row {
  id: string
  title: string
  category: string
  instructions: string
  start_at: string
  due_at: string
  kind: Task['kind']
  status: Task['status']
  version: number
  assignees: string
  total_units: number
  submitted_units: number
}
const SELECT = `SELECT t.*,
  (SELECT json_group_array(json_object('id',m.id,'name',m.name,'nickname',m.nickname)) FROM task_assignees a JOIN members m ON m.id=a.member_id WHERE a.task_id=t.id) AS assignees,
  (SELECT count(*) FROM task_units u WHERE u.task_id=t.id) AS total_units,
  (SELECT count(*) FROM task_units u WHERE u.task_id=t.id AND u.current_submission_id IS NOT NULL) AS submitted_units FROM tasks t`
const view = (r: Row): Task => ({
  id: r.id,
  title: r.title,
  category: r.category,
  instructions: r.instructions,
  start: r.start_at,
  due: r.due_at,
  kind: r.kind,
  status: r.status,
  version: r.version,
  assignees: JSON.parse(r.assignees),
  totalUnits: r.total_units,
  submittedUnits: r.submitted_units,
  units: [],
})
const missing = () => new HttpError(404, 'not_found', 'ไม่พบงานนี้ หรือคุณไม่ได้รับมอบหมายงานนี้')
const conflict = () =>
  new HttpError(409, 'version_conflict', 'งานหรือชุดส่งงานเปลี่ยนจากที่อื่นแล้ว โหลดข้อมูลล่าสุดก่อนส่งอีกครั้ง')

async function task(ctx: Ctx, id: string, memberId?: string): Promise<Task> {
  const row = await ctx.env.DB.prepare(
    `${SELECT} WHERE t.id=? ${memberId ? 'AND EXISTS(SELECT 1 FROM task_assignees WHERE task_id=t.id AND member_id=?)' : ''}`,
  )
    .bind(...(memberId ? [id, memberId] : [id]))
    .first<Row>()
  if (!row) throw missing()
  return view(row)
}
interface UnitRow {
  id: string
  unit_key: string
  version: number
  submission_id: string | null
  mode: 'file' | 'link'
  link_url: string
  note: string
  submitted_at: string
  late: number
  author: string | null
}
async function units(ctx: Ctx, t: Task, memberId?: string): Promise<TaskUnit[]> {
  const rows = await ctx.env.DB.prepare(
    `SELECT u.id,u.unit_key,u.version,s.id AS submission_id,s.mode,s.link_url,s.note,s.submitted_at,s.late,m.name AS author
    FROM task_units u LEFT JOIN task_submissions s ON s.id=u.current_submission_id LEFT JOIN members m ON m.id=s.submitted_by
    WHERE u.task_id=? ${memberId ? 'AND u.unit_key=?' : ''} ORDER BY u.unit_key`,
  )
    .bind(...(memberId ? [t.id, t.kind === 'group' ? 'group' : memberId] : [t.id]))
    .all<UnitRow>()
  const files = await ctx.env.DB.prepare(
    `SELECT f.id,f.name,f.mime,f.size,f.submission_id FROM task_files f JOIN task_units u ON u.current_submission_id=f.submission_id WHERE u.task_id=? ${memberId ? 'AND u.unit_key=?' : ''}`,
  )
    .bind(...(memberId ? [t.id, t.kind === 'group' ? 'group' : memberId] : [t.id]))
    .all<TaskFile & { submission_id: string }>()
  return rows.results.map((r) => ({
    id: r.id,
    unitKey: r.unit_key,
    version: r.version,
    submission: r.submission_id
      ? {
          id: r.submission_id,
          mode: r.mode,
          linkUrl: r.link_url,
          note: r.note,
          submittedAt: r.submitted_at,
          late: !!r.late,
          submittedBy: r.author ?? 'สมาชิกที่ลบแล้ว',
          files: files.results
            .filter((f) => f.submission_id === r.submission_id)
            .map(({ id, name, mime, size }) => ({ id, name, mime, size })),
        }
      : null,
  }))
}
async function list(ctx: Ctx, memberId?: string): Promise<Response> {
  const rows = await ctx.env.DB.prepare(
    `${SELECT} ${memberId ? 'WHERE EXISTS(SELECT 1 FROM task_assignees WHERE task_id=t.id AND member_id=?)' : ''} ORDER BY t.status DESC,t.due_at DESC,t.id LIMIT 101`,
  )
    .bind(...(memberId ? [memberId] : []))
    .all<Row>()
  // Member counts are for their own submission, rather than revealing other individuals' progress.
  const own = memberId
    ? (
        await ctx.env.DB.prepare(
          `SELECT u.task_id,u.current_submission_id FROM task_units u WHERE (u.unit_key=? OR u.unit_key='group') AND EXISTS(SELECT 1 FROM task_assignees a WHERE a.task_id=u.task_id AND a.member_id=?)`,
        )
          .bind(memberId, memberId)
          .all<{ task_id: string; current_submission_id: string | null }>()
      ).results
    : []
  return json({
    tasks: rows.results.slice(0, 100).map((r) => {
      const t = view(r)
      if (memberId) {
        t.totalUnits = 1
        t.submittedUnits = own.some((u) => u.task_id === t.id && u.current_submission_id) ? 1 : 0
      }
      return t
    }),
    truncated: rows.results.length > 100,
  })
}
function input(body: Record<string, unknown>): TaskInput {
  const start = text(body, 'start', 'วันเริ่ม', 16, true),
    due = text(body, 'due', 'กำหนดส่ง', 16, true)
  for (const value of [start, due]) {
    if (
      !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/.test(value) ||
      !Number.isFinite(taskTime(value)) ||
      new Date(taskTime(value) + 7 * 3600000).toISOString().slice(0, 16) !== value
    )
      throw invalid('วันและเวลาไม่ถูกต้อง')
  }
  if (start > due) throw invalid('กำหนดส่งต้องไม่ก่อนวันเริ่ม', 'due')
  if (
    !Array.isArray(body.assigneeIds) ||
    body.assigneeIds.length < 1 ||
    body.assigneeIds.length > 50 ||
    body.assigneeIds.some((id) => typeof id !== 'string' || id.length > 64)
  )
    throw invalid('เลือกสมาชิกที่รับงาน 1–50 คน', 'assigneeIds')
  const ids = [...new Set(body.assigneeIds as string[])]
  return {
    title: text(body, 'title', 'ชื่องาน', 150, true),
    category: text(body, 'category', 'ประเภทงาน', 80, true),
    instructions: text(body, 'instructions', 'รายละเอียด', 5000),
    start,
    due,
    kind: oneOf(body, 'kind', 'รูปแบบงาน', ['individual', 'group']),
    status: oneOf(body, 'status', 'สถานะงาน', ['open', 'archived']),
    assigneeIds: ids,
  }
}
async function save(ctx: Ctx, id?: string): Promise<Response> {
  const session = await requireMutation(ctx)
  const body = await readJson(ctx.request, 16000),
    p = input(body),
    now = nowIso()
  const key = !id ? idempotencyKey(ctx.request) : '',
    hash = !id ? await hashPayload(p) : ''
  if (!id) {
    const replay = await findIdempotent(ctx.env, session.user.id, key, 'tasks:create', hash)
    if (replay) return json({ task: await task(ctx, replay), replayed: true })
  }
  const active = await ctx.env.DB.prepare(
    "SELECT count(*) AS n FROM members WHERE status='active' AND id IN (SELECT value FROM json_each(?))",
  )
    .bind(JSON.stringify(p.assigneeIds))
    .first<{ n: number }>()
  if (active?.n !== p.assigneeIds.length) throw invalid('สมาชิกที่รับงานต้องมีสถานะใช้งานทุกคน', 'assigneeIds')
  const current = id ? await task(ctx, id) : null
  const version = id ? expectedVersion(body) : 1
  const assigneesChanged =
    !!current &&
    (current.kind !== p.kind ||
      JSON.stringify(current.assignees.map((m) => m.id).sort()) !== JSON.stringify([...p.assigneeIds].sort()))
  if (current && current.submittedUnits && assigneesChanged)
    throw new HttpError(409, 'assignments_locked', 'มีการส่งงานแล้ว เปลี่ยนผู้รับงานหรือรูปแบบไม่ได้ ให้สร้างงานใหม่')
  const taskId = id ?? crypto.randomUUID(),
    mutation = crypto.randomUUID()
  const statements: D1PreparedStatement[] = []
  if (id)
    statements.push(
      ctx.env.DB.prepare(
        `UPDATE tasks SET title=?,category=?,instructions=?,start_at=?,due_at=?,kind=?,status=?,version=version+1,updated_by=?,updated_at=?,mutation_token=? WHERE id=? AND version=?
    AND (?=0 OR NOT EXISTS(SELECT 1 FROM task_units WHERE task_id=? AND current_submission_id IS NOT NULL))`,
      ).bind(
        p.title,
        p.category,
        p.instructions,
        p.start,
        p.due,
        p.kind,
        p.status,
        session.user.id,
        now,
        mutation,
        id,
        version,
        assigneesChanged ? 1 : 0,
        id,
      ),
    )
  else
    statements.push(
      ctx.env.DB.prepare(
        'INSERT INTO tasks (id,title,category,instructions,start_at,due_at,kind,status,created_by,updated_by,created_at,updated_at,mutation_token) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
      ).bind(
        taskId,
        p.title,
        p.category,
        p.instructions,
        p.start,
        p.due,
        p.kind,
        p.status,
        session.user.id,
        session.user.id,
        now,
        now,
        mutation,
      ),
    )
  // The update marker fences every dependent statement against a failed CAS or a concurrent submission.
  const fence = 'EXISTS(SELECT 1 FROM tasks WHERE id=? AND version=? AND mutation_token=?)'
  const args = [taskId, id ? version + 1 : 1, mutation]
  if (!id || assigneesChanged) {
    statements.push(ctx.env.DB.prepare(`DELETE FROM task_units WHERE task_id=? AND ${fence}`).bind(taskId, ...args))
    statements.push(ctx.env.DB.prepare(`DELETE FROM task_assignees WHERE task_id=? AND ${fence}`).bind(taskId, ...args))
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO task_assignees(task_id,member_id) SELECT ?,value FROM json_each(?) WHERE ${fence}`,
      ).bind(taskId, JSON.stringify(p.assigneeIds), ...args),
    )
    statements.push(
      ctx.env.DB.prepare(
        `INSERT INTO task_units(id,task_id,unit_key) SELECT ?||':'||value,?,value FROM json_each(?) WHERE ${fence}`,
      ).bind(taskId, taskId, JSON.stringify(p.kind === 'group' ? ['group'] : p.assigneeIds), ...args),
    )
  }
  if (!id) statements.push(idempotencyInsert(ctx.env, session.user.id, key, 'tasks:create', hash, taskId))
  let result: D1Result[]
  try {
    result = await ctx.env.DB.batch(statements)
  } catch (error) {
    if (!id) {
      const replay = await findIdempotent(ctx.env, session.user.id, key, 'tasks:create', hash)
      if (replay) return json({ task: await task(ctx, replay), replayed: true })
    }
    throw error
  }
  if (result[0].meta.changes !== 1) throw conflict()
  return json({ task: await task(ctx, taskId) }, id ? 200 : 201)
}

const MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  pdf: 'application/pdf',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  xls: 'application/vnd.ms-excel',
  xlsx: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  ppt: 'application/vnd.ms-powerpoint',
  pptx: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
  csv: 'text/csv',
  txt: 'text/plain',
  zip: 'application/zip',
}
// Native hex encoding avoids expanding a binary binding into millions of JS numbers.
// 768 KiB becomes 1.5 MiB of hex, below D1's 2 MB value limit; 20 MiB still fits the Free query budget.
const CHUNK_BYTES = 768 * 1024
const hexEncode = (bytes: Uint8Array) => (bytes as Uint8Array & { toHex(): string }).toHex()
const hexDecode = (hex: string) => (Uint8Array as typeof Uint8Array & { fromHex(value: string): Uint8Array }).fromHex(hex)
function fileType(name: string, bytes: Uint8Array): string {
  const ext = name.split('.').pop()?.toLowerCase() ?? '',
    mime = MIME[ext]
  const prefix = (values: number[]) => values.every((v, i) => bytes[i] === v)
  const valid =
    ext === 'png'
      ? prefix([137, 80, 78, 71, 13, 10, 26, 10])
      : ['jpg', 'jpeg'].includes(ext)
        ? prefix([255, 216, 255])
        : ext === 'pdf'
          ? prefix([37, 80, 68, 70, 45])
          : ['doc', 'xls', 'ppt'].includes(ext)
            ? prefix([208, 207, 17, 224, 161, 177, 26, 225])
            : ['docx', 'xlsx', 'pptx', 'zip'].includes(ext)
              ? prefix([80, 75, 3, 4])
              : ['csv', 'txt'].includes(ext)
                ? !bytes.slice(0, 4096).includes(0)
                : false
  if (!mime || !valid) throw invalid(`ไฟล์ ${name} ไม่ใช่ชนิดที่รองรับ หรือเนื้อหาไม่ตรงกับนามสกุล`, 'files')
  return mime
}
async function boundedForm(request: Request): Promise<FormData> {
  const max = MAX_SUBMISSION_BYTES + 128 * 1024
  if (Number(request.headers.get('Content-Length') ?? 0) > max)
    throw new HttpError(413, 'payload_too_large', 'ชุดส่งงานรวมต้องไม่เกิน 20 MB')
  const reader = request.body?.getReader(),
    chunks: Uint8Array[] = []
  if (!reader) throw invalid('เลือกไฟล์สำหรับส่งงาน', 'files')
  let size = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      size += value.byteLength
      if (size > max) {
        await reader.cancel()
        throw new HttpError(413, 'payload_too_large', 'ชุดส่งงานรวมต้องไม่เกิน 20 MB')
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  try {
    return await new Response(
      new Blob(chunks.map((c) => c.buffer.slice(c.byteOffset, c.byteOffset + c.byteLength) as ArrayBuffer)),
      { headers: { 'Content-Type': request.headers.get('Content-Type') ?? '' } },
    ).formData()
  } catch {
    throw invalid('รูปแบบชุดส่งงานไม่ถูกต้อง')
  }
}
async function submit(ctx: Ctx, id: string): Promise<Response> {
  const session = await requireMemberMutation(ctx),
    memberId = session.member.id
  const t = await task(ctx, id, memberId)
  const state = taskAvailability(t)
  if (state === 'archived' || state === 'upcoming')
    throw new HttpError(
      409,
      'submission_closed',
      state === 'upcoming' ? 'ยังไม่ถึงเวลาเริ่มส่งงาน' : 'งานนี้ปิดรับการส่งแล้ว',
    )
  const key = idempotencyKey(ctx.request)
  let body: Record<string, unknown>,
    uploaded: File[] = []
  if ((ctx.request.headers.get('Content-Type') ?? '').startsWith('multipart/form-data')) {
    const form = await boundedForm(ctx.request)
    body = {
      mode: 'file',
      note: form.get('note'),
      expectedVersion: Number(form.get('expectedVersion')),
      taskVersion: Number(form.get('taskVersion')),
    }
    const entries = form.getAll('files')
    if (entries.some((e) => typeof e === 'string')) throw invalid('ไฟล์ไม่ถูกต้อง', 'files')
    uploaded = entries as File[]
  } else body = await readJson(ctx.request, 8192)
  const mode = oneOf(body, 'mode', 'รูปแบบการส่ง', ['file', 'link']),
    note = text(body, 'note', 'หมายเหตุ', 2000)
  let linkUrl = ''
  if (mode === 'link') {
    linkUrl = text(body, 'linkUrl', 'ลิงก์', 2048, true)
    try {
      const u = new URL(linkUrl)
      if (u.protocol !== 'https:' || u.username || u.password) throw Error()
      linkUrl = u.href
    } catch {
      throw invalid('ใช้ลิงก์ HTTPS ที่ถูกต้อง', 'linkUrl')
    }
  } else if (
    uploaded.length < 1 ||
    uploaded.length > 3 ||
    uploaded.reduce((n, f) => n + f.size, 0) > MAX_SUBMISSION_BYTES
  )
    throw invalid('เลือก 1–3 ไฟล์ รวมไม่เกิน 20 MB', 'files')
  const files = [] as { id: string; name: string; mime: string; size: number; hash: string; bytes: Uint8Array }[]
  for (const f of uploaded) {
    if (f.size < 1 || f.size > MAX_FILE_BYTES) throw invalid('แต่ละไฟล์ต้องมีขนาด 1 ไบต์–10 MB', 'files')
    const name = f.name.replace(/[\\/\x00-\x1f\x7f]/g, '_').slice(0, 200)
    const bytes = new Uint8Array(await f.arrayBuffer()),
      mime = fileType(name, bytes)
    const digest = await crypto.subtle.digest('SHA-256', bytes)
    files.push({
      id: crypto.randomUUID(),
      name,
      mime,
      size: bytes.length,
      hash: Array.from(new Uint8Array(digest), (v) => v.toString(16).padStart(2, '0')).join(''),
      bytes,
    })
  }
  const hash = await hashPayload({
    mode,
    note,
    linkUrl,
    files: files.map((f) => ({ name: f.name, mime: f.mime, size: f.size, hash: f.hash })),
  })
  const unitKey = t.kind === 'group' ? 'group' : memberId
  const u = await ctx.env.DB.prepare('SELECT id,version FROM task_units WHERE task_id=? AND unit_key=?')
    .bind(id, unitKey)
    .first<{ id: string; version: number }>()
  if (!u) throw missing()
  const replay = await ctx.env.DB.prepare('SELECT unit_id,submitted_by,payload_hash FROM task_submissions WHERE id=?')
    .bind(key)
    .first<{ unit_id: string; submitted_by: string; payload_hash: string }>()
  if (replay) {
    if (replay.unit_id !== u.id || replay.submitted_by !== memberId || replay.payload_hash !== hash)
      throw new HttpError(409, 'idempotency_mismatch', 'คำขอเดิมมีข้อมูลไม่ตรงกัน')
    return json({ ok: true, replayed: true, submissionId: key })
  }
  const version = expectedVersion(body)
  if (body.taskVersion !== t.version) throw conflict()
  const at = nowIso(),
    bangkok = new Date(Date.parse(at) + 7 * 3600000).toISOString().slice(0, 16),
    mutation = crypto.randomUUID()
  const statements = [
    ctx.env.DB.prepare(
      `UPDATE task_units SET version=version+1,current_submission_id=?,mutation_token=? WHERE id=? AND version=?
    AND EXISTS(SELECT 1 FROM tasks t JOIN task_assignees a ON a.task_id=t.id WHERE t.id=? AND t.version=? AND t.status='open' AND t.start_at<=? AND a.member_id=?)`,
    ).bind(key, mutation, u.id, version, id, t.version, bangkok, memberId),
    ctx.env.DB.prepare(
      `INSERT INTO task_submissions(id,unit_id,submitted_by,mode,link_url,note,submitted_at,late,payload_hash)
      SELECT ?,?,?,?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM task_units WHERE id=? AND version=? AND mutation_token=?)`,
    ).bind(
      key,
      u.id,
      memberId,
      mode,
      linkUrl,
      note,
      at,
      taskTime(t.due) < Date.parse(at) ? 1 : 0,
      hash,
      u.id,
      version + 1,
      mutation,
    ),
  ]
  for (const f of files) {
    statements.push(
      ctx.env.DB.prepare(
        'INSERT INTO task_files(id,submission_id,name,mime,size,sha256) SELECT ?,?,?,?,?,? WHERE EXISTS(SELECT 1 FROM task_units WHERE current_submission_id=? AND mutation_token=?)',
      ).bind(f.id, key, f.name, f.mime, f.size, f.hash, key, mutation),
    )
    for (let pos = 0, part = 0; pos < f.size; pos += CHUNK_BYTES, part++)
      statements.push(
        ctx.env.DB.prepare(
          'INSERT INTO task_file_chunks(file_id,part,bytes) SELECT ?,?,unhex(?) WHERE EXISTS(SELECT 1 FROM task_files WHERE id=?)',
        ).bind(f.id, part, hexEncode(f.bytes.subarray(pos, pos + CHUNK_BYTES)), f.id),
      )
  }
  const result = await ctx.env.DB.batch(statements)
  if (result[0].meta.changes !== 1) {
    const saved = await ctx.env.DB.prepare('SELECT unit_id,submitted_by,payload_hash FROM task_submissions WHERE id=?')
      .bind(key)
      .first<{ unit_id: string; submitted_by: string; payload_hash: string }>()
    if (saved?.unit_id === u.id && saved.submitted_by === memberId && saved.payload_hash === hash)
      return json({ ok: true, replayed: true, submissionId: key })
    throw conflict()
  }
  return json({ ok: true, replayed: false, submissionId: key }, 201)
}
async function download(ctx: Ctx, id: string): Promise<Response> {
  const session = requireViewer(ctx)
  const memberId = session.kind === 'member' ? session.member.id : null
  const f = await ctx.env.DB.prepare(
    `SELECT f.* FROM task_files f JOIN task_submissions s ON s.id=f.submission_id JOIN task_units u ON u.id=s.unit_id
    WHERE f.id=? ${memberId ? "AND (u.unit_key='group' OR u.unit_key=?) AND EXISTS(SELECT 1 FROM task_assignees WHERE task_id=u.task_id AND member_id=?)" : ''}`,
  )
    .bind(...(memberId ? [id, memberId, memberId] : [id]))
    .first<TaskFile>()
  if (!f) throw missing()
  let part = 0
  const stream = new ReadableStream<Uint8Array>({
    async pull(controller) {
      const chunk = await ctx.env.DB.prepare('SELECT hex(bytes) AS hex FROM task_file_chunks WHERE file_id=? AND part=?')
        .bind(id, part++)
        .first<{ hex: string }>()
      if (!chunk) {
        controller.close()
        return
      }
      controller.enqueue(hexDecode(chunk.hex))
    },
  })
  return new Response(stream, {
    headers: {
      'Content-Type': f.mime,
      'Content-Length': String(f.size),
      'Content-Disposition': `attachment; filename*=UTF-8''${encodeURIComponent(f.name)}`,
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  })
}
export async function handleTasks(ctx: Ctx, parts: string[], member = false): Promise<Response | null> {
  const memberId = member ? requireMember(ctx).member.id : undefined
  if (!member) requireUser(ctx)
  const [id, action] = parts,
    method = ctx.request.method
  if (parts.length === 0 && method === 'GET') return list(ctx, memberId)
  if (parts.length === 0 && method === 'POST' && !member) return save(ctx)
  if (parts.length === 1 && method === 'GET') {
    const t = await task(ctx, id, memberId)
    t.units = await units(ctx, t, memberId)
    return json({ task: t })
  }
  if (parts.length === 1 && method === 'PATCH' && !member) return save(ctx, id)
  if (parts.length === 2 && action === 'submissions' && method === 'POST' && member) return submit(ctx, id)
  return null
}
export async function handleTaskFiles(ctx: Ctx, parts: string[]): Promise<Response | null> {
  return parts.length === 1 && ctx.request.method === 'GET' ? download(ctx, parts[0]) : null
}
