import { api } from '../api/client'
import { AppError } from '../data/errors'
import { freshPasswordChallenge } from '../lib/password-material'
import type { PasswordChallenge, PasswordMaterial } from '../lib/password-material'

export const passwordMaterial = (password: string, challenge = freshPasswordChallenge()): Promise<PasswordMaterial> =>
  new Promise((resolve, reject) => {
    const worker = new Worker(new URL('./password-worker.ts', import.meta.url), { type: 'module' })
    const timer = setTimeout(() => fail(), 30_000)
    const fail = () => { clearTimeout(timer); worker.terminate(); reject(new AppError('password_calculation_failed', 0, 'เตรียมการเข้าสู่ระบบไม่สำเร็จ กรุณาลองใหม่')) }
    worker.onerror = fail
    worker.onmessage = (event: MessageEvent<PasswordMaterial & { error?: boolean }>) => {
      worker.terminate()
      clearTimeout(timer)
      if (event.data.error) fail()
      else resolve(event.data)
    }
    worker.postMessage({ password, challenge })
  })

export const memberPasswordChallenge = (studentId: string) =>
  api<PasswordChallenge>('/auth/member/challenge', { method: 'POST', body: { studentId }, quiet401: true })

export const memberActivationStatus = (studentId: string, signal: AbortSignal) =>
  api<{ firstTime: boolean }>('/auth/member/activation', { method: 'POST', body: { studentId }, signal, quiet401: true })

export async function loginMember(studentId: string, password: string) {
  const challenge = await memberPasswordChallenge(studentId)
  const passwordProof = await passwordMaterial(password, challenge)
  return api('/auth/member/login', { method: 'POST', body: { studentId, passwordProof }, quiet401: true })
}
