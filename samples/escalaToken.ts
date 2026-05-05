import crypto from 'crypto'

const TTL_MS = 30 * 24 * 60 * 60 * 1000 // 30 dias

function getSecret(): string {
  const s = process.env.EMAIL_TOKEN_SECRET || process.env.SUPABASE_SERVICE_ROLE_KEY
  if (!s) throw new Error('EMAIL_TOKEN_SECRET ausente')
  return s
}

function b64url(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '')
}

function fromB64url(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4))
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64')
}

export function gerarTokenConfirmacao(membroId: string): string {
  const payload = { m: membroId, exp: Date.now() + TTL_MS }
  const body = b64url(Buffer.from(JSON.stringify(payload)))
  const sig = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest())
  return `${body}.${sig}`
}

export function verificarTokenConfirmacao(token: string): { membroId: string } | null {
  const partes = token.split('.')
  if (partes.length !== 2) return null
  const [body, sig] = partes
  const esperada = b64url(crypto.createHmac('sha256', getSecret()).update(body).digest())
  const a = Buffer.from(sig)
  const b = Buffer.from(esperada)
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null
  try {
    const payload = JSON.parse(fromB64url(body).toString('utf8')) as { m: string; exp: number }
    if (!payload.m || typeof payload.exp !== 'number' || Date.now() > payload.exp) return null
    return { membroId: payload.m }
  } catch {
    return null
  }
}
