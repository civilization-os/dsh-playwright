#!/usr/bin/env node
/**
 * Chrome Bridge administration.
 *
 * Usage:
 *   dsh-chrome-bridge status                 show the bridge configuration and connected extensions
 *   dsh-chrome-bridge url                    print the WebSocket URL to paste into the extension
 *   dsh-chrome-bridge token create [label]   create a pairing token (printed once)
 *   dsh-chrome-bridge token list             list tokens without revealing them
 *   dsh-chrome-bridge token revoke <id>      revoke one token by id or fingerprint
 *
 * This command reads the same settings file as the plugin. It never prints a stored token, and the
 * only time a token is shown is immediately after `token create`.
 */
import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { TokenStore } from '../src/bridge/tokens.js'
import { defaults, validateChromeBridge } from '../src/settings.js'

const USAGE = `dsh-chrome-bridge <command>

Commands:
  status                    Show the bridge configuration and connected extensions.
  url                       Print the WebSocket URL for the extension popup.
  token create [label]      Create a pairing token. Printed once; store it safely.
  token list                List tokens with masked values and fingerprints.
  token revoke <id>         Revoke a token by id or fingerprint.

Options:
  --dir <path>              Data directory (defaults to $DSH_HOME/playwright).
  --json                    Emit machine-readable JSON.`

function parseArgs(argv) {
  const args = { positional: [], json: false, dir: undefined }
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index]
    if (value === '--json') args.json = true
    else if (value === '--dir') { args.dir = argv[index + 1]; index += 1 }
    else if (value.startsWith('--dir=')) args.dir = value.slice('--dir='.length)
    else if (value === '--help' || value === '-h') args.help = true
    else args.positional.push(value)
  }
  return args
}

async function loadState(dir) {
  const home = dir || join(process.env.DSH_HOME || join(homedir(), '.dsh'), 'playwright')
  const settingsPath = join(home, 'settings.json')
  let settings = { ...defaults }
  try {
    settings = { ...defaults, ...JSON.parse(await readFile(settingsPath, 'utf8')) }
  } catch (error) {
    if (error.code !== 'ENOENT') throw new Error(`Could not read ${settingsPath}: ${error.message}`)
  }
  const chromeBridge = validateChromeBridge(settings.chromeBridge)
  const tokens = new TokenStore(join(home, 'chrome-bridge-tokens.json'))
  await tokens.read({ force: true }).catch(() => [])
  return { home, settingsPath, settings, chromeBridge, tokens }
}

/**
 * Best-effort bridge URL. A configured publicUrl always wins because only the operator knows the
 * externally reachable host. Otherwise the local binding is reported.
 */
function bridgeUrl(chromeBridge, settings) {
  if (chromeBridge.publicUrl) return chromeBridge.publicUrl
  const scheme = chromeBridge.tlsKeyFile && chromeBridge.tlsCertFile ? 'wss' : 'ws'
  const port = chromeBridge.mode === 'standalone' && chromeBridge.port ? chromeBridge.port : (process.env.DSH_WEB_PORT || 3080)
  const host = chromeBridge.host === '0.0.0.0' ? '127.0.0.1' : chromeBridge.host
  return `${scheme}://${host}:${port}${chromeBridge.path}`
}

async function probeStatus(url) {
  // The health endpoint belongs to the bridge path and speaks plain HTTP(S).
  const httpUrl = new URL(`${url.replace(/\/$/, '')}/health`.replace(/^ws/, 'http'))
  try {
    const response = await fetch(httpUrl, { signal: AbortSignal.timeout(3000) })
    if (!response.ok) return { reachable: false, reason: `HTTP ${response.status}` }
    return { reachable: true, value: (await response.json()).value }
  } catch (error) {
    return { reachable: false, reason: String(error?.cause?.code || error?.message || error) }
  }
}

function print(value, json) {
  if (json) { process.stdout.write(`${JSON.stringify(value, null, 2)}\n`); return }
  process.stdout.write(`${value}\n`)
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help || args.positional.length === 0) { process.stdout.write(`${USAGE}\n`); return 0 }
  const [command, subcommand, ...rest] = args.positional
  const state = await loadState(args.dir)
  const url = bridgeUrl(state.chromeBridge, state.settings)

  if (command === 'url') {
    print(url, args.json)
    if (!state.chromeBridge.enabled) process.stderr.write('Note: chromeBridge.enabled is false, so the bridge is not listening yet.\n')
    return 0
  }

  if (command === 'status') {
    const probe = state.chromeBridge.enabled ? await probeStatus(url) : { reachable: false, reason: 'bridge disabled' }
    const tokens = await state.tokens.summary()
    const report = {
      enabled: state.chromeBridge.enabled,
      mode: state.chromeBridge.mode,
      path: state.chromeBridge.path,
      url,
      reachable: probe.reachable,
      reason: probe.reachable ? undefined : probe.reason,
      tls: Boolean(state.chromeBridge.tlsKeyFile && state.chromeBridge.tlsCertFile),
      publicUrlConfigured: Boolean(state.chromeBridge.publicUrl),
      defaultBackend: state.settings.backend ?? defaults.backend,
      connectedExtensions: (probe.value?.peers ?? []).filter(peer => peer.authenticated)
        .map(peer => ({ id: peer.id, label: peer.label, extensionVersion: peer.extensionVersion, connectedAt: peer.connectedAt })),
      tokens: tokens.map(entry => ({ id: entry.id, label: entry.label, masked: entry.masked, fingerprint: entry.fingerprint, expired: entry.expired })),
    }
    if (args.json) { print(report, true); return 0 }
    print(`bridge:    ${report.enabled ? 'enabled' : 'disabled'} (${report.mode}${report.tls ? ', TLS' : ''})`, false)
    print(`url:       ${report.url}`, false)
    print(`reachable: ${report.reachable ? 'yes' : `no (${report.reason})`}`, false)
    print(`backend:   ${report.defaultBackend}`, false)
    print(`extensions: ${report.connectedExtensions.length === 0 ? 'none connected' : report.connectedExtensions.map(item => `${item.label || item.id} v${item.extensionVersion ?? '?'}`).join(', ')}`, false)
    print(`tokens:    ${report.tokens.length === 0 ? 'none' : report.tokens.map(item => `${item.masked} (${item.id}${item.expired ? ', expired' : ''})`).join(', ')}`, false)
    if (report.connectedExtensions.length === 0 && report.enabled && report.reachable) {
      print('', false)
      print('Next: open the DSH Chrome Bridge extension popup, paste this URL and a token, then press Connect.', false)
    }
    return 0
  }

  if (command === 'token') {
    if (subcommand === 'list' || subcommand === undefined) {
      const tokens = await state.tokens.summary()
      if (args.json) { print(tokens, true); return 0 }
      if (tokens.length === 0) { print('No pairing tokens exist. Run: dsh-chrome-bridge token create', false); return 0 }
      for (const entry of tokens) print(`${entry.id}  ${entry.masked.padEnd(16)} ${entry.label}${entry.expired ? '  (expired)' : ''}`, false)
      return 0
    }
    if (subcommand === 'create') {
      const label = rest.join(' ').trim() || 'default'
      const record = await state.tokens.add(label)
      if (args.json) { print({ id: record.id, label: record.label, expiresAt: record.expiresAt, token: record.token }, true); return 0 }
      print('', false)
      print('Pairing token (shown once, keep it secret):', false)
      print(`  ${record.token}`, false)
      print('', false)
      print(`id:    ${record.id}`, false)
      print(`label: ${record.label}`, false)
      print('', false)
      print('Paste it into the DSH Chrome Bridge extension popup. Revoke with:', false)
      print(`  dsh-chrome-bridge token revoke ${record.id}`, false)
      return 0
    }
    if (subcommand === 'revoke') {
      const id = rest[0]
      if (!id) { process.stderr.write('Provide a token id or fingerprint to revoke.\n'); return 2 }
      const result = await state.tokens.revoke(id)
      if (args.json) { print({ removed: result.removed, remaining: result.tokens.length }, true); return result.removed === 0 ? 1 : 0 }
      print(result.removed === 0 ? `No token matched ${id}.` : `Revoked ${result.removed} token. Active tokens: ${result.tokens.length}.`, false)
      return result.removed === 0 ? 1 : 0
    }
    process.stderr.write(`Unknown token subcommand: ${subcommand}\n`)
    return 2
  }

  process.stderr.write(`Unknown command: ${command}\n\n${USAGE}\n`)
  return 2
}

process.exitCode = await main().catch(error => {
  process.stderr.write(`${String(error?.message || error)}\n`)
  return 1
})
