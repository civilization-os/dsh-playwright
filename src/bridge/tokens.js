/**
 * Chrome Bridge pairing tokens.
 *
 * A pairing token is the only durable credential the extension needs. It is exchanged once for a
 * short-lived HttpOnly session cookie, so the token itself never travels on the WebSocket URL.
 *
 * Tokens are stored with owner-only permissions in a JSON file outside the chromeBridge settings
 * block, so an accidental settings export can never leak a credential. Full token values are only
 * returned at creation time; listings expose a prefix and a fingerprint for identification.
 */
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename } from 'node:fs/promises'
import { dirname } from 'node:path'

export const TOKEN_PREFIX_LENGTH = 8
export const MIN_TOKEN_LENGTH = 32

/** Short, non-reversible identifier used in logs and listings. */
export function fingerprintToken(token) {
  return createHash('sha256').update(String(token)).digest('hex').slice(0, 12)
}

/** Mask a token for display. Never log or return the whole value. */
export function maskToken(token) {
  const value = String(token ?? '')
  if (value.length <= TOKEN_PREFIX_LENGTH) return '****'
  return `${value.slice(0, TOKEN_PREFIX_LENGTH)}…${value.slice(-4)}`
}

export function createToken(label, options = {}) {
  const now = options.now ?? Date.now()
  return {
    id: `token-${randomUUID().slice(0, 8)}`,
    token: randomBytes(32).toString('base64url'),
    label: typeof label === 'string' && label.trim() ? label.trim().slice(0, 80) : 'default',
    createdAt: now,
    expiresAt: options.ttlMs ? now + options.ttlMs : undefined,
  }
}

export class TokenStore {
  constructor(path) {
    this.path = path
    this.cache = undefined
    this.loadedAt = 0
  }

  /** Read tokens from disk, tolerating malformed files rather than failing the plugin. */
  async read({ force = false } = {}) {
    if (!force && this.cache && Date.now() - this.loadedAt < 1000) return this.cache
    let parsed
    try {
      parsed = JSON.parse(await readFile(this.path, 'utf8'))
    } catch (error) {
      if (error.code === 'ENOENT') { this.cache = []; this.loadedAt = Date.now(); return this.cache }
      throw new Error(`The Chrome Bridge token file could not be read: ${String(error.message || error)}`)
    }
    const tokens = Array.isArray(parsed?.tokens) ? parsed.tokens : []
    this.cache = tokens.filter(entry => entry && typeof entry.token === 'string' && entry.token.length >= MIN_TOKEN_LENGTH)
    this.loadedAt = Date.now()
    return this.cache
  }

  /** Synchronous view used by the hub on every authentication attempt. */
  list() {
    return this.cache ?? []
  }

  async write(tokens) {
    await mkdir(dirname(this.path), { recursive: true })
    const temporary = `${this.path}.${randomUUID()}.tmp`
    const file = await open(temporary, 'wx', 0o600)
    try {
      await file.writeFile(`${JSON.stringify({ version: 1, tokens }, null, 2)}\n`)
      await file.sync()
    } finally {
      await file.close()
    }
    await rename(temporary, this.path)
    this.cache = tokens
    this.loadedAt = Date.now()
    return tokens
  }

  async add(label, options = {}) {
    const tokens = await this.read({ force: true })
    const record = createToken(label, options)
    await this.write([...tokens, record])
    return record
  }

  async revoke(id) {
    const tokens = await this.read({ force: true })
    const wanted = String(id ?? '').trim()
    const next = tokens.filter(entry => entry.id !== wanted && fingerprintToken(entry.token) !== wanted)
    if (next.length === tokens.length) return { removed: 0, tokens: next }
    await this.write(next)
    return { removed: tokens.length - next.length, tokens: next }
  }

  async pruneExpired(now = Date.now()) {
    const tokens = await this.read({ force: true })
    const next = tokens.filter(entry => !entry.expiresAt || entry.expiresAt > now)
    if (next.length !== tokens.length) await this.write(next)
    return tokens.length - next.length
  }

  /** Listing that is safe to log or return to a model: no usable credential is included. */
  async summary() {
    const tokens = await this.read({ force: true })
    return tokens.map(entry => ({
      id: entry.id,
      label: entry.label,
      masked: maskToken(entry.token),
      fingerprint: fingerprintToken(entry.token),
      createdAt: entry.createdAt,
      expiresAt: entry.expiresAt,
      expired: Boolean(entry.expiresAt && entry.expiresAt <= Date.now()),
    }))
  }
}
