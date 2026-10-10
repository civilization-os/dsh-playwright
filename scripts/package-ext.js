import { mkdir, rm, readFile, writeFile } from 'node:fs/promises'
import { execSync } from 'node:child_process'
import { join } from 'node:path'
import { existsSync } from 'node:fs'

const distDir = join(process.cwd(), 'dist')
const outputZip = join(distDir, 'dsh-chrome-bridge-extension.zip')
const extensionDir = join(process.cwd(), 'extension')
const manifestPath = join(extensionDir, 'manifest.json')
const buildInfoPath = join(extensionDir, 'build-info.json')

function getGitCommit() {
  try {
    return execSync('git rev-parse --short HEAD', { encoding: 'utf8' }).trim()
  } catch {
    return 'dev'
  }
}

function formatNow() {
  const d = new Date()
  const pad = n => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}

async function stampVersion() {
  const gitCommit = getGitCommit()
  const buildTime = formatNow()
  const baseVersion = '0.2.0'
  const versionName = `${baseVersion} (${buildTime} #${gitCommit})`

  // 1. Update manifest.json
  if (existsSync(manifestPath)) {
    const raw = await readFile(manifestPath, 'utf8')
    const manifest = JSON.parse(raw)
    manifest.version = baseVersion
    manifest.version_name = versionName
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n', 'utf8')
  }

  // 2. Write build-info.json
  const buildInfo = {
    version: baseVersion,
    versionName,
    buildTime,
    gitCommit,
  }
  await writeFile(buildInfoPath, JSON.stringify(buildInfo, null, 2) + '\n', 'utf8')
  console.log(`📌 已打入扩展版本标记: ${versionName}`)
  return versionName
}

async function packageExtension() {
  await mkdir(distDir, { recursive: true })
  if (existsSync(outputZip)) {
    await rm(outputZip, { force: true })
  }

  const versionName = await stampVersion()

  console.log(`正在打包扩展目录: ${extensionDir} ...`)

  if (process.platform === 'win32') {
    // Windows pwsh Compress-Archive
    const cmd = `powershell -NoProfile -Command "Compress-Archive -Path '${extensionDir}\\*' -DestinationPath '${outputZip}' -Force"`
    execSync(cmd, { stdio: 'inherit' })
  } else {
    // Linux / macOS zip
    const cmd = `cd "${extensionDir}" && zip -r "${outputZip}" ./*`
    execSync(cmd, { stdio: 'inherit' })
  }

  console.log(`\n✅ 扩展打包成功！版本: ${versionName}`)
  console.log(`产物路径: ${outputZip}`)
  console.log(`\n⚠️ 注意事项:`)
  console.log(`由于该扩展为开发者模式分发包，下载该 ZIP 后需要先解压到本地文件夹，然后在 chrome://extensions/ 中点击“加载已解压的扩展程序”，不能直接将 ZIP 文件拖入 Chrome。`)
}

packageExtension().catch(err => {
  console.error('❌ 打包失败:', err)
  process.exit(1)
})
