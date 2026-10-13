/**
 * Bundle the extension content script for in-page execution.
 *
 * esbuild is driven through its JavaScript API instead of `node_modules/.bin/esbuild`: that file is a
 * POSIX shell script, so spawning it raises ENOENT on Windows and every test that needs the page
 * agent fails before it can assert anything.
 */
import assert from 'node:assert/strict'
import { buildSync } from 'esbuild'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(fileURLToPath(new URL('../', import.meta.url)))

/** Build once per process: esbuild output is deterministic and the tests only read the source. */
let cached

/**
 * Return the content script as an injectable script that publishes its internals on
 * `globalThis.__dsh`, so a page can drive `createPageAgent` and `createRefStore` directly.
 * Throws when the bundle cannot be built or does not expose named exports.
 */
export function buildAgentBundle() {
  if (cached !== undefined) return cached
  const result = buildSync({
    entryPoints: [join(root, 'extension/content.js')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'chrome116',
    write: false,
    logLevel: 'error',
  })
  const source = result.outputFiles[0].text
  // esbuild emits a single module-level `export { ... };` for the bundled entry. Rewriting it into an
  // assignment publishes the real declarations instead of a renamed local binding.
  const exported = /export\s*\{([^}]*)\};?\s*$/.exec(source)
  assert.ok(exported, 'the content bundle must expose its named exports')
  const assignments = exported[1].split(',').map(entry => {
    const [local, alias] = entry.split(/\s+as\s+/).map(part => part.trim())
    return `${alias ?? local}: ${local}`
  }).join(', ')
  cached = `${source.slice(0, exported.index)}\n;globalThis.__dsh = { ${assignments} };`
  return cached
}
