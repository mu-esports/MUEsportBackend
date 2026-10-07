import { Link } from 'react-router-dom'
import { ArrowRight, CalendarPlus, CalendarX, ChevronRight, Unplug, UserPlus, Users } from 'lucide-react'
import { CalendarView, useCalendarState } from '../components/CalendarView'
import { SyncBar } from '../components/SyncBar'
import { useShortcuts } from '../components/nav'
import { DataBoundary, EmptyState, PageHeader } from '../components/ui'
import { APP_TAGLINE } from '../config'
import { DATA_SOURCES, SOURCE_STATUS_LABELS } from '../data/sources'
import { GOOGLE_STATUS_LABELS, RESOURCE_NAMES, resourceStatusLabel, useSourcesStatus } from '../data/sourcesStatus'
import { useStore } from '../data/store'
import { IS_DEMO } from '../mode'
import { formatEventRange, upcomingEvents } from '../lib/datetime'

const UPCOMING_LIMIT = 5

export function OverviewPage() {
  const { members: allMembers, events } = useStore()
  // สรุปนับเฉพาะสมาชิกที่ยังอยู่ในแหล่งข้อมูล (รายการที่ไม่พบในชีตต้นฉบับยังดูได้ที่หน้าสมาชิก)
  const members = allMembers.filter((m) => m.sourceState !== 'missing')
  const activeCount = members.filter((m) => m.status === 'active').length
  const suspendedCount = members.length - activeCount
  const upcoming = upcomingEvents(events, UPCOMING_LIMIT)
  const shortcuts = useShortcuts()
  const calendar = useCalendarState()

  return (
    <>
      <PageHeader
        title="ภาพรวม"
        description={`${APP_TAGLINE} สรุปสมาชิก กำหนดการถัดไป และสถานะแหล่งข้อมูล`}
        action={
          <>
            <Link to="/calendar?new=1" className="button">
              <CalendarPlus aria-hidden="true" size={18} />
              เพิ่มกำหนดการ
            </Link>
            <Link to="/members?new=1" className="button button-primary">
              <UserPlus aria-hidden="true" size={18} />
              เพิ่มสมาชิก
            </Link>
          </>
        }
      />

      <nav aria-label="ทางลัด">
        <ul className="shortcuts">
          {shortcuts.map(({ to, icon: Icon, shortcut }) => (
            <li key={to}>
              <Link to={to} className="shortcut">
                <span className="shortcut-icon">
                  <Icon aria-hidden="true" size={22} />
                </span>
                <span>{shortcut}</span>
              </Link>
            </li>
          ))}
        </ul>
      </nav>

      <SyncBar kinds={['sheets', 'calendar']} />

      <DataBoundary>
        <div className="overview-grid">
          <section className="card overview-members" aria-labelledby="overview-members-title">
            <div className="card-header">
              <h2 id="overview-members-title">สมาชิก</h2>
              <Link to="/members" className="text-link">
                ดูสมาชิกทั้งหมด
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            </div>
            {members.length === 0 ? (
              <EmptyState
                icon={Users}
                title="ยังไม่มีสมาชิก"
                action={
                  <Link to="/members?new=1" className="button button-primary">
                    เพิ่มสมาชิกคนแรก
                  </Link>
                }
              >
                เพิ่มสมาชิกคนแรกเพื่อเริ่มเห็นจำนวนสมาชิกที่นี่
              </EmptyState>
            ) : (
              <dl className="stats">
                <div>
                  <dt>สมาชิกทั้งหมด</dt>
                  <dd>
                    {members.length} <span>คน</span>
                  </dd>
                </div>
                <div>
                  <dt>สถานะใช้งาน</dt>
                  <dd>
                    {activeCount} <span>คน</span>
                  </dd>
                </div>
                <div>
                  <dt>พักการใช้งาน</dt>
                  <dd>
                    {suspendedCount} <span>คน</span>
                  </dd>
                </div>
              </dl>
            )}
          </section>

          <section className="card overview-events" aria-labelledby="overview-events-title">
            <div className="card-header">
              <h2 id="overview-events-title">กำหนดการที่กำลังจะมาถึง</h2>
              <Link to="/calendar" className="text-link">
                ดูปฏิทิน
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            </div>
            {upcoming.length === 0 ? (
              <EmptyState
                icon={CalendarX}
                title="ยังไม่มีกำหนดการที่กำลังจะมาถึง"
                action={
                  <Link to="/calendar?new=1" className="button">
                    เพิ่มกำหนดการ
                  </Link>
                }
              >
                เพิ่มกำหนดการถัดไปของชมรมเพื่อให้ทีมงานเห็นตรงกัน
              </EmptyState>
            ) : (
              <ul className="upcoming-list">
                {upcoming.map((e) => (
                  <li key={e.id}>
                    <Link to={`/calendar?event=${encodeURIComponent(e.id)}`} className="upcoming-link">
                      <span className="upcoming-title">{e.title}</span>
                      <span className="upcoming-when">{formatEventRange(e)}</span>
                      <ChevronRight aria-hidden="true" size={18} />
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="card overview-sources" aria-labelledby="overview-sources-title">
            <div className="card-header">
              <h2 id="overview-sources-title">แหล่งข้อมูล</h2>
              <Link to="/sources" className="text-link">
                ดูแหล่งข้อมูล
                <ArrowRight aria-hidden="true" size={16} />
              </Link>
            </div>
            <SourcesSummary />
          </section>
        </div>

        <section className="home-calendar" aria-labelledby="home-calendar-title">
          <div className="card-header">
            <div>
              <h2 id="home-calendar-title">ปฏิทินเดือนนี้</h2>
              <p className="muted">กำหนดการที่บันทึกในระบบนี้ แสดงตามเวลาประเทศไทย</p>
            </div>
            <Link to="/calendar" className="text-link">
              เปิดหน้าปฏิทินเพื่อเพิ่มหรือแก้ไข
              <ArrowRight aria-hidden="true" size={16} />
            </Link>
          </div>
          {/* กดกำหนดการแล้วไปเปิดรายละเอียดที่หน้าปฏิทิน หน้านี้ไม่มี dialog หรือการเขียนข้อมูลของตัวเอง */}
          <div className="card calendar-card">
            <CalendarView
              calendar={calendar}
              events={events}
              headingLevel={3}
              eventHref={(id) => `/calendar?event=${encodeURIComponent(id)}`}
            />
          </div>
        </section>
      </DataBoundary>
    </>
  )
}

function DemoSourcesSummary() {
  return (
    <>
      <p className="notice">
        <Unplug aria-hidden="true" size={18} />
        ยังไม่ได้เชื่อมแหล่งข้อมูลภายนอก ข้อมูลในหน้านี้ทั้งหมดเป็นข้อมูลตัวอย่าง
      </p>
      <ul className="source-summary">
        {DATA_SOURCES.map((s) => (
          <li key={s.id}>
            <span>{s.name}</span>
            <span className="badge badge-neutral">{SOURCE_STATUS_LABELS[s.status]}</span>
          </li>
        ))}
      </ul>
    </>
  )
}

/** สถานะจริงจาก server: การเชื่อมบัญชี Google และแหล่งข้อมูลแต่ละชนิด */
function LiveSourcesSummary() {
  const { state, data, error, reload } = useSourcesStatus()
  if (state === 'loading') {
    return (
      <p className="notice" role="status">
        กำลังโหลดสถานะแหล่งข้อมูล…
      </p>
    )
  }
  if (state === 'error' || !data) {
    return (
      <div className="notice notice-warning" role="alert">
        <Unplug aria-hidden="true" size={18} />
        <div>
          <p>โหลดสถานะแหล่งข้อมูลไม่สำเร็จ: {error}</p>
          <button type="button" className="button button-small" onClick={reload}>
            ลองอีกครั้ง
          </button>
        </div>
      </div>
    )
  }
  return (
    <ul className="source-summary">
      <li>
        <span>บัญชี Google ของชมรม</span>
        <span className={`badge badge-${data.google.status === 'connected' ? 'active' : 'neutral'}`}>{GOOGLE_STATUS_LABELS[data.google.status]}</span>
      </li>
      {data.resources.map((r) => (
        <li key={r.id}>
          <span>{RESOURCE_NAMES[r.id]}</span>
          <span className={`badge badge-${r.status === 'ready' ? 'active' : 'neutral'}`}>{resourceStatusLabel(r.id, r.status)}</span>
        </li>
      ))}
    </ul>
  )
}

const SourcesSummary = IS_DEMO ? DemoSourcesSummary : LiveSourcesSummary
