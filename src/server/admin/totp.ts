import { createHmac, randomBytes } from 'node:crypto'

/** RFC 6238 TOTP (SHA-1, 30 s, 6 digits), the format every authenticator app accepts. */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'

export function base32Encode(bytes: Buffer): string {
  let bits = 0, value = 0, out = ''
  for (const byte of bytes) {
    value = (value << 8) | byte
    bits += 8
    while (bits >= 5) { out += ALPHABET[(value >>> (bits - 5)) & 31]; bits -= 5 }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31]
  return out
}

export function base32Decode(text: string): Buffer {
  const clean = text.replace(/[\s=-]/g, '').toUpperCase()
  let bits = 0, value = 0
  const out: number[] = []
  for (const char of clean) {
    const index = ALPHABET.indexOf(char)
    if (index < 0) throw new Error('invalid base32')
    value = (value << 5) | index
    bits += 5
    if (bits >= 8) { out.push((value >>> (bits - 8)) & 255); bits -= 8 }
  }
  return Buffer.from(out)
}

export function generateTotpSecret(): string {
  return base32Encode(randomBytes(20))
}

export function totpCode(secret: string, counter: number): string {
  const buffer = Buffer.alloc(8)
  buffer.writeBigUInt64BE(BigInt(counter))
  const digest = createHmac('sha1', base32Decode(secret)).update(buffer).digest()
  const offset = digest[digest.length - 1]! & 15
  const binary = ((digest[offset]! & 0x7f) << 24) | (digest[offset + 1]! << 16) | (digest[offset + 2]! << 8) | digest[offset + 3]!
  return String(binary % 1_000_000).padStart(6, '0')
}

/** Returns the matching time step (±1 step of clock drift), or undefined. */
export function verifyTotp(secret: string, code: string, now = Date.now()): number | undefined {
  const digits = code.replace(/\s/g, '')
  if (!/^\d{6}$/.test(digits)) return undefined
  const step = Math.floor(now / 30_000)
  for (const counter of [step, step - 1, step + 1]) if (totpCode(secret, counter) === digits) return counter
  return undefined
}

export function otpauthURL(secret: string, account: string, issuer = '夭夭管理后台'): string {
  const label = encodeURIComponent(`${issuer}:${account}`)
  return `otpauth://totp/${label}?secret=${secret}&issuer=${encodeURIComponent(issuer)}&algorithm=SHA1&digits=6&period=30`
}
