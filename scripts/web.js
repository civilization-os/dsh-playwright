import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { mkdir, writeFile } from 'node:fs/promises'
import './build.js'

const local = new URL('../.local/', import.meta.url)
const home = new URL('harness-home/', local)
await mkdir(new URL('profiles/web/', home), { recursive: true })
const overlay = new URL('playwright.patch.json', local)
await writeFile(overlay, JSON.stringify([{ insert: [{
  id: 'dsh-playwright', name: new URL('../src/index.js', import.meta.url).href,
}] }], null, 2) + '\n')
const args = process.argv.slice(2)
if (!args.some(arg => arg === '--port' || arg.startsWith('--port='))) args.push('--port', '3082')
const child = spawn(process.execPath, ['--import', 'tsx/esm', 'apps/cli/src/bin.ts', 'web',
  '--patch', fileURLToPath(overlay), '--no-open', ...args], {
  cwd: fileURLToPath(new URL('../../deepseek-harness/', import.meta.url)),
  env: { ...process.env, DSH_HOME: fileURLToPath(home) }, stdio: 'inherit',
})
child.on('exit', code => { process.exitCode = code ?? 1 })
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
