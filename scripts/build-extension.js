#!/usr/bin/env node
/**
 * Package the Chrome extension into a self-contained directory and ZIP.
 *
 * The result is a Developer-mode "Load unpacked" directory and a shareable ZIP. It is deliberately
 * NOT a Chrome Web Store package, and it is not installable by dragging the ZIP into Chrome.
 *
 * Outputs:
 *   dist/extension/                          load-unpacked directory
 *   dist/dsh-chrome-bridge-<version>.zip     shareable archive
 *   dist/dsh-chrome-bridge-<version>.zip.sha256
 */
import { build } from 'esbuild'
import { cp, mkdir, readFile, rm, writeFile, stat } from 'node:fs/promises'
import { createWriteStream } from 'node:fs'
import { createHash } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { deflateRaw } from 'node:zlib'
import { promisify } from 'node:util'

const deflate = promisify(deflateRaw)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'extension')
const output = join(root, 'dist', 'extension')

async function main() {
  const manifest = JSON.parse(await readFile(join(source, 'manifest.json'), 'utf8'))
  await rm(output, { recursive: true, force: true })
  await mkdir(output, { recursive: true })

  // `content.js` uses the shared snapshot module, so it is bundled into one classic script that
  // can be registered both declaratively and through chrome.scripting.executeScript.
  await build({
    entryPoints: [join(source, 'content.js')],
    outfile: join(output, 'content.js'),
    bundle: true,
    format: 'iife',
    platform: 'browser',
    target: 'chrome116',
    legalComments: 'none',
    logLevel: 'warning',
  })

  // The worker and popup stay ES modules so they can share helpers between each other.
  for (const entry of ['service-worker.js', 'popup.js']) {
    await build({
      entryPoints: [join(source, entry)],
      outfile: join(output, entry),
      bundle: true,
      format: 'esm',
      platform: 'browser',
      target: 'chrome116',
      legalComments: 'none',
      logLevel: 'warning',
    })
  }

  await cp(join(source, 'popup.html'), join(output, 'popup.html'))
  await cp(join(source, 'popup.css'), join(output, 'popup.css'))
  await writeFile(join(output, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`)

  // Fail the build if a relative import escaped the extension root, which would break loading.
  for (const file of ['content.js', 'service-worker.js', 'popup.js']) {
    const text = await readFile(join(output, file), 'utf8')
    if (/from\s*["']\.\.\//.test(text) || /import\s*\(\s*["']\.\.\//.test(text)) {
      throw new Error(`${file} still references a path outside the extension root.`)
    }
  }

  const zipPath = join(root, 'dist', `dsh-chrome-bridge-${manifest.version}.zip`)
  const entries = ['manifest.json', 'content.js', 'service-worker.js', 'popup.html', 'popup.js', 'popup.css']
  await writeZip(output, entries, zipPath)

  // Chrome will not load a ZIP whose top level holds several files unless a checksum accompanies
  // it, so one is written beside the archive and its value is printed for the operator.
  const zipBytes = await readFile(zipPath)
  const sha256 = createHash('sha256').update(zipBytes).digest('hex')
  await writeFile(`${zipPath}.sha256`, `${sha256}  dsh-chrome-bridge-${manifest.version}.zip\n`)
  const { size } = await stat(zipPath)
  console.log(`extension directory: ${output}`)
  console.log(`extension package:   ${zipPath} (${(size / 1024).toFixed(1)} KiB)`)
  console.log(`sha256:              ${sha256}`)
  console.log(`checksum file:       ${zipPath}.sha256`)
  console.log('Load it with chrome://extensions -> Developer mode -> Load unpacked -> dist/extension')
}

const CRC_TABLE = (() => {
  const table = new Int32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    table[index] = value
  }
  return table
})()

function crc32(buffer) {
  let crc = -1
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ -1) >>> 0
}

/** Write a minimal ZIP archive (stored/deflated entries, no data descriptors). */
async function writeZip(directory, entries, destination) {
  const chunks = []
  const central = []
  let offset = 0
  for (const name of entries) {
    const data = await readFile(join(directory, name))
    const nameBytes = Buffer.from(name, 'utf8')
    const compressed = await deflate(data, { level: 9 })
    const useDeflate = compressed.length < data.length
    const body = useDeflate ? compressed : data
    const method = useDeflate ? 8 : 0
    const crc = crc32(data)

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(0, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt16LE(0, 10)
    local.writeUInt16LE(0, 12)
    local.writeUInt32LE(crc, 14)
    local.writeUInt32LE(body.length, 18)
    local.writeUInt32LE(data.length, 22)
    local.writeUInt16LE(nameBytes.length, 26)
    local.writeUInt16LE(0, 28)
    chunks.push(local, nameBytes, body)

    const header = Buffer.alloc(46)
    header.writeUInt32LE(0x02014b50, 0)
    header.writeUInt16LE(20, 4)
    header.writeUInt16LE(20, 6)
    header.writeUInt16LE(0, 8)
    header.writeUInt16LE(method, 10)
    header.writeUInt16LE(0, 12)
    header.writeUInt16LE(0, 14)
    header.writeUInt32LE(crc, 16)
    header.writeUInt32LE(body.length, 20)
    header.writeUInt32LE(data.length, 24)
    header.writeUInt16LE(nameBytes.length, 28)
    header.writeUInt16LE(0, 30)
    header.writeUInt16LE(0, 32)
    header.writeUInt16LE(0, 34)
    header.writeUInt16LE(0, 36)
    header.writeUInt32LE(0, 38)
    header.writeUInt32LE(offset, 42)
    central.push(header, nameBytes)

    offset += local.length + nameBytes.length + body.length
  }
  const centralBuffer = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(0, 4)
  end.writeUInt16LE(0, 6)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralBuffer.length, 12)
  end.writeUInt32LE(offset, 16)
  end.writeUInt16LE(0, 20)

  const out = createWriteStream(destination)
  for (const chunk of [...chunks, centralBuffer, end]) {
    if (!out.write(chunk)) await new Promise(resolveDrain => out.once('drain', resolveDrain))
  }
  await new Promise(resolveEnd => out.end(resolveEnd))
}

await main()
