import { useEffect, useRef, useState } from 'react'
import { LoaderCircle, Minus, Plus, TriangleAlert } from 'lucide-react'
import type { PDFDocumentLoadingTask, PDFDocumentProxy, RenderTask } from 'pdfjs-dist'
import { contentError } from './api'

/**
 * แสดง PDF ด้วย PDF.js: วาดแต่ละหน้าเป็นภาพบน canvas จึงใช้ได้ทั้งคอมพิวเตอร์และมือถือ โดยไม่พึ่งตัวแสดง PDF ของเบราว์เซอร์
 * - โหลดไฟล์จาก endpoint ของเว็บ (ตรวจ session ทุกครั้ง) ไม่ได้เปิดหน้าของ Google และไม่มีหน้าต่างเข้าสู่ระบบ Google
 * - ไม่รันสคริปต์ในไฟล์ PDF และวาดเฉพาะหน้าที่อยู่ใกล้ส่วนที่มองเห็น หน้าที่เลื่อนพ้นไปแล้วคืนหน่วยความจำ
 */
async function loadPdfjs() {
  // รุ่น legacy ของ PDF.js รองรับเบราว์เซอร์รุ่นเก่ากว่า (เช่น มือถือที่ยังไม่อัปเดต)
  const [lib, worker] = await Promise.all([import('pdfjs-dist/legacy/build/pdf.mjs'), import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url')])
  lib.GlobalWorkerOptions.workerSrc = worker.default
  return lib
}

async function explain(error: unknown, url: string): Promise<string> {
  const name = error instanceof Error ? error.name : ''
  if (name === 'PasswordException') return 'ไฟล์ PDF นี้ตั้งรหัสผ่านไว้ จึงแสดงตัวอย่างในเว็บไม่ได้ ใช้ปุ่มเปิดต้นฉบับแทน'
  if (name === 'InvalidPDFException') return 'ไฟล์นี้ไม่ใช่ PDF ที่อ่านได้ หรือไฟล์เสียหาย จึงแสดงตัวอย่างไม่ได้'
  return (await contentError(url)) ?? 'แสดงตัวอย่างไม่สำเร็จ กดลองอีกครั้ง ถ้ายังไม่ได้ให้ใช้ปุ่มเปิดต้นฉบับ'
}

type State = { kind: 'loading'; percent: number | null } | { kind: 'error'; message: string } | { kind: 'ready'; pages: number; ratio: number }

const ZOOMS = [0.5, 0.75, 1, 1.25, 1.5, 2, 3]
/** ความกว้างสูงสุดของหน้าที่ขนาด 100% บนจอกว้าง (จอแคบกว่านี้หน้าพอดีความกว้างของกล่อง) */
const MAX_FIT_WIDTH = 880
/** จำนวนพิกเซลสูงสุดต่อหนึ่งหน้า กัน canvas ใหญ่เกินบนจอความละเอียดสูง */
const MAX_PAGE_PIXELS = 4_000_000

export function PdfViewer({ url, name }: { url: string; name: string }) {
  const [state, setState] = useState<State>({ kind: 'loading', percent: null })
  const [attempt, setAttempt] = useState(0)
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null)
  const [width, setWidth] = useState(0)
  const [zoom, setZoom] = useState(1)
  const frame = useRef<HTMLDivElement>(null)

  useEffect(() => {
    let cancelled = false
    let task: PDFDocumentLoadingTask | null = null
    setState({ kind: 'loading', percent: null })
    setDoc(null)
    loadPdfjs()
      .then((lib) => {
        if (cancelled) return null
        task = lib.getDocument({
          url,
          withCredentials: true,
          cMapUrl: '/pdfjs/cmaps/',
          cMapPacked: true,
          standardFontDataUrl: '/pdfjs/standard_fonts/',
          wasmUrl: '/pdfjs/wasm/',
          // ไม่แสดงฟอร์มแบบ XFA (PDF.js รุ่นนี้ไม่ประเมินโค้ดจากไฟล์อยู่แล้ว และหน้านี้ไม่เปิดใช้สคริปต์ของ PDF)
          enableXfa: false,
        })
        task.onProgress = ({ loaded, total }: { loaded: number; total: number }) => {
          if (!cancelled && total > 0) setState((s) => (s.kind === 'loading' ? { kind: 'loading', percent: Math.min(99, Math.round((loaded / total) * 100)) } : s))
        }
        return task.promise
      })
      .then(async (loaded) => {
        if (!loaded) return
        if (cancelled) return void loaded.loadingTask.destroy()
        const first = await loaded.getPage(1)
        const viewport = first.getViewport({ scale: 1 })
        if (cancelled) return
        setDoc(loaded)
        setState({ kind: 'ready', pages: loaded.numPages, ratio: viewport.height / viewport.width })
      })
      .catch(async (error: unknown) => {
        if (cancelled) return
        const message = await explain(error, url)
        if (!cancelled) setState({ kind: 'error', message })
      })
    return () => {
      cancelled = true
      void task?.destroy()
    }
  }, [url, attempt])

  // ความกว้างของพื้นที่แสดง: หน้า PDF พอดีความกว้างนี้ที่ขนาด 100%
  useEffect(() => {
    const element = frame.current
    if (!element) return
    const measure = () => {
      const next = Math.floor(element.clientWidth)
      setWidth((current) => (Math.abs(current - next) > 4 ? next : current))
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  const step = (direction: 1 | -1) => setZoom((current) => ZOOMS[Math.min(ZOOMS.length - 1, Math.max(0, ZOOMS.indexOf(current) + direction))])
  const pageWidth = Math.max(0, Math.floor(Math.min(width, MAX_FIT_WIDTH) * zoom))

  return (
    <div className="pdf-viewer">
      {state.kind === 'ready' && (
        <div className="viewer-bar">
          <p role="status">{state.pages} หน้า</p>
          <div className="viewer-zoom" role="group" aria-label="ขนาดตัวอย่าง">
            <button type="button" className="icon-button" aria-label="ย่อ" onClick={() => step(-1)} disabled={zoom === ZOOMS[0]}>
              <Minus aria-hidden="true" size={20} />
            </button>
            <span aria-live="polite">{Math.round(zoom * 100)}%</span>
            <button type="button" className="icon-button" aria-label="ขยาย" onClick={() => step(1)} disabled={zoom === ZOOMS[ZOOMS.length - 1]}>
              <Plus aria-hidden="true" size={20} />
            </button>
          </div>
        </div>
      )}
      <div className="pdf-frame" ref={frame}>
        {state.kind === 'loading' && (
          <div className="state-block" role="status">
            <LoaderCircle aria-hidden="true" size={24} className="spin" />
            <p>กำลังโหลดตัวอย่าง{state.percent !== null ? ` ${state.percent}%` : '…'}</p>
          </div>
        )}
        {state.kind === 'error' && (
          <div className="state-block state-error" role="alert">
            <TriangleAlert aria-hidden="true" size={28} />
            <p className="empty-state-title">แสดงตัวอย่างไม่ได้</p>
            <p className="empty-state-text">{state.message}</p>
            <button type="button" className="button" onClick={() => setAttempt((n) => n + 1)}>
              ลองอีกครั้ง
            </button>
          </div>
        )}
        {state.kind === 'ready' && doc && pageWidth > 0 && (
          <div className="pdf-pages">
            {Array.from({ length: state.pages }, (_, index) => (
              <PdfPage key={index} doc={doc} number={index + 1} total={state.pages} width={pageWidth} ratio={state.ratio} name={name} />
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

function PdfPage({ doc, number, total, width, ratio, name }: { doc: PDFDocumentProxy; number: number; total: number; width: number; ratio: number; name: string }) {
  const holder = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [near, setNear] = useState(false)
  const [pageRatio, setPageRatio] = useState(ratio)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    const element = holder.current
    if (!element) return
    const observer = new IntersectionObserver((entries) => setNear(entries.some((entry) => entry.isIntersecting)), { rootMargin: '800px 0px' })
    observer.observe(element)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    if (!near || width <= 0) return
    let cancelled = false
    let task: RenderTask | null = null
    const canvas = canvasRef.current
    setFailed(false)
    doc
      .getPage(number)
      .then((page) => {
        if (cancelled || !canvas) return
        const base = page.getViewport({ scale: 1 })
        setPageRatio(base.height / base.width)
        let scale = (width / base.width) * Math.min(window.devicePixelRatio || 1, 2)
        const pixels = base.width * base.height * scale * scale
        if (pixels > MAX_PAGE_PIXELS) scale *= Math.sqrt(MAX_PAGE_PIXELS / pixels)
        const viewport = page.getViewport({ scale })
        canvas.width = Math.floor(viewport.width)
        canvas.height = Math.floor(viewport.height)
        task = page.render({ canvas, viewport })
        return task.promise
      })
      .catch((error: unknown) => {
        if (!cancelled && !(error instanceof Error && error.name === 'RenderingCancelledException')) setFailed(true)
      })
    return () => {
      cancelled = true
      task?.cancel()
      // หน้าที่เลื่อนพ้นไปแล้ว: คืนหน่วยความจำของภาพ
      if (canvas) {
        canvas.width = 0
        canvas.height = 0
      }
    }
  }, [doc, number, near, width])

  return (
    <div ref={holder} className="pdf-page" style={{ width, height: Math.round(width * pageRatio) }}>
      <canvas ref={canvasRef} role="img" aria-label={`หน้า ${number} จาก ${total} ของ ${name}`} />
      {failed && <p className="pdf-page-error">แสดงหน้า {number} ไม่ได้</p>}
    </div>
  )
}
