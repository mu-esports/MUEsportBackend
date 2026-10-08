import { argon2id } from '@noble/hashes/argon2.js'
import { decodePasswordBytes, encodePasswordBytes } from '../lib/password-material'
import type { PasswordChallenge } from '../lib/password-material'

self.onmessage = (event: MessageEvent<{ password: string; challenge: PasswordChallenge }>) => {
  const { password, challenge } = event.data
  try {
    // The work runs away from the UI thread; the password is never written to browser storage.
    const hash = argon2id(new TextEncoder().encode(password.normalize('NFC')), decodePasswordBytes(challenge.salt), {
      m: challenge.m, t: challenge.t, p: challenge.p, dkLen: 32,
    })
    self.postMessage({ ...challenge, hash: encodePasswordBytes(hash) })
  } catch {
    self.postMessage({ error: true })
  }
}
