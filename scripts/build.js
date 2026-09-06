import { build } from 'esbuild'
import { mkdir, writeFile } from 'node:fs/promises'

const result = await build({
  entryPoints: ['src/client/index.jsx'], bundle: true, write: false,
  format: 'cjs', platform: 'browser', target: 'es2022', jsx: 'automatic',
  external: ['react', 'react/jsx-runtime'], loader: { '.css': 'text' },
})
await mkdir('lib', { recursive: true })
await writeFile('lib/client.js', 'window.__ModuleLoader__.load({id:"deepseek-harness-playwright",factory:(require)=>{\nvar module={exports:{}};var exports=module.exports;\n'
  + result.outputFiles[0].text + '\nreturn module.exports;}});\n')
