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
  captureStableAria, compareOrRefreshGolden, launchWebScaffold,
  watchConsole, webSnapshotMode, type WebScaffold,
} from './scaffold.ts'
import { newEnglishPage } from './support.ts'

const MODE = webSnapshotMode()
const EXPECTED = fileURLToPath(new URL('./expected/kitty-navigation/', import.meta.url))
const ARTIFACTS = fileURLToPath(new URL('../../../tmp/kitty-navigation/', import.meta.url))
const KITTY_ROOT = fileURLToPath(new URL('../../../plugins/kitty/', import.meta.url))
const PANES = [
  { instance: 'fixture-kitty', token: 'alpha-token', id: 1, title: 'Alpha terminal', cwd: '/workspace/alpha', program: 'zsh', pid: 101 },
  { instance: 'fixture-kitty', token: 'beta-token', id: 2, title: 'Beta terminal', cwd: '/workspace/beta', program: 'python', pid: 102 },
]
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
    await writeFile(join(reportRoot, 'large.html'), `<h1>Large local report</h1><!--${'x'.repeat(17 * 1024 * 1024)}--><p>End of large report</p>`)
    await writeFile(join(reportRoot, 'oversized.html'), '')
    await truncate(join(reportRoot, 'oversized.html'), 64 * 1024 * 1024 + 1)
    await writeFile(join(fixtureRoot, 'private.txt'), 'OUTSIDE_REPORT_SECRET')
    const overlayPath = join(fixtureRoot, 'kitty.patch.yml')
    await writeFile(overlayPath, `${await readFile(join(KITTY_ROOT, 'cordis.patch.yml'), 'utf8')}\n- id: kitty-host\n  config:\n    socketDirectory: ${JSON.stringify(socketDirectory)}\n`)
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
    catalogReads = 0
    screenExtra = ''
    catalogBarrier = undefined
    releaseCatalog = undefined
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.setDefaultTimeout(15_000)
    await page.route(url => url.pathname === '/api/dsh/kitty', async (route) => {
      const request = route.request()
      if (request.method() !== 'GET') {
        mutations.push(request.method())
        const input = request.postDataJSON() as { token?: string; action?: string; key?: string }
        if (allowAltUp && request.method() === 'POST' && input.token === 'alpha-token' && input.action === 'key' && input.key === 'alt+up') {
          await route.fulfill({ json: { delivered: true } })
          return
        }
        if (allowCreate && request.method() === 'POST' && input.token === 'beta-token' && input.action === 'create') {
          panes = [...PANES, { instance: 'fixture-kitty', token: 'gamma-token', id: 3, title: 'Gamma terminal', cwd: '/workspace/beta', program: 'zsh', pid: 103 }]
          await route.fulfill({ json: { id: 3, instance: 'fixture-kitty' } })
          return
        }
        await route.fulfill({ status: 405, json: { error: 'method_not_allowed' } })
        return
      }
      const token = new URL(request.url()).searchParams.get('token')
      if (token !== null) {
        const marker = token === 'alpha-token' ? 'ALPHA_SCREEN_READY' : token === 'beta-token' ? 'BETA_SCREEN_READY' : 'GAMMA_SCREEN_READY'
        await route.fulfill(token === staleToken
          ? { status: 409, json: { error: 'stale_target' } }
          : { json: { text: `${marker}\n${SCREEN_SAMPLE}${screenExtra}` } })
        return
      }
      catalogReads += 1
      const response = (async () => {
        await catalogBarrier
        await route.fulfill(listError
          ? { status: 500, json: { error: 'kitty_operation_failed' } }
          : { json: { panes, pollIntervalMs: 60_000, maxImageBytes: 8 * 1024 * 1024 } })
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
    await Promise.all([...pendingCatalogResponses])
    try {
      if (task.result?.state === 'fail' && page !== undefined && !page.isClosed()) {
        await mkdir(ARTIFACTS, { recursive: true })
        await page.screenshot({ path: join(ARTIFACTS, 'failure.png') })
        await writeFile(join(ARTIFACTS, 'failure-aria.md'), await page.locator('body').ariaSnapshot())
      }
      expect(tripwire).toEqual({ warnings: [], pageErrors: [] })
      expect(mutations).toEqual(allowCreate || allowAltUp ? ['POST'] : [])
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
    const draft = page.getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
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

  it('keeps Alt+Up visible at the start of mobile keys and preserves the draft after dispatch', async () => {
    allowAltUp = true
    await page.setViewportSize({ width: 390, height: 844 })
    await openWindows()
    await showScreen('Alpha')
    const draft = page.getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
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

  it('opens local reports in a resizable Browser with assets, interaction and scoped history', async () => {
    screenExtra = `\n${reportUrl}\n\u001b]8;;${reportUrl}\u0007Open local report\u001b]8;;\u0007`
    await openWindows()
    await showScreen('Alpha')
    const draft = page.getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
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
    const draft = page.getByRole('textbox', { name: 'Text for the selected terminal', exact: true })
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

})
