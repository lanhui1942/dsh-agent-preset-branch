/**
 * dsh-agent-preset-branch — Host half.
 *
 * Mounts two same-origin routes on `ctx.webServer` for the client half:
 *
 *   GET  /dsh-agent-preset-branch/list    → the modes a branch can be started in
 *   POST /dsh-agent-preset-branch/branch  → copy this Session into another mode
 *
 * The work itself lives in ./core.js with its collaborators injected; this file
 * is the Cordis adapter: it resolves the live services per request, hands them
 * to the engine, and turns refusals into JSON.
 *
 * Transport note: the client half is a build-free JavaScript bundle, so it
 * cannot declare the generated Typert descriptors a Remote namespace needs. The
 * community plugins shipped with this product (`dshmarket`,
 * `better-dsh-session-deletetool`) use same-origin HTTP routes for the same
 * reason, and this plugin follows that precedent.
 */

import { BranchEngine, BranchFailure, BRANCH_FAILURES } from './core.js'

/** Services looked up per request; the routes are the only activation requirement. */
export const inject = ['webServer']

const LIST_PATH = '/dsh-agent-preset-branch/list'
const BRANCH_PATH = '/dsh-agent-preset-branch/branch'
const SWITCH_PATH = '/dsh-agent-preset-branch/switch'
const INSPECT_PATH = '/dsh-agent-preset-branch/inspect'

const MAX_BODY_BYTES = 8192

const JSON_HEADERS = {
  'content-type': 'application/json; charset=utf-8',
  'cache-control': 'no-store',
}

/** Message text for an unknown failure, without assuming an Error. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/**
 * Register the routes.
 * @param {object} ctx - Host Cordis context.
 */
export function apply(ctx) {
  const engine = new BranchEngine({
    // The engine's own diagnostics land in the Host log. A branch is the one
    // operation whose failure would otherwise be invisible: it either produces
    // a Session in the wrong mode or produces none at all.
    log: (level, message) => {
      const line = `[dsh-agent-preset-branch] ${message}`
      if (level === 'warn') ctx.logger?.warn?.(line)
      else ctx.logger?.info?.(line)
    },
    services: () => ({
      presets: ctx.get('agentPresets'),
      agents: ctx.get('agents'),
      sessionController: ctx.get('sessionController'),
      // Reading the conversation to migrate, and putting the new session beside
      // the old one. Both are separate services, and both are reported by name
      // when a deployment lacks one.
      sessionQuery: ctx.get('sessionQuery'),
      workspaceRegistry: ctx.get('workspaceRegistry'),
      // The model a branch falls back to when the source Session is not running.
      // Prompt assembly reads `{{model}}` from the Agent's OWN creation options
      // (`context.agent?.options.model`), so a branch created without them cannot
      // run a single turn: "prompt variable "{{model}}" has no value for this
      // assembly (section "deployment:persona-prefix")". A Session that has been
      // resumed after a restart, or that is only being read from persistence, has
      // no live Agent to ask, so the deployment default is the last resort.
      agentDefaultModel: ctx.get('agentDefaultModel'),
    }),
    // The registry emits `tools/change` whenever a composition changes and
    // consumers that cached an Agent's tool list listen for it. A re-mount done
    // outside the registry's own recompose path has to produce the same signal.
    announceToolsChange: () => {
      try {
        ctx.emit('tools/change')
      } catch (error) {
        ctx.logger?.warn?.(`[dsh-agent-preset-branch] tools/change was not delivered: ${messageOf(error)}`)
      }
    },
  })

  const route = (path, name, handler) => {
    ctx.effect(
      () => ctx.webServer.register({
        kind: 'exact',
        path,
        handler: (request, response) => {
          void handler(request, response).catch((error) => {
            ctx.logger?.warn?.(`[dsh-agent-preset-branch] ${name} failed: ${messageOf(error)}`)
            send(response, 500, { ok: false, code: 'internal', message: messageOf(error) })
          })
        },
      }),
      `dsh-agent-preset-branch: ${name} route`,
    )
  }

  route(LIST_PATH, 'list', (request, response) => serveList(engine, request, response))
  route(BRANCH_PATH, 'branch', (request, response) => serveBranch(engine, request, response))
  route(SWITCH_PATH, 'switch', (request, response) => serveSwitch(engine, request, response))
  route(INSPECT_PATH, 'inspect', (request, response) => serveInspect(engine, request, response))
  ctx.logger?.info?.(`[dsh-agent-preset-branch] routes mounted at ${LIST_PATH}, ${BRANCH_PATH}, ${SWITCH_PATH} and ${INSPECT_PATH}`)
}

/**
 * Report one Session's modes: the durable record and the live composition, side
 * by side.
 *
 * This exists because the feature has exactly one silent failure mode — a new
 * session that runs the mode that was asked for while its record says otherwise,
 * or the reverse — and a caller should be able to see which of the two is wrong
 * without reading a log file.
 * @param {BranchEngine} engine - the branch engine.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveInspect(engine, request, response) {
  if (request.method !== 'GET') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only GET is accepted' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: 'the request did not come from this Harness page' })
    return
  }
  let sessionId = ''
  try {
    sessionId = new URL(request.url ?? '/', 'http://127.0.0.1').searchParams.get('sessionId') ?? ''
  } catch {
    sessionId = ''
  }
  try {
    const report = await engine.describe({ sessionId })
    send(response, 200, { ok: true, ...report })
  } catch (error) {
    send(response, statusOf(error, 500), bodyOf(error))
  }
}

/**
 * Answer the selectable roster.
 * @param {BranchEngine} engine - the branch engine.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveList(engine, request, response) {
  if (request.method !== 'GET') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only GET is accepted' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: 'the request did not come from this Harness page' })
    return
  }
  try {
    const roster = await engine.list()
    send(response, 200, { ok: true, ...roster })
  } catch (error) {
    send(response, statusOf(error, 503), bodyOf(error))
  }
}

/**
 * Branch one Session into another mode.
 * @param {BranchEngine} engine - the branch engine.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveBranch(engine, request, response) {
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only POST is accepted' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: 'the request did not come from this Harness page' })
    return
  }
  const body = await readJson(request, response)
  if (body === undefined) return
  try {
    const branch = await engine.branch(body)
    send(response, 200, { ok: true, ...branch })
  } catch (error) {
    send(response, statusOf(error, 500), bodyOf(error))
  }
}

/**
 * Switch a Session that has not started yet into another mode, in place.
 *
 * This is the one mode change DSH itself allows, and it is offered here so the
 * control behaves the same whether or not the sibling
 * `dsh-agent-preset-select` plugin is installed. A started Session is refused by
 * the registry and told to branch instead.
 * @param {BranchEngine} engine - the branch engine.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 */
async function serveSwitch(engine, request, response) {
  if (request.method !== 'POST') {
    send(response, 405, { ok: false, code: 'method-not-allowed', message: 'only POST is accepted' })
    return
  }
  if (!sameOrigin(request)) {
    send(response, 403, { ok: false, code: 'untrusted-origin', message: 'the request did not come from this Harness page' })
    return
  }
  const body = await readJson(request, response)
  if (body === undefined) return
  try {
    const switched = await engine.switchInPlace(body)
    send(response, 200, { ok: true, ...switched })
  } catch (error) {
    send(response, statusOf(error, 500), bodyOf(error))
  }
}

/**
 * The HTTP status a refusal deserves.
 *
 * Exported, with {@link bodyOf}, so the refusal mapping can be exercised
 * directly by the plugin's own verification harness.
 * @param {unknown} error - the thrown value.
 * @param {number} fallback - status for an unrecognized failure.
 * @returns {number} the status.
 */
export function statusOf(error, fallback) {
  if (!(error instanceof BranchFailure)) return fallback
  switch (error.code) {
    case BRANCH_FAILURES.badRequest: return 400
    case BRANCH_FAILURES.unknownPreset: return 404
    case BRANCH_FAILURES.nothingToBranch:
    case BRANCH_FAILURES.branchFailed:
    case BRANCH_FAILURES.branchIncomplete:
    case BRANCH_FAILURES.noLiveAgent:
    case BRANCH_FAILURES.presetLocked:
    case BRANCH_FAILURES.presetRefused: return 409
    case BRANCH_FAILURES.modelUnavailable: return 503
    case BRANCH_FAILURES.unavailable: return 503
    default: return fallback
  }
}

/**
 * The JSON body for a refusal.
 *
 * An incomplete branch is not a failure the user should read as "nothing
 * happened": the Session exists, so its identity is part of the answer.
 * @param {unknown} error - the thrown value.
 * @returns {object} the response body.
 */
export function bodyOf(error) {
  if (!(error instanceof BranchFailure)) {
    return { ok: false, code: 'internal', message: messageOf(error) }
  }
  return {
    ok: false,
    code: error.code,
    message: error.message,
    reason: error.reason,
    ...(typeof error.sessionId === 'string' ? { sessionId: error.sessionId } : {}),
  }
}

/**
 * Read a bounded JSON body.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @param {import('node:http').ServerResponse} response - the response.
 * @returns {Promise<object | undefined>} the parsed body, or undefined once a refusal was sent.
 */
async function readJson(request, response) {
  let text = ''
  try {
    for await (const chunk of request) {
      text += chunk
      if (text.length > MAX_BODY_BYTES) {
        send(response, 413, { ok: false, code: 'too-large', message: 'the request body is too large' })
        return undefined
      }
    }
    return JSON.parse(text === '' ? '{}' : text)
  } catch (error) {
    send(response, 400, { ok: false, code: 'bad-request', message: messageOf(error) })
    return undefined
  }
}

/**
 * Whether the request came from this Harness page.
 *
 * A cross-site page can still POST to a loopback URL; the browser sets Origin on
 * cross-origin requests, so a present Origin that is not this server is refused.
 * @param {import('node:http').IncomingMessage} request - the request.
 * @returns {boolean} whether the request is same-origin.
 */
function sameOrigin(request) {
  const origin = request.headers.origin
  if (origin === undefined) return true
  const host = request.headers.host
  if (host === undefined) return false
  try {
    return new URL(origin).host === host
  } catch {
    return false
  }
}

/**
 * Answer one route.
 * @param {import('node:http').ServerResponse} response - the response.
 * @param {number} status - HTTP status.
 * @param {object} payload - JSON body.
 */
function send(response, status, payload) {
  const body = JSON.stringify(payload)
  response.writeHead(status, { ...JSON_HEADERS, 'content-length': Buffer.byteLength(body) })
  response.end(body)
}
