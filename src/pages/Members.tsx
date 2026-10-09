import { CONTACT_PLATFORMS } from '../lib/contacts'
import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { ExternalLink, ImagePlus, Pencil, Search, SearchX, Trash2, TriangleAlert, UserPlus, Users } from 'lucide-react'
import { useAuth } from '../auth/AuthProvider'
import { Avatar } from '../components/Avatar'
import { Dialog } from '../components/Dialog'
import { SyncBar } from '../components/SyncBar'
import { useToast } from '../components/Toast'
import { DataBoundary, EmptyState, PageHeader, StatusBadge } from '../components/ui'
import { hasCode, isUnconfirmed, messageOf } from '../data/errors'
import { useStore } from '../data/store'
import { useSync } from '../data/sync'
import { ATHLETE_STATUS_LABELS, ROLE_LABELS, ROLES, STATUS_LABELS, STATUSES } from '../data/types'
import type { Member, MemberRole, MemberStatus } from '../data/types'
import { formatDate } from '../lib/datetime'
import { IS_DEMO } from '../mode'
import { AccountSection, ConfirmLoginIdDialog, DeleteAccountDialog, DisableAccountDialog, SetPasswordDialog } from './AccountDialogs'
import type { AccountAction } from './AccountDialogs'
import { MemberForm } from './MemberForm'
import { DeleteMemberDialog } from './DeleteMemberDialog'
import { PhotoDialog } from './PhotoDialog'
import { SuspendConfirm } from './SuspendConfirm'

type FormTarget = { mode: 'add' } | { mode: 'edit'; id: string }

export function MembersPage() {
  const { state, members, setMemberStatus, refresh } = useStore()
  const { isAdmin } = useAuth()
  const toast = useToast()
  const [searchParams, setSearchParams] = useSearchParams()
  // แหล่งหลักของทะเบียน: ชีตที่เชื่อม (ถ้ามี) ใช้บอกว่าสมาชิกคนใดยังอยู่เฉพาะในเว็บ
  const sheet = useSync()?.statuses.sheets
  const sheetLinked = sheet?.linked === true
  const sheetReadOnly = sheetLinked && sheet?.resource?.access === 'read'

  const [query, setQuery] = useState('')
  const [status, setStatus] = useState<MemberStatus | ''>('')
  const [role, setRole] = useState<MemberRole | ''>('')

  const [detailId, setDetailId] = useState<string | null>(null)
  const [form, setForm] = useState<FormTarget | null>(null)
  const [suspendId, setSuspendId] = useState<string | null>(null)
  // กล่องจัดการบัญชีของสมาชิกที่เปิดรายละเอียดอยู่ (เปิดทีละกล่อง ไม่ซ้อนกับกล่องรายละเอียด)
  const [accountAction, setAccountAction] = useState<AccountAction | null>(null)
  // ผลของการจัดการบัญชีครั้งล่าสุด แสดงในกล่องรายละเอียดของสมาชิกคนนั้น
  const [accountNotice, setAccountNotice] = useState('')
  // กล่องจัดการรูปของสมาชิกที่เปิดรายละเอียดอยู่ และผลของการเปลี่ยนรูปครั้งล่าสุด
  const [photoOpen, setPhotoOpen] = useState(false)
  const [photoNotice, setPhotoNotice] = useState('')
  const [deleteTarget, setDeleteTarget] = useState<Member | null>(null)
  const addButton = useRef<HTMLButtonElement>(null)
  // ปุ่มในกล่องรายละเอียดที่ควรได้ focus กลับ เมื่อปิดกล่องย่อยโดยไม่บันทึก (กล่องรายละเอียดถูกสร้างใหม่ จึงระบุปุ่มด้วยชื่อ)
  const returnFocus = useRef<string | null>(null)
  const [busy, setBusy] = useState(false)
  // แสดงในหน้ารายละเอียดที่เปิดอยู่ เพราะข้อความแจ้งผลนอก dialog จะถูกฉากมืดบัง
  const [statusError, setStatusError] = useState('')

  // ทางลัดจากหน้าภาพรวม: /members?new=1 เปิดฟอร์มเพิ่มสมาชิกทันที
  useEffect(() => {
    if (searchParams.get('new') !== '1' || state !== 'ready') return
    setForm({ mode: 'add' })
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('new')
        return next
      },
      { replace: true },
    )
  }, [searchParams, setSearchParams, state])

  // ลิงก์จากหน้านักกีฬา: /members?member=<รหัสสมาชิก> เปิดรายละเอียดของคนนั้น (ไม่พบก็เปิดรายการตามปกติ)
  useEffect(() => {
    const wanted = searchParams.get('member')
    if (!wanted || state !== 'ready') return
    if (members.some((m) => m.id === wanted)) setDetailId(wanted)
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev)
        next.delete('member')
        return next
      },
      { replace: true },
    )
  }, [searchParams, setSearchParams, state, members])

  // ทำงานหลังกล่องรายละเอียดเปิดกลับและตั้ง focus เริ่มต้นของตัวเองแล้ว: ย้าย focus ไปปุ่มที่ผู้ใช้กดเปิดกล่องย่อย
  useEffect(() => {
    const target = returnFocus.current
    if (!target || accountAction !== null || photoOpen || deleteTarget) return
    // คืนหลัง Dialog เปิดและ browser ตั้ง focus เริ่มต้นเสร็จแล้ว มิฉะนั้น focus ถูกปุ่มแก้ไขดึงกลับ
    const frame = requestAnimationFrame(() => {
      const button = document.querySelector<HTMLElement>(`dialog[open] [data-return-focus="${target}"]`)
      if (button) { button.focus(); returnFocus.current = null }
    })
    return () => cancelAnimationFrame(frame)
  }, [accountAction, photoOpen, deleteTarget])
  const closeAccountDialog = () => {
    returnFocus.current = accountAction ? `account-${accountAction}` : null
    setAccountAction(null)
  }

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return members
      .filter((m) => {
        if (status && m.status !== status) return false
        if (role && m.role !== role) return false
        if (!q) return true
        return [m.name, m.nickname, m.studentId ?? '', ROLE_LABELS[m.role]].some((text) => text.toLowerCase().includes(q))
      })
      .sort((a, b) => b.addedAt.localeCompare(a.addedAt) || a.name.localeCompare(b.name, 'th'))
  }, [members, query, status, role])

  const hasFilter = query.trim() !== '' || status !== '' || role !== ''
  const clearFilters = () => {
    setQuery('')
    setStatus('')
    setRole('')
  }

  // สำเนาจากชีตแก้ได้เมื่อแถวยังอยู่และบัญชีชมรมเขียนชีตได้ (server ตรวจซ้ำเสมอ) ข้อมูลเฉพาะในเว็บแก้ได้ตามเดิม
  const canEdit = (m: Member) => m.source !== 'sheets' || !sheetLinked || (m.sourceState !== 'missing' && !sheetReadOnly)
  const byId = (id: string | null) => members.find((m) => m.id === id)
  const detail = byId(detailId)
  const suspendTarget = byId(suspendId)
  const editTarget = form?.mode === 'edit' ? byId(form.id) : undefined

  // จัดการบัญชีสำเร็จ: โหลดสถานะบัญชีล่าสุด แล้วกลับไปที่รายละเอียดของสมาชิกคนเดิม
  const accountSaved = (message: string) => {
    refresh().catch(() => undefined)
    setAccountAction(null)
    setAccountNotice(message)
  }

  const openDetail = (id: string | null) => {
    setStatusError('')
    setAccountNotice('')
    setPhotoNotice('')
    setDetailId(id)
  }

  const changeStatus = async (member: Member, next: MemberStatus) => {
    setBusy(true)
    setStatusError('')
    try {
      await setMemberStatus(member.id, next, member.version)
      // กลับไปที่รายการ เพื่อให้เห็นสถานะใหม่และข้อความแจ้งผล
      setSuspendId(null)
      setDetailId(null)
      toast.success(
        next === 'suspended' ? `พักการใช้งาน “${member.name}” แล้ว` : `เปิดใช้งาน “${member.name}” อีกครั้งแล้ว`,
      )
    } catch (error) {
      setSuspendId(null)
      const action = next === 'suspended' ? 'พักการใช้งาน' : 'เปิดใช้งานอีกครั้ง'
      if (hasCode(error, 'version_conflict')) {
        // โหลดค่าล่าสุดมาแสดงในหน้านี้ ให้ตรวจก่อนกดอีกครั้ง
        refresh().catch(() => undefined)
        setStatusError(`${action}ไม่สำเร็จ: ข้อมูลสมาชิกนี้ถูกแก้ไขจากที่อื่น ด้านล่างเป็นค่าล่าสุดแล้ว ตรวจแล้วกดปุ่มเดิมอีกครั้งถ้ายังต้องการ`)
      } else if (isUnconfirmed(error)) {
        refresh().catch(() => undefined)
        setStatusError(messageOf(error, ''))
      } else {
        setStatusError(`${action}ไม่สำเร็จ: ${messageOf(error, 'ระบบขัดข้อง')} สถานะยังเป็นค่าเดิม กดปุ่มเดิมเพื่อลองอีกครั้ง`)
      }
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <PageHeader
        title="สมาชิก"
        description="ค้นหา ดูรายละเอียด และจัดการรายชื่อสมาชิกของชมรม"
        action={
          <button ref={addButton} type="button" className="button button-primary" onClick={() => setForm({ mode: 'add' })} disabled={sheetReadOnly}>
            <UserPlus aria-hidden="true" size={18} />
            เพิ่มสมาชิก
          </button>
        }
      />

      <SyncBar kinds={['sheets']} />

      <DataBoundary>
        {members.length === 0 ? (
          <section className="card">
            <EmptyState
              icon={Users}
              title="ยังไม่มีสมาชิก"
              action={
                <button type="button" className="button button-primary" onClick={() => setForm({ mode: 'add' })}>
                  เพิ่มสมาชิกคนแรก
                </button>
              }
            >
              เริ่มจากเพิ่มสมาชิกคนแรก แล้วรายชื่อจะแสดงที่นี่
            </EmptyState>
          </section>
        ) : (
          <section className="card" aria-label="รายชื่อสมาชิก">
            <div className="toolbar" role="search">
              <div className="search-field">
                <Search aria-hidden="true" size={18} />
                <label htmlFor="member-search" className="visually-hidden">
                  ค้นหาสมาชิก
                </label>
                <input
                  id="member-search"
                  type="search"
                  placeholder="ค้นหาชื่อ ชื่อเล่น รหัสนักศึกษา หรือบทบาท"
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                />
              </div>
              <div className="toolbar-filter">
                <label htmlFor="filter-status">สถานะ</label>
                <select id="filter-status" value={status} onChange={(e) => setStatus(e.target.value as MemberStatus | '')}>
                  <option value="">ทุกสถานะ</option>
                  {STATUSES.map((s) => (
                    <option key={s} value={s}>
                      {STATUS_LABELS[s]}
                    </option>
                  ))}
                </select>
              </div>
              <div className="toolbar-filter">
                <label htmlFor="filter-role">บทบาท</label>
                <select id="filter-role" value={role} onChange={(e) => setRole(e.target.value as MemberRole | '')}>
                  <option value="">ทุกบทบาท</option>
                  {ROLES.map((r) => (
                    <option key={r} value={r}>
                      {ROLE_LABELS[r]}
                    </option>
                  ))}
                </select>
              </div>
              <button type="button" className="button" onClick={clearFilters} disabled={!hasFilter}>
                ล้างตัวกรอง
              </button>
            </div>

            <p className="result-count" role="status">
              {hasFilter ? `พบ ${filtered.length} จาก ${members.length} คน` : `ทั้งหมด ${members.length} คน`}
            </p>

            {filtered.length === 0 ? (
              <EmptyState
                icon={SearchX}
                title="ไม่พบสมาชิกที่ตรงกับเงื่อนไข"
                action={
                  <button type="button" className="button" onClick={clearFilters}>
                    ล้างตัวกรอง
                  </button>
                }
              >
                ลองเปลี่ยนคำค้นหา หรือล้างตัวกรองเพื่อดูสมาชิกทั้งหมด
              </EmptyState>
            ) : (
              <div className="table-wrap">
                <table className="table members-table">
                  <thead>
                    <tr>
                      <th scope="col">ชื่อ / ชื่อเล่น</th>
                      <th scope="col">บทบาท</th>
                      <th scope="col">สถานะ</th>
                      <th scope="col">วันที่เพิ่ม</th>
                      <th scope="col">
                        <span className="visually-hidden">การทำงาน</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {filtered.map((m) => (
                      <tr key={m.id}>
                        <th scope="row" className="cell-name">
                          <span className="member-cell">
                            <Avatar memberId={m.id} version={m.photoVersion} name={m.nickname || m.name} size="md" />
                            <span className="member-cell-text">
                              <span className="member-name">{m.name}</span>
                              <span className="member-nickname">{m.nickname}</span>
                              {m.studentId && <span className="member-student-id">รหัสนักศึกษา {m.studentId}</span>}
                              <SourceNote member={m} sheetLinked={sheetLinked} />
                            </span>
                          </span>
                        </th>
                        <td data-label="บทบาท">{ROLE_LABELS[m.role]}</td>
                        <td data-label="สถานะ">
                          <StatusBadge status={m.status} />
                        </td>
                        <td data-label="วันที่เพิ่ม" className="cell-date">
                          {formatDate(m.addedAt)}
                        </td>
                        <td className="cell-action">
                          <button
                            type="button"
                            className="button button-small"
                            onClick={() => openDetail(m.id)}
                            aria-label={`ดูรายละเอียด ${m.name}`}
                          >
                            ดูรายละเอียด
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </section>
        )}
      </DataBoundary>

      {detail && !form && !suspendTarget && !accountAction && !photoOpen && !deleteTarget && (
        <Dialog
          title={detail.name}
          description={`ชื่อเล่น: ${detail.nickname}`}
          onRequestClose={() => openDetail(null)}
          footer={
            <>
              {(isAdmin || IS_DEMO) && (
                <button type="button" className="button button-danger-outline" data-return-focus="member-delete" onClick={() => setDeleteTarget(detail)}>
                  <Trash2 aria-hidden="true" size={16} /> ลบข้อมูลสมาชิก
                </button>
              )}
              {!canEdit(detail) ? (
                <>
                  {sheet?.resource && (
                    <a className="button" href={sheet.resource.url} target="_blank" rel="noopener noreferrer">
                      เปิดชีตต้นฉบับ
                      <ExternalLink aria-hidden="true" size={16} />
                    </a>
                  )}
                  <button type="button" className="button button-primary" onClick={() => openDetail(null)} data-autofocus>
                    ปิด
                  </button>
                </>
              ) : (
                <>
                  {detail.status === 'active' ? (
                    <button type="button" className="button button-danger-outline" onClick={() => setSuspendId(detail.id)}>
                      พักการใช้งาน
                    </button>
                  ) : (
                    <button type="button" className="button" disabled={busy} onClick={() => changeStatus(detail, 'active')}>
                      เปิดใช้งานอีกครั้ง
                    </button>
                  )}
                  <button
                    type="button"
                    className="button button-primary"
                    onClick={() => setForm({ mode: 'edit', id: detail.id })}
                    data-autofocus
                  >
                    <Pencil aria-hidden="true" size={16} />
                    แก้ไข
                  </button>
                </>
              )}
            </>
          }
        >
          {statusError && (
            <p className="form-alert detail-alert" role="alert">
              {statusError}
            </p>
          )}
          {detail.sourceState === 'missing' && (
            <p className="notice notice-warning detail-alert">
              <TriangleAlert aria-hidden="true" size={18} />
              ไม่พบแถวของสมาชิกนี้ในชีตต้นฉบับแล้ว ข้อมูลด้านล่างเป็นค่าที่อ่านได้ครั้งล่าสุด ระบบเก็บไว้ ไม่ลบให้เอง
              {sheetLinked && ' จึงแก้จากเว็บไม่ได้จนกว่าแถวจะกลับมาในชีต (กู้คืนได้จากประวัติเวอร์ชันของ Google Sheets)'}
            </p>
          )}
          {sheetReadOnly && detail.source === 'sheets' && (
            <p className="notice detail-alert">บัญชี Google ของชมรมมีสิทธิ์อ่านชีตนี้อย่างเดียว จึงแก้จากเว็บไม่ได้ แก้ที่ชีตต้นฉบับ</p>
          )}
          {detail.studentIdIssue && (
            <p className="notice notice-warning detail-alert">
              <TriangleAlert aria-hidden="true" size={18} />
              <span>
                ชีตระบุรหัสนักศึกษา “{detail.studentIdIssue.claimed}” ซึ่ง
                {detail.studentIdIssue.code === 'invalid' ? 'ผิดรูปแบบ' : detail.studentIdIssue.code === 'duplicate' ? 'ซ้ำกับแถวอื่นในชีต' : 'ซ้ำกับสมาชิกอีกคนในระบบ'} ระบบจึงยังไม่ใช้ค่านี้
                {detail.studentId ? ` (ทะเบียนยังใช้ ${detail.studentId})` : ''} แก้ที่ชีตให้ถูกต้องและไม่ซ้ำ
              </span>
            </p>
          )}
          {!IS_DEMO && (
            <div className="person-head">
              <Avatar memberId={detail.id} version={detail.photoVersion} name={detail.nickname || detail.name} size="xl" label={detail.photoVersion ? `รูปของ ${detail.name}` : `${detail.name} ยังไม่มีรูป`} />
              <div className="person-head-actions">
                {photoNotice && (
                  <p className="notice notice-success" role="status">
                    {photoNotice}
                  </p>
                )}
                <button type="button" className="button button-small" data-return-focus="photo" onClick={() => setPhotoOpen(true)}>
                  <ImagePlus aria-hidden="true" size={16} />
                  {detail.photoVersion ? 'เปลี่ยนหรือลบรูป' : 'เพิ่มรูป'}
                </button>
                <p className="field-hint">รูปนี้ใช้ร่วมกับหน้านักกีฬาและบัญชีของสมาชิกคนนี้</p>
              </div>
            </div>
          )}
          <dl className="detail-list">
            <div>
              <dt>รหัสนักศึกษา</dt>
              <dd className="break-word">{detail.studentId || <span className="muted">ยังไม่ได้กรอก</span>}</dd>
            </div>
            <div>
              <dt>แหล่งข้อมูล</dt>
              <dd>{detail.source === 'sheets' ? 'Google Sheets ที่เชื่อม' : sheetLinked ? 'เฉพาะในเว็บ (ยังไม่อยู่ในชีต)' : 'ในเว็บ'}</dd>
            </div>
            <div>
              <dt>บทบาท</dt>
              <dd>{ROLE_LABELS[detail.role]}</dd>
            </div>
            <div>
              <dt>สถานะ</dt>
              <dd>
                <StatusBadge status={detail.status} />
              </dd>
            </div>
            <div>
              <dt>วันที่เพิ่ม</dt>
              <dd>{formatDate(detail.addedAt)}</dd>
            </div>
            <div>
              <dt>ช่องทางติดต่อ</dt>
              <dd>{detail.contact || <span className="muted">ไม่ได้ระบุ</span>}</dd></div><div><dt>อีเมลสมาชิก</dt><dd className="break-word">{detail.email||<span className="muted">ไม่ได้ระบุ</span>}</dd></div><div><dt>ช่องทางที่สมาชิกเพิ่ม</dt><dd>{detail.contacts?.length?<ul className="profile-contacts">{detail.contacts.map(c=><li key={c.platform}><strong>{CONTACT_PLATFORMS[c.platform]}</strong><span className="break-word">{c.value}</span></li>)}</ul>:<span className="muted">ไม่ได้ระบุ</span>}</dd>
            </div>
            {!IS_DEMO && (
              <div>
                <dt>นักกีฬา</dt>
                <dd className="break-word">
                  {detail.athlete ? (
                    <>
                      {detail.athlete.game} · {ATHLETE_STATUS_LABELS[detail.athlete.status]} (<Link to="/athletes">ดูหน้านักกีฬา</Link>)
                    </>
                  ) : (
                    <span className="muted">ไม่ได้เป็นนักกีฬา</span>
                  )}
                </dd>
              </div>
            )}
            <div className="detail-wide">
              <dt>หมายเหตุ</dt>
              <dd className="pre-line">{detail.note || <span className="muted">ไม่มีหมายเหตุ</span>}</dd>
            </div>
          </dl>
          <AccountSection
            member={detail}
            isAdmin={isAdmin}
            notice={accountNotice}
            onAction={(action) => {
              setAccountNotice('')
              setAccountAction(action)
            }}
          />
        </Dialog>
      )}

      {deleteTarget && <DeleteMemberDialog member={deleteTarget} onClose={() => {
        returnFocus.current = 'member-delete'
        setDeleteTarget(null)
      }} onDeleted={() => {
        const name = deleteTarget.name
        setDeleteTarget(null)
        setDetailId(null)
        refresh().catch(() => undefined)
        toast.success(`ลบข้อมูลสมาชิก “${name}” ออกจากเว็บแล้ว`)
        requestAnimationFrame(() => {
          if (addButton.current && !addButton.current.disabled) addButton.current.focus()
          else document.querySelector<HTMLInputElement>('#member-search')?.focus()
        })
      }} />}

      {detail && accountAction === 'password' && <SetPasswordDialog member={detail} onClose={closeAccountDialog} onSaved={accountSaved} />}
      {detail && accountAction === 'disable' && <DisableAccountDialog member={detail} onClose={closeAccountDialog} onSaved={accountSaved} />}
      {detail && accountAction === 'login-id' && <ConfirmLoginIdDialog member={detail} onClose={closeAccountDialog} onSaved={accountSaved} />}
      {detail && accountAction === 'delete' && (
        <DeleteAccountDialog member={detail} onClose={closeAccountDialog} onSaved={accountSaved} onRefresh={() => void refresh().catch(() => undefined)} />
      )}

      {detail && photoOpen && (
        <PhotoDialog
          person={detail}
          onClose={() => {
            returnFocus.current = 'photo'
            setPhotoOpen(false)
          }}
          onRefresh={() => void refresh().catch(() => undefined)}
          onChanged={(message) => {
            refresh().catch(() => undefined)
            setPhotoOpen(false)
            setPhotoNotice(message)
          }}
        />
      )}

      {suspendTarget && (
        <SuspendConfirm
          name={suspendTarget.name}
          busy={busy}
          onConfirm={() => changeStatus(suspendTarget, 'suspended')}
          onCancel={() => setSuspendId(null)}
        />
      )}

      {form && (form.mode === 'add' || editTarget) && (
        <MemberForm
          member={editTarget}
          onClose={() => setForm(null)}
          onSaved={(message) => {
            setForm(null)
            setDetailId(null)
            toast.success(message)
          }}
        />
      )}
    </>
  )
}

/** ป้ายกำกับสมาชิกที่ไม่ได้เป็นสำเนาปกติจากชีต เพื่อไม่ให้ข้อมูลสองที่ดูเป็น "ล่าสุด" เหมือนกัน */
function SourceNote({ member, sheetLinked }: { member: Member; sheetLinked: boolean }) {
  if (member.sourceState === 'missing') return <span className="badge badge-warning source-note">ไม่พบในชีตต้นฉบับ</span>
  if (sheetLinked && member.source === 'local') return <span className="badge badge-neutral source-note">เฉพาะในเว็บ</span>
  return null
}
