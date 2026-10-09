import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link } from 'react-router-dom'
import { CircleCheck, CirclePause, Gamepad2, ImagePlus, LoaderCircle, Pencil, Search, SearchX, Swords, TriangleAlert, UserMinus, UserPlus } from 'lucide-react'
import { Avatar } from '../components/Avatar'
import { ConfirmDialog, Dialog } from '../components/Dialog'
import { useToast } from '../components/Toast'
import { EmptyState, PageHeader, StatusBadge } from '../components/ui'
import { athletesApi } from '../data/athletes'
import { hasCode, messageOf } from '../data/errors'
import { useStore } from '../data/store'
import { useSync } from '../data/sync'
import { ATHLETE_STATUS_LABELS, ATHLETE_STATUSES } from '../data/types'
import type { Athlete, AthleteStatus } from '../data/types'
import { AthleteForm } from './AthleteForm'
import { PhotoDialog } from './PhotoDialog'

type FormTarget = { mode: 'add' } | { mode: 'edit'; memberId: string }
type LoadState = 'loading' | 'ready' | 'error'

function AthleteStatusBadge({ status }: { status: AthleteStatus }) {
  const Icon = status === 'active' ? CircleCheck : CirclePause
  return (
    <span className={`badge badge-${status === 'active' ? 'active' : 'neutral'}`}>
      <Icon aria-hidden="true" size={14} />
      {ATHLETE_STATUS_LABELS[status]}
    </span>
  )
}

/**
 * หน้านักกีฬา (หลังบ้าน): รายชื่อนักกีฬาของชมรม แยกจากหน้าสมาชิก
 * นักกีฬาแต่ละคนคือคนในทะเบียนสมาชิกที่มีข้อมูลการแข่งขันเพิ่ม: ข้อมูลบุคคลและรูปมาจากทะเบียน ไม่มีบุคคลซ้ำ และไม่ใช่สิทธิ์ใช้ระบบ
 */
export function AthletesPage() {
  const { state: storeState, loadError: storeError, members, reload: reloadStore, refresh } = useStore()
  const toast = useToast()
  const sheet = useSync()?.statuses.sheets
  const sheetReadOnly = sheet?.linked === true && sheet?.resource?.access === 'read'

  const [athletes, setAthletes] = useState<Athlete[]>([])
  const [state, setState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const seq = useRef(0)

  const [query, setQuery] = useState('')
  const [game, setGame] = useState('')
  const [status, setStatus] = useState<AthleteStatus | ''>('')

  const [detailId, setDetailId] = useState<string | null>(null)
  const [form, setForm] = useState<FormTarget | null>(null)
  const [removeId, setRemoveId] = useState<string | null>(null)
  const [photoId, setPhotoId] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  // แสดงในกล่องรายละเอียดที่เปิดอยู่ (ข้อความนอกกล่องถูกฉากมืดบัง)
  const [detailError, setDetailError] = useState('')
  const [detailNotice, setDetailNotice] = useState('')
  // ปุ่มในกล่องรายละเอียดที่ควรได้ focus กลับ เมื่อปิดกล่องย่อยโดยไม่บันทึก
  const returnFocus = useRef<string | null>(null)
  useEffect(() => {
    const target = returnFocus.current
    if (!target || removeId !== null || photoId !== null) return
    const frame = requestAnimationFrame(() => {
      const button = document.querySelector<HTMLElement>(`dialog[open] [data-return-focus="${target}"]`)
      if (button) { button.focus(); returnFocus.current = null }
    })
    return () => cancelAnimationFrame(frame)
  }, [removeId, photoId])

  /** โหลดรายชื่อนักกีฬา quiet = ไม่เปลี่ยนเป็นสถานะกำลังโหลด (ใช้หลังบันทึกหรือเมื่อกลับมาที่แท็บ) */
  const load = useCallback(async (quiet: boolean) => {
    const current = ++seq.current
    if (!quiet) setState('loading')
    try {
      const list = await athletesApi.list()
      if (current !== seq.current) return
      setAthletes(list)
      setState('ready')
    } catch (failure) {
      if (current !== seq.current || quiet) return
      setLoadError(messageOf(failure, ''))
      setState('error')
    }
  }, [])

  useEffect(() => {
    load(false)
    return () => {
      seq.current++
    }
  }, [load])

  // กลับมาที่แท็บนี้: ดึงค่าล่าสุดที่คนอื่นอาจแก้ไว้ (ฟอร์มที่เปิดอยู่เก็บค่าของตัวเอง และ server ตรวจรุ่นตอนบันทึก)
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === 'visible') load(true)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [load])

  // ข้อมูลบุคคล (ชื่อ ชื่อเล่น รหัสนักศึกษา รูป สถานะ) ใช้ค่าล่าสุดจากทะเบียนสมาชิกที่หน้านี้ถืออยู่ จึงตรงกับหน้าสมาชิกเสมอ
  const roster = useMemo(() => {
    const byId = new Map(members.map((m) => [m.id, m]))
    return athletes.map((a) => {
      const person = byId.get(a.memberId)
      return person
        ? { ...a, name: person.name, nickname: person.nickname, studentId: person.studentId ?? '', memberStatus: person.status, memberSourceState: person.sourceState ?? 'ok', photoVersion: person.photoVersion ?? null }
        : a
    })
  }, [athletes, members])

  // เกมที่มีในรายชื่อ (ไม่สนตัวพิมพ์เล็กใหญ่ ใช้การสะกดที่พบครั้งแรก)
  const games = useMemo(() => {
    const seen = new Map<string, string>()
    for (const a of roster) if (!seen.has(a.game.toLowerCase())) seen.set(a.game.toLowerCase(), a.game)
    return [...seen.values()].sort((a, b) => a.localeCompare(b, 'th'))
  }, [roster])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return roster
      .filter((a) => {
        if (status && a.status !== status) return false
        if (game && a.game.toLowerCase() !== game.toLowerCase()) return false
        if (!q) return true
        return [a.name, a.nickname, a.studentId, a.ign, a.team, a.position, a.game].some((text) => text.toLowerCase().includes(q))
      })
      .sort((a, b) => a.status.localeCompare(b.status) || a.game.localeCompare(b.game, 'th') || a.name.localeCompare(b.name, 'th'))
  }, [roster, query, game, status])

  const hasFilter = query.trim() !== '' || game !== '' || status !== ''
  const clearFilters = () => {
    setQuery('')
    setGame('')
    setStatus('')
  }

  const byId = (id: string | null) => roster.find((a) => a.memberId === id)
  const detail = byId(detailId)
  const editTarget = form?.mode === 'edit' ? byId(form.memberId) : undefined
  const removeTarget = byId(removeId)
  const photoTarget = byId(photoId)
  const takenIds = useMemo(() => new Set(athletes.map((a) => a.memberId)), [athletes])

  const openDetail = (id: string | null) => {
    setDetailError('')
    setDetailNotice('')
    setDetailId(id)
  }

  /** ข้อมูลเปลี่ยน: โหลดรายชื่อนักกีฬาและทะเบียนสมาชิกล่าสุด (รูปและชื่อมาจากทะเบียน) */
  const refreshAll = () => {
    load(true)
    refresh().catch(() => undefined)
  }

  const removeAthlete = async (target: Athlete) => {
    setBusy(true)
    setDetailError('')
    try {
      const result = await athletesApi.remove(target.memberId, target.version)
      setRemoveId(null)
      setDetailId(null)
      refreshAll()
      toast.success(result.removed ? `ถอด “${target.name}” ออกจากนักกีฬาแล้ว ข้อมูลในทะเบียนสมาชิกยังอยู่` : `“${target.name}” ไม่ได้เป็นนักกีฬาแล้ว ไม่มีอะไรต้องทำเพิ่ม`)
    } catch (failure) {
      setRemoveId(null)
      refreshAll()
      if (hasCode(failure, 'version_conflict')) {
        setDetailError('ถอดจากนักกีฬาไม่สำเร็จ: ข้อมูลนักกีฬาของคนนี้ถูกแก้ไขจากที่อื่น ด้านล่างเป็นค่าล่าสุดแล้ว ตรวจแล้วกดปุ่มเดิมอีกครั้งถ้ายังต้องการ')
      } else if (hasCode(failure, 'network')) {
        setDetailError('ยังยืนยันไม่ได้ว่าถอดจากนักกีฬาแล้วหรือไม่ เพราะเชื่อมต่อระบบกลางไม่ได้ รายชื่อจะแสดงสถานะจริงเมื่อโหลดได้ ถ้ายังอยู่ให้กดปุ่มเดิมอีกครั้ง')
      } else {
        setDetailError(`ถอดจากนักกีฬาไม่สำเร็จ: ${messageOf(failure, 'ระบบขัดข้อง')} ข้อมูลยังเป็นค่าเดิม กดปุ่มเดิมเพื่อลองอีกครั้ง`)
      }
    } finally {
      setBusy(false)
    }
  }

  const addButton = (label: string) => (
    <button type="button" className="button button-primary" onClick={() => setForm({ mode: 'add' })}>
      <UserPlus aria-hidden="true" size={18} />
      {label}
    </button>
  )

  const pending = storeState === 'loading' || (storeState === 'ready' && state === 'loading')
  const failed = storeState === 'error' || state === 'error'

  return (
    <>
      <PageHeader title="นักกีฬา" description="รายชื่อนักกีฬาของชมรม แยกตามเกมและทีม ข้อมูลบุคคลและรูปมาจากทะเบียนสมาชิก" action={!pending && !failed ? addButton('เพิ่มนักกีฬา') : undefined} />

      {pending && (
        <div className="state-block" role="status">
          <LoaderCircle aria-hidden="true" size={24} className="spin" />
          <p>กำลังโหลดรายชื่อนักกีฬา…</p>
        </div>
      )}

      {!pending && failed && (
        <div className="state-block state-error" role="alert">
          <TriangleAlert aria-hidden="true" size={28} />
          <p className="empty-state-title">โหลดรายชื่อนักกีฬาไม่สำเร็จ</p>
          <p className="empty-state-text">{(storeState === 'error' ? storeError : loadError) || 'โหลดข้อมูลจากระบบกลางไม่ได้ ลองอีกครั้งในอีกสักครู่'}</p>
          <button
            type="button"
            className="button button-primary"
            onClick={() => {
              if (storeState === 'error') reloadStore()
              load(false)
            }}
          >
            ลองโหลดอีกครั้ง
          </button>
        </div>
      )}

      {!pending && !failed && roster.length === 0 && (
        <section className="card">
          <EmptyState icon={Swords} title="ยังไม่มีนักกีฬา" action={addButton('เพิ่มนักกีฬาคนแรก')}>
            เพิ่มนักกีฬาจากคนในทะเบียนสมาชิก แล้วรายชื่อจะแสดงที่นี่ การเป็นนักกีฬาไม่เปลี่ยนสิทธิ์ใช้ระบบของคนนั้น
          </EmptyState>
        </section>
      )}

      {!pending && !failed && roster.length > 0 && (
        <section className="card" aria-label="รายชื่อนักกีฬา">
          <div className="toolbar" role="search">
            <div className="search-field">
              <Search aria-hidden="true" size={18} />
              <label htmlFor="athlete-search" className="visually-hidden">
                ค้นหานักกีฬา
              </label>
              <input id="athlete-search" type="search" placeholder="ค้นหาชื่อ ชื่อเล่น ชื่อในเกม ทีม หรือเกม" value={query} onChange={(e) => setQuery(e.target.value)} />
            </div>
            <div className="toolbar-filter">
              <label htmlFor="athlete-filter-game">เกม</label>
              <select id="athlete-filter-game" value={game} onChange={(e) => setGame(e.target.value)}>
                <option value="">ทุกเกม</option>
                {games.map((g) => (
                  <option key={g} value={g}>
                    {g}
                  </option>
                ))}
              </select>
            </div>
            <div className="toolbar-filter">
              <label htmlFor="athlete-filter-status">สถานะนักกีฬา</label>
              <select id="athlete-filter-status" value={status} onChange={(e) => setStatus(e.target.value as AthleteStatus | '')}>
                <option value="">ทุกสถานะ</option>
                {ATHLETE_STATUSES.map((s) => (
                  <option key={s} value={s}>
                    {ATHLETE_STATUS_LABELS[s]}
                  </option>
                ))}
              </select>
            </div>
            <button type="button" className="button" onClick={clearFilters} disabled={!hasFilter}>
              ล้างตัวกรอง
            </button>
          </div>

          <p className="result-count" role="status">
            {hasFilter ? `พบ ${filtered.length} จาก ${roster.length} คน` : `นักกีฬาทั้งหมด ${roster.length} คน`}
          </p>

          {filtered.length === 0 ? (
            <EmptyState
              icon={SearchX}
              title="ไม่พบนักกีฬาที่ตรงกับเงื่อนไข"
              action={
                <button type="button" className="button" onClick={clearFilters}>
                  ล้างตัวกรอง
                </button>
              }
            >
              ลองเปลี่ยนคำค้นหา หรือล้างตัวกรองเพื่อดูนักกีฬาทั้งหมด
            </EmptyState>
          ) : (
            <ul className="roster-grid">
              {filtered.map((a) => (
                <li key={a.memberId} className="roster-card">
                  <Avatar memberId={a.memberId} version={a.photoVersion} name={a.nickname || a.name} size="lg" />
                  <div className="roster-main">
                    <p className="roster-name" title={a.name}>
                      {a.name}
                    </p>
                    <p className="roster-nickname">
                      {a.nickname}
                      {a.ign ? ` · ${a.ign}` : ''}
                    </p>
                    <p className="roster-game">
                      <Gamepad2 aria-hidden="true" size={15} />
                      <span>
                        {a.game}
                        {a.team ? ` · ${a.team}` : ''}
                        {a.position ? ` · ${a.position}` : ''}
                      </span>
                    </p>
                    <p className="roster-badges">
                      <AthleteStatusBadge status={a.status} />
                      {a.memberStatus !== 'active' && <span className="badge badge-suspended">สมาชิกถูกพักการใช้งาน</span>}
                      {a.memberSourceState === 'missing' && <span className="badge badge-warning">ไม่พบในชีตต้นฉบับ</span>}
                    </p>
                  </div>
                  <button type="button" className="button button-small roster-open" onClick={() => openDetail(a.memberId)} aria-label={`ดูรายละเอียดนักกีฬา ${a.name}`}>
                    ดูรายละเอียด
                  </button>
                </li>
              ))}
            </ul>
          )}
        </section>
      )}

      {detail && !form && !removeTarget && !photoTarget && (
        <Dialog
          title={detail.name}
          description={`ชื่อเล่น: ${detail.nickname}`}
          onRequestClose={() => openDetail(null)}
          footer={
            <>
              <button type="button" className="button button-danger-outline" data-return-focus="remove" onClick={() => setRemoveId(detail.memberId)}>
                <UserMinus aria-hidden="true" size={16} />
                ถอดจากนักกีฬา
              </button>
              <button type="button" className="button button-primary" onClick={() => setForm({ mode: 'edit', memberId: detail.memberId })} data-autofocus>
                <Pencil aria-hidden="true" size={16} />
                แก้ไข
              </button>
            </>
          }
        >
          {detailError && (
            <p className="form-alert detail-alert" role="alert">
              {detailError}
            </p>
          )}
          {detailNotice && (
            <p className="notice notice-success detail-alert" role="status">
              <CircleCheck aria-hidden="true" size={18} />
              <span>{detailNotice}</span>
            </p>
          )}
          <div className="person-head">
            <Avatar memberId={detail.memberId} version={detail.photoVersion} name={detail.nickname || detail.name} size="xl" label={detail.photoVersion ? `รูปของ ${detail.name}` : `${detail.name} ยังไม่มีรูป`} />
            <div className="person-head-actions">
              <button type="button" className="button button-small" data-return-focus="photo" onClick={() => setPhotoId(detail.memberId)}>
                <ImagePlus aria-hidden="true" size={16} />
                {detail.photoVersion ? 'เปลี่ยนหรือลบรูป' : 'เพิ่มรูป'}
              </button>
              <p className="field-hint">รูปนี้เป็นรูปเดียวกับในหน้าสมาชิก</p>
            </div>
          </div>
          {detail.memberSourceState === 'missing' && (
            <p className="notice notice-warning detail-alert">
              <TriangleAlert aria-hidden="true" size={18} />
              ไม่พบแถวของคนนี้ในชีตต้นฉบับของทะเบียนสมาชิกแล้ว ข้อมูลนักกีฬาและรูปยังเก็บไว้กับคนเดิม ไม่ถูกลบ
            </p>
          )}
          <dl className="detail-list">
            <div>
              <dt>เกม</dt>
              <dd className="break-word">{detail.game}</dd>
            </div>
            <div>
              <dt>สถานะนักกีฬา</dt>
              <dd>
                <AthleteStatusBadge status={detail.status} />
              </dd>
            </div>
            <div>
              <dt>ทีม</dt>
              <dd className="break-word">{detail.team || <span className="muted">ไม่ได้ระบุ</span>}</dd>
            </div>
            <div>
              <dt>ตำแหน่ง</dt>
              <dd className="break-word">{detail.position || <span className="muted">ไม่ได้ระบุ</span>}</dd>
            </div>
            <div>
              <dt>ชื่อในเกม (IGN)</dt>
              <dd className="break-word">{detail.ign || <span className="muted">ไม่ได้ระบุ</span>}</dd>
            </div>
            <div>
              <dt>รหัสนักศึกษา</dt>
              <dd className="break-word">{detail.studentId || <span className="muted">ยังไม่ได้กรอก</span>}</dd>
            </div>
            <div>
              <dt>สถานะในทะเบียนสมาชิก</dt>
              <dd>
                <StatusBadge status={detail.memberStatus} />
              </dd>
            </div>
            <div>
              <dt>ทะเบียนสมาชิก</dt>
              <dd>
                <Link to={`/members?member=${encodeURIComponent(detail.memberId)}`}>เปิดข้อมูลสมาชิกของคนนี้</Link>
              </dd>
            </div>
            <div className="detail-wide">
              <dt>หมายเหตุของนักกีฬา</dt>
              <dd className="pre-line">{detail.note || <span className="muted">ไม่มีหมายเหตุ</span>}</dd>
            </div>
          </dl>
        </Dialog>
      )}

      {removeTarget && (
        <ConfirmDialog title={`ถอด “${removeTarget.name}” ออกจากนักกีฬา?`} confirmLabel="ถอดจากนักกีฬา" tone="danger" busy={busy} onConfirm={() => removeAthlete(removeTarget)} onCancel={() => {
          returnFocus.current = 'remove'
          setRemoveId(null)
        }}>
          <ul className="bulleted">
            <li>ลบเฉพาะข้อมูลนักกีฬา (เกม ทีม ตำแหน่ง ชื่อในเกม และหมายเหตุของนักกีฬา) ของคนนี้</li>
            <li>ข้อมูลในทะเบียนสมาชิก รูป และบัญชีเข้าสู่ระบบของคนนี้ไม่ถูกลบหรือเปลี่ยน ยังเข้าสู่ระบบได้ตามเดิม</li>
            <li>เพิ่มกลับเป็นนักกีฬาได้ภายหลัง โดยกรอกข้อมูลนักกีฬาใหม่</li>
          </ul>
        </ConfirmDialog>
      )}

      {photoTarget && (
        <PhotoDialog
          person={{ id: photoTarget.memberId, name: photoTarget.name, nickname: photoTarget.nickname, photoVersion: photoTarget.photoVersion }}
          onClose={() => {
            returnFocus.current = 'photo'
            setPhotoId(null)
          }}
          onRefresh={refreshAll}
          onChanged={(message) => {
            refreshAll()
            setPhotoId(null)
            setDetailNotice(message)
          }}
        />
      )}

      {form && (form.mode === 'add' || editTarget) && (
        <AthleteForm
          athlete={editTarget}
          members={members}
          takenIds={takenIds}
          games={games}
          canAddPerson={!sheetReadOnly}
          onClose={() => setForm(null)}
          onStale={refreshAll}
          onSaved={(message, saved) => {
            // แสดงผลหลัง server ยืนยันแล้วเท่านั้น จากนั้นโหลดรายชื่อล่าสุดเงียบ ๆ
            seq.current++
            setAthletes((list) => (list.some((a) => a.memberId === saved.memberId) ? list.map((a) => (a.memberId === saved.memberId ? saved : a)) : [...list, saved]))
            refreshAll()
            setForm(null)
            setDetailId(null)
            toast.success(message)
          }}
        />
      )}
    </>
  )
}
