/** Real Loader/browser Kitty navigation with only terminal HTTP responses replaced. */
import { copyFile, mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
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
    scaffold = await launchWebScaffold({
      extraOverlayPath: join(KITTY_ROOT, 'cordis.patch.yml'),
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
    page = await newEnglishPage(browser)
    tripwire = watchConsole(page)
    page.setDefaultTimeout(15_000)
    await page.route(url => url.pathname === '/api/dsh/kitty', async (route) => {
      const request = route.request()
      if (request.method() !== 'GET') {
        mutations.push(request.method())
        const input = request.postDataJSON() as { token?: string; action?: string }
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
          : { json: { text: `${marker}\n${SCREEN_SAMPLE}` } })
        return
      }
      await route.fulfill(listError
        ? { status: 500, json: { error: 'kitty_operation_failed' } }
        : { json: { panes, pollIntervalMs: 60_000, maxImageBytes: 8 * 1024 * 1024 } })
    })
    await page.goto(scaffold.authenticatedUrl, { waitUntil: 'load' })
    await page.getByRole('button', { name: 'Kitty terminal', exact: true }).waitFor()
  })

  afterEach(async ({ task }) => {
    try {
      if (task.result?.state === 'fail' && page !== undefined && !page.isClosed()) {
        await mkdir(ARTIFACTS, { recursive: true })
        await page.screenshot({ path: join(ARTIFACTS, 'failure.png') })
        await writeFile(join(ARTIFACTS, 'failure-aria.md'), await page.locator('body').ariaSnapshot())
      }
      expect(tripwire).toEqual({ warnings: [], pageErrors: [] })
      expect(mutations).toEqual(allowCreate ? ['POST'] : [])
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

  it('replaces the desktop session list with windows and switches directly between terminals', async () => {
    await openWindows()
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

})
