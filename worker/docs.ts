/**
 * ตัวแปลงระหว่างข้อความธรรมดาใน editor ของเว็บ กับโครงสร้างของ Google Docs
 * ไฟล์นี้เป็นฟังก์ชันล้วน ไม่เรียกเครือข่าย จึงทดสอบกับคำตอบจำลองของ Google ได้ตรง ๆ
 *
 * หลักการ
 * - ดัชนีของ Google Docs นับเป็น UTF-16 code unit เหมือน string ของ JavaScript
 * - editor รองรับเฉพาะเอกสารข้อความพื้นฐาน: แท็บเดียว ย่อหน้าปกติ ไม่มีการจัดรูปแบบ
 * - เอกสารที่มีโครงสร้างอื่นเปิดอ่านได้อย่างเดียว เพื่อไม่ให้การบันทึกทำลายโครงสร้างนั้น
 * - การบันทึกแก้เฉพาะช่วงที่ต่างจากเดิม และไม่แตะ newline สุดท้ายของเอกสาร
 */

export const MAX_CONTENT_UNITS = 50_000
export const MAX_TITLE_LENGTH = 200

type Json = Record<string, unknown>

export interface ParsedDocument {
  title: string
  revisionId: string
  tabId: string
  /** ข้อความใน editor: เนื้อหาทั้งหมดโดยไม่รวม newline สุดท้ายที่ Google Docs มีเสมอ */
  text: string
  supported: boolean
  /** เหตุผลที่แก้ในเว็บไม่ได้ (ภาษาไทย ไม่ซ้ำ) */
  reasons: string[]
}

const isObject = (value: unknown): value is Json => !!value && typeof value === 'object' && !Array.isArray(value)
const hasEntries = (value: unknown) => (Array.isArray(value) ? value.length > 0 : isObject(value) && Object.keys(value).length > 0)

/** รูปแบบตัวอักษรถือว่ามีเมื่อมีค่าที่ไม่ว่าง เช่น ตัวหนา ลิงก์ สี หรือฟอนต์ */
function hasTextStyle(style: unknown): boolean {
  if (!isObject(style)) return false
  return Object.values(style).some((value) => (isObject(value) ? hasEntries(value) : value !== false && value !== null && value !== undefined))
}

const ELEMENT_REASONS: Record<string, string> = {
  inlineObjectElement: 'มีรูปภาพหรือวัตถุแทรก',
  footnoteReference: 'มีเชิงอรรถ',
  pageBreak: 'มีตัวแบ่งหน้า',
  columnBreak: 'มีตัวแบ่งคอลัมน์',
  horizontalRule: 'มีเส้นคั่น',
  equation: 'มีสมการ',
  autoText: 'มีข้อความอัตโนมัติ เช่น เลขหน้า',
  person: 'มีการกล่าวถึงบุคคล',
  richLink: 'มีลิงก์แบบการ์ด',
  dateElement: 'มีวันที่แบบโต้ตอบ',
}

/** อ่านเอกสารจาก documents.get (ต้องขอ includeTabsContent=true) และตรวจว่า editor ของเว็บแก้ได้หรือไม่ */
export function parseDocument(doc: unknown): ParsedDocument {
  const reasons = new Set<string>()
  const root = isObject(doc) ? doc : {}
  const title = typeof root.title === 'string' ? root.title : ''
  const revisionId = typeof root.revisionId === 'string' ? root.revisionId : ''
  const tabs = Array.isArray(root.tabs) ? (root.tabs as unknown[]) : []
  const tab = isObject(tabs[0]) ? tabs[0] : {}
  const tabProperties = isObject(tab.tabProperties) ? tab.tabProperties : {}
  const tabId = typeof tabProperties.tabId === 'string' ? tabProperties.tabId : ''
  const documentTab = isObject(tab.documentTab) ? tab.documentTab : {}
  const body = isObject(documentTab.body) ? documentTab.body : {}
  const content = Array.isArray(body.content) ? (body.content as unknown[]) : []

  if (!revisionId || !tabId || tabs.length === 0) reasons.add('อ่านโครงสร้างเอกสารจาก Google ได้ไม่ครบ')
  if (tabs.length > 1 || hasEntries(tab.childTabs)) reasons.add('มีหลายแท็บ')
  if (hasEntries(documentTab.headers) || hasEntries(documentTab.footers)) reasons.add('มีหัวกระดาษหรือท้ายกระดาษ')
  if (hasEntries(documentTab.footnotes)) reasons.add('มีเชิงอรรถ')
  if (hasEntries(documentTab.lists)) reasons.add('มีรายการแบบหัวข้อย่อยหรือลำดับเลข')
  if (hasEntries(documentTab.inlineObjects) || hasEntries(documentTab.positionedObjects)) reasons.add('มีรูปภาพหรือวัตถุแทรก')
  if (hasEntries(documentTab.suggestedDocumentStyleChanges) || hasEntries(documentTab.suggestedNamedStylesChanges)) {
    reasons.add('มีคำแนะนำการแก้ไขที่ยังไม่ได้ตอบรับ')
  }

  let text = ''
  let firstParagraphStart: number | null = null
  let lastEnd = 0

  content.forEach((raw, index) => {
    const element = isObject(raw) ? raw : {}
    if (isObject(element.sectionBreak)) {
      if (index !== 0) reasons.add('มีการแบ่งส่วนของเอกสาร')
      return
    }
    if (isObject(element.table)) return void reasons.add('มีตาราง')
    if (isObject(element.tableOfContents)) return void reasons.add('มีสารบัญ')
    if (!isObject(element.paragraph)) return void reasons.add('มีโครงสร้างที่ระบบยังไม่รองรับ')

    const paragraph = element.paragraph
    if (firstParagraphStart === null && typeof element.startIndex === 'number') firstParagraphStart = element.startIndex
    if (typeof element.endIndex === 'number') lastEnd = element.endIndex

    if (isObject(paragraph.bullet)) reasons.add('มีรายการแบบหัวข้อย่อยหรือลำดับเลข')
    if (hasEntries(paragraph.positionedObjectIds)) reasons.add('มีรูปภาพหรือวัตถุแทรก')
    if (
      hasEntries(paragraph.suggestedParagraphStyleChanges) ||
      hasEntries(paragraph.suggestedBulletChanges) ||
      hasEntries(paragraph.suggestedPositionedObjectIds)
    ) {
      reasons.add('มีคำแนะนำการแก้ไขที่ยังไม่ได้ตอบรับ')
    }
    const style = isObject(paragraph.paragraphStyle) ? paragraph.paragraphStyle : {}
    if (typeof style.namedStyleType === 'string' && style.namedStyleType !== 'NORMAL_TEXT') {
      reasons.add('มีหัวข้อหรือรูปแบบย่อหน้า')
    }

    for (const rawPart of Array.isArray(paragraph.elements) ? (paragraph.elements as unknown[]) : []) {
      const part = isObject(rawPart) ? rawPart : {}
      if (!isObject(part.textRun)) {
        const kind = Object.keys(part).find((key) => key in ELEMENT_REASONS)
        reasons.add(kind ? ELEMENT_REASONS[kind] : 'มีโครงสร้างที่ระบบยังไม่รองรับ')
        continue
      }
      const run = part.textRun
      if (hasEntries(run.suggestedInsertionIds) || hasEntries(run.suggestedDeletionIds) || hasEntries(run.suggestedTextStyleChanges)) {
        reasons.add('มีคำแนะนำการแก้ไขที่ยังไม่ได้ตอบรับ')
      }
      if (hasTextStyle(run.textStyle)) reasons.add('มีการจัดรูปแบบตัวอักษร เช่น ตัวหนา ลิงก์ สี หรือฟอนต์')
      text += typeof run.content === 'string' ? run.content : ''
    }
  })

  if (text.includes('\u000b')) reasons.add('มีการขึ้นบรรทัดแบบไม่ขึ้นย่อหน้าใหม่')

  // ตรวจว่าข้อความที่อ่านได้ตรงกับดัชนีของ Google จริง ก่อนจะยอมให้คำนวณช่วงแก้ไขจากข้อความนี้
  const consistent = text.endsWith('\n') && firstParagraphStart === 1 && lastEnd === 1 + text.length
  if (!consistent && reasons.size === 0) reasons.add('โครงสร้างเอกสารไม่ตรงกับรูปแบบข้อความพื้นฐานที่ระบบรองรับ')

  return {
    title,
    revisionId,
    tabId,
    text: text.endsWith('\n') ? text.slice(0, -1) : text,
    supported: reasons.size === 0,
    reasons: [...reasons],
  }
}

/**
 * ทำข้อความให้อยู่ในรูปที่ Google Docs เก็บได้ตรงตัว
 * - ขึ้นบรรทัดใช้ \n เท่านั้น
 * - ตัดอักขระควบคุมและ Private Use Area ที่ Google Docs ตัดทิ้งเองเมื่อแทรกข้อความ
 */
export function normalizeText(input: string): string {
  return input
    .replace(/\r\n?/g, '\n')
    .replace(/[\u0000-\u0008\u000b-\u001f\ue000-\uf8ff]/g, '')
}

const isHighSurrogate = (code: number) => code >= 0xd800 && code <= 0xdbff
const isLowSurrogate = (code: number) => code >= 0xdc00 && code <= 0xdfff

export interface EditPlan {
  /** จำนวน code unit ต้นข้อความที่เหมือนเดิม */
  prefix: number
  /** จำนวน code unit ที่ลบ */
  deleted: number
  /** ข้อความที่แทรก */
  inserted: string
  requests: Json[]
}

/**
 * คำสั่ง batchUpdate ที่เปลี่ยนข้อความเดิมเป็นข้อความใหม่ โดยแก้เฉพาะช่วงที่ต่างกัน
 * ช่วงที่ลบอยู่ภายในข้อความของ editor เสมอ จึงไม่ครอบ newline สุดท้ายของเอกสาร
 * และไม่ตัดกลางคู่ surrogate (เช่น emoji)
 */
export function planEdit(oldText: string, newText: string, tabId: string): EditPlan {
  const max = Math.min(oldText.length, newText.length)
  let prefix = 0
  while (prefix < max && oldText.charCodeAt(prefix) === newText.charCodeAt(prefix)) prefix++
  if (prefix > 0 && isHighSurrogate(oldText.charCodeAt(prefix - 1))) prefix--

  let suffix = 0
  while (
    suffix < max - prefix &&
    oldText.charCodeAt(oldText.length - 1 - suffix) === newText.charCodeAt(newText.length - 1 - suffix)
  ) {
    suffix++
  }
  if (suffix > 0 && isLowSurrogate(oldText.charCodeAt(oldText.length - suffix))) suffix--

  const deleted = oldText.length - prefix - suffix
  const inserted = newText.slice(prefix, newText.length - suffix)
  const requests: Json[] = []
  // เนื้อหาเริ่มที่ดัชนี 1 (ดัชนี 0 เป็น section break ต้นเอกสาร)
  const start = 1 + prefix
  if (deleted > 0) {
    requests.push({ deleteContentRange: { range: { startIndex: start, endIndex: start + deleted, tabId } } })
  }
  if (inserted.length > 0) {
    requests.push({ insertText: { location: { index: start, tabId }, text: inserted } })
  }
  return { prefix, deleted, inserted, requests }
}
