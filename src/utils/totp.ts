import crypto from 'crypto'
import { config } from '../config'

// RFC 6238 TOTP (the 6-digit codes of Google/Microsoft Authenticator),
// implemented with Node's crypto — no extra dependency.

const B32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'
const STEP_SECONDS = 30

export function base32Encode(buf: Buffer): string {
  let bits = 0
  let value = 0
  let out = ''
  for (const byte of buf) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) {
      out += B32[(value >>> (bits - 5)) & 31]
      bits -= 5
    }
  }
  if (bits > 0) out += B32[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(s: string): Buffer {
  const clean = s.toUpperCase().replace(/[^A-Z2-7]/g, '')
  let bits = 0
  let value = 0
  const out: number[] = []
  for (const ch of clean) {
    value = (value << 5) | B32.indexOf(ch)
    bits += 5
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255)
      bits -= 8
    }
  }
  return Buffer.from(out)
}

export const newTotpSecret = () => base32Encode(crypto.randomBytes(20))
export const currentStep = (now = Date.now()) => Math.floor(now / 1000 / STEP_SECONDS)

function hotp(secret: string, counter: number): string {
  const buf = Buffer.alloc(8)
  buf.writeBigUInt64BE(BigInt(counter))
  const hmac = crypto.createHmac('sha1', base32Decode(secret)).update(buf).digest()
  const offset = hmac[hmac.length - 1] & 0xf
  const code = ((hmac[offset] & 0x7f) << 24) | (hmac[offset + 1] << 16) | (hmac[offset + 2] << 8) | hmac[offset + 3]
  return String(code % 1_000_000).padStart(6, '0')
}

// Returns the matching time step (to block replays), or null. Accepts one
// step either side for phone clock drift.
export function verifyTotp(secret: string, code: string, now = Date.now()): number | null {
  const c = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(c)) return null
  const step = currentStep(now)
  for (const s of [step, step - 1, step + 1]) {
    const expected = hotp(secret, s)
    if (crypto.timingSafeEqual(Buffer.from(expected), Buffer.from(c))) return s
  }
  return null
}

export function otpauthUri(secret: string, accountEmail: string, issuer = 'Zaitoon Accounts') {
  return `otpauth://totp/${encodeURIComponent(`${issuer}:${accountEmail}`)}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=${STEP_SECONDS}`
}

// MFA secrets are stored encrypted (AES-256-GCM) with a key derived from the
// JWT secret, so a database dump alone doesn't reveal them.
const key = () => crypto.createHash('sha256').update(`mfa:${config.jwtSecret}`).digest()

export function encryptSecret(plain: string): string {
  const iv = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv('aes-256-gcm', key(), iv)
  const enc = Buffer.concat([cipher.update(plain, 'utf8'), cipher.final()])
  return ['v1', iv.toString('base64'), cipher.getAuthTag().toString('base64'), enc.toString('base64')].join(':')
}

export function decryptSecret(stored: string): string {
  const [v, iv, tag, data] = stored.split(':')
  if (v !== 'v1') throw new Error('Unknown MFA secret format')
  const decipher = crypto.createDecipheriv('aes-256-gcm', key(), Buffer.from(iv, 'base64'))
  decipher.setAuthTag(Buffer.from(tag, 'base64'))
  return Buffer.concat([decipher.update(Buffer.from(data, 'base64')), decipher.final()]).toString('utf8')
}

// 8 one-time recovery codes like "7K3Q-9XMD"
export function newRecoveryCodes(n = 8): string[] {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
  return Array.from({ length: n }, () => {
    const b = crypto.randomBytes(8)
    const s = Array.from(b, (x) => alphabet[x % alphabet.length]).join('')
    return `${s.slice(0, 4)}-${s.slice(4, 8)}`
  })
}

// Strip MFA secrets (and the password hash) before sending a user to the client
export function publicUser<T extends Record<string, unknown>>(u: T) {
  const { passwordHash: _p, mfaSecret: _s, mfaPendingSecret: _ps, mfaRecoveryCodes: _r, mfaLastStep: _l, ...rest } = u as Record<string, unknown>
  return rest as Omit<T, 'passwordHash' | 'mfaSecret' | 'mfaPendingSecret' | 'mfaRecoveryCodes' | 'mfaLastStep'>
}
