/**
 * Shared browser launcher for tests that need a real DOM.
 *
 * Preference order: a detected system Chrome or Edge, then the Playwright-managed Chromium that is
 * already present in the environment cache. Tests that cannot find any browser skip rather than
 * fail, so the suite stays usable on a bare machine.
 */
import { existsSync, readdirSync } from 'node:fs'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { chromium } from 'playwright-core'
import { discoverBrowsers } from '../src/settings.js'

/** Locate a Playwright-managed Chromium by scanning the browser cache for any revision. */
export function findBundledChromium(home = homedir()) {
  const cache = process.env.PLAYWRIGHT_BROWSERS_PATH || join(home, '.cache', 'ms-playwright')
  if (!existsSync(cache)) return undefined
  const candidates = []
  for (const entry of readdirSync(cache)) {
    if (!entry.startsWith('chromium-')) continue
    const version = Number(entry.split('-')[1])
    candidates.push({ version, path: join(cache, entry, 'chrome-linux64', 'chrome') })
    candidates.push({ version, path: join(cache, entry, 'chrome-linux', 'chrome') })
  }
  candidates.sort((a, b) => b.version - a.version)
  return candidates.find(candidate => existsSync(candidate.path))?.path
}

/** Resolve a launchable executable path, or undefined when the environment has no browser. */
export async function resolveBrowserPath() {
  const system = (await discoverBrowsers()).find(item => item.id === 'chrome') ?? (await discoverBrowsers()).find(item => item.id === 'msedge')
  if (system) return system.path
  return findBundledChromium()
}

/** Launch a browser for a test, or return undefined so the caller can skip. */
export async function launchTestBrowser() {
  const executablePath = await resolveBrowserPath()
  if (!executablePath) return undefined
  return chromium.launch({ executablePath, args: ['--no-sandbox', '--disable-dev-shm-usage'] })
}
