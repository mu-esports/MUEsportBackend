import { useCallback, useEffect, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { Link } from 'react-router-dom'
import { ArrowLeft, CornerUpRight, ExternalLink, FileX2, Folder, LoaderCircle, RefreshCw, Share2, TriangleAlert } from 'lucide-react'
import { AppError, messageOf } from '../data/errors'
import { formatTimestamp } from '../lib/datetime'
import { contentError, formatBytes, KIND_LABELS, libraryApi } from './api'
import type { FileDetail, FormData, NoPreviewReason, SheetData, TextData } from './api'
import { KIND_ICONS } from './FileList'
import { PdfViewer } from './PdfViewer'

type Load = { kind: 'loading' } | { kind: 'error'; code: string; message: string } | { kind: 'ready'; detail: FileDetail }

interface Props {
  fileId: string
  audience: 'staff' | 'member'
  /** ลิงก์กลับไปรายการ (รวมคำค้นเดิม) */
  backTo: string
  backLabel?: string
  /** ชื่อระบบสำหรับ title ของหน้า */
  siteName: string
  /** ปุ่มเพิ่มเติมของฝั่งทีมงาน */
  extra?(detail: FileDetail): ReactNode
}

const OPEN_NOTE: Record<Props['audience'], string> = {
  member: 'การเปิดต้นฉบับเป็นการออกไปที่ Google: จะเปิดได้หรือไม่ขึ้นกับสิทธิ์ของบัญชี Google ที่ล็อกอินในเบราว์เซอร์นี้ เว็บไซต์นี้ไม่ได้แชร์ไฟล์ให้',
  staff: 'ปุ่มนี้เปิดหน้าของ Google ในแท็บใหม่ ใช้สิทธิ์ของบัญชี Google ที่คุณล็อกอินในเบราว์เซอร์ เว็บไซต์นี้ไม่ได้แชร์ไฟล์หรือให้สิทธิ์แก้ไขอัตโนมัติ',
}

/** หน้าตัวอย่างไฟล์ (อ่านอย่างเดียว) ใช้ร่วมกันทั้งทีมงานและสมาชิก: มีกล่องแสดงเนื้อหากล่องเดียว ไม่มีหน้าต่างของ Google ซ้อน */
export function FilePreview({ fileId, audience, backTo, backLabel = 'กลับไปรายการไฟล์', siteName, extra }: Props) {
  const [load, setLoad] = useState<Load>({ kind: 'loading' })
  const [version, setVersion] = useState(0)
  const [refreshing, setRefreshing] = useState(false)
  const seq = useRef(0)
  const heading = useRef<HTMLHeadingElement>(null)

  const fetchDetail = useCallback(
    (quiet: boolean) => {
      const current = ++seq.current
      if (quiet) setRefreshing(true)
      else setLoad({ kind: 'loading' })
      libraryApi.detail(fileId).then(
        (detail) => {
          if (current !== seq.current) return
          setLoad({ kind: 'ready', detail })
          setRefreshing(false)
          // โหลดเนื้อหาใหม่ด้วยเมื่อผู้ใช้กดรีเฟรช
          if (quiet) setVersion((n) => n + 1)
        },
        (failure: unknown) => {
          if (current !== seq.current) return
          setRefreshing(false)
          setLoad({ kind: 'error', code: failure instanceof AppError ? failure.code : 'unknown', message: messageOf(failure, 'เปิดไฟล์ไม่สำเร็จ ลองอีกครั้ง') })
        },
      )
    },
    [fileId],
  )

  useEffect(() => fetchDetail(false), [fetchDetail])

  const name = load.kind === 'ready' ? load.detail.file.name : ''
  useEffect(() => {
    if (name) document.title = `${name} · ${siteName}`
  }, [name, siteName])
  useEffect(() => {
    if (load.kind === 'ready') heading.current?.focus()
    // ย้าย focus เฉพาะตอนเปิดไฟล์ครั้งแรก ไม่ย้ายตอนรีเฟรช
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load.kind])

  const back = (
    <Link to={backTo} className="text-link preview-back">
      <ArrowLeft aria-hidden="true" size={18} />
      {backLabel}
    </Link>
  )

  if (load.kind === 'loading') {
    return (
      <div className="file-preview">
        {back}
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังเปิดไฟล์…</p>
        </div>
      </div>
    )
  }

  if (load.kind === 'error') {
    const gone = load.code === 'file_unavailable'
    return (
      <div className="file-preview">
        {back}
        <div className="state-block state-error" role="alert">
          {gone ? <FileX2 aria-hidden="true" size={28} /> : <TriangleAlert aria-hidden="true" size={28} />}
          <h1 className="empty-state-title" tabIndex={-1}>
            {gone ? 'เปิดไฟล์นี้ไม่ได้แล้ว' : load.code === 'library_unavailable' ? 'คลังไฟล์ยังไม่พร้อมใช้งาน' : 'เปิดไฟล์ไม่สำเร็จ'}
          </h1>
          <p className="empty-state-text">{load.message}</p>
          <div className="button-row button-row-center">
            {!gone && (
              <button type="button" className="button button-primary" onClick={() => fetchDetail(false)}>
                ลองอีกครั้ง
              </button>
            )}
            <Link to={backTo} className="button">
              {backLabel}
            </Link>
          </div>
        </div>
      </div>
    )
  }

  const { detail } = load
  const { file, preview, links } = detail
  const Icon = KIND_ICONS[file.kind]
  const openLink = links.edit ?? (links.open ? { url: links.open, label: 'เปิดต้นฉบับ' } : null)

  return (
    <div className="file-preview">
      {back}
      <header className="preview-head">
        <span className={`file-icon file-icon-${file.kind}`} aria-hidden="true">
          <Icon size={24} />
        </span>
        <div className="preview-heading">
          <h1 className="preview-title" tabIndex={-1} ref={heading}>
            {file.name}
          </h1>
          <p className="file-meta">
            <span>{KIND_LABELS[file.kind]}</span>
            {file.modifiedTime && <span>แก้ไขล่าสุด {formatTimestamp(file.modifiedTime)}</span>}
            {file.size !== null && <span>{formatBytes(file.size)}</span>}
          </p>
          {(file.folder || file.shortcut || file.shared) && (
            <p className="file-tags">
              {file.folder && (
                <span className="file-tag">
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
            </p>
          )}
        </div>
      </header>

      <div className="preview-actions">
        <button type="button" className="button" onClick={() => fetchDetail(true)} aria-disabled={refreshing}>
          <RefreshCw aria-hidden="true" size={16} className={refreshing ? 'spin' : undefined} />
          {refreshing ? 'กำลังรีเฟรช…' : 'รีเฟรช'}
        </button>
        {openLink && (
          <a className={`button${links.edit ? ' button-primary' : ''}`} href={openLink.url} target="_blank" rel="noopener noreferrer">
            {openLink.label}
            <ExternalLink aria-hidden="true" size={16} />
            <span className="visually-hidden"> (เปิดแท็บใหม่)</span>
          </a>
        )}
        {extra?.(detail)}
      </div>
      {openLink && <p className="field-hint preview-note">{OPEN_NOTE[audience]}</p>}

      <section className="viewer-box" aria-label={`ตัวอย่างของ ${file.name}`}>
        {preview.kind === 'pdf' && <PdfViewer key={version} url={libraryApi.contentUrl(file.id)} name={file.name} />}
        {preview.kind === 'image' && <ImageViewer key={version} url={libraryApi.contentUrl(file.id)} name={file.name} />}
        {preview.kind === 'thumbnail' && <>
          <p className="thumbnail-note">ตัวอย่างขนาดย่อจาก Google · เปิดต้นฉบับเพื่อดูความละเอียดเต็ม</p>
          <ImageViewer key={version} url={libraryApi.thumbnailUrl(file.id)} name={file.name} />
        </>}
        {preview.kind === 'sheet' && <SheetViewer key={version} fileId={file.id} />}
        {preview.kind === 'form' && <FormViewer key={version} fileId={file.id} note={OPEN_NOTE[audience]} />}
        {preview.kind === 'text' && <TextViewer key={version} fileId={file.id} />}
        {preview.kind === 'none' && <NoPreview reason={preview.reason} kindLabel={KIND_LABELS[file.kind]} maxBytes={preview.maxBytes} hasLink={openLink !== null} />}
      </section>
      <p className="field-hint preview-note">ตัวอย่างนี้อ่านได้อย่างเดียว ข้อมูลล่าสุดจาก Google เมื่อ {formatTimestamp(detail.fetchedAt)} กด “รีเฟรช” เพื่อโหลดใหม่</p>
    </div>
  )
}

const NO_PREVIEW: Record<NoPreviewReason, (label: string, maxBytes: number) => string> = {
  folder: () => 'รายการนี้เป็นโฟลเดอร์ จึงไม่มีตัวอย่าง',
  unsupported: (label) => `ไฟล์ชนิดนี้ (${label}) ยังไม่มีตัวอย่างในเว็บ`,
  too_large: (_, maxBytes) => `ไฟล์นี้ใหญ่เกิน ${Math.round(maxBytes / 1024 / 1024)} MB จึงไม่แสดงตัวอย่างในเว็บ`,
  download_disabled: () => 'เจ้าของไฟล์ไม่อนุญาตให้ดาวน์โหลดหรือคัดลอกไฟล์นี้ จึงแสดงตัวอย่างในเว็บไม่ได้',
}

function NoPreview({ reason, kindLabel, maxBytes, hasLink }: { reason: NoPreviewReason | null; kindLabel: string; maxBytes: number; hasLink: boolean }) {
  return (
    <div className="state-block" role="status">
      <FileX2 aria-hidden="true" size={28} />
      <p className="empty-state-title">ไม่มีตัวอย่างในเว็บ</p>
      <p className="empty-state-text">
        {NO_PREVIEW[reason ?? 'unsupported'](kindLabel, maxBytes)}
        {hasLink ? ' ใช้ปุ่มเปิดต้นฉบับด้านบนเพื่อเปิดใน Google' : ''}
      </p>
    </div>
  )
}

function ViewerError({ message, retry }: { message: string; retry(): void }) {
  return (
    <div className="state-block state-error" role="alert">
      <TriangleAlert aria-hidden="true" size={28} />
      <p className="empty-state-title">แสดงตัวอย่างไม่ได้</p>
      <p className="empty-state-text">{message}</p>
      <button type="button" className="button" onClick={retry}>
        ลองอีกครั้ง
      </button>
    </div>
  )
}

const ViewerLoading = () => (
  <div className="state-block" role="status">
    <LoaderCircle aria-hidden="true" size={24} className="spin" />
    <p>กำลังโหลดตัวอย่าง…</p>
  </div>
)

function ImageViewer({ url, name }: { url: string; name: string }) {
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [attempt, setAttempt] = useState(0)
  return (
    <div className="image-viewer">
      {state === 'loading' && <ViewerLoading />}
      {state === 'error' ? (
        <ViewerError
          message={message}
          retry={() => {
            setState('loading')
            setAttempt((n) => n + 1)
          }}
        />
      ) : (
        <img
          key={attempt}
          src={`${url}${attempt ? `?retry=${attempt}` : ''}`}
          alt={name}
          hidden={state !== 'ready'}
          onLoad={() => setState('ready')}
          onError={() => {
            void contentError(url).then((reason) => {
              setMessage(reason ?? 'แสดงรูปนี้ไม่สำเร็จ กดลองอีกครั้ง ถ้ายังไม่ได้ให้ใช้ปุ่มเปิดต้นฉบับ')
              setState('error')
            })
          }}
        />
      )}
    </div>
  )
}

/** ชื่อคอลัมน์แบบตารางคำนวณ: 1 → A, 27 → AA */
function columnName(index: number): string {
  let out = ''
  for (let n = index; n > 0; n = Math.floor((n - 1) / 26)) out = String.fromCharCode(65 + ((n - 1) % 26)) + out
  return out
}

function SheetViewer({ fileId }: { fileId: string }) {
  const [info, setInfo] = useState<SheetData | null>(null)
  const [rows, setRows] = useState<SheetData['rows']>([])
  const [state, setState] = useState<'loading' | 'ready' | 'error'>('loading')
  const [message, setMessage] = useState('')
  const [more, setMore] = useState<'idle' | 'loading' | 'error'>('idle')
  const [firstRow, setFirstRow] = useState(1)
  const seq = useRef(0)

  const load = useCallback(
    (tab: number | null, offset: number) => {
      const current = ++seq.current
      const append = offset > 0
      if (append) setMore('loading')
      else setState('loading')
      libraryApi.sheet(fileId, tab, offset).then(
        (data) => {
          if (current !== seq.current) return
          setInfo(data)
          setRows((list) => (append ? [...list, ...data.rows] : data.rows))
          if (!append) setFirstRow(data.range?.firstRow ?? 1)
          setState('ready')
          setMore('idle')
        },
        (failure: unknown) => {
          if (current !== seq.current) return
          setMessage(messageOf(failure, 'โหลดตารางไม่สำเร็จ ลองอีกครั้ง'))
          if (append) setMore('error')
          else setState('error')
        },
      )
    },
    [fileId],
  )

  useEffect(() => load(null, 0), [load])

  if (state === 'loading') return <ViewerLoading />
  if (state === 'error' || !info) return <ViewerError message={message} retry={() => load(info?.tab ?? null, 0)} />
  if (info.tabs.length === 0 || info.tab === null) {
    return (
      <div className="state-block" role="status">
        <p className="empty-state-title">ไฟล์นี้ไม่มีแท็บตารางให้แสดง</p>
      </div>
    )
  }
  const range = info.range
  const columns = info.columns ?? []

  return (
    <div className="sheet-viewer">
      <div className="viewer-bar">
        <div className="toolbar-filter">
          <label htmlFor="sheet-tab">แท็บ</label>
          <select id="sheet-tab" value={info.tab} onChange={(e) => load(Number(e.target.value), 0)}>
            {info.tabs.map((tab) => (
              <option key={tab.id} value={tab.id}>
                {tab.title || 'ไม่มีชื่อ'}
              </option>
            ))}
          </select>
        </div>
        {/* บอกขอบเขตที่แสดงจริง ไม่ให้เข้าใจว่าเป็นข้อมูลทั้งชีต */}
        <p className="sheet-range" role="status">
          {range
            ? `แสดงแถว ${firstRow.toLocaleString('en-US')}–${range.lastRow.toLocaleString('en-US')} จากตาราง ${range.totalRows.toLocaleString('en-US')} แถว · คอลัมน์ A–${columnName(range.lastColumn)}`
            : 'ไม่มีแถวในช่วงนี้'}
          {info.truncatedColumns && range ? ` (แท็บนี้มี ${range.totalColumns} คอลัมน์ แสดง ${range.lastColumn} คอลัมน์แรก)` : ''}
          {info.hiddenRows + info.hiddenColumns > 0 ? ' · ไม่แสดงแถวหรือคอลัมน์ที่ซ่อนไว้ใน Google Sheets' : ''}
        </p>
      </div>
      {rows.length === 0 ? (
        <p className="sheet-empty">ไม่มีข้อมูลในช่วงแถวที่แสดง</p>
      ) : (
        <div className="sheet-wrap" tabIndex={0} role="region" aria-label={`ตารางของแท็บ ${info.tabs.find((t) => t.id === info.tab)?.title ?? ''}`}>
          <table className="sheet-table">
            <thead>
              <tr>
                <th scope="col" className="sheet-corner">
                  <span className="visually-hidden">เลขแถว</span>
                </th>
                {columns.map((column) => (
                  <th scope="col" key={column}>
                    {columnName(column)}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.number}>
                  <th scope="row">{row.number}</th>
                  {row.cells.map((cell, index) => (
                    <td key={index}>{cell}</td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {more === 'error' && (
        <p className="form-alert" role="alert">
          {message}
        </p>
      )}
      {info.hasMoreRows && range && (
        <div className="file-more">
          <button type="button" className="button" onClick={() => load(info.tab, range.lastRow)} aria-disabled={more === 'loading'}>
            {more === 'loading' && <LoaderCircle aria-hidden="true" size={16} className="spin" />}
            {more === 'loading' ? 'กำลังโหลด…' : `โหลดแถวถัดไป (ตั้งแต่แถว ${(range.lastRow + 1).toLocaleString('en-US')})`}
          </button>
          <p className="field-hint">ยังแสดงไม่ครบทุกแถวของแท็บนี้</p>
        </div>
      )}
    </div>
  )
}

const QUESTION_KINDS: Record<string, string> = {
  short_text: 'คำตอบสั้น', paragraph: 'คำตอบยาว', radio: 'เลือกหนึ่งข้อ', checkbox: 'เลือกได้หลายข้อ', dropdown: 'เลือกจากรายการ', scale: 'สเกล', date: 'วันที่',
  time: 'เวลา', rating: 'ให้คะแนน', file_upload: 'อัปโหลดไฟล์', grid: 'ตารางตัวเลือก', section: 'หัวข้อส่วน', text: 'ข้อความประกอบ', image: 'รูปภาพ', video: 'วิดีโอ',
  unknown: 'คำถามชนิดอื่น',
}

function FormViewer({ fileId, note }: { fileId: string; note: string }) {
  const [form, setForm] = useState<FormData | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setForm(null)
    setError('')
    libraryApi.form(fileId).then(
      (data) => !cancelled && setForm(data),
      (failure: unknown) => !cancelled && setError(messageOf(failure, 'โหลดคำถามของฟอร์มไม่สำเร็จ ลองอีกครั้ง')),
    )
    return () => {
      cancelled = true
    }
  }, [fileId, attempt])

  if (error) return <ViewerError message={error} retry={() => setAttempt((n) => n + 1)} />
  if (!form) return <ViewerLoading />
  return (
    <div className="form-viewer">
      <h2 className="form-viewer-title">{form.title || 'ฟอร์มไม่มีชื่อ'}</h2>
      {form.description && <p className="pre-line muted">{form.description}</p>}
      {form.responderUrl && (
        <div className="form-viewer-open">
          <a className="button button-primary" href={form.responderUrl} target="_blank" rel="noopener noreferrer">
            เปิดฟอร์ม
            <ExternalLink aria-hidden="true" size={16} />
            <span className="visually-hidden"> (เปิดแท็บใหม่)</span>
          </a>
          <p className="field-hint">เปิดหน้าตอบฟอร์มของ Google ในแท็บใหม่ การตอบเป็นไปตามการตั้งค่าของฟอร์มนั้น {note}</p>
        </div>
      )}
      {form.items.length === 0 ? (
        <p className="muted">ฟอร์มนี้ยังไม่มีคำถาม</p>
      ) : (
        <ol className="form-items">
          {form.items.map((item, index) => (
            <li key={index} className={item.kind === 'section' ? 'form-item form-item-section' : 'form-item'}>
              <p className="form-item-title">
                {item.title || <span className="muted">ไม่มีข้อความ</span>}
                {item.required && <span className="badge badge-neutral">ต้องตอบ</span>}
              </p>
              <p className="form-item-kind">{QUESTION_KINDS[item.kind] ?? QUESTION_KINDS.unknown}</p>
              {item.description && <p className="pre-line muted">{item.description}</p>}
              {item.rows.length > 0 && <p className="form-item-rows">แถว: {item.rows.join(' · ')}</p>}
              {item.options.length > 0 && (
                <ul className="form-item-options">
                  {item.options.map((option, optionIndex) => (
                    <li key={optionIndex}>{option}</li>
                  ))}
                </ul>
              )}
            </li>
          ))}
        </ol>
      )}
      <p className="field-hint">แสดงเฉพาะคำถามของฟอร์ม ไม่มีคำตอบของผู้ตอบในหน้านี้</p>
    </div>
  )
}

function TextViewer({ fileId }: { fileId: string }) {
  const [data, setData] = useState<TextData | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)

  useEffect(() => {
    let cancelled = false
    setData(null)
    setError('')
    libraryApi.text(fileId).then(
      (result) => !cancelled && setData(result),
      (failure: unknown) => !cancelled && setError(messageOf(failure, 'โหลดข้อความไม่สำเร็จ ลองอีกครั้ง')),
    )
    return () => {
      cancelled = true
    }
  }, [fileId, attempt])

  if (error) return <ViewerError message={error} retry={() => setAttempt((n) => n + 1)} />
  if (!data) return <ViewerLoading />
  return (
    <div className="text-viewer">
      {data.truncated && (
        <p className="notice notice-warning" role="status">
          <TriangleAlert aria-hidden="true" size={18} />
          <span>
            แสดงเฉพาะ {formatBytes(data.bytes)} แรกของไฟล์{data.totalBytes !== null ? ` (ทั้งไฟล์ ${formatBytes(data.totalBytes)})` : ''} ไม่ใช่ทั้งไฟล์ ใช้ปุ่มเปิดต้นฉบับเพื่อดูทั้งหมด
          </span>
        </p>
      )}
      {data.text === '' ? <p className="muted">ไฟล์นี้ว่าง</p> : <pre className="text-preview" tabIndex={0}>{data.text}</pre>}
    </div>
  )
}
