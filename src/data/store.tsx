import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { messageOf } from './errors'
import { repository } from './repository'
import { useAutoSync } from './sync'
import type { ClubEvent, ClubEventInput, Member, MemberInput, MemberStatus } from './types'

type LoadState = 'loading' | 'ready' | 'error'

interface Store {
  state: LoadState
  /** เหตุผลที่โหลดไม่สำเร็จ (เมื่อ state เป็น error) */
  loadError: string
  members: Member[]
  events: ClubEvent[]
  /** โหลดใหม่ทั้งหมดพร้อมแสดงสถานะกำลังโหลด */
  reload(): void
  /** ดึงค่าล่าสุดเงียบ ๆ โดยไม่กระทบสิ่งที่ผู้ใช้กำลังกรอก */
  refresh(): Promise<void>
  addMember(input: MemberInput, key: string): Promise<Member>
  updateMember(id: string, input: MemberInput, expectedVersion: number): Promise<Member>
  setMemberStatus(id: string, status: MemberStatus, expectedVersion: number): Promise<Member>
  deleteMember(member: Member): Promise<void>
  addEvent(input: ClubEventInput, key: string): Promise<ClubEvent>
  updateEvent(id: string, input: ClubEventInput, expectedVersion: number): Promise<ClubEvent>
  resetSampleData(): Promise<void>
}

const StoreContext = createContext<Store | null>(null)

const upsert = <T extends { id: string }>(items: T[], item: T) =>
  items.some((i) => i.id === item.id) ? items.map((i) => (i.id === item.id ? item : i)) : [...items, item]

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, setState] = useState<LoadState>('loading')
  const [loadError, setLoadError] = useState('')
  const [members, setMembers] = useState<Member[]>([])
  const [events, setEvents] = useState<ClubEvent[]>([])
  // ลำดับของคำขออ่านล่าสุด: คำตอบของคำขอเก่าที่มาช้าจะไม่ทับข้อมูลที่ใหม่กว่า
  const memberSeq = useRef(0)
  const eventSeq = useRef(0)

  const refreshMembers = useCallback(async () => {
    const seq = ++memberSeq.current
    const list = await repository.listMembers()
    if (seq === memberSeq.current) setMembers(list)
  }, [])
  const refreshEvents = useCallback(async () => {
    const seq = ++eventSeq.current
    const list = await repository.listEvents()
    if (seq === eventSeq.current) setEvents(list)
  }, [])

  const refresh = useCallback(async () => {
    await Promise.all([refreshMembers(), refreshEvents()])
  }, [refreshMembers, refreshEvents])

  // ลำดับของการโหลดทั้งชุด: เฉพาะการโหลดครั้งล่าสุดเท่านั้นที่เปลี่ยนสถานะของหน้าได้
  // ผลของการโหลดที่ถูกแทนที่ไปแล้วถูกทิ้ง (ดู memberSeq/eventSeq) จึงต้องไม่ทำให้หน้าขึ้นว่าโหลดเสร็จก่อนข้อมูลชุดล่าสุดมาถึง
  // เกิดได้เมื่อ React เรียก effect ตอนเปิดหน้าซ้ำในโหมดพัฒนา (StrictMode): หน้าจะแสดง “ไม่มีข้อมูล” ชั่วครู่ทั้งที่มีข้อมูล
  const loadSeq = useRef(0)

  const reload = useCallback(() => {
    const current = ++loadSeq.current
    setState('loading')
    refresh().then(
      () => {
        if (current === loadSeq.current) setState('ready')
      },
      (error: unknown) => {
        if (current !== loadSeq.current) return
        setLoadError(messageOf(error, ''))
        setState('error')
      },
    )
  }, [refresh])

  useEffect(reload, [reload])

  // สำเนาจาก Google เปลี่ยน (จากรอบซิงค์ของแท็บนี้ แท็บอื่น อุปกรณ์อื่น หรือ Cron): ดึงรายการใหม่เงียบ ๆ
  // ฟอร์มที่เปิดอยู่เก็บค่าของตัวเอง จึงไม่ถูกทับ และ server ยังตรวจรุ่นตอนบันทึก
  useAutoSync(['sheets', 'calendar'], () => {
    if (state === 'ready') refresh().catch(() => undefined)
  })

  // กลับมาที่แท็บนี้: ดึงค่าล่าสุดที่คนอื่นอาจแก้ไว้ ฟอร์มที่เปิดอยู่เก็บค่าของตัวเอง จึงไม่ถูกล้าง
  useEffect(() => {
    if (state !== 'ready') return
    const onVisible = () => {
      if (document.visibilityState === 'visible') refresh().catch(() => undefined)
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => document.removeEventListener('visibilitychange', onVisible)
  }, [state, refresh])

  const store = useMemo<Store>(() => {
    // แสดงผลหลังที่เก็บข้อมูลยืนยันแล้วเท่านั้น จากนั้นดึงรายการที่เกี่ยวข้องใหม่เพื่อรับการแก้ของคนอื่นด้วย
    const savedMember = (member: Member) => {
      memberSeq.current++
      setMembers((list) => upsert(list, member))
      refreshMembers().catch(() => undefined)
      return member
    }
    const savedEvent = (event: ClubEvent) => {
      eventSeq.current++
      setEvents((list) => upsert(list, event))
      refreshEvents().catch(() => undefined)
      return event
    }

    return {
      state,
      loadError,
      members,
      events,
      reload,
      refresh,
      addMember: async (input, key) => savedMember(await repository.createMember(input, key)),
      updateMember: async (id, input, version) => savedMember(await repository.updateMember(id, input, version)),
      setMemberStatus: async (id, status, version) => savedMember(await repository.setMemberStatus(id, status, version)),
      async deleteMember(member) {
        await repository.deleteMember(member)
        memberSeq.current++
        setMembers((list) => list.filter((item) => item.id !== member.id))
        refreshMembers().catch(() => undefined)
      },
      addEvent: async (input, key) => savedEvent(await repository.createEvent(input, key)),
      updateEvent: async (id, input, version) => savedEvent(await repository.updateEvent(id, input, version)),
      async resetSampleData() {
        if (!repository.reset) throw new Error('รีเซ็ตได้เฉพาะโหมดข้อมูลตัวอย่าง')
        await repository.reset()
        await refresh()
        setState('ready')
      },
    }
  }, [state, loadError, members, events, reload, refresh, refreshMembers, refreshEvents])

  return <StoreContext.Provider value={store}>{children}</StoreContext.Provider>
}

export function useStore() {
  const store = useContext(StoreContext)
  if (!store) throw new Error('useStore ต้องใช้ภายใน StoreProvider')
  return store
}
