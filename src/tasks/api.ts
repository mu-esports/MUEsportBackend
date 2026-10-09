import { api } from '../api/client'
import type { Task, TaskInput } from './types'
export const tasksApi = {
  list: (member = false) => api<{ tasks: Task[]; truncated: boolean }>(member ? '/api/member/tasks' : '/api/tasks'),
  get: async (id: string, member = false) =>
    (await api<{ task: Task }>(`${member ? '/api/member/tasks' : '/api/tasks'}/${id}`)).task,
  save: async (input: TaskInput, task?: Task, key?: string) =>
    (
      await api<{ task: Task }>(task ? `/api/tasks/${task.id}` : '/api/tasks', {
        method: task ? 'PATCH' : 'POST',
        body: { ...input, ...(task ? { expectedVersion: task.version } : {}) },
        idempotencyKey: key,
      })
    ).task,
  submit: (
    task: Task,
    key: string,
    payload: { mode: 'file' | 'link'; linkUrl: string; note: string; files: File[] },
  ) => {
    const path = `/api/member/tasks/${task.id}/submissions`,
      version = task.units[0].version
    if (payload.mode === 'link')
      return api<{ ok: true; submissionId: string }>(path, {
        method: 'POST',
        idempotencyKey: key,
        body: {
          mode: 'link',
          linkUrl: payload.linkUrl,
          note: payload.note,
          expectedVersion: version,
          taskVersion: task.version,
        },
      })
    const form = new FormData()
    form.set('note', payload.note)
    form.set('expectedVersion', String(version))
    form.set('taskVersion', String(task.version))
    for (const file of payload.files) form.append('files', file)
    return api<{ ok: true; submissionId: string }>(path, { method: 'POST', idempotencyKey: key, form })
  },
}
