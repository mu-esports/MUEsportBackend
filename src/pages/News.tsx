import { useEffect, useState } from 'react'
import { ExternalLink, LoaderCircle, Newspaper, Pencil, Plus, RefreshCw } from 'lucide-react'
import { PageHeader } from '../components/ui'
import { useToast } from '../components/Toast'
import { messageOf } from '../data/errors'
import { CLUB_NEWS_SOURCE, NEWS_STATUS, newsApi } from '../news/api'
import type { StaffNews } from '../news/api'
import { NewsCard, NewsDialog } from '../news/NewsFeed'
import { NewsForm } from './NewsForm'

export function NewsPage() {
  const [posts, setPosts] = useState<StaffNews[] | null>(null)
  const [error, setError] = useState('')
  const [attempt, setAttempt] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('')
  const [form, setForm] = useState<StaffNews | 'new' | null>(null)
  const [preview, setPreview] = useState<StaffNews | null>(null)
  const toast = useToast()
  useEffect(() => {
    let cancelled = false
    newsApi.list().then(page => { if (!cancelled) { setPosts(page.news); setTruncated(page.truncated); setError('') } }, failure => { if (!cancelled) setError(messageOf(failure, 'โหลดข่าวไม่สำเร็จ')) })
    return () => { cancelled = true }
  }, [attempt])
  const shown = posts?.filter(p => (!filter || p.status === filter) && `${p.title} ${p.category}`.toLowerCase().includes(query.trim().toLowerCase())) ?? []
  return <>
    <PageHeader title="ข่าวและกิจกรรมชมรม" description="จัดการข่าวสำหรับสมาชิก พร้อมภาพและลิงก์โพสต์ต้นทาง" action={<button type="button" className="button button-primary" onClick={() => setForm('new')}><Plus size={18} aria-hidden="true" />เพิ่มข่าว</button>} />
    <div className="news-source-note"><Newspaper size={20} aria-hidden="true" /><div><strong>ข่าวจากหน้าเว็บชมรม</strong><p>เริ่มต้นจากข่าวบนเว็บไซต์ของชมรม ทีมงานแก้ไขและเผยแพร่ข่าวให้สมาชิกได้ที่นี่ การแก้ไขจะไม่เปลี่ยนโพสต์ Instagram หรือข่าวบนเว็บไซต์สาธารณะ</p></div><a className="button" href={CLUB_NEWS_SOURCE} target="_blank" rel="noopener noreferrer">ดูหน้าบ้าน<ExternalLink size={16} aria-hidden="true" /></a></div>
    <div className="news-filters"><label className="field">ค้นหาข่าว<input type="search" value={query} onChange={e => setQuery(e.target.value)} placeholder="ค้นหัวข้อหรือหมวดหมู่" /></label><label className="field">สถานะ<select value={filter} onChange={e => setFilter(e.target.value)}><option value="">ทุกสถานะ</option>{Object.entries(NEWS_STATUS).map(([v,l]) => <option key={v} value={v}>{l}</option>)}</select></label><button type="button" className="button" onClick={() => setAttempt(n => n + 1)}><RefreshCw size={16} aria-hidden="true" />อัปเดต</button></div>
    {error && <p className="form-alert" role="alert">{error}{posts && ' กำลังแสดงข้อมูลที่โหลดไว้ก่อนหน้า'}</p>}
    {!posts && !error && <div className="state-block" role="status"><LoaderCircle size={24} className="spin" aria-hidden="true" />กำลังโหลดข่าว…</div>}
    {posts && shown.length === 0 && <div className="empty-state"><Newspaper size={28} aria-hidden="true" /><p className="empty-state-title">ไม่พบข่าว</p><p>เพิ่มข่าวใหม่หรือเปลี่ยนตัวกรอง</p></div>}
    <div className="news-grid">{shown.map(post => <article key={post.id} className="news-manage-card"><NewsCard post={post} onOpen={() => setPreview(post)} /><div className="news-manage-actions"><span className={`badge badge-${post.status === 'published' ? 'active' : 'neutral'}`}>{NEWS_STATUS[post.status]}</span><button type="button" className="button button-small" onClick={() => setForm(post)} aria-label={`แก้ไขข่าว ${post.title}`}><Pencil size={16} aria-hidden="true" />แก้ไข</button></div></article>)}</div>
    {truncated && <p className="muted">แสดงข่าวล่าสุด 200 รายการ</p>}
    {preview && <NewsDialog post={preview} onClose={() => setPreview(null)} />}
    {form && <NewsForm key={form === 'new' ? 'new' : form.id} post={form === 'new' ? undefined : form} onClose={() => setForm(null)} onSaved={post => {
      setPosts(list => [post, ...(list ?? []).filter(p => p.id !== post.id)].sort((a,b) => b.publishedDate.localeCompare(a.publishedDate) || a.id.localeCompare(b.id)))
      setForm(null); toast.success('บันทึกข่าวแล้ว'); setAttempt(n => n + 1)
    }} />}
  </>
}
