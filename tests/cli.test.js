/**
 * CLI smoke tests.
 *
 * The `dsh-chrome-bridge` command is the operator-facing entry point, so its output contract is
 * checked directly: it must report state, print a token exactly once, and never echo a stored token
 * in a listing.
 */
import test from 'node:test'
import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'

const run = promisify(execFile)
const root = resolve(fileURLToPath(new URL('../', import.meta.url)))
const cli = join(root, 'bin', 'chrome-bridge.js')

/** Invoke the CLI against an isolated DSH home. */
async function cli_run(args, home) {
  try {
    const { stdout, stderr } = await run(process.execPath, [cli, ...args], { env: { ...process.env, DSH_HOME: home } })
    return { code: 0, stdout, stderr }
  } catch (error) {
    return { code: error.code ?? 1, stdout: error.stdout ?? '', stderr: error.stderr ?? '' }
  }
}

async function tempHome(t) {
  const home = await mkdtemp(join(tmpdir(), 'dsh-cli-'))
  t.after(() => rm(home, { recursive: true, force: true }))
  return home
}

test('help is printed when no command is given', async t => {
  const home = await tempHome(t)
  const result = await cli_run([], home)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /token create/)
  assert.match(result.stdout, /token revoke/)
})

test('status reports a disabled bridge and the resolved URL', async t => {
  const home = await tempHome(t)
  const result = await cli_run(['status'], home)
  assert.equal(result.code, 0)
  assert.match(result.stdout, /bridge:\s+disabled/)
  assert.match(result.stdout, /url:\s+ws:\/\/127\.0\.0\.1:\d+\/chrome-bridge/)
  assert.match(result.stdout, /backend:\s+chrome-extension/)
  assert.match(result.stdout, /tokens:\s+none/)
})

test('a configured publicUrl and backend are reflected', async t => {
  const home = await tempHome(t)
  await mkdir(join(home, 'playwright'), { recursive: true })
  await writeFile(join(home, 'playwright', 'settings.json'), JSON.stringify({
    backend: 'playwright',
    chromeBridge: { enabled: true, mode: 'webServer', publicUrl: 'wss://dsh.example.com/chrome-bridge' },
  }))
  const result = await cli_run(['status', '--json'], home)
  assert.equal(result.code, 0)
  const report = JSON.parse(result.stdout)
  assert.equal(report.enabled, true)
  assert.equal(report.url, 'wss://dsh.example.com/chrome-bridge')
  assert.equal(report.defaultBackend, 'playwright')
  assert.equal(report.publicUrlConfigured, true)
})

test('token create prints a token once, and list never repeats it', async t => {
  const home = await tempHome(t)
  const created = await cli_run(['token', 'create', 'work laptop'], home)
  assert.equal(created.code, 0)
  const token = /^\s{2}([A-Za-z0-9_-]{40,})$/m.exec(created.stdout)?.[1]
  assert.ok(token, `a token must be printed: ${created.stdout}`)
  assert.match(created.stdout, /shown once/)
  assert.match(created.stdout, /work laptop/)

  const listed = await cli_run(['token', 'list'], home)
  assert.equal(listed.code, 0)
  assert.equal(listed.stdout.includes(token), false, 'a listing must never contain the full token')
  assert.match(listed.stdout, /work laptop/)
  assert.match(listed.stdout, /…/)
})

test('token revoke accepts an id and reports the remaining count', async t => {
  const home = await tempHome(t)
  const created = await cli_run(['token', 'create'], home)
  const id = /id:\s+(token-[0-9a-f]+)/.exec(created.stdout)?.[1]
  assert.ok(id, `an id must be printed: ${created.stdout}`)

  const revoked = await cli_run(['token', 'revoke', id], home)
  assert.equal(revoked.code, 0)
  assert.match(revoked.stdout, /Revoked 1 token/)
  assert.match(revoked.stdout, /Active tokens: 0/)

  const missing = await cli_run(['token', 'revoke', 'token-doesnotexist'], home)
  assert.equal(missing.code, 1)
  assert.match(missing.stdout, /No token matched/)

  const noId = await cli_run(['token', 'revoke'], home)
  assert.equal(noId.code, 2)
  assert.match(noId.stderr, /Provide a token id/)
})

test('an unknown command fails with usage text', async t => {
  const home = await tempHome(t)
  const result = await cli_run(['frobnicate'], home)
  assert.equal(result.code, 2)
  assert.match(result.stderr, /Unknown command/)
  assert.match(result.stderr, /Usage|Commands:/)
})

test('the JSON output contract stays stable for automation', async t => {
  const home = await tempHome(t)
  // `ttlHours` is a tool parameter; the CLI creates non-expiring tokens, so `expiresAt` is absent.
  const created = await cli_run(['token', 'create', 'ci', '--json'], home)
  const record = JSON.parse(created.stdout)
  assert.equal(record.label, 'ci')
  assert.equal(record.expiresAt, undefined)
  assert.ok(record.token.length >= 32)
})
