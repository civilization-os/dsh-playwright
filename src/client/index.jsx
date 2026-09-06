import { useEffect, useRef, useState } from 'react'
import { BrowserController } from './controller.js'
import { zh, en } from './locales.js'
import css from './styles.css'

export const inject = ['slots', 'locale', 'connection']
const namespace = 'settings.playwright-browser'

export function apply(ctx) {
  const controller = new BrowserController((endpoint, args, signal) => ctx.connection.rpc.call('/playwright-browser', endpoint, args, signal))
  ctx.effect(() => ctx.locale.register(namespace, { zh, en }))
  ctx.effect(() => () => controller.dispose())
  ctx.effect(() => { const style = document.createElement('style'); style.textContent = css; document.head.append(style); return () => style.remove() })
  ctx.on('connection/reset', () => { void controller.request('status') })
  const t = ctx.locale.bind(namespace)
  ctx.slots.inject('settings.section', () => ctx.slots.register({
    name: 'settings.section', id: 'playwright-browser', order: 18, label: () => t('nav'), locale: namespace,
    inject: () => ({ hooks: { browser: controller }, request: (endpoint, args) => controller.request(endpoint, args) }),
  }, BrowserSettings))
}

function BrowserSettings({ t, useBrowser, request }) {
  const state = useBrowser(value => value)
  const [draft, setDraft] = useState(state.configured)
  const dirty = useRef(false)
  const edit = patch => { dirty.current = true; setDraft(value => ({ ...value, ...patch })) }
  const save = async () => { if (await request('save', draft)) dirty.current = false }
  useEffect(() => { if (!dirty.current) setDraft(state.configured) }, [state.configured])
  useEffect(() => { void request('status'); const timer = setInterval(() => { void request('status') }, 3000); return () => clearInterval(timer) }, [request])
  const found = id => state.browsers.some(item => item.id === id)
  const browserPath = id => state.browsers.find(item => item.id === id)?.path
  return <section className="dsh-pw"><header><div><h2>{t('title')}</h2><p>{t('intro')}</p></div><button type="button" disabled={state.saving} onClick={() => request('probe')}>{t(state.saving ? 'probing' : 'probe')}</button></header>
    {state.error && <p className="dsh-pw-error" role="alert">{t('failed')}</p>}
    <section className="dsh-pw-card"><header><h3>{t('browser')}</h3></header><div className="dsh-pw-form">
      <label>{t('browser')}<select value={draft.browser} onChange={event => edit({ browser: event.target.value })}><option value="auto">{t('auto')}</option><option value="chrome">{t('chrome')}</option><option value="msedge">{t('msedge')}</option></select></label>
      <label>{t('mode')}<span className="dsh-pw-mode"><button type="button" aria-pressed={!draft.headless} onClick={() => edit({ headless: false })}>{t('headed')}</button><button type="button" aria-pressed={draft.headless} onClick={() => edit({ headless: true })}>{t('headless')}</button></span></label>
      <label>{t('timeout')}<input type="number" min="1000" max="120000" value={draft.timeoutMs} onChange={event => edit({ timeoutMs: Number(event.target.value) })} /></label>
      <label>{t('viewport')}<span className="dsh-pw-mode"><input aria-label="width" type="number" value={draft.width} onChange={event => edit({ width: Number(event.target.value) })} /><input aria-label="height" type="number" value={draft.height} onChange={event => edit({ height: Number(event.target.value) })} /></span></label>
      <div className="dsh-pw-actions"><button type="button" disabled={state.saving} onClick={save}>{t(state.saving ? 'saving' : 'save')}</button></div>
    </div></section>
    <section className="dsh-pw-card"><header><h3>{t('checks')}</h3></header><div className="dsh-pw-checks">
      <Check label={t('chrome')} ok={found('chrome')} value={browserPath('chrome') || t('missing')} />
      <Check label={t('msedge')} ok={found('msedge')} value={browserPath('msedge') || t('missing')} />
      <Check label={t('selected')} ok={Boolean(state.selected)} value={state.selected ? t(state.selected) : t('missing')} />
      <Check label={t('checks')} ok={state.launch === 'available'} value={t(`launch_${state.launch}`)} />
      <Check label={t('tools')} ok value={t('toolsReady')} />
      <Check label={t('activePages')} ok value={String(state.activePages)} />
    </div><p className="dsh-pw-note">{t('profile')}</p></section>
    <section className="dsh-pw-card"><header><div><h3>{t('runbooks')}</h3><p>{t('runbooksIntro')}</p></div><span className="dsh-pw-count">{state.runbooks.length}</span></header>
      {!state.runbooks.length && <p className="dsh-pw-empty">{t('runbooksEmpty')}</p>}
      {state.runbooks.map(item => <article className="dsh-pw-runbook" key={item.id}><div><strong>{item.name}</strong><p>{item.origin}{item.path} · {t('version')} {item.version} · {item.stepCount} {t('steps')}</p><p>{item.task}</p>{item.instructionsPreview && <p className="dsh-pw-runbook-instructions">{item.instructionsPreview}</p>}</div><div className="dsh-pw-runbook-actions"><button type="button" onClick={() => request('runbook-enable', { id: item.id, enabled: !item.enabled })}>{t(item.enabled ? 'disable' : 'enable')}</button><button type="button" onClick={() => request('runbook-delete', { id: item.id })}>{t('delete')}</button></div></article>)}
      <p className="dsh-pw-note">{t('runbooksNote')}</p>
    </section>
  </section>
}

function Check({ label, ok, value }) {
  return <div className="dsh-pw-check"><strong><i className={`dsh-pw-dot${ok ? ' dsh-pw-dot-ok' : ''}`} />{label}</strong><span>{value}</span></div>
}
