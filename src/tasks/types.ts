export interface TaskPerson {
  id: string
  name: string
  nickname: string
}
export interface TaskFile {
  id: string
  name: string
  mime: string
  size: number
}
export interface Submission {
  id: string
  mode: 'link' | 'file'
  linkUrl: string
  note: string
  submittedAt: string
  late: boolean
  submittedBy: string
  files: TaskFile[]
}
export interface TaskUnit {
  id: string
  version: number
  unitKey: string
  submission: Submission | null
}
export interface Task {
  id: string
  title: string
  category: string
  instructions: string
  start: string
  due: string
  kind: 'individual' | 'group'
  status: 'open' | 'archived'
  version: number
  assignees: TaskPerson[]
  totalUnits: number
  submittedUnits: number
  units: TaskUnit[]
}
export interface TaskInput {
  title: string
  category: string
  instructions: string
  start: string
  due: string
  kind: Task['kind']
  status: Task['status']
  assigneeIds: string[]
}
export const FILE_ACCEPT = '.png,.jpg,.jpeg,.pdf,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.csv,.txt,.zip'
export const MAX_FILE_BYTES = 10 * 1024 * 1024
export const MAX_SUBMISSION_BYTES = 20 * 1024 * 1024
export const taskTime = (value: string) => Date.parse(`${value}+07:00`)
export function taskAvailability(task: Pick<Task, 'status' | 'start' | 'due'>, now = Date.now()) {
  return task.status === 'archived'
    ? 'archived'
    : now < taskTime(task.start)
      ? 'upcoming'
      : now > taskTime(task.due)
        ? 'late'
        : 'open'
}
