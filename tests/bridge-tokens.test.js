/**
 * Pairing token store tests.
 *
 * Tokens are the only durable credential in the Chrome Bridge, so their lifecycle is covered
 * explicitly: creation, on-disk permissions, masking, expiry, and revocation.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { TokenStore, createToken, fingerprintToken, maskToken, MIN_TOKEN_LENGTH } from '../src/bridge/tokens.js'

async function store(t, name = 'tokens.json') {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-tokens-'))
  t.after(() => rm(directory, { recursive: true, force: true }))
  return { directory, path: join(directory, name), tokens: new TokenStore(join(directory, name)) }
}

test('a new token has enough entropy and is masked for display', async t => {
  const { tokens } = await store(t)
  const record = await tokens.add('laptop')
  assert.equal(record.label, 'laptop')
  assert.ok(record.token.length >= MIN_TOKEN_LENGTH)
  assert.match(record.token, /^[A-Za-z0-9_-]+$/, 'the token must be URL-safe')
  assert.match(maskToken(record.token), /^.{8}….{4}$/)
  assert.equal(maskToken('short'), '****')
  assert.equal(fingerprintToken(record.token).length, 12)
  assert.notEqual(fingerprintToken(record.token), fingerprintToken(`${record.token}x`))
})

test('tokens are written owner-only and never duplicated', async t => {
  const { path, tokens } = await store(t)
  const first = await tokens.add('one')
  const second = await tokens.add('two')
  const mode = (await stat(path)).mode & 0o777
  assert.equal(mode, 0o600, 'the token file must not be world readable')
  const parsed = JSON.parse(await readFile(path, 'utf8'))
  assert.equal(parsed.tokens.length, 2)
  assert.notEqual(first.token, second.token)
  assert.deepEqual((await tokens.read({ force: true })).map(entry => entry.label), ['one', 'two'])
})

test('a listing never exposes a usable credential', async t => {
  const { tokens } = await store(t)
  const record = await tokens.add('desk')
  const summary = await tokens.summary()
  assert.equal(summary.length, 1)
  assert.equal(summary[0].id, record.id)
  assert.equal(JSON.stringify(summary).includes(record.token), false, 'the full token must not be listed')
  assert.equal(summary[0].masked, maskToken(record.token))
  assert.equal(summary[0].fingerprint, fingerprintToken(record.token))
})

test('a token can be revoked by id or by fingerprint', async t => {
  const { tokens } = await store(t)
  const first = await tokens.add('one')
  const second = await tokens.add('two')
  assert.equal((await tokens.revoke(first.id)).removed, 1)
  assert.deepEqual((await tokens.read({ force: true })).map(entry => entry.label), ['two'])
  assert.equal((await tokens.revoke(fingerprintToken(second.token))).removed, 1)
  assert.deepEqual(await tokens.read({ force: true }), [])
  assert.equal((await tokens.revoke('does-not-exist')).removed, 0)
})

test('expired tokens are pruned and reported as expired', async t => {
  const { tokens } = await store(t)
  const expired = createToken('old', { ttlMs: -1000 })
  const live = createToken('new', { ttlMs: 60_000 })
  await tokens.write([expired, live])
  const summary = await tokens.summary()
  assert.equal(summary.find(entry => entry.label === 'old').expired, true)
  assert.equal(summary.find(entry => entry.label === 'new').expired, false)
  assert.equal(await tokens.pruneExpired(), 1)
  assert.deepEqual((await tokens.read({ force: true })).map(entry => entry.label), ['new'])
})

test('malformed and short entries are dropped rather than trusted', async t => {
  const { path, tokens } = await store(t)
  await writeFile(path, JSON.stringify({ version: 1, tokens: [
    { id: 'good', token: 'a'.repeat(43), label: 'good' },
    { id: 'short', token: 'tiny', label: 'short' },
    { id: 'missing-token', label: 'none' },
    null,
  ] }))
  const kept = await tokens.read({ force: true })
  assert.deepEqual(kept.map(entry => entry.id), ['good'])
})

test('a missing file reads as an empty list, and a broken file fails loudly', async t => {
  const { path, tokens } = await store(t, 'absent.json')
  assert.deepEqual(await tokens.read({ force: true }), [])
  await writeFile(path, 'this is not json')
  await assert.rejects(tokens.read({ force: true }), /could not be read/)
})
