import { Dialog } from '../components/Dialog'
import { formatEventRange } from '../lib/datetime'
import type { MemberEvent } from './api'

export function MemberEventDialog({ event, onClose }: { event: MemberEvent; onClose(): void }) {
  return <Dialog title={event.title} description={formatEventRange(event)} onRequestClose={onClose} footer={<button type="button" className="button button-primary" onClick={onClose} data-autofocus>ปิด</button>}>
    <dl className="detail-list">
      <div className="detail-wide"><dt>วันและเวลา</dt><dd>{formatEventRange(event)}</dd></div>
      <div className="detail-wide"><dt>สถานที่หรือลิงก์</dt><dd>{!event.location ? <span className="muted">ไม่ได้ระบุ</span> : /^https?:\/\/\S+$/i.test(event.location) ? <a href={event.location} target="_blank" rel="noopener noreferrer" className="break-word">{event.location}</a> : <span className="break-word">{event.location}</span>}</dd></div>
      <div className="detail-wide"><dt>รายละเอียด</dt><dd className="pre-line break-word">{event.description || <span className="muted">ไม่มีรายละเอียดเพิ่มเติม</span>}</dd></div>
    </dl>
  </Dialog>
}
