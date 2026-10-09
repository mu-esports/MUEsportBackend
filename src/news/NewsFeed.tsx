import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, Newspaper, RefreshCw } from 'lucide-react'
import { Dialog } from '../components/Dialog'
import { messageOf } from '../data/errors'
import { formatDate } from '../lib/datetime'
import { newsApi } from './api'
import type { NewsPost } from './api'

export function NewsImage({ post, poster = false }: { post: NewsPost; poster?: boolean }) {
  const [failed, setFailed] = useState(false)
  if (!post.imageUrl || failed) return <div className="news-image news-image-empty" aria-hidden="true"><Newspaper size={32} /></div>
  return <img className={poster ? 'news-poster' : 'news-image'} src={post.imageUrl} alt={poster ? `โปสเตอร์ ${post.title}` : ''} loading="lazy" decoding="async" referrerPolicy="no-referrer" onError={() => setFailed(true)} />
}

export function NewsCard({ post, onOpen }: { post: NewsPost; onOpen(): void }) {
  return <button type="button" className="news-card" onClick={onOpen} aria-haspopup="dialog">
    <NewsImage post={post} />
    <span className="news-card-body">
      <span className="news-meta"><span className="badge badge-neutral">{post.category}</span><span>{formatDate(post.publishedDate)}</span></span>
      <span className="news-title">{post.title}</span>
      {post.summary && <span className="news-summary">{post.summary}</span>}
      <span className="news-read">อ่านรายละเอียด <ExternalLink size={14} aria-hidden="true" /></span>
    </span>
  </button>
}

export function NewsDialog({ post, onClose }: { post: NewsPost; onClose(): void }) {
  return <Dialog title={post.title} description={`${post.category} · ${formatDate(post.publishedDate)}`} onRequestClose={onClose} footer={<>
    {post.instagramUrl && <a className="button" href={post.instagramUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={16} aria-hidden="true" />ดูโพสต์ Instagram</a>}
    {post.sourceUrl && <a className="button" href={post.sourceUrl} target="_blank" rel="noopener noreferrer">ดูต้นทาง<ExternalLink size={16} aria-hidden="true" /></a>}
    <button type="button" className="button button-primary" data-autofocus onClick={onClose}>ปิด</button>
  </>}>
    <div className="news-detail">
      {post.imageUrl && <NewsImage post={post} poster />}
      {post.summary && <p className="news-lead">{post.summary}</p>}
      {post.body && <p className="pre-line break-word">{post.body}</p>}
    </div>
  </Dialog>
}

/** อ่านสำเนาข่าวจากระบบกลาง ไม่รอโหลด Instagram หรือ iframe ก่อนแสดงหน้า */
export function MemberNewsFeed({ limit }: { limit?: number }) {
  const [posts, setPosts] = useState<NewsPost[] | null>(null)
  const [error, setError] = useState('')
  const [truncated, setTruncated] = useState(false)
  const [attempt, setAttempt] = useState(0)
  const [open, setOpen] = useState<NewsPost | null>(null)
  useEffect(() => {
    const controller = new AbortController()
    setError('')
    newsApi.member(controller.signal).then(page => {
      if (controller.signal.aborted) return
      setPosts(page.news); setTruncated(page.truncated)
    }, failure => { if (!controller.signal.aborted) setError(messageOf(failure, 'โหลดข่าวไม่สำเร็จ')) })
    return () => controller.abort()
  }, [attempt])
  // เปลี่ยนข่าวในหลังบ้านแล้วกลับมาหน้าสมาชิก: อ่านใหม่โดยไม่ทำให้รายการเดิมหาย
  useEffect(() => {
    const refresh = () => { if (document.visibilityState === 'visible') setAttempt(n => n + 1) }
    window.addEventListener('focus', refresh)
    return () => window.removeEventListener('focus', refresh)
  }, [])
  return <>
    <div className="news-feed-heading"><h2>ข่าวจากชมรม</h2><button type="button" className="button button-small" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} aria-hidden="true" />อัปเดตข่าว</button></div>
    {error && <div className="form-alert" role="alert">{error}{posts && ' กำลังแสดงข้อมูลที่โหลดไว้ก่อนหน้า'}</div>}
    {!posts && !error && <p className="m-inline-state" role="status"><LoaderCircle size={18} className="spin" aria-hidden="true" />กำลังโหลดข่าว…</p>}
    {posts?.length === 0 && <p className="m-empty">ยังไม่มีข่าวที่เผยแพร่</p>}
    {posts && <div className="news-grid">{posts.slice(0, limit ?? posts.length).map(post => <NewsCard key={post.id} post={post} onOpen={() => setOpen(post)} />)}</div>}
    {truncated && <p className="muted">แสดงข่าวล่าสุด 100 รายการ</p>}
    {open && <NewsDialog post={open} onClose={() => setOpen(null)} />}
  </>
}
