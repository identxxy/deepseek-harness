import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

/**
 * Built-artifact smoke for the first generated Remote: plain Node boots the
 * Host and Browser bundle handoffs, then crosses the shared `/api` HTTP route.
 */

const packageDir = fileURLToPath(new URL('..', import.meta.url))
const root = resolve(packageDir, '../../..')
const artifact = (path: string): string => join(root, path)
const artifactUrl = (path: string): string => pathToFileURL(artifact(path)).href

const requiredArtifacts = [
  'packages/client/connection/lib/client.js',
  'packages/client/connection/lib/index.js',
  'packages/api/remotes/lib/client.js',
  'packages/core/agent/lib/index.js',
  'packages/core/session/lib/index.js',
  'packages/goal/goal/lib/index.js',
  'packages/goal/goal/lib/typert.host.js',
  'packages/console/console-remote/lib/index.js',
  'packages/console/console/lib/index.js',
  'packages/console/console-remote/lib/typert.host.js',
  'packages/api/gateway/lib/client.js',
  'packages/api/gateway/lib/index.js',
  'packages/typert/registry/lib/client.js',
  'packages/typert/registry/lib/index.js',
].every(path => existsSync(artifact(path)))

describe.skipIf(!requiredArtifacts)('Goal Remote built LIB chain', () => {
  it('runs root and Agent-scoped calls through generated bundles and real HTTP', async () => {
    const urls = Object.fromEntries(Object.entries({
      agent: 'packages/core/agent/lib/index.js',
      apiGatewayClient: 'packages/api/gateway/lib/client.js',
      apiGatewayHost: 'packages/api/gateway/lib/index.js',
      connectionClient: 'packages/client/connection/lib/client.js',
      connectionHost: 'packages/client/connection/lib/index.js',
      consoleRemote: 'packages/console/console-remote/lib/index.js',
      console: 'packages/console/console/lib/index.js',
      consoleTypert: 'packages/console/console-remote/lib/typert.host.js',
      goal: 'packages/goal/goal/lib/index.js',
      goalTypert: 'packages/goal/goal/lib/typert.host.js',
      registryClient: 'packages/typert/registry/lib/client.js',
      registryHost: 'packages/typert/registry/lib/index.js',
      remotesClient: 'packages/api/remotes/lib/client.js',
      session: 'packages/core/session/lib/index.js',
    }).map(([key, path]) => [key, artifactUrl(path)]))
    const script = `
      import { createServer } from 'node:http'
      import * as cordis from '@deepseek-ai/cordis'

      const urls = ${JSON.stringify(urls)}
      const { Context } = cordis
      const { default: AgentRegistry } = await import(urls.agent)
      const connectionHost = await import(urls.connectionHost)
      const { default: TypertRemoteService } = await import(urls.apiGatewayHost)
      const { default: GoalService } = await import(urls.goal)
      const { TYPERT } = await import(urls.goalTypert)
      const { default: ConsoleRemoteService } = await import(urls.consoleRemote)
      const { ConsoleError } = await import(urls.console)
      const { TYPERT: CONSOLE_TYPERT } = await import(urls.consoleTypert)
      const { default: TypertRegistry } = await import(urls.registryHost)
      const { Session, SessionId } = await import(urls.session)

      const routes = []
      const host = new Context()
      host.provide('webServer', {
        register(route) {
          routes.push(route)
          return () => { routes.splice(routes.indexOf(route), 1) }
        },
        tapIndex() { return () => {} },
        port: 0,
      })
      await host.plugin({ inject: connectionHost.inject, apply: connectionHost.apply })
      await host.plugin(TypertRegistry)
      await host.plugin(AgentRegistry)
      await host.plugin(TypertRemoteService)
      const consoleAccess = { consoleId: 'built-console', capability: 'built-capability' }
      const writes = []
      const signals = []
      let stopped = false
      let consoleWaitStarted = false
      let consoleHostObservedAbort = false
      host.provide('consoles', {
        snapshot(access) {
          if (access.capability !== consoleAccess.capability) {
            throw new ConsoleError('ACCESS_DENIED', 'denied')
          }
          return { id: consoleAccess.consoleId, workspaceId: 'workspace', cwd: '/workspace', pid: 42, size: { rows: 24, cols: 80 }, status: { kind: 'running' }, oldestOutputByte: 0, nextOutputByte: 2 }
        },
        readOutput(_access, fromByte) { return { kind: 'data', data: fromByte === 0 ? Uint8Array.from([0, 255]) : new Uint8Array(), fromByte, nextByte: fromByte === 0 ? 2 : fromByte, availableThroughByte: 2 } },
        waitOutput(_access, _fromByte, signal) {
          consoleWaitStarted = true
          return new Promise((_, reject) => signal.addEventListener('abort', () => {
            consoleHostObservedAbort = true
            reject(signal.reason)
          }, { once: true }))
        },
        write(_access, data) { writes.push(data); return Promise.resolve() },
        resize() { return Promise.resolve() },
        signal(_access, signal) { signals.push(signal); return Promise.resolve({ delivered: true, targetPgid: 7 }) },
        stop() { stopped = true; return Promise.resolve() },
      })
      await host.plugin(ConsoleRemoteService, { maxPollWaitMs: 500, maxWriteBytes: 16 })
      host.typert.register(CONSOLE_TYPERT)
      await host.plugin(GoalService)
      host.typert.register(TYPERT)

      const makeAgent = rawId => {
        const session = new Session(SessionId(rawId))
        return {
          id: session.id,
          options: {},
          session,
          ctx: host.extend(),
          status: 'idle',
          acceptsNextStep: false,
          send() {},
          updateInbox() { return 'not-found' },
          followup() {},
          steer() { return { outcome: Promise.resolve({ status: 'rejected' }) } },
          inject(input) { session.append('user/message', input, { surfaceOp: 'append' }) },
          reserveTurnAdmission() {},
          cancel() {},
          whenIdle() { return Promise.resolve() },
        }
      }
      const rootAgent = makeAgent('built-root-agent')
      const scopedAgent = makeAgent('built-scoped-agent')
      host.agents.register(rootAgent)
      host.agents.register(scopedAgent)

      if (routes.length !== 1 || routes[0].path !== '/api') {
        throw new Error('Connection did not register exactly one /api route')
      }
      const server = createServer((request, response) => { void routes[0].handler(request, response) })
      await new Promise(resolveListen => server.listen(0, '127.0.0.1', resolveListen))
      const address = server.address()
      if (address === null || typeof address === 'string') throw new Error('HTTP server has no TCP address')
      const origin = 'http://127.0.0.1:' + String(address.port)

      const handoffs = new Map()
      globalThis.window = {
        __ModuleLoader__: {
          load(handoff) { handoffs.set(handoff.id, handoff) },
        },
      }
      globalThis.location = { hostname: '127.0.0.1', origin, search: '' }
      await import(urls.registryClient)
      await import(urls.connectionClient)
      await import(urls.apiGatewayClient)
      await import(urls.remotesClient)

      const instantiate = id => {
        const handoff = handoffs.get(id)
        if (handoff === undefined) throw new Error('missing Client bundle handoff ' + id)
        return handoff.factory(specifier => {
          if (specifier === '@deepseek-ai/cordis') return cordis
          throw new Error('unexpected Client external ' + specifier)
        })
      }
      const client = new Context()
      for (const id of [
        '@deepseek-ai/dsh-typert-registry',
        '@deepseek-ai/dsh-client-connection',
        '@deepseek-ai/dsh-api-gateway',
        '@deepseek-ai/dsh-api-remotes',
      ]) {
        const plugin = instantiate(id)
        await client.plugin({ inject: plugin.inject, apply: plugin.apply })
      }
      client.typert.contexts.registerClient('agent', {
        identity: candidate => candidate.builtAgentId,
      })

      let invalidRejected = false
      try {
        await client.remote.goals.create(rootAgent.id, { objective: 1 })
      } catch {
        invalidRejected = true
      }
      // Every generated method resolves to the RemoteResult envelope; the
      // business values below are what the assertions pin.
      const rootResult = await client.remote.goals.create(rootAgent.id, { objective: 'root goal' })
      const rootEdit = await client.remote.goals.edit(
        rootAgent.id,
        rootResult.value.ref,
        { objective: 'edited root goal' },
      )
      const agentContext = client.extend({ builtAgentId: scopedAgent.id })
      const scopedResult = await agentContext.remote.goals.create({ objective: 'scoped goal', maxGoalRounds: 3 })
      const consoleRead = await client.remote.consoles.read({ access: consoleAccess, fromByte: 0, waitMs: 10 })
      const consoleDenied = await client.remote.consoles.snapshot({ access: { ...consoleAccess, capability: 'wrong' } })
      const consoleAbortController = new AbortController()
      const consoleAbortPromise = client.remote.consoles.read({ access: consoleAccess, fromByte: 2, waitMs: 500 }, consoleAbortController.signal).then(result => {
        if (!result.ok) throw result.error
        return result.value
      })
      while (!consoleWaitStarted) await new Promise(resolveWait => setTimeout(resolveWait, 1))
      consoleAbortController.abort(new Error('built caller abort'))
      let consoleCallerAborted = false
      try { await consoleAbortPromise } catch { consoleCallerAborted = true }
      await client.remote.consoles.signal({ access: consoleAccess, signal: 'SIGINT' })
      let consoleInvalidSignalRejected = false
      try { await client.remote.consoles.signal({ access: consoleAccess, signal: 'SIGQUIT' }) } catch { consoleInvalidSignalRejected = true }
      await client.remote.consoles.write({ access: consoleAccess, data: 'hello' })
      await client.remote.consoles.stop({ access: consoleAccess })
      const result = {
        invalidRejected,
        rootResult: rootResult.value,
        rootEdit: rootEdit.value,
        scopedResult: scopedResult.value,
        rootGoal: host.goals.get(rootAgent)?.objective,
        scopedGoal: host.goals.get(scopedAgent)?.objective,
        rootEvents: rootAgent.session.events.length,
        scopedEvents: scopedAgent.session.events.length,
        consoleRead: consoleRead.value,
        writes,
        stopped,
        consoleDenied: consoleDenied.value,
        consoleCallerAborted,
        consoleHostObservedAbort,
        consoleInvalidSignalRejected,
        signals,
      }

      await client.fiber.dispose()
      await new Promise((resolveClose, rejectClose) => server.close(error => {
        if (error === undefined) resolveClose()
        else rejectClose(error)
      }))
      await host.fiber.dispose()
      console.log(JSON.stringify(result))
    `

    const result = await runPlainNode(script)
    expect(result.exitCode, `stderr:\n${result.stderr}`).toBe(0)
    const output = JSON.parse(result.stdout.trim().split('\n').at(-1) ?? '{}') as {
      invalidRejected: boolean
      rootResult: { ref: { id: string; revision: number } }
      rootEdit: { objective: string; revision: number }
      scopedResult: { ref: { id: string; revision: number } }
      rootGoal: string
      scopedGoal: string
      rootEvents: number
      scopedEvents: number
      consoleRead: { ok: true; value: { output: { dataBase64: string }; console: { pid?: number } } }
      writes: string[]
      stopped: boolean
      consoleDenied: { ok: false; error: { code: string } }
      consoleCallerAborted: boolean
      consoleHostObservedAbort: boolean
      consoleInvalidSignalRejected: boolean
      signals: string[]
    }
    expect(output).toMatchObject({
      invalidRejected: true,
      rootResult: { ref: { revision: 1 } },
      rootEdit: { objective: 'edited root goal', revision: 2 },
      scopedResult: { ref: { revision: 1 } },
      rootGoal: 'edited root goal',
      scopedGoal: 'scoped goal',
      rootEvents: 2,
      scopedEvents: 1,
      consoleRead: { ok: true, value: { output: { dataBase64: 'AP8=' }, console: {} } },
      writes: ['hello'],
      stopped: true,
      consoleDenied: { ok: false, error: { code: 'ACCESS_DENIED' } },
      consoleCallerAborted: true,
      consoleHostObservedAbort: true,
      consoleInvalidSignalRejected: true,
      signals: ['SIGINT'],
    })
    expect(output.rootResult.ref.id).toMatch(/^goal-/)
    expect(output.scopedResult.ref.id).toMatch(/^goal-/)
  }, 60_000)
})

/** Execute one ESM script without tsx or a TypeScript loader. */
function runPlainNode(script: string): Promise<{
  readonly exitCode: number | null
  readonly stdout: string
  readonly stderr: string
}> {
  return new Promise((resolveRun) => {
    execFile(process.execPath, ['--input-type=module', '-e', script], {
      cwd: packageDir,
      encoding: 'utf8',
      timeout: 55_000,
    }, (error, stdout, stderr) => {
      resolveRun({
        exitCode: error === null ? 0 : typeof error.code === 'number' ? error.code : null,
        stdout,
        stderr,
      })
    })
  })
}
