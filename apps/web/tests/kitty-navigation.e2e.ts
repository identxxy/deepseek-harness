/** Real Loader/browser Kitty navigation with only terminal HTTP responses replaced. */
import { copyFile, mkdir, mkdtemp, readFile, rm, symlink, truncate, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { build } from 'tsdown'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import {
  captureStableAria, compareOrRefreshGolden, launchWebScaffold, seedSession,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

type SavedLayout = { paneRoot: unknown; activePaneId: string | null }

const MODE = webSnapshotMode()
const EXPECTED = fileURLToPath(new URL('./expected/kitty-navigation/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../tmp/kitty-navigation/', import.meta.url))
const KITTY_ROOT = fileURLToPath(new URL('../../../plugins/kitty/', import.meta.url))
const PANES = [
  { windowId: 'a'.repeat(64), instance: 'fixture-kitty', token: 'alpha-token', id: 1, title: 'Alpha terminal', cwd: '/workspace/alpha', program: 'zsh', pid: 101 },
  { windowId: 'b'.repeat(64), instance: 'fixture-kitty', token: 'beta-token', id: 2, title: 'Beta terminal', cwd: '/workspace/beta', program: 'python', pid: 102 },
]
const SCROLL_OPTIONS = { debounceMs: 70, pixelsPerLine: 40, touchSensitivity: 2, maxLines: 8 }
const SCREEN_SAMPLE = [
  '$ pwd',
  '/workspace/example',
  '\u001b[32mReady\u001b[0m · terminal connected',
  '第一行：检查终端输出',
  '第二行：继续当前会话',
  'Third line: continue working.',
].join('\n')

describe.skipIf(MODE === 'record')('web e2e: Kitty window navigation', () => {
  let fixtureRoot: string
  let scaffold: WebScaffold
  let browser: Browser
  let page: Page
  let tripwire: ReturnType<typeof watchConsole>
  let panes = PANES
  let listError = false
  let staleToken = ''
  let mutations: string[]
  let allowCreate = false
  let allowAltUp = false
  let allowComposer = false
  let composerInputs: Record<string, unknown>[]
  let composerStale = false
  let composerBarrier: Promise<void> | undefined
  let releaseComposer: (() => void) | undefined
  const pendingComposerResponses = new Set<Promise<void>>()
  let allowScroll = false
  let scrollAmounts: (number | 'end')[]
  let scrollOffset = 0
  let scrollBarrier: Promise<void> | undefined
  let releaseScroll: (() => void) | undefined
  const pendingScrollResponses = new Set<Promise<void>>()
  let screenTokens: string[]
  let catalogReads = 0
  let screenExtra = ''
  let reportUrl: string
  let catalogBarrier: Promise<void> | undefined
  let releaseCatalog: (() => void) | undefined
  const pendingCatalogResponses = new Set<Promise<void>>()

  beforeAll(async () => {
    fixtureRoot = await mkdtemp(join(tmpdir(), 'dsh-kitty-browser-'))
    const pluginRoot = join(fixtureRoot, 'kitty')
    await mkdir(pluginRoot)
    await copyFile(join(KITTY_ROOT, 'package.json'), join(pluginRoot, 'package.json'))
    await symlink(join(KITTY_ROOT, 'node_modules'), join(pluginRoot, 'node_modules'), 'junction')
    const bundles = await build({ cwd: KITTY_ROOT, config: join(KITTY_ROOT, 'tsdown.config.ts'), outDir: join(pluginRoot, 'lib'), logLevel: 'silent' })
    await Promise.all(bundles.map(bundle => bundle[Symbol.asyncDispose]()))
    await mkdir(join(fixtureRoot, 'node_modules', '@deepseek-ai'), { recursive: true })
    await symlink(pluginRoot, join(fixtureRoot, 'node_modules', '@deepseek-ai', 'dsh-kitty'), 'junction')
    const installAnchor = join(fixtureRoot, 'package.json')
    await writeFile(installAnchor, JSON.stringify({
      name: 'dsh-kitty-browser-fixture',
      dependencies: { '@deepseek-ai/dsh-kitty': '0.1.0' },
    }))
    const socketDirectory = join(fixtureRoot, 'sockets')
    await mkdir(socketDirectory)
    const reportRoot = join(fixtureRoot, 'reports')
    const sharedAssets = join(fixtureRoot, 'shared-assets')
    await mkdir(sharedAssets)
    await writeFile(join(sharedAssets, 'figure.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="96" height="48"><rect width="96" height="48" fill="#246ea0"/></svg>')
    await mkdir(join(reportRoot, 'assets'), { recursive: true })
    reportUrl = pathToFileURL(join(reportRoot, 'index.html')).href
    await writeFile(join(reportRoot, 'index.html'), `<!doctype html><html><head><base href=assets/><title>Local report</title><link rel=stylesheet href=style.css></head><body>
      <h1 id=top>Local report</h1><img alt="Report image" src=plot.svg><p id=data>Loading data</p><a href="#top">Report heading</a>
      <button id=increment>Increment</button><output id=count>0</output>
      <a href=../next.html>Next report</a><a href=../../private.txt>Outside report directory</a>
      <script src=report.js></script></body></html>`)
    await writeFile(join(reportRoot, 'assets', 'style.css'), 'body{font-family:sans-serif;background:#f4f8ff}h1{color:rgb(20,60,100)}img{width:80px;height:40px}')
    await writeFile(join(reportRoot, 'assets', 'plot.svg'), '<svg xmlns="http://www.w3.org/2000/svg" width="80" height="40"><rect width="80" height="40" fill="#245ad0"/></svg>')
    await writeFile(join(reportRoot, 'assets', 'data.json'), '{"message":"Relative data loaded"}')
    await writeFile(join(reportRoot, 'assets', 'report.js'), `document.getElementById('increment').onclick=()=>{document.getElementById('count').textContent=String(Number(document.getElementById('count').textContent)+1)};
      fetch('./data.json').then(response=>response.json()).then(value=>{document.getElementById('data').textContent=value.message});
      try{parent.document.body.dataset.reportAccess='unsafe'}catch{document.body.dataset.isolated='yes'}`)
    await writeFile(join(reportRoot, 'next.html'), '<h1>Next report</h1><form action=index.html method=get><input name=q value=return><button>Return to report</button></form>')
    await writeFile(join(reportRoot, 'external-assets.html'), '<h1>Report with separate assets</h1><img alt="External figure" src="../shared-assets/figure.svg"><video controls poster="../shared-assets/figure.svg"></video><a href="../shared-assets/figure.svg">Outside report directory</a>')
    await writeFile(join(reportRoot, 'large.html'), `<h1>Large local report</h1><!--${'x'.repeat(17 * 1024 * 1024)}--><p>End of large report</p>`)
    await writeFile(join(reportRoot, 'oversized.html'), '')
    await truncate(join(reportRoot, 'oversized.html'), 64 * 1024 * 1024 + 1)
    await writeFile(join(fixtureRoot, 'private.txt'), 'OUTSIDE_REPORT_SECRET')
    const overlayPath = join(fixtureRoot, 'kitty.patch.yml')
    await writeFile(overlayPath, `${await readFile(join(KITTY_ROOT, 'cordis.patch.yml'), 'utf8')}\n- id: kitty-host\n  config:\n    socketDirectory: ${JSON.stringify(socketDirectory)}\n    previewAssetDirectories: [${JSON.stringify(sharedAssets)}]\n`)
    scaffold = await launchWebScaffold({
      extraOverlayPath: overlayPath,
      extraInstallAnchors: [installAnchor],
    })
    browser = await chromium.launch()
    if (MODE === 'refresh') {
      await mkdir(EXPECTED, { recursive: true })
      await mkdir(ARTIFACTS, { recursive: true })
    }
  })

  beforeEach(async () => {
    panes = PANES
    listError = false
    staleToken = ''
    mutations = []
    allowCreate = false
    allowAltUp = false
    allowComposer = false
    composerInputs = []
    composerStale = false
    composerBarrier = undefined
    releaseComposer = undefined
    allowScroll = false
    scrollAmounts = []
    scrollOffset = 0
    scrollBarrier = undefined
    releaseScroll = undefined
    screenTokens = []
    catalogReads = 0
    screenExtra = ''
    catalogBarrier = undefined
    releaseCatalog = undefined
    page = await newEnglishPage(browser)
    await page.addInitScript(() => {
      Object.defineProperty(Crypto.prototype, 'randomUUID', { value: undefined, configurable: true })
    })
    tripwire = watchConsole(page)
    page.setDefaultTimeout(15_000)
    await page.route(url => url.pathname === '/api/dsh/kitty', async (route) => {
      const request = route.request()
      if (request.method() !== 'GET') {
        mutations.push(request.method())
        const input = request.postDataJSON() as { token?: string; action?: string; key?: string; amount?: number | 'end' }
        if (allowComposer && request.method() === 'POST' && panes.some(pane => pane.token === input.token)
          && (input.action === 'text' || (input.action === 'key' && ['enter', 'up', 'down', 'left', 'right'].includes(input.key ?? '')))) {
          composerInputs.push(input)
          const response = (async () => {
            await composerBarrier
            await route.fulfill(composerStale
              ? { status: 409, json: { error: 'stale_target' } }
              : { json: { delivered: true } })
          })()
          pendingComposerResponses.add(response)
          try { await response }
          finally { pendingComposerResponses.delete(response) }
          return
        }
        if (allowScroll && request.method() === 'POST' && input.token === 'alpha-token' && input.action === 'scroll' && input.amount !== undefined) {
          scrollAmounts.push(input.amount)
          scrollOffset = input.amount === 'end' ? 0 : scrollOffset + input.amount
          const text = `ALPHA_SCREEN_READY\nREMOTE_OFFSET_${scrollOffset}\n${SCREEN_SAMPLE}${screenExtra}`
          const response = (async () => {
            await scrollBarrier
            await route.fulfill({ json: { text } })
          })()
          pendingScrollResponses.add(response)
          try { await response }
          finally { pendingScrollResponses.delete(response) }
          return
        }
        if (allowAltUp && request.method() === 'POST' && input.token === 'alpha-token' && input.action === 'key' && input.key === 'alt+up') {
          await route.fulfill({ json: { delivered: true } })
          return
        }
        if (allowCreate && request.method() === 'POST' && input.token === 'beta-token' && input.action === 'create') {
          panes = [...PANES, { windowId: 'c'.repeat(64), instance: 'fixture-kitty', token: 'gamma-token', id: 3, title: 'Gamma terminal', cwd: '/workspace/beta', program: 'zsh', pid: 103 }]
          await route.fulfill({ json: { id: 3, instance: 'fixture-kitty' } })
          return
        }
        await route.fulfill({ status: 405, json: { error: 'method_not_allowed' } })
        return
      }
      const token = new URL(request.url()).searchParams.get('token')
      if (token !== null) {
        screenTokens.push(token)
        const target = panes.find(pane => pane.token === token)
        const marker = target?.id === 1 ? 'ALPHA_SCREEN_READY' : target?.id === 2 ? 'BETA_SCREEN_READY' : 'GAMMA_SCREEN_READY'
        await route.fulfill(token === staleToken || !target
          ? { status: 409, json: { error: 'stale_target' } }
          : { json: { text: `${marker}\n${SCREEN_SAMPLE}${screenExtra}` } })
        return
      }
      catalogReads += 1
      const response = (async () => {
        await catalogBarrier
        await route.fulfill(listError
          ? { status: 500, json: { error: 'kitty_operation_failed' } }
          : { json: { panes, pollIntervalMs: 60_000, maxImageBytes: 8 * 1024 * 1024, scroll: SCROLL_OPTIONS } })
      })()
      pendingCatalogResponses.add(response)
      try { await response }
      finally { pendingCatalogResponses.delete(response) }
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).waitFor()
  })

  afterEach(async ({ task }) => {
    releaseCatalog?.()
    releaseScroll?.()
    releaseComposer?.()
    await Promise.all([...pendingCatalogResponses])
    await Promise.all([...pendingScrollResponses])
    await Promise.all([...pendingComposerResponses])
    try {
      if (task.result?.state === 'fail' && page !== undefined && !page.isClosed()) {
        await mkdir(ARTIFACTS, { recursive: true })
        await page.screenshot({ path: join(ARTIFACTS, 'failure.png') })
        await writeFile(join(ARTIFACTS, 'failure-aria.md'), await page.locator('body').ariaSnapshot())
      }
      expect(tripwire).toEqual({ warnings: [], pageErrors: [] })
      expect(mutations).toEqual([
        ...(allowCreate || allowAltUp ? ['POST'] : []), ...scrollAmounts.map(() => 'POST'), ...composerInputs.map(() => 'POST'),
      ])
    } finally {
      await page?.close()
    }
  })

  afterAll(async () => {
    try { await browser?.close() }
    finally {
      try { await scaffold?.close() }
      finally { if (fixtureRoot !== undefined) await rm(fixtureRoot, { recursive: true, force: true }) }
    }
  })

  async function openWindows() {
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).click()
    await page.getByRole('button', { name: '#1 · Alpha terminal', exact: true }).waitFor()
    expect(await page.getByRole('tree', { name: 'Sessions', exact: true }).isVisible()).toBe(false)
    expect(await page.locator('.dsh-kitty-panel select').count()).toBe(0)
  }

  async function showScreen(name: 'Alpha' | 'Beta') {
    await page.getByRole('button', { name: name === 'Alpha' ? '#1 · Alpha terminal' : '#2 · Beta terminal', exact: true }).click()
    await page.locator('.dsh-kitty-screen').filter({ hasText: `${name.toUpperCase()}_SCREEN_READY` }).waitFor()
    expect(await page.locator('.dsh-kitty-panel select').count()).toBe(0)
    expect(await page.locator('.dsh-kitty-pane-title').textContent()).toBe(name === 'Alpha' ? '#1 · Alpha terminal' : '#2 · Beta terminal')
    expect(await page.locator('.dsh-kitty-panel header').count()).toBe(0)
    expect(await page.locator('.dsh-kitty-panel').getByRole('button', { name: /^(New window|Terminal options)$/ }).count()).toBe(0)
  }

  async function snapshot(name: string) {
    await compareOrRefreshGolden(join(EXPECTED, `${name}.expected.md`),
      await captureStableAria(page, '.dsh-kitty-browser', scaffold.workspaceCwd), MODE)
  }

  it('starts catalog transport before plugin boot and shares the pending read with the chooser', async () => {
    catalogReads = 0
    catalogBarrier = new Promise<void>((resolve) => { releaseCatalog = resolve })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).waitFor()
    expect(catalogReads).toBe(1)
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).click()
    await page.getByRole('button', { name: 'Loading…', exact: true }).waitFor()
    await snapshot('loading-windows')
    expect(catalogReads).toBe(1)
    catalogBarrier = undefined
    releaseCatalog?.()
    await page.getByRole('button', { name: '#1 · Alpha terminal', exact: true }).waitFor()
    expect(catalogReads).toBe(1)
    expect(await page.evaluate(() => performance.getEntriesByType('resource')
      .filter(entry => new URL(entry.name).pathname === '/api/dsh/kitty')
      .map(entry => (entry as PerformanceResourceTiming).initiatorType))).toEqual(['link'])
    await showScreen('Alpha')
  })

  it('keeps cached windows selectable while refreshing the catalog on return', async () => {
    await openWindows()
    await page.getByRole('button', { name: 'Refresh panes', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to home', exact: true }).click()
    catalogBarrier = new Promise<void>((resolve) => { releaseCatalog = resolve })
    const previousReads = catalogReads
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).click()
    await page.getByRole('button', { name: 'Loading…', exact: true }).waitFor()
    await expect.poll(() => catalogReads).toBe(previousReads + 1)
    await showScreen('Beta')
    catalogBarrier = undefined
    releaseCatalog?.()
  })

  it('reuses cached application scripts and styles when opening Kitty after a reload', async () => {
    // Browser route interception disables HTTP caching; this page uses the real empty Kitty socket directory.
    const cachedPage = await newEnglishPage(browser)
    const cachedConsole = watchConsole(cachedPage)
    try {
      if (process.env.DSH_KITTY_PERF === '1') {
        const cdp = await cachedPage.context().newCDPSession(cachedPage)
        await cdp.send('Network.enable')
        await cdp.send('Emulation.setCPUThrottlingRate', { rate: 4 })
        await cdp.send('Network.emulateNetworkConditions', {
          offline: false, latency: 80, downloadThroughput: 10_000_000 / 8, uploadThroughput: 2_000_000 / 8,
        })
      }
      await cachedPage.addInitScript(() => {
        let seenBoot = false
        const observer = new MutationObserver(() => {
          const boot = document.querySelector('[data-dsh-boot]')
          if (boot !== null) seenBoot = true
          if (seenBoot && boot === null) {
            performance.mark('kitty-test:app-ready')
            observer.disconnect()
          }
        })
        observer.observe(document, { subtree: true, childList: true })
        document.addEventListener('click', (event) => {
          if (event.target instanceof Element && event.target.closest('button')?.getAttribute('aria-label') === 'Kitty terminal') {
            performance.mark('kitty-test:open')
          }
        })
      })
      const reports = []
      for (const navigation of ['cold', 'reload'] as const) {
        if (navigation === 'cold') await cachedPage.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
        else await cachedPage.reload({ waitUntil: 'load' })
        await cachedPage.getByRole('button', { name: 'Kitty terminal', exact: true }).click()
        await cachedPage.getByText('No Kitty panes found', { exact: true }).waitFor()
        reports.push(await cachedPage.evaluate(navigation => ({
          navigation,
          appReadyMs: performance.getEntriesByName('kitty-test:app-ready')[0]!.startTime,
          openToListMs: performance.now() - performance.getEntriesByName('kitty-test:open')[0]!.startTime,
          resources: performance.getEntriesByType('resource')
            .filter((entry) => {
              const path = new URL(entry.name).pathname
              return path === '/plugins/' || /^\/assets\/.*\.(?:js|css)$/.test(path)
            })
            .map((entry) => {
              const resource = entry as PerformanceResourceTiming
              return { url: resource.name, transferSize: resource.transferSize, decodedBodySize: resource.decodedBodySize }
            }),
        }), navigation))
      }
      const [cold, reloaded] = reports
      expect(cold!.resources.length).toBeGreaterThan(0)
      expect(cold!.resources.every(resource => resource.transferSize > 0)).toBe(true)
      expect(reloaded!.resources.map(resource => resource.url).sort()).toEqual(cold!.resources.map(resource => resource.url).sort())
      expect(reloaded!.resources.every(resource => resource.transferSize === 0 && resource.decodedBodySize > 0)).toBe(true)
      expect(cachedConsole).toEqual({ warnings: [], pageErrors: [] })
      if (process.env.DSH_KITTY_PERF === '1') {
        await mkdir(ARTIFACTS, { recursive: true })
        await writeFile(join(ARTIFACTS, 'startup-performance.json'), JSON.stringify(reports, null, 2) + '\n')
      }
    } finally { await cachedPage.close() }
  })

  it('replaces the desktop session list with windows and switches directly between terminals', async () => {
    await openWindows()
    await page.getByRole('button', { name: 'Refresh panes', exact: true }).waitFor()
    await snapshot('windows')
    await showScreen('Alpha')
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'desktop-terminal.png') })
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Keep this draft in Alpha')
    await page.locator('.dsh-kitty-file').setInputFiles({
      name: 'draft.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=', 'base64'),
    })
    await page.getByRole('img', { name: 'draft.png', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    await showScreen('Alpha')
    expect(await draft.inputValue()).toBe('Keep this draft in Alpha')
    expect(await page.getByRole('img', { name: 'draft.png', exact: true }).isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).isVisible()).toBe(true)
    await showScreen('Beta')
    expect(await draft.inputValue()).toBe('')
    expect(await page.getByRole('img', { name: 'draft.png', exact: true }).count()).toBe(0)
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    await page.getByRole('button', { name: '#1 · Alpha terminal', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Back to home', exact: true }).click()
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).waitFor()
  })

  it('uses terminal → windows → home on mobile and restores all three browser-history levels', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    await showScreen('Alpha')
    expect(await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).waitFor()
    await snapshot('mobile-windows')
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-windows.png') })
    await showScreen('Beta')
    expect(await page.getByRole('button', { name: 'New window', exact: true }).isVisible()).toBe(false)
    expect(await page.getByRole('button', { name: 'Terminal options', exact: true }).isVisible()).toBe(false)
    await compareOrRefreshGolden(join(EXPECTED, 'mobile-terminal-header.expected.md'),
      await captureStableAria(page, '.dsh-kitty-pane-header', scaffold.workspaceCwd), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-terminal.png') })
    await page.goBack()
    await page.getByRole('button', { name: '#1 · Alpha terminal', exact: true }).waitFor()
    await expect.poll(() => page.locator('.dsh-kitty-screen').isVisible()).toBe(false)
    await page.goBack()
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).waitFor()
    await page.goForward()
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).waitFor()
    await page.goForward()
    await page.locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    await page.getByRole('button', { name: 'Back to home', exact: true }).click()
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).waitFor()
  })

  it('keeps the newline checkbox beside Send and opens direction keys from the mobile key panel', async () => {
    allowComposer = true
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    await showScreen('Alpha')
    const newline = page.locator('[data-actor-kind="panel"][data-active]').getByRole('checkbox', { name: 'Append newline', exact: true })
    expect(await newline.count()).toBe(1)
    expect(await newline.isChecked()).toBe(true)
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    const send = page.getByRole('button', { name: 'Send', exact: true })
    expect(await page.locator('.dsh-kitty-newline span').isVisible()).toBe(true)
    expect(await page.locator('.dsh-kitty-newline span').textContent()).toBe('Append newline')
    expect(await page.getByRole('button', { name: 'Up arrow', exact: true }).count()).toBe(0)
    for (const width of [320, 390]) {
      await page.setViewportSize({ width, height: 844 })
      expect((await page.locator('.dsh-kitty-input').boundingBox())!.height).toBeLessThanOrEqual(42)
      expect((await page.locator('.dsh-kitty-compose').boundingBox())!.height).toBeLessThanOrEqual(50)
      await expect.poll(async () => {
        const bounds = await send.boundingBox()
        return bounds!.x + bounds!.width
      }).toBeLessThanOrEqual(width)
      const labelBounds = await page.locator('.dsh-kitty-newline').boundingBox()
      const sendBounds = await send.boundingBox()
      expect(labelBounds!.x).toBeGreaterThanOrEqual(0)
      expect(sendBounds!.x + sendBounds!.width).toBeLessThanOrEqual(width)
      expect(Math.abs(labelBounds!.y - sendBounds!.y)).toBeLessThanOrEqual(4)
      expect(sendBounds!.x - labelBounds!.x - labelBounds!.width).toBeLessThanOrEqual(8)
    }
    await draft.fill('First message')
    await send.click()
    await expect.poll(() => draft.inputValue()).toBe('')
    await newline.uncheck()
    await draft.fill('y')
    await send.click()
    await expect.poll(() => draft.inputValue()).toBe('')
    await draft.fill('Keyboard send')
    await draft.press('Control+Enter')
    await expect.poll(() => draft.inputValue()).toBe('')
    expect(composerInputs).toEqual([
      { token: 'alpha-token', action: 'text', text: 'First message', submit: true },
      { token: 'alpha-token', action: 'text', text: 'y', submit: false },
      { token: 'alpha-token', action: 'text', text: 'Keyboard send', submit: false },
    ])
    await newline.check()
    await draft.fill('Keep this draft')
    const keys = page.getByRole('button', { name: 'Terminal keys', exact: true })
    await keys.click()
    const keyboard = page.locator('.dsh-kitty-keyboard')
    for (const direction of ['Up', 'Down', 'Left', 'Right']) {
      const button = keyboard.getByRole('button', { name: `${direction} arrow`, exact: true })
      const bounds = await button.boundingBox()
      expect(bounds!.x).toBeGreaterThanOrEqual(0)
      expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
      await button.click()
      await expect.poll(() => button.isEnabled()).toBe(true)
    }
    expect(composerInputs.slice(3)).toEqual(['up', 'down', 'left', 'right'].map(key => ({ token: 'alpha-token', action: 'key', key })))
    expect(await draft.inputValue()).toBe('Keep this draft')
    await keys.click()
    expect(await page.getByRole('button', { name: 'Up arrow', exact: true }).count()).toBe(0)
    await newline.uncheck()
    await compareOrRefreshGolden(join(EXPECTED, 'mobile-send-options.expected.md'),
      await captureStableAria(page, '.dsh-kitty-send-options', scaffold.workspaceCwd), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-send-options.png') })
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    await showScreen('Beta')
    expect(await newline.isChecked()).toBe(false)
  })

  it.each([390, 1680])('uses one Send button for text or an empty Enter at width %s', async (width) => {
    allowComposer = true
    await page.setViewportSize({ width, height: 1000 })
    await openWindows()
    await showScreen('Alpha')
    const draft = page.getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    const newline = page.getByRole('checkbox', { name: 'Append newline', exact: true })
    const send = page.getByRole('button', { name: 'Send', exact: true })
    await newline.uncheck()
    await draft.fill('/model')
    await send.click()
    await expect.poll(() => draft.inputValue()).toBe('')
    expect(composerInputs).toEqual([{ token: 'alpha-token', action: 'text', text: '/model', submit: false }])
    await send.click()
    await expect.poll(() => composerInputs.length).toBe(2)
    await expect.poll(() => send.isEnabled()).toBe(true)
    await newline.check()
    await send.click()
    await expect.poll(() => composerInputs.length).toBe(3)
    await expect.poll(() => send.isEnabled()).toBe(true)
    await draft.press('Control+Enter')
    await expect.poll(() => composerInputs.length).toBe(4)
    await expect.poll(() => send.isEnabled()).toBe(true)
    expect(composerInputs.slice(1)).toEqual(Array.from({ length: 3 }, () => ({ token: 'alpha-token', action: 'key', key: 'enter' })))
    await page.getByRole('button', { name: 'Terminal keys', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Enter ↵', exact: true }).count()).toBe(0)
    expect(await page.getByRole('button', { name: 'Paste only', exact: true }).count()).toBe(0)
    expect(await send.count()).toBe(1)
  })

  it('keeps Alt+Up visible at the start of mobile keys and preserves the draft after dispatch', async () => {
    allowAltUp = true
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    await showScreen('Alpha')
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Answer after focusing the question')
    await page.getByRole('button', { name: 'Terminal keys', exact: true }).click()
    const keyboard = page.locator('.dsh-kitty-keyboard')
    const altUp = keyboard.getByRole('button', { name: 'Alt + ↑', exact: true })
    expect(await keyboard.getByRole('button').first().textContent()).toBe('Alt + ↑')
    const bounds = await altUp.boundingBox()
    expect(bounds!.x).toBeGreaterThanOrEqual(0)
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390)
    const sent = page.waitForRequest(request => new URL(request.url()).pathname === '/api/dsh/kitty' && request.method() === 'POST')
    await altUp.click()
    expect((await sent).postDataJSON()).toEqual({ token: 'alpha-token', action: 'key', key: 'alt+up' })
    await page.getByText('Dispatched · check the terminal for receipt.', { exact: true }).waitFor()
    expect(await draft.inputValue()).toBe('Answer after focusing the question')
    await compareOrRefreshGolden(join(EXPECTED, 'mobile-terminal-keys.expected.md'),
      await captureStableAria(page, '.dsh-kitty-keyboard', scaffold.workspaceCwd), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-terminal-keys.png') })
  })

  it('opens reports above 16 MiB and identifies oversized reports without losing the current page', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    screenExtra = `\n${new URL('large.html', reportUrl).href}`
    await openWindows()
    await showScreen('Alpha')
    await page.locator('.dsh-kitty-screen').getByRole('link', { name: new URL('large.html', reportUrl).href, exact: true }).click()
    const report = page.frameLocator('.dsh-kitty-preview iframe')
    await report.getByRole('heading', { name: 'Large local report', exact: true }).waitFor()
    await report.getByText('End of large report', { exact: true }).waitFor()
    const address = page.getByRole('textbox', { name: 'Report address', exact: true })
    await address.fill(new URL('oversized.html', reportUrl).href)
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'This report or its resources exceed the preview size limit.' }).waitFor()
    expect(await report.getByRole('heading', { name: 'Large local report', exact: true }).isVisible()).toBe(true)
    await compareOrRefreshGolden(join(EXPECTED, 'report-too-large.expected.md'),
      await captureStableAria(page, '.dsh-kitty-preview-status', scaffold.workspaceCwd), MODE)
    expect(await page.getByText('Open a terminal link or enter a report address.', { exact: true }).isVisible()).toBe(false)
    await page.route(url => url.pathname === '/api/dsh/kitty/preview', route => route.fulfill({ status: 404, contentType: 'text/plain', body: 'not found' }))
    await address.fill(reportUrl)
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await page.getByRole('alert').filter({ hasText: 'Report preview is unavailable. Restart DSH and try again.' }).waitFor()
    await compareOrRefreshGolden(join(EXPECTED, 'report-unavailable.expected.md'),
      await captureStableAria(page, '.dsh-kitty-preview-status', scaffold.workspaceCwd), MODE)
    expect(await report.getByRole('heading', { name: 'Large local report', exact: true }).isVisible()).toBe(true)
  })

  it('keeps a compact expanding composer in each Kitty pane with independent drafts, images and send preferences', async () => {
    allowComposer = true
    panes = [...PANES, {
      windowId: 'c'.repeat(64), instance: 'fixture-kitty', token: 'gamma-token', id: 3, title: 'Gamma terminal', cwd: '/workspace/gamma', program: 'zsh', pid: 103,
    }]
    await page.setViewportSize({ width: 1680, height: 1050 })
    await openWindows()
    await showScreen('Alpha')
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    const newline = page.locator('[data-actor-kind="panel"][data-active]').getByRole('checkbox', { name: 'Append newline', exact: true })
    await draft.fill('Keep Alpha draft')
    await newline.uncheck()
    await page.locator('.dsh-kitty-file').setInputFiles({
      name: 'alpha.png', mimeType: 'image/png',
      buffer: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII=', 'base64'),
    })
    await page.getByRole('img', { name: 'alpha.png', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Split right', exact: true }).click()
    const splits = page.locator('[data-actor-kind="panel"]')
    await expect.poll(() => splits.count()).toBe(2)
    const left = splits.nth(0)
    const right = splits.nth(1)
    await right.locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
    expect(await splits.getByRole('textbox').count()).toBe(2)
    expect(await right.locator('.dsh-kitty-input').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(42)
    expect(await right.locator('.dsh-kitty-compose').evaluate(element => element.getBoundingClientRect().height)).toBeLessThanOrEqual(50)
    expect(await newline.isChecked()).toBe(true)
    expect(await draft.inputValue()).toBe('')
    expect(await right.getByRole('img', { name: 'alpha.png', exact: true }).count()).toBe(0)
    expect(await left.getByRole('img', { name: 'alpha.png', exact: true }).count()).toBe(1)
    await draft.fill('Replace this draft')
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).click()
    await right.locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    expect(await left.locator('.dsh-kitty-pane-title').textContent()).toBe('#1 · Alpha terminal')
    expect(await left.locator('.dsh-kitty-screen').textContent()).toContain('ALPHA_SCREEN_READY')
    expect(await draft.inputValue()).toBe('')
    await draft.fill('Keep Beta draft')
    const betaInput = await draft.elementHandle()
    await left.locator('.dsh-kitty-pane-title').click()
    await expect.poll(() => page.getByRole('button', { name: '#1 · Alpha terminal', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await betaInput!.evaluate(element => element === document.querySelectorAll('.dsh-kitty-compose textarea')[1])).toBe(true)
    expect(await right.getByRole('textbox').inputValue()).toBe('Keep Beta draft')
    expect(await draft.inputValue()).toBe('Keep Alpha draft')
    expect(await newline.isChecked()).toBe(false)
    await page.getByRole('img', { name: 'alpha.png', exact: true }).waitFor()
    await page.getByRole('button', { name: '#3 · Gamma terminal', exact: true }).click()
    await left.locator('.dsh-kitty-screen').filter({ hasText: 'GAMMA_SCREEN_READY' }).waitFor()
    expect(await draft.inputValue()).toBe('')
    expect(await newline.isChecked()).toBe(false)
    expect(await right.locator('.dsh-kitty-pane-title').textContent()).toBe('#2 · Beta terminal')
    expect(await right.locator('.dsh-kitty-screen').textContent()).toContain('BETA_SCREEN_READY')
    await right.locator('.dsh-kitty-pane-title').click()
    expect(await draft.inputValue()).toBe('Keep Beta draft')
    expect(await newline.isChecked()).toBe(true)
    await right.getByRole('button', { name: 'Split down', exact: true }).click()
    await expect.poll(() => page.locator('.dsh-kitty-pane-title').allTextContents())
      .toEqual(['#3 · Gamma terminal', '#2 · Beta terminal', '#2 · Beta terminal'])
    expect(await splits.getByRole('textbox').count()).toBe(3)
    expect(await draft.inputValue()).toBe('')
    const last = splits.nth(2)
    const handleBounds = (await page.getByRole('button', { name: 'Browser', exact: true }).boundingBox())!
    const canvasBounds = (await page.locator('[data-pane-canvas]').boundingBox())!
    expect(canvasBounds.x + canvasBounds.width).toBeLessThanOrEqual(handleBounds.x - 4)
    const initialHeight = (await last.locator('.dsh-kitty-input').boundingBox())!.height
    await draft.fill('First line\nSecond line\nThird line')
    expect((await last.locator('.dsh-kitty-input').boundingBox())!.height).toBeGreaterThan(initialHeight + 20)
    await draft.fill('')
    await expect.poll(async () => (await last.locator('.dsh-kitty-input').boundingBox())!.height).toBe(initialHeight)
    for (const pane of await splits.all()) {
      const paneBounds = (await pane.boundingBox())!
      const composerBounds = (await pane.locator('.dsh-kitty-compose').boundingBox())!
      expect(composerBounds.y).toBeGreaterThan(paneBounds.y + 34)
      expect(composerBounds.y + composerBounds.height).toBeLessThanOrEqual(paneBounds.y + paneBounds.height + 1)
      expect(composerBounds.width).toBeLessThanOrEqual(paneBounds.width)
    }
    await compareOrRefreshGolden(join(EXPECTED, 'desktop-split-terminals.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'desktop-split-terminals.png') })
    await splits.nth(2).getByRole('button', { name: 'Close pane', exact: true }).click()
    await right.locator('.dsh-kitty-pane-title').click()
    expect(await draft.inputValue()).toBe('Keep Beta draft')
    await right.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => draft.inputValue()).toBe('')
    await left.locator('.dsh-kitty-pane-title').click()
    await draft.fill('Gamma without Enter')
    await draft.press('Control+Enter')
    await expect.poll(() => draft.inputValue()).toBe('')
    expect(composerInputs).toEqual([
      { token: 'beta-token', action: 'text', text: 'Keep Beta draft', submit: true },
      { token: 'gamma-token', action: 'text', text: 'Gamma without Enter', submit: false },
    ])
  })

  it('settles a pending send in its original split while another pane edits its draft', async () => {
    allowComposer = true
    composerBarrier = new Promise<void>((resolve) => { releaseComposer = resolve })
    await openWindows()
    await showScreen('Alpha')
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Send Alpha once')
    const image = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII='
    await page.locator('.dsh-kitty-compose').evaluate((element, data) => {
      const transfer = new DataTransfer()
      transfer.items.add(new File([Uint8Array.from(atob(data), char => char.charCodeAt(0))], 'sent.png', { type: 'image/png' }))
      element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
    }, image)
    await page.getByRole('img', { name: 'sent.png', exact: true }).waitFor()
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => composerInputs.length).toBe(1)
    await page.getByRole('button', { name: 'Split right', exact: true }).click()
    const splits = page.locator('[data-actor-kind="panel"]')
    await expect.poll(() => splits.count()).toBe(2)
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).click()
    await draft.fill('Keep Beta while Alpha sends')
    expect(await draft.isEnabled()).toBe(true)
    const receipt = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dsh/kitty')
    releaseComposer?.()
    await (await receipt).finished()
    await splits.nth(0).locator('.dsh-kitty-pane-title').click()
    await expect.poll(() => draft.inputValue()).toBe('')
    expect(await draft.isEnabled()).toBe(true)
    await splits.nth(1).locator('.dsh-kitty-pane-title').click()
    expect(await draft.inputValue()).toBe('Keep Beta while Alpha sends')
    expect(composerInputs).toEqual([{ token: 'alpha-token', action: 'text', text: 'Send Alpha once', submit: true, image: { mime: 'image/png', data: image } }])
  })

  it.each([false, true])('preserves a replacement draft when an older send completes with stale=%s', async (stale) => {
    allowComposer = true
    composerStale = stale
    composerBarrier = new Promise<void>((resolve) => { releaseComposer = resolve })
    await openWindows()
    await showScreen('Alpha')
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Old Alpha submission')
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect.poll(() => composerInputs.length).toBe(1)
    await showScreen('Beta')
    await showScreen('Alpha')
    await draft.fill('New Alpha draft')
    const receipt = page.waitForResponse(response => response.request().method() === 'POST' && new URL(response.url()).pathname === '/api/dsh/kitty')
    releaseComposer?.()
    await (await receipt).finished()
    await page.getByRole('button', { name: 'Terminal keys', exact: true }).click()
    expect(await draft.inputValue()).toBe('New Alpha draft')
    expect(await draft.isEnabled()).toBe(true)
    expect(composerInputs).toEqual([{ token: 'alpha-token', action: 'text', text: 'Old Alpha submission', submit: true }])
  })

  it('clears a stale background Kitty pane without changing the focused terminal or its draft', async () => {
    await openWindows()
    await showScreen('Alpha')
    await page.getByRole('button', { name: 'Split right', exact: true }).click()
    const splits = page.locator('[data-actor-kind="panel"]')
    await expect.poll(() => splits.count()).toBe(2)
    const left = splits.nth(0)
    const right = splits.nth(1)
    await left.locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).click()
    await right.locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Keep the focused terminal draft')
    staleToken = 'alpha-token'
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await left.getByRole('heading', { name: 'Select a Kitty window', exact: true }).waitFor()
    expect(await right.locator('.dsh-kitty-screen').textContent()).toContain('BETA_SCREEN_READY')
    expect(await draft.inputValue()).toBe('Keep the focused terminal draft')
    expect(await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await right.getAttribute('data-active')).toBe('true')
  })

  it('keeps separator and sparkle rows to one line as the viewport and animation change', async () => {
    const rule = '─'.repeat(180)
    const body = 'Ordinary terminal text still wraps. '.repeat(6)
    const screen = (stars: string) => `\n\x1b[90m${rule}\x1b[0m\n\x1b[31mAFTER_RULE\x1b[0m\n${stars}\n\x1b[32mAFTER_STARS\x1b[0m\n\x1b[34m${body}\x1b[0m`
    screenExtra = screen('    ⠈              ⢀    ⠐⠂    ⠄   '.repeat(6))
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    await showScreen('Alpha')
    const output = page.locator('.dsh-kitty-screen')
    const decorations = output.locator('.dsh-kitty-decoration')
    await expect.poll(() => decorations.count()).toBe(2)
    const geometry = async () => output.evaluate((element) => {
      const lineHeight = parseFloat(getComputedStyle(element).lineHeight)
      const rows = [...element.querySelectorAll<HTMLElement>('.dsh-kitty-decoration')]
      const after = [...element.querySelectorAll('span')].find(span => span.textContent === 'AFTER_STARS')!
      return {
        lineHeight, heights: rows.map(row => row.getBoundingClientRect().height),
        clipped: rows.every(row => row.scrollWidth > row.clientWidth),
        followingOffset: after.getBoundingClientRect().top - rows[1]!.getBoundingClientRect().top,
        overflow: element.scrollWidth > element.clientWidth,
      }
    })
    const before = await geometry()
    expect(before.clipped).toBe(true)
    expect(before.overflow).toBe(false)
    for (const height of before.heights) expect(height).toBeCloseTo(before.lineHeight, 0)
    expect(before.followingOffset).toBeLessThan(before.lineHeight * 2)
    const ordinary = output.locator('span').filter({ hasText: body }).last()
    expect((await ordinary.boundingBox())!.height).toBeGreaterThan(before.lineHeight * 3)
    screenExtra = screen(' ⡀ ⠂                      ⠠ ⠠       ⠈'.repeat(10))
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await expect.poll(() => decorations.nth(1).textContent()).toBe(' ⡀ ⠂                      ⠠ ⠠       ⠈'.repeat(10))
    const after = await geometry()
    expect(after.heights).toEqual(before.heights)
    expect(after.followingOffset).toBeCloseTo(before.followingOffset, 0)
    await page.setViewportSize({ width: 320, height: 844 })
    await expect.poll(() => page.locator('[class*="centerCol"]').evaluate(element => element.getBoundingClientRect().width)).toBe(320)
    const narrow = await geometry()
    expect(narrow.heights).toEqual(before.heights)
    expect(narrow.overflow).toBe(false)
    await compareOrRefreshGolden(join(EXPECTED, 'mobile-decoration-lines.expected.md'),
      await captureStableAria(page, '.dsh-kitty-output', scaffold.workspaceCwd), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-decoration-lines.png') })
  })

  it('scrolls locally before forwarding edge wheel gestures and returns to Kitty live output', async () => {
    allowScroll = true
    screenExtra = '\n' + Array.from({ length: 100 }, (_, index) => `Terminal line ${index + 1}`).join('\n')
    await openWindows()
    await showScreen('Alpha')
    const output = page.locator('.dsh-kitty-screen')
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Keep the draft while browsing history')
    await output.evaluate((element) => { element.scrollTop = 200 })
    await output.hover()
    await page.mouse.wheel(0, -80)
    await expect.poll(() => output.evaluate(element => element.scrollTop)).toBeLessThan(200)
    expect(scrollAmounts).toEqual([])
    const cancelled = await output.evaluate((element) => {
      element.scrollTop = 0
      const zoom = new WheelEvent('wheel', { deltaY: -40, ctrlKey: true, cancelable: true })
      element.dispatchEvent(zoom)
      const horizontal = new WheelEvent('wheel', { deltaX: -100, deltaY: -1, cancelable: true })
      element.dispatchEvent(horizontal)
      const upward = new WheelEvent('wheel', { deltaY: -120, cancelable: true })
      element.dispatchEvent(upward)
      return [zoom.defaultPrevented, horizontal.defaultPrevented, upward.defaultPrevented]
    })
    expect(cancelled).toEqual([false, false, true])
    await output.filter({ hasText: 'REMOTE_OFFSET_-3' }).waitFor()
    expect(scrollAmounts).toEqual([-3])
    expect(await output.evaluate(element => element.scrollTop)).toBe(0)
    expect(await draft.inputValue()).toBe('Keep the draft while browsing history')
    await output.evaluate((element) => {
      element.scrollTop = element.scrollHeight
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: 2, deltaMode: WheelEvent.DOM_DELTA_LINE, cancelable: true }))
    })
    await output.filter({ hasText: 'REMOTE_OFFSET_-1' }).waitFor()
    await output.evaluate((element) => {
      element.scrollTop = 0
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1000, deltaMode: WheelEvent.DOM_DELTA_LINE, cancelable: true }))
    })
    await output.filter({ hasText: 'REMOTE_OFFSET_-9' }).waitFor()
    expect(scrollAmounts).toEqual([-3, 2, -SCROLL_OPTIONS.maxLines])
    await page.getByRole('button', { name: 'Latest output ↓', exact: true }).click()
    await output.filter({ hasText: 'REMOTE_OFFSET_0' }).waitFor()
    await expect.poll(() => output.evaluate(element => Math.abs(element.scrollHeight - element.clientHeight - element.scrollTop)))
      .toBeLessThan(2)
    expect(scrollAmounts).toEqual([-3, 2, -SCROLL_OPTIONS.maxLines, 'end'])
    expect(await draft.inputValue()).toBe('Keep the draft while browsing history')
  })

  it('forwards mobile edge swipes and leaves the Include scrollback view entirely local', async () => {
    allowScroll = true
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    await showScreen('Alpha')
    const output = page.locator('.dsh-kitty-screen')
    const cdp = await page.context().newCDPSession(page)
    try {
      const start = await output.locator('span').filter({ hasText: 'Ready' }).first().boundingBox()
      const x = start!.x + start!.width / 2
      const y = start!.y + start!.height / 2
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 100 }] })
      await output.filter({ hasText: 'REMOTE_OFFSET_-5' }).waitFor()
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y + 200 }] })
      await output.filter({ hasText: 'REMOTE_OFFSET_-10' }).waitFor()
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally { await cdp.detach() }
    expect(scrollAmounts).toEqual([-5, -5])
    await compareOrRefreshGolden(join(EXPECTED, 'mobile-scrolled-terminal.expected.md'),
      await captureStableAria(page, '.dsh-kitty-output', scaffold.workspaceCwd), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-scrolled-terminal.png') })
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
    await page.getByRole('button', { name: 'Include scrollback', exact: true }).click()
    await showScreen('Alpha')
    expect(await output.evaluate((element) => {
      element.scrollTop = 0
      const event = new WheelEvent('wheel', { deltaY: -200, cancelable: true })
      element.dispatchEvent(event)
      return event.defaultPrevented
    })).toBe(false)
    await page.getByRole('button', { name: 'Latest output ↓', exact: true }).click()
    await expect.poll(() => page.getByRole('button', { name: 'Latest output ↓', exact: true }).isVisible()).toBe(false)
    expect(scrollAmounts).toEqual([-5, -5])
  })

  it('cancels an older screen poll before displaying a scrolled viewport', async () => {
    allowScroll = true
    await openWindows()
    await showScreen('Alpha')
    const output = page.locator('.dsh-kitty-screen')
    let enter!: () => void
    let release!: () => void
    const entered = new Promise<void>((resolve) => { enter = resolve })
    const barrier = new Promise<void>((resolve) => { release = resolve })
    let pending: Promise<void> | undefined
    const isScreen = (url: URL) => url.pathname === '/api/dsh/kitty' && url.searchParams.get('token') === 'alpha-token'
    await page.route(isScreen, (route) => {
      pending = (async () => {
        enter()
        await barrier
        await route.fulfill({ json: { text: 'STALE_POLL_MUST_NOT_REPLACE_VIEWPORT' } })
      })()
      return pending
    })
    try {
      await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
      await entered
      const aborted = page.waitForEvent('requestfailed', request => isScreen(new URL(request.url())))
      await output.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, deltaMode: 1, cancelable: true })))
      await aborted
      await output.filter({ hasText: 'REMOTE_OFFSET_-1' }).waitFor()
      release()
      await pending
      expect(await output.textContent()).not.toContain('STALE_POLL_MUST_NOT_REPLACE_VIEWPORT')
      expect(scrollAmounts).toEqual([-1])
    } finally {
      release()
      await pending
    }
  })

  it('coalesces gestures during a scroll and ignores its late response after switching windows', async () => {
    allowScroll = true
    await openWindows()
    await showScreen('Alpha')
    scrollBarrier = new Promise<void>((resolve) => { releaseScroll = resolve })
    const output = page.locator('.dsh-kitty-screen')
    await output.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, deltaMode: 1, cancelable: true })))
    await expect.poll(() => scrollAmounts).toEqual([-2])
    await output.evaluate((element) => {
      for (let index = 0; index < 3; index++) element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, deltaMode: 1, cancelable: true }))
    })
    scrollBarrier = undefined
    releaseScroll!()
    await output.filter({ hasText: 'REMOTE_OFFSET_-5' }).waitFor()
    expect(scrollAmounts).toEqual([-2, -3])
    scrollBarrier = new Promise<void>((resolve) => { releaseScroll = resolve })
    await output.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, deltaMode: 1, cancelable: true })))
    await expect.poll(() => scrollAmounts).toEqual([-2, -3, -1])
    await showScreen('Beta')
    releaseScroll!()
    await Promise.all([...pendingScrollResponses])
    await Promise.all([...pendingComposerResponses])
    expect(await output.textContent()).toContain('BETA_SCREEN_READY')
    expect(await output.textContent()).not.toContain('REMOTE_OFFSET')
    scrollBarrier = undefined
    await showScreen('Alpha')
    await output.evaluate((element) => {
      element.dispatchEvent(new WheelEvent('wheel', { deltaY: -7, deltaMode: 1, cancelable: true }))
      document.querySelector<HTMLButtonElement>('button[aria-label="#2 · Beta terminal"]')!.click()
    })
    await output.filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    await showScreen('Alpha')
    await output.evaluate(element => element.dispatchEvent(new WheelEvent('wheel', { deltaY: -1, deltaMode: 1, cancelable: true })))
    await expect.poll(() => scrollAmounts).toEqual([-2, -3, -1, -1])
    await output.filter({ hasText: 'REMOTE_OFFSET_-7' }).waitFor()
  })

  it('returns stale terminals to the window list and refreshes empty and failed lists', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    staleToken = 'alpha-token'
    await page.getByRole('button', { name: '#1 · Alpha terminal', exact: true }).click()
    await page.getByText('The selected pane or foreground process changed. Select it again.', { exact: true }).waitFor()
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).waitFor()
    await expect.poll(() => page.locator('.dsh-kitty-screen').isVisible()).toBe(false)
    panes = []
    await page.getByRole('button', { name: 'Refresh panes', exact: true }).click()
    await page.getByText('No Kitty panes found', { exact: true }).waitFor()
    await snapshot('empty-windows')
    listError = true
    await page.getByRole('button', { name: 'Refresh panes', exact: true }).click()
    await page.getByText('Unable to load Kitty windows. Refresh to try again.', { exact: true }).waitFor()
    listError = false
    panes = PANES
    await page.getByRole('button', { name: 'Refresh panes', exact: true }).click()
    await showScreen('Beta')
  })

  it('creates windows from the mobile chooser in the previously selected terminal directory', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    expect(await page.getByRole('button', { name: 'New window', exact: true }).isDisabled()).toBe(true)
    await showScreen('Beta')
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    allowCreate = true
    await page.getByRole('button', { name: 'New window', exact: true }).click()
    await page.getByRole('button', { name: '#3 · Gamma terminal', exact: true }).waitFor()
    await expect.poll(() => page.locator('.dsh-kitty-screen').isVisible()).toBe(false)
    expect(await page.getByRole('status').textContent()).toContain('#3')
    await snapshot('created-windows')
    await page.getByRole('button', { name: '#3 · Gamma terminal', exact: true }).click()
    await page.locator('.dsh-kitty-screen').filter({ hasText: 'GAMMA_SCREEN_READY' }).waitFor()
  })

  it('applies display options from the mobile chooser across window selections', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    await page.getByRole('button', { name: 'Terminal options', exact: true }).click()
    await page.getByRole('button', { name: 'Include scrollback', exact: true }).click()
    await page.getByRole('button', { name: 'Original line width', exact: true }).click()
    await page.getByRole('button', { name: 'Follow output', exact: true }).click()
    await snapshot('mobile-options')
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-options.png') })
    const allScreen = page.waitForRequest((request) => {
      const url = new URL(request.url())
      return url.pathname === '/api/dsh/kitty' && url.searchParams.get('token') === 'alpha-token' && url.searchParams.get('extent') === 'all'
    })
    await showScreen('Alpha')
    await allScreen
    expect(await page.locator('.dsh-kitty-screen.is-wide').isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: 'Latest output ↓', exact: true }).isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Back to Kitty windows', exact: true }).click()
    expect(await page.getByRole('button', { name: 'Include scrollback', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('button', { name: 'Original line width', exact: true }).getAttribute('aria-pressed')).toBe('true')
    expect(await page.getByRole('button', { name: 'Follow output', exact: true }).getAttribute('aria-pressed')).toBe('false')
    await showScreen('Beta')
    expect(await page.locator('.dsh-kitty-screen.is-wide').isVisible()).toBe(true)
    expect(await page.getByRole('button', { name: 'Latest output ↓', exact: true }).isVisible()).toBe(true)
  })

  it('loads configured external figures and posters without granting report navigation to their directory', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    const url = new URL('external-assets.html', reportUrl).href
    screenExtra = `\n${url}`
    await openWindows()
    await showScreen('Alpha')
    await page.locator('.dsh-kitty-screen').getByRole('link', { name: url, exact: true }).click()
    const report = page.frameLocator('.dsh-kitty-preview iframe')
    await report.getByRole('heading', { name: 'Report with separate assets', exact: true }).waitFor()
    await expect.poll(() => report.getByAltText('External figure').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(96)
    expect(await report.locator('video').getAttribute('poster')).toMatch(/^data:image\/svg\+xml;base64,/)
    await compareOrRefreshGolden(join(EXPECTED, 'report-external-assets.expected.md'),
      await captureStableAria(page, '.dsh-kitty-preview', scaffold.workspaceCwd, { replacements: [[url, '{{reportUrl}}']] }), MODE)
    await report.getByRole('link', { name: 'Outside report directory', exact: true }).click()
    await page.locator('.dsh-kitty-preview').getByRole('alert').filter({ hasText: 'This report requests files outside the allowed preview directories.' }).waitFor()
    expect(await report.getByRole('heading', { name: 'Report with separate assets', exact: true }).isVisible()).toBe(true)
    await compareOrRefreshGolden(join(EXPECTED, 'report-forbidden.expected.md'),
      await captureStableAria(page, '.dsh-kitty-preview-status', scaffold.workspaceCwd), MODE)
  })

  it('opens local reports in a resizable Browser with assets, interaction and scoped history', async () => {
    screenExtra = `\n${reportUrl}\n\u001b]8;;${reportUrl}\u0007Open local report\u001b]8;;\u0007`
    await openWindows()
    await showScreen('Alpha')
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Keep the terminal draft')
    await page.locator('.dsh-kitty-screen').getByRole('link', { name: 'Open local report', exact: true }).click()
    const drawer = page.locator('.dsh-kitty-preview')
    const report = page.frameLocator('.dsh-kitty-preview iframe')
    await report.getByText('Relative data loaded', { exact: true }).waitFor()
    await expect.poll(() => drawer.evaluate(element => Math.round(element.getBoundingClientRect().right))).toBe(1680)
    expect(await report.locator('h1').evaluate(element => getComputedStyle(element).color)).toBe('rgb(20, 60, 100)')
    expect(await report.getByAltText('Report image').evaluate(image => (image as HTMLImageElement).naturalWidth)).toBe(80)
    expect(await report.locator('body').getAttribute('data-isolated')).toBe('yes')
    expect(await page.locator('body').getAttribute('data-report-access')).toBe(null)
    expect(await drawer.locator('iframe').getAttribute('sandbox')).not.toContain('allow-same-origin')
    await report.getByRole('button', { name: 'Increment', exact: true }).click()
    expect(await report.locator('#count').textContent()).toBe('1')
    await compareOrRefreshGolden(join(EXPECTED, 'report-browser.expected.md'),
      await captureStableAria(page, '.dsh-kitty-preview', scaffold.workspaceCwd, { replacements: [[reportUrl, '{{reportUrl}}']] }), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'desktop-report.png') })
    const before = await drawer.boundingBox()
    const resize = await drawer.getByRole('separator', { name: 'Resize browser', exact: true }).boundingBox()
    await page.mouse.move(resize!.x + resize!.width / 2, resize!.y + 180)
    await page.mouse.down()
    await page.mouse.move(resize!.x - 100, resize!.y + 180, { steps: 4 })
    await page.mouse.up()
    expect((await drawer.boundingBox())!.width).toBeGreaterThan(before!.width + 90)
    await drawer.getByRole('button', { name: 'Pin browser', exact: true }).click()
    await draft.click({ position: { x: 20, y: 20 } })
    expect(await drawer.getAttribute('aria-hidden')).toBe('false')
    await report.getByRole('link', { name: 'Next report', exact: true }).click()
    await report.getByRole('heading', { name: 'Next report', exact: true }).waitFor()
    await drawer.getByRole('button', { name: 'Back', exact: true }).click()
    await report.getByText('Relative data loaded', { exact: true }).waitFor()
    await drawer.getByRole('button', { name: 'Forward', exact: true }).click()
    await report.getByRole('heading', { name: 'Next report', exact: true }).waitFor()
    await report.getByRole('button', { name: 'Return to report', exact: true }).click()
    await report.getByText('Relative data loaded', { exact: true }).waitFor()
    expect(await drawer.getByRole('textbox', { name: 'Report address', exact: true }).inputValue()).toBe(reportUrl + '?q=return')
    await report.getByRole('link', { name: 'Outside report directory', exact: true }).click()
    await drawer.getByRole('alert').waitFor()
    expect(await report.getByRole('heading', { name: 'Local report', exact: true }).isVisible()).toBe(true)
    expect(await drawer.textContent()).not.toContain('OUTSIDE_REPORT_SECRET')
    await drawer.getByRole('button', { name: 'Close browser', exact: true }).click()
    await expect.poll(() => drawer.getAttribute('aria-hidden')).toBe('true')
    expect(await draft.inputValue()).toBe('Keep the terminal draft')
    expect(await page.locator('.dsh-kitty-screen').isVisible()).toBe(true)
    await page.getByRole('button', { name: 'Browser', exact: true }).click()
    await report.getByText('Relative data loaded', { exact: true }).waitFor()
    await drawer.getByRole('button', { name: 'Close browser', exact: true }).click()
    await page.locator('.dsh-kitty-screen').getByRole('link', { name: reportUrl, exact: true }).click()
    await report.getByText('Relative data loaded', { exact: true }).waitFor()
    expect(await drawer.getByRole('button', { name: 'Forward', exact: true }).isDisabled()).toBe(true)
    await drawer.getByRole('button', { name: 'Back', exact: true }).click()
    await expect.poll(() => drawer.getAttribute('aria-hidden')).toBe('true')
  })

  it('returns from the mobile Browser to the terminal before windows and home, and swipes closed', async () => {
    await page.setViewportSize({ width: 390, height: 844 })
    screenExtra = `\n${reportUrl}`
    await openWindows()
    await showScreen('Alpha')
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Mobile draft')
    const handle = page.getByRole('button', { name: 'Browser', exact: true })
    expect(await handle.textContent()).toBe('BROWSER')
    expect(await handle.locator('span').evaluate(element => getComputedStyle(element).writingMode)).toBe('vertical-rl')
    const handleBounds = await handle.boundingBox()
    expect(handleBounds!.width).toBeLessThanOrEqual(44)
    expect(handleBounds!.height).toBeGreaterThan(100)
    expect(Math.round(handleBounds!.x + handleBounds!.width)).toBe(390)
    await compareOrRefreshGolden(join(EXPECTED, 'mobile-browser-handle.expected.md'),
      await captureStableAria(page, '.dsh-kitty-browser-handle', scaffold.workspaceCwd), MODE)
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-browser-handle.png') })
    await handle.click()
    await page.getByText('Open a terminal link or enter a report address.', { exact: true }).waitFor()
    await page.getByRole('textbox', { name: 'Report address', exact: true }).fill(new URL('missing.html', reportUrl).href)
    await page.getByRole('button', { name: 'Open', exact: true }).click()
    await page.locator('.dsh-kitty-preview').getByRole('alert').filter({ hasText: 'This report or resource was not found on the DSH host.' }).waitFor()
    expect(await page.getByText('Open a terminal link or enter a report address.', { exact: true }).isVisible()).toBe(false)
    await page.getByRole('button', { name: 'Close browser', exact: true }).click()
    await handle.waitFor()
    await page.locator('.dsh-kitty-screen').getByRole('link', { name: reportUrl, exact: true }).click()
    const drawer = page.locator('.dsh-kitty-preview')
    const report = page.frameLocator('.dsh-kitty-preview iframe')
    await report.getByText('Relative data loaded', { exact: true }).waitFor()
    await expect.poll(() => drawer.evaluate(element => Math.round(element.getBoundingClientRect().right))).toBe(390)
    expect(Math.round((await drawer.boundingBox())!.width)).toBe(390)
    await report.getByRole('link', { name: 'Report heading', exact: true }).click()
    if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mobile-report.png') })
    await page.goBack()
    await expect.poll(() => drawer.getAttribute('aria-hidden')).toBe('true')
    expect(await page.locator('.dsh-kitty-screen').isVisible()).toBe(true)
    expect(await draft.inputValue()).toBe('Mobile draft')
    await page.goForward()
    await report.getByText('Relative data loaded', { exact: true }).waitFor()
    const title = drawer.locator('.dsh-kitty-preview-title')
    const bounds = await title.boundingBox()
    const cdp = await page.context().newCDPSession(page)
    try {
      await cdp.send('Emulation.setTouchEmulationEnabled', { enabled: true })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: bounds!.x + 20, y: bounds!.y + 20 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: bounds!.x + 160, y: bounds!.y + 20 }] })
      await cdp.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally { await cdp.detach() }
    await expect.poll(() => drawer.getAttribute('aria-hidden')).toBe('true')
    expect(await draft.inputValue()).toBe('Mobile draft')
    await page.goBack()
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).waitFor()
    await expect.poll(() => page.locator('.dsh-kitty-screen').isVisible()).toBe(false)
    await page.goBack()
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).waitFor()
  })

  it('restores each Kitty split with fresh tokens and retains the complete layout on mobile', async () => {
    await openWindows()
    await showScreen('Alpha')
    await page.getByRole('button', { name: 'Split right', exact: true }).click()
    const splits = page.locator('[data-actor-kind="panel"]')
    await expect.poll(() => splits.count()).toBe(2)
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).click()
    await splits.nth(1).locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    const draft = page.locator('[data-actor-kind="panel"][data-active]').getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
    await draft.fill('Unsent input stays transient')
    await splits.nth(1).getByRole('checkbox', { name: 'Append newline', exact: true }).uncheck()
    const saved = await page.evaluate(() => ({
      layout: JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout,
      kitty: JSON.parse(localStorage.getItem('dsh.kitty.windows.v1')!) as unknown,
    }))
    const paneIds = await splits.evaluateAll(nodes => nodes.map(node => node.getAttribute('data-actor-pane')!))
    expect(saved.kitty).toEqual({ version: 1, windows: {
      [paneIds[0]!]: PANES[0]!.windowId,
      [paneIds[1]!]: PANES[1]!.windowId,
    } })
    panes = PANES.map(pane => ({ ...pane, token: `${pane.token}-restarted`, instance: 'restarted-instance', title: `${pane.title} renamed`, cwd: '/new/cwd', pid: pane.pid + 100 }))
    catalogBarrier = new Promise<void>((resolve) => { releaseCatalog = resolve })
    await page.reload({ waitUntil: 'domcontentloaded' })
    await expect.poll(() => page.getByRole('heading', { name: 'Reconnecting to the saved Kitty window…', exact: true }).count()).toBe(2)
    const restoredReads = screenTokens.length
    catalogBarrier = undefined
    releaseCatalog?.()
    await splits.nth(0).locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
    await splits.nth(1).locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    expect(screenTokens.slice(restoredReads).sort()).toEqual(['alpha-token-restarted', 'beta-token-restarted'])
    expect(await page.locator('.dsh-kitty-pane-title').allTextContents()).toEqual(['#1 · Alpha terminal renamed', '#2 · Beta terminal renamed'])
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout)).toEqual(saved.layout)
    expect(await draft.inputValue()).toBe('')
    expect(await splits.nth(1).getByRole('checkbox', { name: 'Append newline', exact: true }).isChecked()).toBe(true)
    expect(await page.locator('.dsh-kitty-compose').count()).toBe(2)
    await compareOrRefreshGolden(join(EXPECTED, 'restored-kitty-splits.expected.md'),
      await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
    await page.setViewportSize({ width: 390, height: 844 })
    await expect.poll(() => splits.count()).toBe(1)
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout)).toEqual(saved.layout)
    await page.setViewportSize({ width: 1680, height: 1000 })
    await splits.nth(0).locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
    await splits.nth(1).locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
  })

  it('keeps a missing Kitty split empty even when another window reuses its number and title', async () => {
    await openWindows()
    await showScreen('Alpha')
    await page.getByRole('button', { name: 'Split right', exact: true }).click()
    const splits = page.locator('[data-actor-kind="panel"]')
    await expect.poll(() => splits.count()).toBe(2)
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).click()
    await splits.nth(1).locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    panes = [PANES[0]!, { ...PANES[1]!, windowId: 'd'.repeat(64), token: 'replacement-token' }]
    screenTokens = []
    await page.reload({ waitUntil: 'domcontentloaded' })
    await splits.nth(0).locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
    await splits.nth(1).getByText('The saved Kitty window is no longer available. Choose another window.', { exact: true }).waitFor()
    expect(screenTokens).toEqual(['alpha-token'])
    expect(await splits.nth(1).locator('.dsh-kitty-compose').count()).toBe(0)
    expect(await splits.nth(0).locator('.dsh-kitty-compose').count()).toBe(1)
    await compareOrRefreshGolden(join(EXPECTED, 'missing-saved-window.expected.md'),
      await captureStableAria(page, '[data-actor-kind="panel"]:last-child', scaffold.workspaceCwd), MODE)
    await splits.nth(1).getByRole('button', { name: 'Kitty windows', exact: true }).click()
    await page.getByRole('button', { name: '#2 · Beta terminal', exact: true }).click()
    await splits.nth(1).locator('.dsh-kitty-screen').filter({ hasText: 'BETA_SCREEN_READY' }).waitFor()
    expect(screenTokens).toContain('replacement-token')
  })

  it('retains saved Kitty bindings after a failed catalog read and restores them on retry', async () => {
    await openWindows()
    await showScreen('Alpha')
    const saved = await page.evaluate(() => localStorage.getItem('dsh.kitty.windows.v1'))
    listError = true
    screenTokens = []
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.locator('.dsh-kitty-empty').getByRole('alert').waitFor()
    expect(screenTokens).toEqual([])
    expect(await page.evaluate(() => localStorage.getItem('dsh.kitty.windows.v1'))).toBe(saved)
    listError = false
    await page.locator('.dsh-kitty-empty').getByRole('button', { name: 'Refresh panes', exact: true }).click()
    await page.locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
    expect(screenTokens).toEqual(['alpha-token'])
  })

  it.each([
    { version: 2, windows: { pane: 'a'.repeat(64) } },
    { version: 1, windows: { pane: 'alpha-token' } },
  ])('rejects malformed saved Kitty bindings: $version / $windows.pane', async (persisted) => {
    await openWindows()
    await showScreen('Alpha')
    const diagnostics: string[] = []
    page.on('console', (message) => {
      if (message.text().includes("snapshot store 'dsh.kitty.windows.v1' rehydration failed")) diagnostics.push(message.text())
    })
    await page.evaluate((value) => { localStorage.setItem('dsh.kitty.windows.v1', JSON.stringify(value)) }, persisted)
    screenTokens = []
    await page.reload({ waitUntil: 'domcontentloaded' })
    await page.getByRole('heading', { name: 'Select a Kitty window', exact: true }).waitFor()
    expect(diagnostics).toHaveLength(1)
    expect(screenTokens).toEqual([])
    await page.locator('.dsh-kitty-empty').getByRole('button', { name: 'Kitty windows', exact: true }).click()
    await showScreen('Alpha')
  })

  it('restores mixed Agent Sessions and Kitty without the first Session baseline replacing the focused pane', async () => {
    const raw = await readFile(new URL('../../../snapshots/web/navigation-panes/session.v2.jsonl', import.meta.url), 'utf8')
    const sessionIds: string[] = []
    for (const letter of ['A', 'B']) {
      sessionIds.push(await seedSession(scaffold, raw.replaceAll('FIRST_DONE', `AGENT_${letter}_OK`)
        .replaceAll('"FIR","ST","_D","ONE"', `"AGE","NT","_${letter}","_OK"`)
        .replaceAll('NavScenario: first run bash to', `Restore Agent ${letter}`), `kitty-restore-agent-${letter.toLowerCase()}`))
    }
    await openWindows()
    await showScreen('Alpha')
    const saved = await page.evaluate(([firstSession, secondSession]) => {
      const layout = JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout
      if (layout.paneRoot === null) throw new Error('Expected a saved Kitty pane')
      layout.paneRoot = { kind: 'split', id: 'mixed-root', direction: 'horizontal', ratio: 0.5,
        first: { kind: 'leaf', id: 'agent-a', actor: { kind: 'agent', id: firstSession! } },
        second: { kind: 'split', id: 'mixed-right', direction: 'vertical', ratio: 0.5,
          first: { kind: 'leaf', id: 'agent-b', actor: { kind: 'agent', id: secondSession! } }, second: layout.paneRoot },
      }
      localStorage.setItem('dsh.layout.panes.v1', JSON.stringify(layout))
      return layout
    }, sessionIds)
    let releaseBaseline: (() => void) | undefined
    const baselineBarrier = new Promise<void>((resolve) => { releaseBaseline = resolve })
    const pending = new Set<Promise<void>>()
    let baselineRead = false
    await page.route(url => url.pathname === '/api/session/list', async (route) => {
      const response = (async () => {
        baselineRead = true
        await baselineBarrier
        await route.continue()
      })()
      pending.add(response)
      try { await response } finally { pending.delete(response) }
    })
    try {
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
      expect(baselineRead).toBe(true)
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout)).toEqual(saved)
      releaseBaseline?.()
      await page.locator('[data-actor-pane="agent-a"]').getByText('AGENT_A_OK', { exact: true }).waitFor()
      await page.locator('[data-actor-pane="agent-b"]').getByText('AGENT_B_OK', { exact: true }).waitFor()
      expect(await page.locator('.dsh-kitty-screen').textContent()).toContain('ALPHA_SCREEN_READY')
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout)).toEqual(saved)
      await compareOrRefreshGolden(join(EXPECTED, 'restored-agent-and-kitty-splits.expected.md'),
        await captureStableAria(page, '[class*="centerCol"]', scaffold.workspaceCwd), MODE)
      await page.locator('[data-actor-pane="agent-b"]').getByText('AGENT_B_OK', { exact: true }).click()
      await expect.poll(() => page.evaluate(() => (JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout).activePaneId)).toBe('agent-b')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await page.locator('[data-actor-pane="agent-a"]').getByText('AGENT_A_OK', { exact: true }).waitFor()
      await page.locator('[data-actor-pane="agent-b"]').getByText('AGENT_B_OK', { exact: true }).waitFor()
      await page.locator('.dsh-kitty-screen').filter({ hasText: 'ALPHA_SCREEN_READY' }).waitFor()
      expect(await page.evaluate(() => JSON.parse(localStorage.getItem('dsh.layout.panes.v1')!) as SavedLayout)).toEqual({ ...saved, activePaneId: 'agent-b' })
      const agentA = page.locator('[data-actor-pane="agent-a"]')
      const agentB = page.locator('[data-actor-pane="agent-b"]')
      const kitty = page.locator('[data-actor-kind="panel"]')
      for (const pane of [agentA, agentB]) {
        expect((await pane.locator('[data-composer-card]').boundingBox())!.height).toBeLessThanOrEqual(42)
        expect(await pane.getByRole('button', { name: 'More options', exact: true }).getAttribute('aria-expanded')).toBe('false')
      }
      expect((await kitty.locator('.dsh-kitty-input').boundingBox())!.height).toBeLessThanOrEqual(42)
      await agentA.locator('[data-composer-input]').click()
      await agentA.locator('[data-composer-input]').fill('Agent A draft')
      await agentB.locator('[data-composer-input]').click()
      await agentB.locator('[data-composer-input]').fill('Agent B draft')
      await kitty.getByRole('textbox').fill('Kitty draft')
      expect(await agentA.locator('[data-composer-input]').textContent()).toBe('Agent A draft')
      expect(await agentB.locator('[data-composer-input]').textContent()).toBe('Agent B draft')
      await agentA.locator('[data-composer-input]').click()
      await agentA.locator('[data-composer-input]').fill('First line\nSecond line\nThird line')
      expect((await agentA.locator('[data-composer-card]').boundingBox())!.height).toBeGreaterThan(60)
      await agentA.locator('[data-composer-input]').fill('Agent A draft')
      await expect.poll(async () => (await agentA.locator('[data-composer-card]').boundingBox())!.height).toBeLessThanOrEqual(42)
      await agentA.getByRole('button', { name: 'More options', exact: true }).click()
      expect(await agentA.getByRole('button', { name: 'More options', exact: true }).getAttribute('aria-expanded')).toBe('true')
      await agentA.getByRole('button', { name: 'More options', exact: true }).click()
      if (MODE === 'refresh') await page.screenshot({ path: join(ARTIFACTS, 'mixed-compact-inputs.png') })
      await agentB.locator('[data-composer-input]').click()
      await agentA.locator('[data-composer-card]').evaluate((element) => {
        const transfer = new DataTransfer()
        transfer.items.add(new File([Uint8Array.from(atob('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aA1sAAAAASUVORK5CYII='), char => char.charCodeAt(0))], 'agent-only.png', { type: 'image/png' }))
        element.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: transfer }))
      })
      await agentA.getByRole('img', { name: 'agent-only.png', exact: true }).waitFor()
      expect(await agentB.getByRole('img', { name: 'agent-only.png', exact: true }).count()).toBe(0)
      expect(await kitty.getByRole('img', { name: 'agent-only.png', exact: true }).count()).toBe(0)
      await agentA.getByRole('button', { name: 'Split down', exact: true }).click()
      const duplicate = page.locator('[data-actor-kind="agent"][data-active]')
      const duplicateId = await duplicate.getAttribute('data-actor-pane')
      expect(duplicateId).not.toBe('agent-a')
      await duplicate.locator('[data-composer-input]').fill('Shared Session draft')
      await expect.poll(() => agentA.locator('[data-composer-input]').textContent()).toBe('Shared Session draft')
      await agentA.locator('[data-composer-input]').focus()
      await agentA.locator('[data-composer-input]').fill('Draft after focus transfer')
      const other = page.locator(`[data-actor-pane="${duplicateId}"]`)
      await expect.poll(() => other.locator('[data-composer-input]').textContent()).toBe('Draft after focus transfer')
      await other.getByRole('button', { name: 'Close pane', exact: true }).click()
      await agentA.locator('[data-composer-input]').click()
      await agentA.locator('[data-composer-input]').fill('Draft after closing duplicate')
      await agentB.locator('[data-composer-input]').click()
      expect(await agentB.locator('[data-composer-input]').textContent()).toBe('Agent B draft')
      await page.reload({ waitUntil: 'domcontentloaded' })
      await expect.poll(() => agentA.locator('[data-composer-input]').textContent()).toBe('Draft after closing duplicate')
      await expect.poll(() => agentB.locator('[data-composer-input]').textContent()).toBe('Agent B draft')
    } finally {
      releaseBaseline?.()
      await Promise.all(pending)
    }
  })

})
