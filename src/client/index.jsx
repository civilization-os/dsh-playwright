import { useDeferredValue, useEffect, useRef, useState } from 'react'
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
    <RunbookWorkbench state={state} request={request} t={t} />
  </section>
}

function RunbookWorkbench({ state, request, t }) {
  const [query, setQuery] = useState(''); const deferredQuery = useDeferredValue(query)
  const [filter, setFilter] = useState('all'); const [openId, setOpenId] = useState(''); const [editing, setEditing] = useState(false); const [deleteId, setDeleteId] = useState('')
  const needle = deferredQuery.trim().toLocaleLowerCase()
  const visible = state.runbooks.filter(item => (filter === 'all' || filter === 'active' && item.activeId || filter === 'draft' && item.activeId !== item.id)
    && (!needle || `${item.name} ${item.task} ${item.origin}${item.path}`.toLocaleLowerCase().includes(needle)))
  const open = async id => { setOpenId(id); setEditing(false); if (!await request('runbook-detail', { id })) setOpenId('') }
  const close = () => { setOpenId(''); setEditing(false) }
  const toggle = (event, item) => { event?.stopPropagation(); const activeLatest = item.activeId === item.id; void request('runbook-enable', { id: activeLatest ? item.activeId : item.id, enabled: !activeLatest }) }
  return <section className="dsh-pw-card dsh-pw-library"><header><div><h3>{t('runbooks')}</h3><p>{t('runbooksIntro')}</p></div><span className="dsh-pw-count">{state.runbooks.length}</span></header>
    <div className="dsh-pw-library-tools"><label className="dsh-pw-search"><span className="dsh-pw-sr">{t('searchRunbooks')}</span><input value={query} onChange={event => setQuery(event.target.value)} placeholder={t('searchRunbooks')} /></label>
      <div className="dsh-pw-filter" aria-label={t('filterRunbooks')}>{['all', 'active', 'draft'].map(value => <button type="button" key={value} aria-pressed={filter === value} onClick={() => setFilter(value)}>{t(`filter_${value}`)}</button>)}</div>
    </div>
    {!state.runbooks.length ? <p className="dsh-pw-empty">{t('runbooksEmpty')}</p> : !visible.length ? <p className="dsh-pw-empty">{t('runbooksNoMatch')}</p> : <div className="dsh-pw-runbook-grid">{visible.map(item => <article className="dsh-pw-runbook" key={item.id}>
      <div className="dsh-pw-runbook-top"><span className={`dsh-pw-badge ${item.activeId ? 'is-active' : ''}`}>{item.activeId === item.id ? t('active') : item.activeId ? `${t('active')} v${item.activeVersion}` : t('draft')}</span><span>{item.origin}{item.path}</span></div>
      <button type="button" className="dsh-pw-runbook-title" onClick={() => open(item.id)}>{item.name}</button><p className="dsh-pw-runbook-task">{item.task}</p>{item.instructionsPreview ? <p className="dsh-pw-runbook-instructions">{item.instructionsPreview}</p> : null}
      <div className="dsh-pw-runbook-meta"><span>{t('version')} {item.version}{item.versionCount > 1 ? ` / ${item.versionCount}` : ''}</span><span>{item.stepCount} {t('steps')}</span><span>{item.successCount}✓ · {item.failureCount}×</span></div>
      <div className="dsh-pw-runbook-actions"><button type="button" onClick={event => toggle(event, item)}>{t(item.activeId === item.id ? 'disable' : 'enableVersion')}</button><button type="button" onClick={event => { event.stopPropagation(); setDeleteId(item.id) }}>{t('delete')}</button></div>
    </article>)}</div>}
    <p className="dsh-pw-note">{t('runbooksNote')}</p>
    {openId && state.selectedRunbook?.id === openId ? <RunbookDetail item={state.selectedRunbook} versions={state.runbookVersions ?? []} busy={state.saving} editing={editing} setEditing={setEditing} request={request} onOpen={open} onClose={close} onDelete={setDeleteId} t={t} /> : null}
    {deleteId ? <ConfirmDialog title={t('deleteRunbook')} body={t('deleteRunbookHint')} busy={state.saving} onCancel={() => setDeleteId('')} onConfirm={async () => { if (await request('runbook-delete', { id: deleteId })) { if (openId === deleteId) close(); setDeleteId('') } }} t={t} /> : null}
  </section>
}

function RunbookDetail({ item, versions, busy, editing, setEditing, request, onOpen, onClose, onDelete, t }) {
  const [draft, setDraft] = useState(() => editableRunbook(item))
  useEffect(() => setDraft(editableRunbook(item)), [item.id])
  useDialogDismiss(onClose)
  const set = (key, value) => setDraft(current => ({ ...current, [key]: value }))
  const save = async () => {
    const ok = await request('runbook-revise', { id: item.id, name: draft.name, task: draft.task, instructions: draft.instructions,
      inputs: lines(draft.inputs), preconditions: lines(draft.preconditions), successCriteria: draft.successCriteria })
    if (ok) onClose()
  }
  return <div className="dsh-pw-overlay" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onClose() }}><section className="dsh-pw-dialog dsh-pw-runbook-dialog" role="dialog" aria-modal="true" aria-labelledby="dsh-pw-runbook-title">
    <header><div><span className={`dsh-pw-badge ${item.enabled ? 'is-active' : ''}`}>{t(item.enabled ? 'active' : 'draft')}</span><h3 id="dsh-pw-runbook-title">{item.name}</h3><p>{item.origin}{item.path} · {t('version')} {item.version}</p></div><button className="dsh-pw-icon-button" type="button" onClick={onClose} aria-label={t('close')}>×</button></header>
    {editing ? <div className="dsh-pw-runbook-edit"><label>{t('runbookName')}<input value={draft.name} onChange={event => set('name', event.target.value)} /></label><label>{t('runbookTask')}<input value={draft.task} onChange={event => set('task', event.target.value)} /></label>
      <label>{t('inputs')}<textarea rows="3" value={draft.inputs} onChange={event => set('inputs', event.target.value)} placeholder={t('onePerLine')} /></label><label>{t('preconditions')}<textarea rows="3" value={draft.preconditions} onChange={event => set('preconditions', event.target.value)} placeholder={t('onePerLine')} /></label>
      <label className="is-wide">{t('instructions')}<textarea rows="7" value={draft.instructions} onChange={event => set('instructions', event.target.value)} /></label><label className="is-wide">{t('successCriteria')}<textarea rows="3" value={draft.successCriteria} onChange={event => set('successCriteria', event.target.value)} /></label>
    </div> : <div className="dsh-pw-runbook-body"><section><h4>{t('runbookTask')}</h4><p>{item.task}</p></section>{item.inputs.length ? <section><h4>{t('inputs')}</h4><div className="dsh-pw-chips">{item.inputs.map(value => <span key={value}>{value}</span>)}</div></section> : null}
      {item.preconditions.length ? <section><h4>{t('preconditions')}</h4><ul>{item.preconditions.map(value => <li key={value}>{value}</li>)}</ul></section> : null}{item.instructions ? <section><h4>{t('instructions')}</h4><p className="dsh-pw-preserve">{item.instructions}</p></section> : null}
      {item.successCriteria ? <section><h4>{t('successCriteria')}</h4><p className="dsh-pw-preserve">{item.successCriteria}</p></section> : null}<section><div className="dsh-pw-section-title"><h4>{t('steps')}</h4><span>{item.steps.length}</span></div>{item.steps.length ? <ol className="dsh-pw-steps">{item.steps.map((step, index) => <RunbookStep key={`${step.type}-${index}`} step={step} index={index} t={t} />)}</ol> : <p>{t('noRecordedSteps')}</p>}</section>
      <section><div className="dsh-pw-section-title"><h4>{t('versions')}</h4><span>{versions.length}</span></div><div className="dsh-pw-versions">{versions.map(version => <button type="button" aria-pressed={version.id === item.id} key={version.id} onClick={() => onOpen(version.id)}>v{version.version}<small>{version.enabled ? t('active') : formatDate(version.updatedAt)}</small></button>)}</div></section>
    </div>}
    <footer><button type="button" className="is-danger" onClick={() => onDelete(item.id)}>{t('delete')}</button><span /><button type="button" onClick={() => setEditing(!editing)}>{t(editing ? 'cancel' : 'edit')}</button>{editing ? <button type="button" className="is-primary" disabled={busy || !draft.name.trim() || !draft.task.trim()} onClick={save}>{t(busy ? 'saving' : 'saveRevision')}</button> : <button type="button" className="is-primary" disabled={busy} onClick={() => request('runbook-enable', { id: item.id, enabled: !item.enabled })}>{t(item.enabled ? 'disable' : 'enableVersion')}</button>}</footer>
  </section></div>
}

function RunbookStep({ step, index, t }) {
  const title = step.type === 'act' ? `${step.action ?? t('action')} · ${step.role ?? ''} ${step.name ?? ''}` : step.type === 'request' ? `${step.method ?? 'GET'} ${step.path ?? ''}` : step.type === 'open' ? step.url ?? t('open') : step.type === 'wait' ? t('wait') : step.type
  const detail = step.type === 'request' ? [...(step.queryKeys ?? []), ...(step.bodyKeys ?? [])].join(' · ') : step.frameUrl ?? ''
  return <li><span>{String(index + 1).padStart(2, '0')}</span><div><strong>{title}</strong>{detail ? <p>{detail}</p> : null}</div>{step.status ? <em>{step.status}</em> : null}</li>
}

function ConfirmDialog({ title, body, busy, onCancel, onConfirm, t }) { useDialogDismiss(onCancel); return <div className="dsh-pw-overlay is-confirm" role="presentation" onMouseDown={event => { if (event.target === event.currentTarget) onCancel() }}><section className="dsh-pw-dialog dsh-pw-confirm" role="alertdialog" aria-modal="true" aria-labelledby="dsh-pw-confirm-title"><header><h3 id="dsh-pw-confirm-title">{title}</h3></header><p>{body}</p><footer><button type="button" onClick={onCancel}>{t('cancel')}</button><button type="button" className="is-danger" disabled={busy} onClick={onConfirm}>{t('confirmDelete')}</button></footer></section></div> }

const editableRunbook = item => ({ name: item.name, task: item.task, instructions: item.instructions ?? '', inputs: (item.inputs ?? []).join('\n'), preconditions: (item.preconditions ?? []).join('\n'), successCriteria: item.successCriteria ?? '' })
const lines = value => value.split(/\r?\n/).map(item => item.trim()).filter(Boolean)
const formatDate = value => new Date(value).toLocaleDateString()
function useDialogDismiss(onDismiss) { useEffect(() => { const listener = event => { if (event.key === 'Escape') onDismiss() }; document.addEventListener('keydown', listener); return () => document.removeEventListener('keydown', listener) }, [onDismiss]) }

function Check({ label, ok, value }) {
  return <div className="dsh-pw-check"><strong><i className={`dsh-pw-dot${ok ? ' dsh-pw-dot-ok' : ''}`} />{label}</strong><span>{value}</span></div>
}
