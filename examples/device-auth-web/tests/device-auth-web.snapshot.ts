import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { request as httpRequest } from 'node:http'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import Include from '@deepseek-ai/cordis-plugin-include'
import Loader from '@deepseek-ai/cordis-plugin-loader'
import * as DeviceAuthDomain from '@deepseek-ai/dsh-device-auth-domain'
import * as DeviceAuthWeb from '@deepseek-ai/dsh-host-device-auth-web'
import * as WebServer from '@deepseek-ai/dsh-host-webserver'
import * as Storage from '@deepseek-ai/dsh-storage'
import * as StorageDomain from '@deepseek-ai/dsh-storage-domain'
import * as StorageJson from '@deepseek-ai/dsh-storage-json'
import type { Browser, Page } from 'playwright'
import { chromium } from 'playwright'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const leaf = dirname(dirname(fileURLToPath(import.meta.url)))
const expectedDir = join(leaf, 'tests', 'snapshots')

function request(port: number, path: string, accept: string): Promise<{ status: number; location?: string }> {
  return new Promise((resolve, reject) => {
    const req = httpRequest({ host: '127.0.0.1', port, path, headers: { accept, host: 'dsh.example' } }, (res) => {
      res.resume()
      res.once('end', () => {
        resolve({
          status: res.statusCode ?? 0,
          ...(res.headers.location === undefined ? {} : { location: res.headers.location }),
        })
      })
    })
    req.once('error', reject)
    req.end()
  })
}

describe('device auth web assembled browser snapshot', () => {
  let root = ''
  let ctx: Context
  let browser: Browser
  let page: Page
  let previousStorageRoot: string | undefined

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), 'dsh-device-auth-web-snapshot-'))
    previousStorageRoot = process.env.DSH_DEVICE_AUTH_SNAPSHOT_STORAGE_ROOT
    process.env.DSH_DEVICE_AUTH_SNAPSHOT_STORAGE_ROOT = join(root, 'storage')
    ctx = new Context()
    ctx.baseUrl = pathToFileURL(leaf).href + '/'
    await ctx.plugin(Loader)
    ctx.loader.builtins.include = Include
    const modules = new Map<string, unknown>([
      ['@deepseek-ai/dsh-host-webserver', WebServer],
      ['@deepseek-ai/dsh-storage', Storage],
      ['@deepseek-ai/dsh-storage-json', StorageJson],
      ['@deepseek-ai/dsh-storage-domain', StorageDomain],
      ['@deepseek-ai/dsh-device-auth-domain', DeviceAuthDomain],
      ['@deepseek-ai/dsh-host-device-auth-web', DeviceAuthWeb],
    ])
    ctx.loader.internal = {
      version: 'v2',
      async import(specifier: string) {
        const module = modules.get(specifier)
        if (module === undefined) throw new Error(`unexpected Loader import: ${specifier}`)
        return module
      },
    } as unknown as NonNullable<typeof ctx.loader.internal>
    await ctx.loader.create({
      name: 'cordis:include',
      config: { path: pathToFileURL(join(leaf, 'cordis.yml')).href },
    })
    await ctx.loader.await()
    const executablePath = process.env.DSH_PLAYWRIGHT_EXECUTABLE_PATH
    browser = await chromium.launch(executablePath === undefined ? {} : { executablePath })
    page = await browser.newPage()
  })

  afterAll(async () => {
    await browser?.close()
    await ctx?.fiber.dispose()
    if (previousStorageRoot === undefined) delete process.env.DSH_DEVICE_AUTH_SNAPSHOT_STORAGE_ROOT
    else process.env.DSH_DEVICE_AUTH_SNAPSHOT_STORAGE_ROOT = previousStorageRoot
    if (root !== '') await rm(root, { recursive: true, force: true })
  })

  it('renders the public login form without exposing its token input', async () => {
    await page.goto(`http://127.0.0.1:${String(ctx.webServer.port)}/auth/device/login`)
    const token = page.getByRole('textbox', { name: 'Permanent token' })
    expect(await token.getAttribute('type')).toBe('password')
    expect((await page.locator('body').ariaSnapshot()).trimEnd()).toBe(
      (await readFile(join(expectedDir, 'login.expected.md'), 'utf8')).trimEnd(),
    )
  })

  it('renders an empty local device administration table without secrets', async () => {
    await page.goto(`http://127.0.0.1:${String(ctx.webServer.port)}/auth/device/admin`)
    const aria = await page.locator('body').ariaSnapshot()
    expect(aria.trimEnd()).toBe((await readFile(join(expectedDir, 'admin.expected.md'), 'utf8')).trimEnd())
    expect(aria).not.toContain('dshd1.')
    expect(aria).not.toContain('__Host-dsh_device_session')
    expect(await page.locator('tbody tr').count()).toBe(0)
  })

  it('redirects unauthenticated HTML and rejects unauthenticated API requests on the public Host', async () => {
    const html = await request(ctx.webServer.port, '/', 'text/html')
    expect(html.status).toBe(302)
    expect(html.location).toBe('/auth/device/login')

    const api = await request(ctx.webServer.port, '/api/missing', 'application/json')
    expect(api.status).toBe(401)
  })
})
