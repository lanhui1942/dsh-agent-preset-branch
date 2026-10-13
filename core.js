/**
 * dsh-agent-preset-branch — migration engine.
 *
 * One job: continue an existing conversation under a DIFFERENT Agent preset.
 *
 * DSH cannot change a session's mode after it has run: the registry's `select()`
 * refuses as soon as a turn exists. So the mode has to be chosen while a Session
 * is still being composed — and the Host does compose one from a requested
 * preset on `session.create`. What that path cannot do is carry a conversation
 * over, because a Session is event-sourced and its history arrives as a seed.
 *
 * Both halves therefore go through ONE call: `ctx.agents.create` is handed the
 * source conversation as a seed AND a `setup` that mounts the requested preset.
 * The child is composed in the requested mode before it is ever published, so
 * its tool layer and prompt sections are built from that mode — not swapped
 * afterwards.
 *
 * Why not the Host's own fork command: `sessionController.fork` composes the
 * child from `presetForObservation(source)`, and `SessionForkRequest` carries no
 * preset at all, so a forked child always inherits the parent's mode. That is
 * exactly the path this feature must not take.
 *
 * This module holds the whole sequence with its collaborators injected, so the
 * order of operations can be tested without a live Host.
 *
 * @module dsh-agent-preset-branch/core
 */

import { randomUUID } from 'node:crypto'

/**
 * The Host's own fork-seed construction, loaded lazily.
 *
 * It is imported rather than reimplemented so a seed is byte-for-byte what the
 * Host produces. The import must be dynamic: this plugin lives in a directory
 * Node's resolution cannot see `node_modules` from (the profile reaches it
 * through a link), so a static specifier would throw while the module loads and
 * take the whole plugin down. A Host that cannot supply it falls back to
 * {@link localForkSeed}, which answers the same shape for a log whose tail needs
 * no repair.
 * @returns {Promise<((events: readonly object[], boundary: number) => object[]) | undefined>} the builder.
 */
async function loadForkSeed() {
  try {
    const module = await import('@deepseek-ai/dsh-session/fork')
    if (typeof module?.buildForkSeed === 'function') return module.buildForkSeed
  } catch {
    // Resolution is unavailable from this directory; the local builder answers.
  }
  return undefined
}

/**
 * Copy an inclusive event prefix and mark its inherited cut.
 *
 * The shape matches the Host's builder for a cleanly closed tail: the copied
 * prefix, then the `session/end-seed` marker the child's constructor requires at
 * its inherited cut. The cut is the latest completed turn boundary, so the
 * prefix ends closed and needs no synthetic repair closers.
 * @param {readonly object[]} events - source log with contiguous seqs.
 * @param {number} boundary - inclusive source seq the child inherits through.
 * @returns {object[]} the seed.
 */
function localForkSeed(events, boundary) {
  const prefix = events.slice(0, boundary + 1)
  const last = events[boundary]
  return prefix.concat([{
    type: 'session/end-seed',
    seq: boundary + 1,
    time: typeof last?.time === 'number' ? last.time : Date.now(),
    data: { inherited: true },
  }])
}

/** Stable failure codes; each maps to one user-facing sentence on the client. */
export const BRANCH_FAILURES = Object.freeze({
  badRequest: 'bad-request',
  unknownPreset: 'agent-preset/not-found',
  nothingToBranch: 'nothing-to-branch',
  branchFailed: 'branch-failed',
  branchIncomplete: 'branch-incomplete',
  noLiveAgent: 'agent-preset/unavailable',
  presetLocked: 'agent-preset/locked',
  presetRefused: 'agent-preset/refused',
  modelUnavailable: 'model-unavailable',
  unavailable: 'unavailable',
})

/** A refusal this plugin can explain, in the shape the client reports verbatim. */
export class BranchFailure extends Error {
  /**
   * @param {string} code - one of {@link BRANCH_FAILURES}.
   * @param {string} message - developer-facing text.
   * @param {string} reason - the sentence the client shows.
   * @param {object} [details] - extra fields merged into the response body.
   */
  constructor(code, message, reason, details) {
    super(message)
    this.name = 'BranchFailure'
    this.code = code
    this.reason = reason
    if (details !== undefined) Object.assign(this, details)
  }
}

/** Preset ids come from declaration files; keep them to the same safe shape as sessions. */
const IDENTITY = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,199}$/

/** Titles are free text; cap what one branch may carry over. */
export const MAX_TITLE_LENGTH = 200

/** Message text for an unknown failure, without assuming an Error. */
const messageOf = (error) => (error instanceof Error ? error.message : String(error))

/** A remote refusal keeps its reason in `details`; surface that when present. */
const reasonOf = (error) => {
  const details = error?.details
  if (details !== null && typeof details === 'object' && typeof details.reason === 'string' && details.reason !== '') return details.reason
  return messageOf(error)
}

/**
 * Reject an identity this plugin will not forward to the Host.
 * @param {string} value - candidate identity.
 * @param {string} field - field name, for the message.
 * @returns {string} the trimmed identity.
 */
function requireIdentity(value, field) {
  const trimmed = typeof value === 'string' ? value.trim() : ''
  if (!IDENTITY.test(trimmed)) {
    throw new BranchFailure(
      BRANCH_FAILURES.badRequest,
      `${field} is not a usable identity`,
      `${field} 不是一个可用的标识。`,
    )
  }
  return trimmed
}

/**
 * The model selection the copied Session should run, when readable.
 *
 * This is load-bearing, not a preference. Prompt assembly resolves `{{model}}`
 * and `{{provider}}` from the Agent's OWN creation options — the agent loop
 * registers them as `context.agent?.options.model` — so an Agent created without
 * them fails its very first assembly:
 *
 *   prompt variable "{{model}}" has no value for this assembly
 *   (section "deployment:persona-prefix")
 *
 * A Session that is currently running always had those options, but one that was
 * resumed after a restart, or read from persistence while no Agent is live,
 * cannot supply them through the controller's per-Agent selection holder. Three
 * sources are therefore tried, most specific first:
 *
 *   1. the source Session's live Agent and its installed selection holder (the
 *      session-local choice — what that conversation is actually running);
 *   2. that Agent's own creation options (what a live Agent was made with);
 *   3. the deployment default (what an ordinary new Session gets), so a branch
 *      taken from a stopped Session still comes up runnable.
 *
 * @param {object} sessionController - the Host's session controller.
 * @param {object} agents - the Host's Agent registry.
 * @param {string} sessionId - the Session being copied.
 * @param {object} [agentDefaultModel] - the deployment default-model service.
 * @returns {{provider: string, model: string} | undefined} the selection.
 */
function readSelection(sessionController, agents, sessionId, agentDefaultModel) {
  const usable = (value) => value !== null && value !== undefined && typeof value === 'object'
    && typeof value.provider === 'string' && value.provider !== ''
    && typeof value.model === 'string' && value.model !== ''
    ? { provider: value.provider, model: value.model }
    : undefined
  let agent
  try {
    agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
  } catch {
    agent = undefined
  }
  if (agent !== undefined) {
    try {
      const held = usable(sessionController?.selectionFor?.(agent)?.current)
      if (held !== undefined) return held
    } catch {
      // The holder is an internal seam; its absence just moves on.
    }
    let created
    try {
      created = usable(agent.options)
    } catch {
      created = undefined
    }
    if (created !== undefined) return created
  }
  try {
    return usable(agentDefaultModel?.currentSelection?.())
  } catch {
    return undefined
  }
}

/**
 * Make `{{provider}}` and `{{model}}` resolvable for one composed child.
 *
 * The deployment prompt (`deployment:persona-prefix`) is assembler text and may
 * reference these; the agent loop registers both as global variables reading
 * `context.agent?.options`. This pins the same two values on the CHILD's own
 * scope, where a scoped entry shadows the global one, so the first assembly
 * cannot come out with `undefined` for either:
 *
 *   prompt variable "{{model}}" has no value for this assembly
 *   (section "deployment:persona-prefix")
 *
 * Both are registered through the child's own context, so they are disposed with
 * it. A deployment without that service, or one whose variable name is taken in
 * the same scope, is left exactly as it was — this only ever adds a value the
 * assembly would otherwise have to invent.
 *
 * @param {object} agentCtx - the child's scoped composition context.
 * @param {{provider: string, model: string}} selection - the chosen route.
 */
function pinPromptVariables(agentCtx, selection) {
  const prompt = agentCtx?.systemPrompt
  if (prompt === undefined || typeof prompt.variable !== 'function') return
  const pinned = [
    ['provider', () => selection.provider],
    ['model', () => selection.model],
  ]
  for (const [name, provider] of pinned) {
    try {
      prompt.variable(name, provider)
    } catch {
      // The name is already owned in this exact scope; its value stands.
    }
  }
}

/**
 * Install the copied model selection on a freshly composed Agent.
 *
 * The Agent was created with the same `{provider, model}` in its own options, so
 * this is the second half: it makes the live selection holder agree before the
 * first request is prepared. Both steps are best effort — a holder that exposes
 * only one of its two entry points must not fail the migration the model is
 * already carried by.
 * @param {object} sessionController - the Host's session controller.
 * @param {object} agent - the composed Agent.
 * @param {object | undefined} selection - the selection to install, if any.
 */
function installSelection(sessionController, agent, selection) {
  if (selection === undefined || agent === undefined) return
  try {
    sessionController?.installSelection?.(agent)
    const holder = sessionController?.selectionFor?.(agent)
    if (typeof holder?.install === 'function') holder.install(selection)
    else if (holder !== undefined && holder !== null) holder.current = selection
  } catch {
    // The Agent's own options already carry the model.
  }
}

/**
 * The mode a composed Agent reports, when the registry can answer.
 *
 * `composedPreset` is the live composition — what actually decides the tools and
 * prompt for the next turn. `presetForSession` is the durable projection, and the
 * session header is the last resort. All three are tried because a disagreement
 * between them is precisely the failure this feature must not hide, and the
 * caller compares the answer against what it asked for.
 * @param {object} presets - the Host's preset registry.
 * @param {object} sessionController - the Host's session controller.
 * @param {object | undefined} agent - the composed Agent, if it is live.
 * @returns {string | undefined} the preset id.
 */
function readComposedPreset(presets, sessionController, agent) {
  if (agent === undefined) return undefined
  try {
    const composed = presets?.composedPreset?.(agent.ctx)
    if (typeof composed === 'string' && composed !== '') return composed
  } catch {
    // A registry without that reader falls through to the durable readers.
  }
  try {
    const projected = sessionController?.presetForSession?.(agent.session)
    if (typeof projected === 'string' && projected !== '') return projected
  } catch {
    // Then the header.
  }
  try {
    const header = agent.session?.header?.agentPreset
    if (typeof header === 'string' && header !== '') return header
  } catch {
    // No readable header: the caller reports "unconfirmed".
  }
  return undefined
}

/**
 * The inclusive event seq a migration copies through: the latest completed turn,
 * plus any standalone events recorded after it.
 *
 * This is the Host's own default cut for a fork (`latestCompletedPrefixBoundary`),
 * reproduced rather than imported because it is an unexported internal. It
 * returns undefined when no turn has finished, which is what makes "nothing to
 * migrate yet" a first-class answer instead of an empty copy.
 * @param {readonly object[]} events - the source log, ascending by seq.
 * @returns {number | undefined} the inclusive cut, or undefined.
 */
function latestCompletedPrefixBoundary(events) {
  const list = Array.isArray(events) ? events : []
  const lastTurnEnd = list.findLast((event) => event?.type === 'turn/end')
  if (lastTurnEnd === undefined) return undefined
  let boundary = lastTurnEnd.seq
  for (const next of list.slice(boundary + 1)) {
    // A new turn, an appended user message, or an inbox splice all begin fresh
    // content; anything else after the last turn end belongs to the copy.
    if (next?.type === 'turn/start') break
    if (next?.type === 'user/message' && next.surfaceOp === 'append') break
    if (next?.type === 'agent/inbox/spliced') break
    boundary = next.seq
  }
  return boundary
}

/**
 * The cut point a request asks for, or undefined to use the default.
 *
 * A caller that names a point names a COMPLETED turn — the event at that seq has
 * to be a `turn/end` — because the copy has to end at a closed boundary: the seed
 * carries no repair closers, so an arbitrary seq inside a turn would hand the
 * child a half-written turn. Anything else (absent, not an integer, negative, a
 * seq the log does not hold, or an event that is not a `turn/end`) falls back to
 * the latest completed turn rather than failing the branch.
 *
 * @param {unknown} value - the requested seq.
 * @param {readonly object[]} events - the source log, ascending by seq.
 * @returns {number | undefined} the requested cut, or undefined for the default.
 */
function requestedBoundary(value, events) {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) return undefined
  const event = events.find((candidate) => candidate?.seq === value)
  return event?.type === 'turn/end' ? value : undefined
}

/**
 * The Workspace the source Session belongs to, when it has one.
 *
 * A subagent has no workspace of its own, so its ancestry is walked the way the
 * Host's own fork resolution does.
 * @param {object} workspaceRegistry - the Host's workspace registry.
 * @param {object} sessionQuery - the Host's session query service.
 * @param {object} header - the source Session header.
 * @returns {Promise<object | undefined>} the workspace.
 */
async function branchWorkspace(workspaceRegistry, sessionQuery, header) {
  if (workspaceRegistry === undefined || typeof workspaceRegistry.list !== 'function') return undefined
  const workspaces = workspaceRegistry.list()
  const direct = workspaces.find((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(header.id))
  if (direct !== undefined || header.origin !== 'subagent') return direct
  try {
    const lineage = await sessionQuery.traceSession(header.id)
    for (const ancestor of lineage?.ancestors ?? []) {
      const owner = workspaces.find((workspace) => Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(ancestor.header.id))
      if (owner !== undefined) return owner
    }
  } catch {
    // A trace that cannot resolve simply leaves the session unworkspaced.
  }
  return undefined
}

/** A fresh Session identity in the Host's own shape. */
function mintSessionId() {
  return `session-${randomUUID()}`
}

/**
 * The branch engine.
 *
 * Collaborators are read from the Host per call rather than captured at load
 * time, because a profile can mount (or unmount) any of them later.
 */
export class BranchEngine {
  /**
   * @param {object} hooks - Host bindings.
   * @param {() => object | undefined} hooks.services - resolves the live services.
   */
  constructor(hooks) {
    this.hooks = hooks
  }

  /**
   * The modes a branch can be started in.
   *
   * A preset the registry cannot activate (`broken`) is left out: offering it
   * would only move the discovery of that fact to a failed branch.
   * @returns {Promise<{defaultId: string | undefined, presets: object[]}>} the roster.
   */
  async list() {
    const { presets } = this.hooks.services()
    if (presets === undefined) {
      throw new BranchFailure(BRANCH_FAILURES.unavailable, 'this deployment mounts no agent-preset registry', '当前部署没有挂载 Agent 预设注册表。')
    }
    const roster = await presets.list()
    return {
      defaultId: typeof presets.defaultId === 'string' ? presets.defaultId : undefined,
      presets: roster
        .filter((preset) => preset?.broken === undefined)
        .map((preset) => ({
          id: preset.id,
          ...(preset.name === undefined ? {} : { name: preset.name }),
          ...(preset.description === undefined ? {} : { description: preset.description }),
        })),
    }
  }

  /**
   * Copy one Session's finished history into a new Session running another mode.
   *
   * The parent is never written to: the copy is a new Session, and the two are
   * independent from then on.
   *
   * @param {object} request - branch request.
   * @param {string} request.sessionId - the Session to branch from.
   * @param {string} request.agentPreset - the mode the branch runs in.
   * @param {string} [request.title] - title for the branch.
   * @param {number} [request.atSeq] - seq of a COMPLETED turn to cut at; the default
   * is the latest completed turn, and an unusable value falls back to it.
   * @returns {Promise<{sessionId: string, agentPreset: string, currentPreset: string, titleApplied: boolean, parentSession: string, atSeq: number, atLatest: boolean}>} the branch.
   * @throws {BranchFailure} on any refusal.
   */
  async branch(request) {
    const sessionId = requireIdentity(request?.sessionId, 'sessionId')
    const agentPreset = requireIdentity(request?.agentPreset, 'agentPreset')
    const requestedTitle = typeof request?.title === 'string' ? request.title.trim().slice(0, MAX_TITLE_LENGTH) : ''
    const { presets, agents, sessionController, sessionQuery, workspaceRegistry, agentDefaultModel } = this.hooks.services()

    // Everything below is required, and each is named separately so a missing
    // one reads as itself rather than as "branching is broken".
    if (presets === undefined) {
      throw new BranchFailure(BRANCH_FAILURES.unavailable, 'this deployment mounts no agent-preset registry', '当前部署没有挂载 Agent 预设注册表。')
    }
    if (agents === undefined || typeof agents.create !== 'function' || typeof agents.get !== 'function') {
      throw new BranchFailure(BRANCH_FAILURES.unavailable, 'this deployment mounts no Agent registry', '当前部署没有挂载 Agent 注册表，无法新建会话。')
    }
    if (sessionQuery === undefined || typeof sessionQuery.observeSession !== 'function') {
      throw new BranchFailure(BRANCH_FAILURES.unavailable, 'this deployment mounts no session query service', '当前部署没有挂载会话查询服务，无法读出要迁移的对话。')
    }

    // 1. Resolve the mode before anything is created, so a typo cannot leave a
    //    half-made session behind.
    let resolved
    try {
      resolved = await presets.resolve(agentPreset)
    } catch (error) {
      throw new BranchFailure(BRANCH_FAILURES.unknownPreset, messageOf(error), `没有这个模式：${reasonOf(error)}`)
    }
    const targetPreset = resolved?.id ?? agentPreset

    // 2. Read the conversation to migrate, and the cut to migrate through: the
    //    latest completed turn, plus any standalone events after it. A session
    //    that has not finished a turn has nothing to carry over.
    let observation
    try {
      observation = await sessionQuery.observeSession(sessionId)
    } catch (error) {
      throw new BranchFailure(BRANCH_FAILURES.branchFailed, messageOf(error), `读不出这个任务的对话：${reasonOf(error)}`)
    }
    let source
    try {
      source = observation
      // The cut is the caller's completed turn when it named a usable one, and
      // the latest completed turn otherwise. Both are turn boundaries, so the
      // copy ends closed either way; `atLatest` is reported so a caller can say
      // which of the two actually happened.
      const requested = requestedBoundary(request?.atSeq, source.events)
      const latest = latestCompletedPrefixBoundary(source.events)
      const boundary = requested ?? latest
      if (boundary === undefined) {
        throw new BranchFailure(
          BRANCH_FAILURES.nothingToBranch,
          `session "${sessionId}" has no completed turn to migrate`,
          '这个任务还没有完成过一轮，没有可迁移的对话。先让它跑完一轮，再以别的模式新建。',
        )
      }
      const atLatest = boundary === latest

      // 3. One call builds the session in the requested mode from that history.
      //    The seed is the Host's own construction: an inclusive prefix copy plus
      //    the inherited cut marker. It is read once, lazily, so a Host that
      //    cannot supply the module still migrates through the local builder.
      const buildSeed = this.hooks.forkSeed ?? loadForkSeed
      const seed = ((await buildSeed()) ?? localForkSeed)(source.events, boundary)
      const workspace = await branchWorkspace(workspaceRegistry, sessionQuery, source.header)
      // The child MUST be created with a provider and a model: prompt assembly
      // reads them from the Agent's own options, so omitting them breaks the
      // child's first turn outright. See {@link readSelection}.
      const selection = readSelection(sessionController, agents, sessionId, agentDefaultModel)
      // Refuse rather than build a Session that cannot run a single turn. Prompt
      // assembly needs `{{provider}}` and `{{model}}` from these options; without
      // a readable one the branch would publish and then fail its first turn with
      // "prompt variable "{{model}}" has no value for this assembly", which reads
      // as a broken feature rather than a missing default.
      if (selection === undefined) {
        throw new BranchFailure(
          BRANCH_FAILURES.modelUnavailable,
          'no provider/model could be resolved for the branch (no live selection, no agent creation options and no deployment default)',
          '读不出该用哪个模型：源会话当前没在运行，部署也没有默认模型。请先在任意会话里选一次模型，再重试。',
        )
      }
      const childId = mintSessionId()
      let created
      try {
        created = await agents.create({
          sessionId: childId,
          seed,
          inheritedEventCount: boundary + 1,
          meta: {
            ...(source.header.cwd === undefined ? {} : { cwd: source.header.cwd }),
            parentSession: source.header.id,
            isSeeded: true,
            agentPreset: targetPreset,
          },
          agentOptions: selection,
          setup: async (agentCtx, agent) => {
            // `recompose` is the registry's own composition step — it rebinds the
            // unpublished Agent AND emits the `tools/change` signal consumers
            // listen for, which a bare `mount` does not. It is the same call
            // ordinary session creation makes through the controller.
            if (typeof presets.recompose === 'function') await presets.recompose(agentCtx, targetPreset)
            else await presets.mount(agentCtx, targetPreset)
            // ...and then make the two prompt variables the deployment persona may
            // reference resolvable on THIS child, before it is ever published.
            pinPromptVariables(agentCtx, selection)
            // Record the choice in the session's own log, the way the registry's
            // own `select()` does. The `agentPreset` projection is folded from
            // the header OR from this event, so writing it makes the durable
            // record — which is what the mode badge and every later resume read —
            // say the same thing as the live composition.
            try {
              const applied = agentCtx?.get?.('agentPresets')?.composedPreset?.(agentCtx)
              const recorded = typeof applied === 'string' && applied !== '' ? applied : targetPreset
              agent?.session?.append?.('agent-preset/selected', { agentPreset: recorded })
            } catch (error) {
              this.hooks.log?.('warn', `branch ${childId}: the session log would not take the preset selection: ${messageOf(error)}`)
            }
            installSelection(sessionController, agent, selection)
          },
        })
        if (created === undefined) {
          throw new BranchFailure(BRANCH_FAILURES.branchIncomplete, 'the Agent registry answered without a handle', '新建会话没有返回结果。')
        }
      } catch (error) {
        if (error instanceof BranchFailure) throw error
        // The preset is composed inside `setup`, so an unknown mode surfaces from
        // creation rather than from `resolve` above.
        const isUnknownPreset = error?.code === BRANCH_FAILURES.unknownPreset || /unknown agent preset/i.test(messageOf(error))
        if (isUnknownPreset) {
          throw new BranchFailure(BRANCH_FAILURES.unknownPreset, messageOf(error), `没有这个模式：${reasonOf(error)}`)
        }
        throw new BranchFailure(BRANCH_FAILURES.branchFailed, messageOf(error), `无法以「${targetPreset}」新建会话：${reasonOf(error)}`)
      }

      // 4. Put it beside the conversation it came from.
      if (workspace !== undefined) {
        try {
          await workspace.attachSession(childId)
        } catch (error) {
          this.hooks.log?.('warn', `branch ${childId} was created but could not attach to workspace ${workspace.id}: ${messageOf(error)}`)
        }
      }

      // 5. Confirm the mode the new session actually runs, and say it in the log.
      //    A session that came up in the wrong mode is the one failure this
      //    feature can hide, so it is reported rather than assumed away — and the
      //    live composition and the durable record are reported separately,
      //    because they can disagree.
      const childAgent = agents.get(childId)
      const applied = readComposedPreset(presets, sessionController, childAgent)
      const durable = typeof childAgent?.session?.header?.agentPreset === 'string' ? childAgent.session.header.agentPreset : undefined
      if (applied !== undefined && applied !== targetPreset) {
        this.hooks.log?.('warn', `branch ${childId} runs preset "${applied}" but "${targetPreset}" was requested`)
      } else if (durable !== undefined && durable !== targetPreset) {
        this.hooks.log?.('warn', `branch ${childId} runs "${applied ?? targetPreset}" but its record says "${durable}"`)
      } else {
        this.hooks.log?.('info', `branch ${childId} created from ${sessionId} in preset "${targetPreset}" on ${selection.provider}/${selection.model} (record: ${durable ?? applied ?? 'unconfirmed'})`)
      }
      // The route is on the record too: a branch that came up without the model
      // it was created with is otherwise only visible as a broken first turn.
      const liveModel = childAgent?.options?.model
      if (typeof liveModel !== 'string' || liveModel !== selection.model) {
        this.hooks.log?.('warn', `branch ${childId} was created on ${selection.provider}/${selection.model} but its Agent reports model "${String(liveModel)}"`)
      }

      this.hooks.announceToolsChange?.()

      // 6. Rewrite the title. A refusal here must not lose the session that
      //    already exists, so it is reported rather than thrown.
      let titleApplied = false
      if (requestedTitle !== '' && childAgent !== undefined) {
        try {
          await sessionController?.rename?.({ sessionId: childId, title: requestedTitle })
          titleApplied = true
        } catch {
          titleApplied = false
        }
      }

      return {
        sessionId: childId,
        agentPreset: targetPreset,
        currentPreset: applied ?? targetPreset,
        recordedPreset: durable,
        titleApplied,
        parentSession: sessionId,
        // The cut the copy actually used, and whether that was the default. A
        // caller that asked for an earlier turn can tell whether it got it.
        atSeq: boundary,
        atLatest,
        inheritedEventCount: boundary + 1,
        // The route the child was created on. Reported so a caller can see that
        // the branch carries a model instead of discovering it from a first turn
        // that cannot assemble its prompt.
        provider: selection.provider,
        model: selection.model,
      }
    } finally {
      // The observation is a lease; releasing it is what lets a live Session
      // keep writing.
      try {
        await source?.release?.()
      } catch {
        // Releasing twice, or after the lease already settled, is not an error.
      }
    }
  }

  /**
   * Report a Session's modes: the durable record and the live composition
   * separately, because this feature fails exactly when those two disagree.
   *
   * The durable side answers from the live Agent when there is one (no extra
   * persistence read), and falls back to `observeSession` for a stopped Session.
   * @param {object} request - describe request.
   * @param {string} request.sessionId - the Session to describe.
   * @returns {Promise<object>} the report.
   * @throws {BranchFailure} when the Session cannot be read.
   */
  async describe(request) {
    const sessionId = requireIdentity(request?.sessionId, 'sessionId')
    const { presets, agents, sessionQuery } = this.hooks.services()
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    let headerPreset
    let lastSelected
    let eventCount
    if (agent !== undefined) {
      headerPreset = agent.session?.header?.agentPreset
      try {
        const events = agent.session?.snapshotEvents?.() ?? []
        eventCount = events.length
        lastSelected = events.findLast((event) => event?.type === 'agent-preset/selected')?.data?.agentPreset
      } catch {
        // A log that cannot be snapshotted simply reports no events.
      }
    } else if (sessionQuery !== undefined) {
      try {
        const observation = await sessionQuery.observeSession(sessionId)
        try {
          headerPreset = observation.header?.agentPreset
          eventCount = observation.events?.length
          lastSelected = observation.events?.findLast?.((event) => event?.type === 'agent-preset/selected')?.data?.agentPreset
        } finally {
          await observation.release?.().catch?.(() => {}) ?? undefined
        }
      } catch (error) {
        throw new BranchFailure(BRANCH_FAILURES.branchFailed, messageOf(error), `读不出这个会话：${reasonOf(error)}`)
      }
    }
    const composed = agent === undefined ? undefined : readComposedPreset(presets, undefined, agent)
    const recorded = lastSelected ?? headerPreset
    return {
      sessionId,
      live: agent !== undefined,
      headerPreset,
      lastSelected,
      recordedPreset: recorded,
      composedPreset: composed,
      eventCount,
      agrees: composed === undefined || recorded === undefined || composed === recorded,
    }
  }

  /**
   * Switch a Session that has run nothing yet into another mode, in place.
   *
   * This is the mode change DSH itself supports: the registry's `select()`
   * refuses once a turn exists, and that refusal is surfaced verbatim rather
   * than worked around. A caller with a started Session wants {@link branch}.
   *
   * @param {object} request - switch request.
   * @param {string} request.sessionId - the Session to switch.
   * @param {string} request.agentPreset - the mode to adopt.
   * @returns {Promise<{agentPreset: string}>} the committed mode.
   * @throws {BranchFailure} on any refusal.
   */
  async switchInPlace(request) {
    const sessionId = requireIdentity(request?.sessionId, 'sessionId')
    const agentPreset = requireIdentity(request?.agentPreset, 'agentPreset')
    const { presets, agents } = this.hooks.services()
    if (presets === undefined) {
      throw new BranchFailure(BRANCH_FAILURES.unavailable, 'this deployment mounts no agent-preset registry', '当前部署没有挂载 Agent 预设注册表。')
    }
    try {
      await presets.resolve(agentPreset)
    } catch (error) {
      throw new BranchFailure(BRANCH_FAILURES.unknownPreset, messageOf(error), `没有这个模式：${reasonOf(error)}`)
    }
    const agent = typeof agents?.get === 'function' ? agents.get(sessionId) : undefined
    if (agent === undefined) {
      throw new BranchFailure(
        BRANCH_FAILURES.noLiveAgent,
        `session "${sessionId}" has no live Agent`,
        '这个任务当前不在可切换状态（会话未运行或已结束）。已开始的任务请改用「以该模式分支」。',
      )
    }
    try {
      const selected = await presets.select(agent, agentPreset)
      return { agentPreset: typeof selected === 'string' && selected !== '' ? selected : agentPreset }
    } catch (error) {
      const code = error?.code === BRANCH_FAILURES.presetLocked ? BRANCH_FAILURES.presetLocked : BRANCH_FAILURES.presetRefused
      throw new BranchFailure(
        code,
        messageOf(error),
        code === BRANCH_FAILURES.presetLocked
          ? '这个任务已经开始了，模式不能再改。请用「以该模式分支」开一条继承上下文的支线。'
          : `无法切换模式：${reasonOf(error)}`,
      )
    }
  }
}
