import type { Ctx } from './env'
import { nowIso } from './env'
import { HttpError, json, readJson } from './http'
import { requireMemberMutation } from './session'
import { expectedVersion, invalid, text } from './validation'
import { CONTACT_PLATFORMS, type ContactChannel } from '../src/lib/contacts'

export async function ownProfile(ctx: Ctx): Promise<Response> {
  const session = await requireMemberMutation(ctx)
  const body = await readJson(ctx.request, 8192)
  const email = text(body, 'email', 'อีเมล', 254).toLowerCase()
  if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw invalid('อีเมลไม่ถูกต้อง', 'email')
  const version = expectedVersion(body)
  if (!Array.isArray(body.contacts) || body.contacts.length > 9)
    throw invalid('เลือกช่องทางติดต่อได้ไม่เกิน 9 ช่องทาง', 'contacts')
  const used = new Set<string>()
  const contacts: ContactChannel[] = body.contacts.map((entry: unknown) => {
    if (!entry || typeof entry !== 'object') throw invalid('ช่องทางติดต่อไม่ถูกต้อง', 'contacts')
    const c = entry as Record<string, unknown>
    if (typeof c.platform !== 'string' || !Object.hasOwn(CONTACT_PLATFORMS, c.platform) || used.has(c.platform))
      throw invalid('เลือกแพลตฟอร์มที่ไม่ซ้ำกัน', 'contacts')
    used.add(c.platform)
    return { platform: c.platform as ContactChannel['platform'], value: text(c, 'value', 'ช่องทางติดต่อ', 200, true) }
  })
  const result = await ctx.env.DB.prepare(
    `INSERT INTO member_profiles (member_id,email,contacts_json,version,updated_at)
    SELECT ?,?,?,2,? WHERE ? = 1 OR EXISTS(SELECT 1 FROM member_profiles WHERE member_id=?)
    ON CONFLICT(member_id) DO UPDATE SET email=excluded.email,contacts_json=excluded.contacts_json,version=member_profiles.version+1,updated_at=excluded.updated_at WHERE member_profiles.version=?`,
  )
    .bind(session.member.id, email, JSON.stringify(contacts), nowIso(), version, session.member.id, version)
    .run()
  if (result.meta.changes !== 1)
    throw new HttpError(409, 'version_conflict', 'ข้อมูลติดต่อเปลี่ยนจากที่อื่นแล้ว โหลดข้อมูลล่าสุดก่อนบันทึกอีกครั้ง')
  return json({ ok: true })
}
