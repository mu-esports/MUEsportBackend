import { useCallback, useEffect, useRef, useState } from 'react'
import type { FormEvent, ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import {
  ClipboardList, CornerUpRight, File, Files, FileSpreadsheet, FileText, Film, Folder, Image, LayoutGrid, List, LoaderCircle, Music, Presentation, RefreshCw, Search, SearchX, Share2, TriangleAlert,
} from 'lucide-react'
import type { LucideIcon } from 'lucide-react'
import { AppError, messageOf } from '../data/errors'
import { formatTimestamp } from '../lib/datetime'
import { formatBytes, KIND_LABELS, libraryApi, TYPE_OPTIONS } from './api'
import type { FileKind, FileListPage, FileType, LibraryFile, ListQuery, SortKey } from './api'
import { useAuth } from '../auth/AuthProvider'
import { Thumbnail } from './Thumbnail'

// เก็บเฉพาะในหน่วยความจำและแยกตามผู้ใช้: กลับจากตัวอย่างเห็นรายการเดิมทันที ขณะตรวจข้อมูลใหม่
const snapshots = new Map<string, { page: FileListPage; at: number }>()
let snapshotViewer = ''

export const KIND_ICONS: Record<FileKind, LucideIcon> = {
  doc: FileText, sheet: FileSpreadsheet, slides: Presentation, form: ClipboardList, pdf: FileText, image: Image, office: FileText, text: FileText,
  drawing: Image, video: Film, audio: Music, folder: Folder, other: File,
}

const TYPES = TYPE_OPTIONS.map((option) => option.value)

/** หมวดที่แสดงเป็นปุ่มด้านบนของคลัง: ใช้ตัวกรองประเภทเดียวกับช่อง “ประเภท” และเก็บใน URL (?type=doc) เหมือนกัน */
const CATEGORIES: { type: FileType; label: string; icon: LucideIcon }[] = [
  { type: 'all', label: 'ทั้งหมด', icon: Files },
  { type: 'doc', label: 'Google Docs', icon: FileText },
  { type: 'sheet', label: 'Google Sheets', icon: FileSpreadsheet },
  { type: 'form', label: 'Google Forms', icon: ClipboardList },
]

function queryOf(params: URLSearchParams): ListQuery {
  const type = params.get('type') as FileType | null
  return { q: params.get('q') ?? '', type: type && TYPES.includes(type) ? type : 'all', sort: params.get('sort') === 'name' ? 'name' : 'modified' }
}

/** ส่วน query ของ URL จากตัวเลือกของรายการ (ค่าเริ่มต้นไม่ใส่ใน URL) */
function searchOf(query: ListQuery): string {
  const out = new URLSearchParams()
  if (query.q.trim()) out.set('q', query.q.trim())
  if (query.type !== 'all') out.set('type', query.type)
  if (query.sort !== 'modified') out.set('sort', query.sort)
  const text = out.toString()
  return text ? `?${text}` : ''
}

type View =
  | { kind: 'loading' }
  /** คลังยังไม่พร้อม (ยังไม่เปิดใช้ หรือการเชื่อม Google มีปัญหา): เป็นสถานะของระบบ ไม่ใช่ "ไม่มีไฟล์" */
  | { kind: 'unavailable'; message: string; reason: string }
  | { kind: 'error'; message: string }
  | { kind: 'ready' }

interface Props {
  /** path ของหน้ารายการ (ลิงก์ไปตัวอย่างคือ `${basePath}/<รหัสไฟล์>`) */
  basePath: string
  /** ส่วนที่แสดงแทนรายการเมื่อคลังยังไม่พร้อม (ฝั่งทีมงานใส่ปุ่มเปิดใช้คลัง) */
  unavailable?(info: { message: string; reason: string }): ReactNode
  /** คำอธิบายเพิ่มของหมวดที่เลือกอยู่ (ฝั่งทีมงานใช้แยก “ไฟล์ Google Forms” ออกจากหน้าเครื่องมือฟอร์ม) */
  categoryNote?(type: FileType): ReactNode
}

/** รายการไฟล์ของคลังชมรม ใช้ร่วมกันทั้งหน้าทีมงานและหน้าสมาชิก: ค้นหา กรองประเภท เรียง โหลดเพิ่มทีละหน้า และรีเฟรช */
export function FileList({ basePath, unavailable, categoryNote }: Props) {
  const { user, member } = useAuth()
  const viewer = user ? `staff:${user.id}` : member ? `member:${member.id}` : ''
  if (snapshotViewer !== viewer) { snapshots.clear(); snapshotViewer = viewer }
  const [params, setParams] = useSearchParams()
  const query = queryOf(params)
  const key = `${query.q}\n${query.type}\n${query.sort}`
  const cacheKey = `${viewer}:${key}`

  const [view, setView] = useState<View>({ kind: 'loading' })
  const [viewKey, setViewKey] = useState(key)
  const [files, setFiles] = useState<LibraryFile[]>([])
  const [meta, setMeta] = useState<Pick<FileListPage, 'nextPageToken' | 'incomplete' | 'fetchedAt' | 'stale' | 'error'> | null>(null)
  const [refreshing, setRefreshing] = useState(false)
  const [loadingMore, setLoadingMore] = useState(false)
  const [moreError, setMoreError] = useState('')
  const [text, setText] = useState(query.q)
  const [layout, setLayout] = useState<'grid' | 'list'>('grid')
  const seq = useRef(0)
  const live = useRef<HTMLParagraphElement>(null)

  const load = useCallback(
    (fresh: boolean) => {
      const current = ++seq.current
      const [q, type, sort] = key.split('\n') as [string, FileType, SortKey]
      setMoreError('')
      if (fresh) setRefreshing(true)
      else {
        const snapshot = snapshots.get(cacheKey)
        if (snapshot && Date.now() - snapshot.at < 60_000) {
          setFiles(snapshot.page.files)
          setMeta(snapshot.page)
          setView({ kind: 'ready' })
          setRefreshing(true)
        } else {
          snapshots.delete(cacheKey)
          setView({ kind: 'loading' })
          setRefreshing(false)
        }
        setViewKey(key)
        setLoadingMore(false)
      }
      libraryApi.list({ q, type, sort }, { fresh }).then(
        (page) => {
          if (current !== seq.current) return
          setFiles(page.files)
          if (snapshots.size >= 12) snapshots.delete(snapshots.keys().next().value!)
          snapshots.set(cacheKey, { page, at: Date.now() })
          setMeta(page)
          setView({ kind: 'ready' })
          setRefreshing(false)
        },
        (failure: unknown) => {
          if (current !== seq.current) return
          setRefreshing(false)
          if (failure instanceof AppError && failure.code === 'library_unavailable') {
            snapshots.delete(cacheKey)
            setView({ kind: 'unavailable', message: failure.message, reason: String(failure.data.reason ?? '') })
          } else if (fresh || snapshots.has(cacheKey)) {
            // รีเฟรชไม่สำเร็จ: รายการเดิมยังอยู่ และบอกว่าไม่ใช่ข้อมูลล่าสุด
            setMeta((previous) => (previous ? { ...previous, stale: true, error: { code: 'refresh_failed', message: messageOf(failure, 'รีเฟรชไม่สำเร็จ ลองอีกครั้ง') } } : previous))
          } else {
            setView({ kind: 'error', message: messageOf(failure, 'โหลดรายการไฟล์ไม่สำเร็จ ลองอีกครั้ง') })
          }
        },
      )
    },
    [key, cacheKey],
  )

  useEffect(() => load(false), [load])
  useEffect(() => () => { seq.current++ }, [])
  useEffect(() => setText(query.q), [query.q])

  const apply = (next: Partial<ListQuery>) => {
    setParams(new URLSearchParams(searchOf({ ...query, ...next })), { replace: true })
  }

  const submit = (event: FormEvent) => {
    event.preventDefault()
    apply({ q: text })
  }

  const more = async () => {
    if (!meta?.nextPageToken || loadingMore) return
    const current = seq.current
    setLoadingMore(true)
    setMoreError('')
    try {
      const page = await libraryApi.list(query, { pageToken: meta.nextPageToken })
      if (current !== seq.current) return
      // กันรายการซ้ำเมื่อไฟล์ถูกแก้ระหว่างโหลดสองหน้า
      const combined = { ...page, files: [...files, ...page.files.filter((file) => !files.some((existing) => existing.id === file.id))], stale: meta.stale || page.stale, error: page.error ?? meta.error }
      setFiles(combined.files)
      setMeta(combined)
      snapshots.set(cacheKey, { page: combined, at: Date.now() })
      if (live.current) live.current.textContent = `โหลดเพิ่มอีก ${page.files.length} ไฟล์`
    } catch (failure) {
      if (current !== seq.current) return
      if (failure instanceof AppError && failure.code === 'page_expired') {
        setMoreError('รายการใน Google เปลี่ยนไประหว่างที่เปิดหน้านี้ กด “รีเฟรช” เพื่อโหลดรายการใหม่จากต้น')
      } else {
        setMoreError(messageOf(failure, 'โหลดเพิ่มไม่สำเร็จ ลองอีกครั้ง'))
      }
    } finally {
      if (current === seq.current) setLoadingMore(false)
    }
  }

  const filtered = query.q.trim() !== '' || query.type !== 'all'
  // เลือกเฉพาะประเภท (ไม่มีคำค้น): ข้อความเมื่อไม่มีไฟล์บอกชื่อประเภทนั้นตรง ๆ
  const typeOnly = query.q.trim() === '' && query.type !== 'all'
  const typeLabel = TYPE_OPTIONS.find((option) => option.value === query.type)?.label ?? ''
  // URL/ตัวกรองเปลี่ยนก่อน effect โหลดข้อมูล: อย่าแสดงผลเก่าราวกับเป็นผลของเงื่อนไขใหม่
  const shownView: View = viewKey === key ? view : { kind: 'loading' }
  const note = categoryNote?.(query.type)

  return (
    <div className="file-library">
      {/* หมวดเป็นลิงก์ที่เปลี่ยนเฉพาะ ?type= ของหน้านี้: เปิดซ้ำหรือส่งลิงก์แล้วอยู่หมวดเดิม คำค้นและการเรียงที่เลือกไว้ยังอยู่ */}
      <nav className="file-categories" aria-label="หมวดไฟล์">
        {CATEGORIES.map(({ type, label, icon: Icon }) => (
          <Link
            key={type}
            to={{ search: searchOf({ ...query, q: text, type }) }}
            replace
            className={`file-category${query.type === type ? ' active' : ''}`}
            aria-current={query.type === type ? 'true' : undefined}
          >
            <Icon aria-hidden="true" size={18} />
            <span>{label}</span>
          </Link>
        ))}
      </nav>
      {note}
      <form className="file-toolbar" role="search" onSubmit={submit}>
        <div className="file-search">
          <div className="search-field">
            <Search aria-hidden="true" size={18} />
            <label htmlFor="file-search" className="visually-hidden">
              ค้นหาชื่อไฟล์
            </label>
            <input id="file-search" type="search" placeholder="ค้นหาชื่อไฟล์" value={text} onChange={(e) => setText(e.target.value)} maxLength={100} enterKeyHint="search" />
          </div>
          <button type="submit" className="button">
            ค้นหา
          </button>
        </div>
        <div className="toolbar-filter">
          <label htmlFor="file-type">ประเภท</label>
          <select id="file-type" value={query.type} onChange={(e) => apply({ q: text, type: e.target.value as FileType })}>
            {TYPE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
        </div>
        <div className="toolbar-filter">
          <label htmlFor="file-sort">เรียงตาม</label>
          <select id="file-sort" value={query.sort} onChange={(e) => apply({ q: text, sort: e.target.value as SortKey })}>
            <option value="modified">แก้ไขล่าสุด</option>
            <option value="name">ชื่อไฟล์</option>
          </select>
        </div>
      </form>
      <div className="file-view-row">
        <span className="field-hint">เลือกไฟล์เพื่อเปิดดูตัวอย่าง</span>
        <div className="file-view-switch" role="group" aria-label="มุมมองไฟล์">
          <button type="button" className="icon-button" aria-label="มุมมองตาราง" aria-pressed={layout === 'grid'} onClick={() => setLayout('grid')}><LayoutGrid size={19} aria-hidden="true" /></button>
          <button type="button" className="icon-button" aria-label="มุมมองรายการ" aria-pressed={layout === 'list'} onClick={() => setLayout('list')}><List size={19} aria-hidden="true" /></button>
        </div>
      </div>

      {shownView.kind === 'loading' && (
        <div role="status" className="file-loading">
          <p className="field-hint">กำลังโหลดรายการไฟล์…</p>
          <div className="file-grid" aria-hidden="true">{Array.from({ length: 8 }, (_, i) => <div className="file-skeleton" key={i}><div /><span /><span /></div>)}</div>
        </div>
      )}

      {shownView.kind === 'unavailable' &&
        (unavailable?.(shownView) ?? (
          <div className="state-block" role="status">
            <TriangleAlert aria-hidden="true" size={28} />
            <p className="empty-state-title">คลังไฟล์ยังไม่พร้อมใช้งาน</p>
            <p className="empty-state-text">{shownView.message}</p>
            <button type="button" className="button" onClick={() => load(false)}>
              ลองอีกครั้ง
            </button>
          </div>
        ))}

      {shownView.kind === 'error' && (
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดรายการไฟล์ไม่สำเร็จ</p>
          <p className="empty-state-text">{shownView.message}</p>
          <button type="button" className="button button-primary" onClick={() => load(false)}>
            ลองโหลดอีกครั้ง
          </button>
        </div>
      )}

      {shownView.kind === 'ready' && meta && (
        <>
          <div className="file-status">
            <p className="result-count" role="status">
              {files.length === 0
                ? meta.nextPageToken
                  ? 'ยังไม่พบไฟล์ในช่วงที่ตรวจ ยังมีรายการให้ตรวจต่อ'
                  : 'ไม่มีไฟล์ที่จะแสดง'
                : meta.nextPageToken
                  ? `แสดง ${files.length} ไฟล์แรก ยังมีไฟล์อีก`
                  : `แสดงครบ ${files.length} ไฟล์${filtered ? 'ที่ตรงกับเงื่อนไข' : ''}`}
              {' · '}
              ข้อมูลจาก Google เมื่อ {formatTimestamp(meta.fetchedAt)}
            </p>
            <button type="button" className="button button-small" onClick={() => { if (!refreshing) load(true) }} aria-disabled={refreshing}>
              <RefreshCw aria-hidden="true" size={16} className={refreshing ? 'spin' : undefined} />
              {refreshing ? 'กำลังรีเฟรช…' : 'รีเฟรช'}
            </button>
          </div>

          {meta.stale && (
            <p className="notice notice-warning" role="status">
              <TriangleAlert aria-hidden="true" size={18} />
              <span>
                รายการนี้อาจไม่ใช่ข้อมูลล่าสุด: {meta.error?.message ?? 'อัปเดตจาก Google ไม่สำเร็จ'} (กำลังแสดงรายการที่ได้เมื่อ {formatTimestamp(meta.fetchedAt)})
              </span>
            </p>
          )}
          {meta.incomplete && (
            <p className="notice notice-warning" role="status">
              <TriangleAlert aria-hidden="true" size={18} />
              <span>Google แจ้งว่าผลการค้นหาครั้งนี้อาจได้ไม่ครบ ลองรีเฟรชหรือค้นด้วยคำที่เจาะจงขึ้น</span>
            </p>
          )}

          {files.length === 0 && meta.nextPageToken ? (
            // Google ยังมีรายการให้ตรวจต่อ: ยังสรุปไม่ได้ว่าไม่มีไฟล์ ให้โหลดชุดถัดไปด้วยปุ่มด้านล่าง
            <div className="empty-state file-pending">
              <Search aria-hidden="true" size={28} />
              <p className="empty-state-title">ยังไม่พบไฟล์ที่ตรงกับเงื่อนไขในช่วงแรกของรายการ</p>
              <p className="empty-state-text">รายการของ Google ยังมีต่อ กด “โหลดไฟล์เพิ่ม” เพื่อค้นในชุดถัดไป</p>
            </div>
          ) : files.length === 0 ? (
            <div className="empty-state">
              <SearchX aria-hidden="true" size={28} />
              <p className="empty-state-title">{typeOnly ? `ยังไม่มีไฟล์ ${typeLabel} ในคลัง` : filtered ? 'ไม่พบไฟล์ที่ตรงกับเงื่อนไข' : 'ยังไม่มีไฟล์ในคลัง'}</p>
              <p className="empty-state-text">
                {typeOnly
                  ? `หมวดนี้แสดงไฟล์ ${typeLabel} ทุกไฟล์ที่บัญชี Google ของชมรมเข้าถึงได้ รวมไฟล์ที่ถูกแชร์มา ตอนนี้ยังไม่มีไฟล์ประเภทนี้`
                  : filtered
                    ? 'ลองเปลี่ยนคำค้นหาหรือประเภทไฟล์ (การค้นหาดูจากชื่อไฟล์)'
                    : 'เมื่อมีไฟล์ในบัญชี Google ของชมรม หรือมีคนแชร์ไฟล์ให้บัญชีชมรม ไฟล์จะแสดงที่นี่'}
              </p>
              {filtered && (
                <button type="button" className="button" onClick={() => apply({ q: '', type: 'all' })}>
                  {typeOnly ? 'ดูไฟล์ทั้งหมด' : 'ล้างตัวกรอง'}
                </button>
              )}
            </div>
          ) : (
            <ul className={`file-grid${layout === 'list' ? ' file-grid-list' : ''}`}>
              {files.map((file) => (
                <FileCard key={`${file.id}:${file.modifiedTime}`} file={file} visual={layout === 'grid'} to={`${basePath}/${encodeURIComponent(file.id)}`} state={{ search: params.toString() ? `?${params.toString()}` : '' }} />
              ))}
            </ul>
          )}

          <p className="visually-hidden" role="status" ref={live} />
          {moreError && (
            <p className="form-alert" role="alert">
              {moreError}
            </p>
          )}
          {meta.nextPageToken && (
            <div className="file-more">
              <button type="button" className="button" onClick={more} aria-disabled={loadingMore}>
                {loadingMore && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
                {loadingMore ? 'กำลังโหลด…' : 'โหลดไฟล์เพิ่ม'}
              </button>
              <p className="field-hint">ยังแสดงไม่ครบทุกไฟล์ กดเพื่อโหลดชุดถัดไป</p>
            </div>
          )}
        </>
      )}
    </div>
  )
}

export function FileCard({ file, to, state, visual = false }: { file: LibraryFile; to: string; state?: unknown; visual?: boolean }) {
  const Icon = KIND_ICONS[file.kind]
  return (
    <li className={`file-card${visual ? ' file-card-visual' : ''}`}>
      {visual && (file.thumbnail ? <Thumbnail url={libraryApi.thumbnailUrl(file.id, file.modifiedTime)} /> : <div className={`file-thumbnail file-thumbnail-type file-thumbnail-${file.kind}`} aria-hidden="true"><Icon size={48} strokeWidth={1.4} /><span>{KIND_LABELS[file.kind]}</span></div>)}
      <div className="file-info">
      <span className={`file-icon file-icon-${file.kind}`} aria-hidden="true">
        <Icon size={22} />
      </span>
      <div className="file-main">
        {/* ชื่อยาวถูกตัดด้วย CSS: ชื่อเต็มอยู่ในลิงก์ (โปรแกรมอ่านหน้าจออ่านครบ) ใน title และในหน้าตัวอย่าง */}
        <Link to={to} state={state} className="file-name" title={file.name}>
          {file.name}
        </Link>
        <p className="file-meta">
          <span>{KIND_LABELS[file.kind]}</span>
          {file.modifiedTime && <span>แก้ไข {formatTimestamp(file.modifiedTime)}</span>}
          {file.size !== null && <span>{formatBytes(file.size)}</span>}
        </p>
        {(file.folder || file.shortcut || file.shared || !file.previewable) && (
          <p className="file-tags">
            {file.folder && (
              <span className="file-tag" title={file.folder}>
                <Folder aria-hidden="true" size={14} />
                <span className="file-tag-text">{file.folder}</span>
              </span>
            )}
            {file.shortcut && (
              <span className="file-tag">
                <CornerUpRight aria-hidden="true" size={14} />
                ทางลัด
              </span>
            )}
            {file.shared && (
              <span className="file-tag">
                <Share2 aria-hidden="true" size={14} />
                แชร์ให้ชมรม
              </span>
            )}
            {!file.previewable && <span className="file-tag">ไม่มีตัวอย่างในเว็บ</span>}
          </p>
        )}
      </div>
      </div>
    </li>
  )
}
