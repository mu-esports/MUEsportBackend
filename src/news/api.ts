import { api } from '../api/client'

export interface NewsPost {
  id: string; title: string; summary: string; body: string; category: string; publishedDate: string
  imageUrl: string; instagramUrl: string; sourceUrl: string
}
export type NewsStatus = 'draft' | 'published' | 'archived'
export interface StaffNews extends NewsPost { status: NewsStatus; version: number; updatedAt: string }
export type NewsInput = Omit<StaffNews, 'id' | 'version' | 'updatedAt'>
export const NEWS_STATUS: Record<NewsStatus, string> = { draft: 'ร่าง', published: 'แสดงให้สมาชิก', archived: 'เก็บเข้าคลัง' }
export const CLUB_NEWS_SOURCE = 'https://mu-esports-website.muesport2567.workers.dev/#news'
export const newsApi = {
  list: () => api<{ news: StaffNews[]; truncated: boolean }>('/api/news'),
  member: (signal?: AbortSignal) => api<{ news: NewsPost[]; truncated: boolean }>('/api/member/news', { signal }),
  create: async (input: NewsInput, key: string) => (await api<{ news: StaffNews }>('/api/news', { method: 'POST', body: input, idempotencyKey: key })).news,
  update: async (id: string, input: NewsInput, expectedVersion: number) => (await api<{ news: StaffNews }>(`/api/news/${encodeURIComponent(id)}`, { method: 'PATCH', body: { ...input, expectedVersion } })).news,
}
