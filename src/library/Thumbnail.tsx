import { useEffect, useRef, useState } from 'react'
import { ImageOff } from 'lucide-react'
import { notifyUnauthorized } from '../api/client'

// จำกัดภาพย่อที่โหลดพร้อมกัน: ไม่ให้การเปิดรายการ 30 ไฟล์ยิงคำขอทั้งหมดในคราวเดียว
let active = 0
type Job = { signal: AbortSignal; start(): void }
const queue: Job[] = []
function drain() {
  while (active < 4 && queue.length) {
    const job = queue.shift()!
    if (!job.signal.aborted) job.start()
  }
}
function imageBlob(url: string, signal: AbortSignal): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const job: Job = { signal, start() {
      active++
      fetch(url, { credentials: 'same-origin', cache: 'no-store', signal }).then(async (response) => {
        if (response.status === 401) notifyUnauthorized()
        if (!response.ok || !response.headers.get('Content-Type')?.startsWith('image/')) throw new Error('thumbnail unavailable')
        return response.blob()
      }).then(resolve, reject).finally(() => { active--; drain() })
    } }
    signal.addEventListener('abort', () => {
      const index = queue.indexOf(job)
      if (index !== -1) { queue.splice(index, 1); reject(new DOMException('Aborted', 'AbortError')) }
    }, { once: true })
    queue.push(job)
    drain()
  })
}

/** โหลดเฉพาะภาพที่ใกล้เข้าหน้าจอ และยกเลิกคำขอเมื่อออกจากหน้านี้ */
export function Thumbnail({ url }: { url: string }) {
  const element = useRef<HTMLDivElement>(null)
  const [visible, setVisible] = useState(false)
  const [image, setImage] = useState('')
  const [failed, setFailed] = useState(false)
  useEffect(() => {
    if (!element.current) return
    if (!('IntersectionObserver' in window)) { setVisible(true); return }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) { setVisible(true); observer.disconnect() }
    }, { rootMargin: '100px' })
    observer.observe(element.current)
    return () => observer.disconnect()
  }, [])
  useEffect(() => {
    if (!visible) return
    const controller = new AbortController()
    let objectUrl = ''
    setImage('')
    setFailed(false)
    void imageBlob(url, controller.signal).then((blob) => {
      if (controller.signal.aborted) return
      objectUrl = URL.createObjectURL(blob)
      setImage(objectUrl)
    }, () => { if (!controller.signal.aborted) setFailed(true) })
    return () => { controller.abort(); if (objectUrl) URL.revokeObjectURL(objectUrl) }
  }, [visible, url])
  return <div ref={element} className={`file-thumbnail${!image && !failed ? ' is-loading' : ''}`} aria-hidden="true">
    {image ? <img src={image} alt="" decoding="async" onError={() => { setImage(''); setFailed(true) }} /> : failed ? <span className="thumbnail-fallback"><ImageOff size={28} /><span>เปิดดูตัวอย่าง</span></span> : <span className="thumbnail-placeholder" />}
  </div>
}
