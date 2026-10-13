/**
 * dsh-agent-preset-branch — Client half.
 *
 * Two surfaces, one engine:
 *
 * 1. The Session header. The mode control the product ships read-only, made
 *    actionable — with one deliberate difference from a plain mode switcher: the
 *    row below the mode list does not start a new task, it BRANCHES this one. A
 *    blank Session switches in place; a started Session is copied into a new
 *    Session that runs the chosen mode and inherits everything up to the last
 *    completed turn.
 * 2. The completed turn's action row. A mode pill sits beside the product's own
 *    branch button; opening it lists the modes and picking one branches this
 *    conversation under it in a single click.
 *
 * The header control is unchanged on purpose: the shipped label registered by
 * `@deepseek-ai/dsh-client-ui-agent-preset` in `conversation.session.header.actions`
 * is replaced in place (same id, priority -1 — a list slot elects the lowest
 * priority per id). The row pill is a plain addition to
 * `conversation.chat.assistant-actions`, the strip the Chat owner renders with
 * its own copy and branch icons — the owner's own `extraActions` seat, one cell
 * added beside the shipped ones. Both popovers are the shipped `Menu`, a refusal
 * is the shipped `Toast`, and every colour is a design-system token.
 */
window.__ModuleLoader__.load({
  id: 'dsh-agent-preset-branch',
  factory(require) {
    const React = require('react')
    const primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    const {
      Menu, Toast,
      IconAgentPresetOutlineRegular, IconChevronDownOutlineRegular,
      IconCheckOutlineRegular, IconWarningOutlineRegular,
    } = primitives
    const h = React.createElement
    const { Fragment, useCallback, useEffect, useRef, useState, useSyncExternalStore } = React

    const NS = 'dsh-agent-preset-branch'
    const LIST_PATH = '/dsh-agent-preset-branch/list'
    const BRANCH_PATH = '/dsh-agent-preset-branch/branch'
    const SWITCH_PATH = '/dsh-agent-preset-branch/switch'

    /** How long a refusal banner stays up; the shipped toast default is 3s. */
    const TOAST_HOLD_MS = 8000

    /**
     * How often the roster is re-read while the card is open.
     *
     * A preset can be created (or a broken one repaired) by another surface at
     * any moment, and the page has no event for the registry: the open card
     * polls, and every open starts with a fresh read.
     */
    const ROSTER_POLL_MS = 15000

    const DICT = {
      zh: {
        'hint.pick': '以某个模式新建会话，并把当前对话迁移过去',
        'hint.blank': '任务还没开始，选中的模式会直接用于这个任务',
        'action.branch': '以「{name}」新建会话',
        'action.branchBusy': '正在新建会话…',
        'action.switch': '切换为「{name}」',
        'action.switchBusy': '正在切换…',
        'toast.branchFailed': '无法新建会话：{reason}',
        'toast.branchDone': '已新建「{name}」会话，并迁移了当前对话（模型 {route}）',
        'toast.branchMismatch': '会话已新建，但它的模式记录是「{got}」而不是「{want}」',
        'toast.branchUnconfirmed': '会话已新建并迁移对话，但宿主没有回报它的模式',
        'toast.switchFailed': '无法切换模式：{reason}',
        'route.unknown': '未回报',
        'noDescription': '暂无描述。',
        'empty': '没有可用的模式。',
        'toast.listFailed': '读取模式列表失败：{reason}',
        'preset.standard': '标准模式',
        'preset.ptc': 'PTC 模式',
        'preset.minimal': '极简模式',
        'preset.cordis': '创造模式',
        'preset.standard.description': '处理代码、文件和资料，适合大多数任务。Agent 会按需使用检索、编辑和终端等工具。',
        'preset.ptc.description': '包含标准模式的所有能力，更适合批量调用工具，并对结果进行筛选、整理、去重、统计或汇总的任务。',
        'preset.minimal.description': 'Agent 仅使用终端工具完成任务，适合测试和对比其基础表现。',
        'preset.cordis.description': '用对话定制 DSH：让 Agent 编写插件，添加新功能或界面；也能组合工具和提示词，创建自己的模式。',
        'menuLabel': '模式分支',
        'current': '当前：{name}',
        'pill.label': '分支模式',
        'pill.aria': '以其它模式新建会话',
        'pill.hint': '选一个模式，就以该模式新建一个会话，并把当前对话迁移过去',
        'pill.hintEarlier': '选一个模式，就以该模式新建会话，并从这轮（{cut}）之前的对话接上',
        'pill.busy': '正在以「{name}」新建会话…',
        'pill.pendingHint': '正在新建会话，请稍候',
        'pill.cut': '切点：第 {turn} 轮末尾',
        'pill.seq': '切点：事件 {seq}',
        'toast.pillStarted': '正在以「{name}」新建会话…',
        'toast.branchDoneAt': '已新建「{name}」会话，并从{cut}迁移了对话（模型 {route}）',
      },
      en: {
        'hint.pick': 'Start a session in another mode and migrate this conversation into it',
        'hint.blank': 'Nothing has run yet; the chosen mode applies to this task directly',
        'action.branch': 'New session in “{name}”',
        'action.branchBusy': 'Starting a session…',
        'action.switch': 'Switch to “{name}”',
        'action.switchBusy': 'Switching…',
        'toast.branchFailed': 'Could not start the session: {reason}',
        'toast.branchDone': 'Started a “{name}” session and migrated this conversation (model {route})',
        'toast.branchMismatch': 'The session was created, but its record says “{got}” instead of “{want}”',
        'toast.branchUnconfirmed': 'The session was created and the conversation migrated, but the Host reported no mode for it',
        'toast.switchFailed': 'Could not switch mode: {reason}',
        'route.unknown': 'not reported',
        'noDescription': 'No description.',
        'empty': 'No mode is available.',
        'toast.listFailed': 'Could not read the mode list: {reason}',
        'preset.standard': 'Standard mode',
        'preset.ptc': 'PTC mode',
        'preset.minimal': 'Minimal mode',
        'preset.cordis': 'Creator mode',
        'preset.standard.description': 'Work with code, files, and information. Suitable for most tasks, with search, editing, terminal commands, and other tools available as needed.',
        'preset.ptc.description': 'Includes all Standard mode capabilities. Better suited to tasks that call tools in batches and then filter, organize, deduplicate, count, or summarize the results.',
        'preset.minimal.description': 'The agent works using only a terminal tool. Useful for testing and comparing its basic performance.',
        'preset.cordis.description': 'Customize DSH through conversation. Let the agent write plugins that add features or UI, or combine tools and prompts to create your own mode.',
        'menuLabel': 'Branch mode',
        'current': 'Current: {name}',
        'pill.label': 'Branch mode',
        'pill.aria': 'Start a session in another mode',
        'pill.hint': 'Pick a mode to start a session in it and migrate this conversation into it',
        'pill.hintEarlier': 'Pick a mode to start a session in it, continuing from the conversation up to this turn ({cut})',
        'pill.busy': 'Starting a “{name}” session…',
        'pill.pendingHint': 'A session is being created; one moment',
        'pill.cut': 'Cut: end of turn {turn}',
        'pill.seq': 'Cut: event {seq}',
        'toast.pillStarted': 'Starting a “{name}” session…',
        'toast.branchDoneAt': 'Started a “{name}” session and migrated the conversation from {cut} (model {route})',
      },
    }

    /** Fill one `{name}` placeholder set. */
    function interpolate(text, params) {
      if (params === undefined) return text
      return text.replace(/\{(\w+)\}/g, (match, name) => (name in params ? String(params[name]) : match))
    }

    /** Translate through the registered locale when there is one, else the zh table. */
    let translate = null
    function t(key, params) {
      if (translate !== null) {
        try {
          const value = translate(key, params)
          if (typeof value === 'string' && value !== '') return value
        } catch {
          // A missing key falls through to the local table.
        }
      }
      const fallback = DICT.zh[key]
      return typeof fallback === 'string' ? interpolate(fallback, params) : key
    }

    /**
     * The few declarations the shipped primitives leave to the caller.
     *
     * The anchor mirrors the label this control replaces: `--dsw-alias-fill-tsp-
     * secondary` (the fill that label names) is not a token this build defines,
     * so that label renders with no fill at all — the anchor keeps exactly that
     * flat look and only takes the hover fill while it is hovered or open.
     */
    const CSS = `
.dapb-anchor{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:22px;max-width:180px;padding:0 4px;border:none;border-radius:var(--dsw-radius-xs);background:transparent;color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:22px;white-space:nowrap;cursor:pointer}
.dapb-anchor:hover:not(:disabled),.dapb-anchor[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dapb-anchor:disabled{cursor:default;opacity:.6}
.dapb-anchor:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:-2px}
.dapb-icon{flex:none;opacity:.7}
.dapb-chevron{flex:none;color:var(--dsw-alias-label-caption)}
.dapb-text{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dapb-card{min-width:300px}
.dapb-row{display:flex;flex-direction:column;gap:2px;min-width:0;width:100%}
.dapb-rowLabel{display:flex;align-items:center;gap:6px;min-width:0;color:var(--dsw-alias-label-primary);font-size:13px;line-height:20px}
.dapb-rowLabel>span:first-child{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dapb-check{flex:none;margin-inline-start:auto;color:var(--dsw-alias-label-primary)}
.dapb-desc{color:var(--dsw-alias-label-caption);white-space:normal;font-size:12px;line-height:16px}
.dapb-action{display:flex;align-items:center;gap:6px;min-width:0;cursor:pointer}
.dapb-action[aria-disabled=true]{opacity:.4;cursor:not-allowed}
.dapb-pillWrap{display:inline-flex;align-items:center}
.dapb-pill{box-sizing:border-box;display:inline-flex;align-items:center;gap:4px;height:22px;max-width:140px;padding:0 8px;border:none;border-radius:999px;background:var(--dsw-alias-bg-layer-2);color:var(--dsw-alias-label-tertiary);font:inherit;font-size:12px;line-height:22px;white-space:nowrap;cursor:pointer;transition:background-color .12s,color .12s}
.dapb-pill:hover:not(:disabled),.dapb-pill[aria-expanded=true]{background:var(--dsw-alias-interactive-bg-hover);color:var(--dsw-alias-label-secondary)}
.dapb-pill:disabled{cursor:default;opacity:.5}
.dapb-pill:focus-visible{outline:var(--dsw-focus-ring-width) solid var(--dsw-focus-ring-color);outline-offset:1px}
.dapb-pill[data-state=busy]{opacity:.6}
.dapb-pillIcon{flex:none;opacity:.75}
.dapb-pillChevron{flex:none;color:var(--dsw-alias-label-caption)}
.dapb-pillText{min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.dapb-pillLabel{color:var(--dsw-alias-label-caption)}
`

    /** The plugin's stylesheet, mounted with the control. */
    function Styles() {
      return h('style', { 'data-dsh-plugin': NS, children: CSS })
    }

    /** The built-in preset names, which the declarations leave to the dictionary. */
    const BUILT_IN_NAMES = {
      standard: 'preset.standard',
      ptc: 'preset.ptc',
      minimal: 'preset.minimal',
      cordis: 'preset.cordis',
    }

    /** Their description keys, for a registry that publishes none. */
    const BUILT_IN_DESCRIPTIONS = {
      standard: 'preset.standard.description',
      ptc: 'preset.ptc.description',
      minimal: 'preset.minimal.description',
      cordis: 'preset.cordis.description',
    }

    /**
     * Display copy for one roster row.
     * @param {object} preset - roster row.
     * @returns {{name: string, description: string}} display copy.
     */
    function presetText(preset) {
      const declaredName = typeof preset?.name === 'string' && preset.name !== '' ? preset.name : undefined
      const declaredDescription = typeof preset?.description === 'string' && preset.description !== '' ? preset.description : undefined
      const key = BUILT_IN_NAMES[preset?.id]
      const name = declaredName ?? (key === undefined ? String(preset?.id ?? '') : t(key))
      const descriptionKey = BUILT_IN_DESCRIPTIONS[preset?.id]
      const description = declaredDescription
        ?? (declaredName === undefined && descriptionKey !== undefined ? t(descriptionKey) : undefined)
        ?? t('noDescription')
      return { name, description }
    }

    /** One Host answer turned into a refusal, or undefined when it succeeded. */
    function refusalOf(payload, status) {
      if (payload !== null && typeof payload === 'object' && payload.ok === true) return undefined
      const reason = payload !== null && typeof payload === 'object'
        ? (typeof payload.reason === 'string' && payload.reason !== '' ? payload.reason : payload.message)
        : undefined
      return { reason: typeof reason === 'string' && reason !== '' ? reason : `HTTP ${status}` }
    }

    /** Ask the Host for the selectable roster. */
    async function fetchRoster() {
      const response = await fetch(LIST_PATH, { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      const refusal = refusalOf(payload, response.status)
      if (refusal !== undefined) throw new Error(refusal.reason)
      return { presets: payload.presets ?? [], defaultId: payload.defaultId }
    }

    /**
     * Ask the Host to copy this Session into another mode.
     * @returns {Promise<{sessionId?: string, refusal?: {reason: string}}>} the branch or a refusal.
     */
    async function requestBranch(payload) {
      const response = await fetch(BRANCH_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload),
      })
      const answer = await response.json().catch(() => null)
      const refusal = refusalOf(answer, response.status)
      if (refusal !== undefined) return { refusal }
      return {
        sessionId: answer.sessionId,
        agentPreset: answer.agentPreset,
        currentPreset: answer.currentPreset,
        // What the new session's own record says. Present so the outcome can be
        // reported instead of assumed.
        recordedPreset: answer.recordedPreset,
        // The cut the Host actually used, and whether it was the default. A
        // caller that asked for an earlier turn can tell whether it got it.
        atSeq: answer.atSeq,
        atLatest: answer.atLatest,
        // The route the child was created on: the one value whose absence leaves
        // the child unable to assemble its first prompt, so success names it.
        model: answer.model,
      }
    }

    /**
     * Switch this Session's mode in place, through this plugin's own Host.
     *
     * Only the shipped registry can do this, and only while the Session has run
     * nothing; the Host route surfaces the registry's refusal verbatim when it
     * cannot (`agent-preset/locked`).
     */
    async function requestSelect(sessionId, agentPreset) {
      try {
        const response = await fetch(SWITCH_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, agentPreset }),
        })
        const payload = await response.json().catch(() => null)
        return refusalOf(payload, response.status)
      } catch (error) {
        return { reason: error instanceof Error ? error.message : String(error) }
      }
    }

    /** The list readers the control falls back to, and the reveal it uses. */
    let bridgeSessions = () => undefined
    let bridgeWorkspaces = () => undefined
    let openSession = () => {
      throw new Error('this page has no workspace navigation service to reveal a Session with')
    }

    /**
     * Announce what a successful branch actually produced.
     *
     * A copy that came up in the wrong mode is the one failure this feature can
     * hide, so the outcome is named in the same breath as the jump — including
     * the case where the Host could not confirm it. The session exists by now,
     * so a page that cannot reveal it is reported without undoing anything.
     * @param {{sessionId?: string, agentPreset?: string, currentPreset?: string, recordedPreset?: string, atSeq?: number}} answer - the Host's answer.
     * @param {(text: string) => void} announce - the surface's refusal/echo channel.
     * @param {{seq: number, turn?: number, atLatest?: boolean}} [cut] - the branch point the caller asked for.
     */
    function announceBranchOutcome(answer, announce, cut) {
      const recorded = answer.recordedPreset ?? answer.currentPreset
      // A branch the caller pinned to an earlier turn says so; the default cut
      // keeps the shipped sentence, so the two surfaces read the same.
      const where = cut === undefined || cut.atLatest === true || answer.atLatest === true
        ? undefined
        : (cut.turn === undefined ? t('pill.seq', { seq: cut.seq }) : t('pill.cut', { turn: cut.turn }))
      // The model travels with the success message on purpose: a branch created
      // without one publishes fine and then dies on its first turn.
      const route = typeof answer.model === 'string' && answer.model !== '' ? answer.model : undefined
      if (recorded === undefined) announce(t('toast.branchUnconfirmed'))
      else if (recorded !== answer.agentPreset) announce(t('toast.branchMismatch', { got: recorded, want: answer.agentPreset }))
      else if (where === undefined) announce(t('toast.branchDone', { name: presetText({ id: recorded }).name, route: route ?? t('route.unknown') }))
      else announce(t('toast.branchDoneAt', { name: presetText({ id: recorded }).name, cut: where, route: route ?? t('route.unknown') }))
      try {
        openSession(answer.sessionId)
      } catch (error) {
        announce(t('toast.branchFailed', { reason: error instanceof Error ? error.message : String(error) }))
      }
    }

    /** One mode row: the name with the selected marker at its trailing edge, description under it. */
    function PresetRow({ preset, selected }) {
      const copy = presetText(preset)
      return h('span', { className: 'dapb-row', 'data-mode-row': preset.id }, [
        h('span', { key: 'name', className: 'dapb-rowLabel' }, [
          h('span', { key: 'text', children: copy.name }),
          selected ? h(IconCheckOutlineRegular, { key: 'check', size: 14, className: 'dapb-check' }) : null,
        ]),
        h('span', { key: 'desc', className: 'dapb-desc', children: copy.description }),
      ])
    }

    /**
     * The header control.
     *
     * The anchor is always a button — the mode can be read and reopened at any
     * time — and every refusal is reported in words.
     */
    function AgentPresetBranch(props) {
      const { sessionId } = props
      const readSessions = typeof props.useSessions === 'function' ? props.useSessions : bridgeSessions
      const readWorkspaces = typeof props.useWorkspaces === 'function' ? props.useWorkspaces : bridgeWorkspaces
      const summary = readSessions((state) => {
        const row = state?.byId?.[sessionId]
        if (row === undefined) return undefined
        const preset = row.projectionValues?.agentPreset
        return {
          preset: typeof preset === 'string' ? preset : undefined,
          blank: row.blank === true,
          running: row.running === true,
          mainView: (row.retainedBy?.mainView ?? 0) > 0,
          title: typeof row.displayTitle === 'string' ? row.displayTitle : '',
        }
      })
      const workspaceId = readWorkspaces((state) => state?.items?.find((item) => Array.isArray(item.sessionIds) && item.sessionIds.includes(sessionId))?.workspaceId)
      const [roster, setRoster] = useState(null)
      const [rosterError, setRosterError] = useState(null)
      const [open, setOpen] = useState(false)
      const [working, setWorking] = useState(false)
      const [optimistic, setOptimistic] = useState(undefined)
      const [toast, setToast] = useState(null)
      const toastSeq = useRef(0)

      const load = useCallback(() => {
        fetchRoster().then(
          (value) => {
            setRoster(value)
            setRosterError(null)
          },
          (reason) => setRosterError(reason instanceof Error ? reason.message : String(reason)),
        )
      }, [])

      useEffect(() => {
        load()
      }, [load])

      useEffect(() => {
        if (!open) return undefined
        const poll = window.setInterval(load, ROSTER_POLL_MS)
        return () => window.clearInterval(poll)
      }, [open, load])

      useEffect(() => {
        const onFocus = () => load()
        window.addEventListener('focus', onFocus)
        return () => window.removeEventListener('focus', onFocus)
      }, [load])

      useEffect(() => {
        setOpen(false)
        setOptimistic((previous) => (previous !== undefined && previous.id === summary?.preset ? undefined : previous))
      }, [sessionId, summary?.preset])

      const announce = useCallback((text) => {
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text })
      }, [])

      const closeMenu = useCallback(() => setOpen(false), [])

      const toggleMenu = useCallback(() => {
        setOpen((value) => {
          if (!value) load()
          return !value
        })
      }, [load])

      if (summary === undefined || summary.mainView !== true || summary.preset === undefined) return null

      const preset = summary.preset
      const shownId = optimistic === undefined ? preset : optimistic.id
      const selected = roster?.presets?.find((entry) => entry.id === shownId)
      const shown = selected === undefined ? { name: shownId, description: t('noDescription') } : presetText(selected)
      // Nothing has run yet → the mode can still be adopted in place, and the
      // row says so. Anything else can only continue under another mode as a
      // copy of this conversation, which is what the row does.
      const canSwitchInPlace = summary.blank === true && summary.running !== true
      const options = roster?.presets ?? []
      const builtIn = options.filter((entry) => typeof entry.name !== 'string' || entry.name === '')
      const custom = options.filter((entry) => typeof entry.name === 'string' && entry.name !== '')

      /** Change the shown mode in place; only the shipped registry can, and only while nothing has run. */
      const switchInPlace = (id, done) => {
        requestSelect(sessionId, id).then(
          (refusal) => {
            done()
            setOptimistic(undefined)
            if (refusal === undefined) return
            announce(t('toast.switchFailed', { reason: refusal.reason }))
          },
          (reason) => {
            done()
            setOptimistic(undefined)
            announce(t('toast.switchFailed', { reason: reason instanceof Error ? reason.message : String(reason) }))
          },
        )
      }

      /**
       * Choose a mode.
       *
       * Picking never closes the card and never rewrites the Session by itself:
       * the tick and the row's wording change under the pointer, and the one
       * action below is what commits. A row click that silently changed the
       * Session's mode was the most confusing thing this control could do, so
       * the only in-place change left is the explicit action, offered solely for
       * a Session that has not run anything yet.
       */
      const pick = (id) => {
        setOptimistic(id === preset ? undefined : { id })
      }

      /**
       * The row's one action.
       *
       * Nothing has run → adopt the shown mode in place (the registry allows it).
       * Something has run → copy the conversation into a new Session composed
       * from the shown mode, carrying this task's title, and reveal it. The
       * parent is never touched.
       */
      const run = () => {
        if (working) return
        setWorking(true)
        if (canSwitchInPlace) {
          switchInPlace(shownId, () => setWorking(false))
          return
        }
        requestBranch({
          sessionId,
          agentPreset: shownId,
          ...(summary.title === '' ? {} : { title: summary.title }),
        }).then(
          (answer) => {
            setWorking(false)
            if (answer.refusal !== undefined) {
              announce(t('toast.branchFailed', { reason: answer.refusal.reason }))
              return
            }
            setOpen(false)
            setOptimistic(undefined)
            announceBranchOutcome(answer, announce)
          },
          (reason) => {
            setWorking(false)
            announce(t('toast.branchFailed', { reason: reason instanceof Error ? reason.message : String(reason) }))
          },
        )
      }

      /** One mode row, carried as the menu entry's label. */
      const row = (entry) => ({
        id: entry.id,
        label: h(PresetRow, { preset: entry, selected: entry.id === shownId }),
      })

      /**
       * The `Menu`'s special rows.
       *
       * `Menu` marks a special row with `type`, never with a boolean: an entry
       * carrying `separator: true` is an ordinary cell, which renders a blank
       * full-height button and reports an internal id when clicked.
       */
      const SEPARATOR = (id) => ({ id, type: 'separator' })

      const items = [
        // Only a Session that has run nothing shows its current mode as a
        // disabled label: there, re-picking it would be a no-op, and `Menu`
        // cannot express a disabled entry.
        !canSwitchInPlace || !options.some((entry) => entry.id === preset)
          ? null
          : { id: '__current', type: 'label', text: t('current', { name: presetText({ id: preset }).name }) },
        ...builtIn.map(row),
        builtIn.length > 0 && custom.length > 0 ? SEPARATOR('__custom-sep') : null,
        ...custom.map(row),
        options.length === 0 && rosterError === null ? { id: '__empty', type: 'label', text: t('empty') } : null,
        rosterError === null ? null : { id: '__error', type: 'label', text: t('toast.listFailed', { reason: rosterError }) },
      ].filter((entry) => entry !== null)

      const actionText = canSwitchInPlace
        ? (working ? t('action.switchBusy') : t('action.switch', { name: shown.name }))
        : (working ? t('action.branchBusy') : t('action.branch', { name: shown.name }))

      return h(Fragment, null, [
        h(Menu, {
          key: 'menu',
          open,
          onClose: closeMenu,
          items,
          onSelect: pick,
          align: 'start',
          portal: true,
          listClassName: 'dapb-card',
          // `Menu` draws its own hairline above the footer, so no separator
          // entry here; the footer takes entries, not a node.
          footer: [
            {
              id: '__branch-action',
              label: h('span', {
                className: 'dapb-action',
                'data-branch-action': canSwitchInPlace ? 'switch' : 'branch',
                role: 'button',
                tabIndex: working ? undefined : 0,
                'aria-disabled': working ? 'true' : undefined,
                onClick: run,
                onKeyDown: (event) => {
                  if (event.key !== 'Enter' && event.key !== ' ') return
                  event.preventDefault()
                  run()
                },
                children: actionText,
              }),
            },
          ],
          anchor: h('button', {
            type: 'button',
            className: 'dapb-anchor',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            title: canSwitchInPlace ? t('hint.blank') : t('hint.pick'),
            onClick: toggleMenu,
            children: [
              h(IconAgentPresetOutlineRegular, { key: 'icon', size: 14, className: 'dapb-icon' }),
              h('span', { key: 'text', className: 'dapb-text', children: shown.name }),
              h(IconChevronDownOutlineRegular, { key: 'chev', size: 12, className: 'dapb-chevron' }),
            ],
          }),
        }),
        toast === null
          ? null
          : h(Toast, {
            key: `toast-${toast.seq}`,
            text: toast.text,
            icon: h(IconWarningOutlineRegular, { size: 14 }),
            holdMs: TOAST_HOLD_MS,
            onDone: () => setToast(null),
          }),
      ])
    }

    /** The control plus its stylesheet. */
    function AgentPresetBranchWithStyles(props) {
      return h(Fragment, null, [h(Styles, { key: 'style' }), h(AgentPresetBranch, { key: 'control', ...props })])
    }

    /**
     * The mode pill beside the product's own branch button.
     *
     * It sits in the completed turn's action row, which the Chat owner renders in
     * `conversation.chat.assistant-actions` and hands `messageId`. Picking a mode
     * commits at once — there is no footer here, because the row already says
     * what the click does — and the resulting Session inherits this conversation
     * through THIS row's completed turn. That is what makes every turn in the
     * transcript usable rather than only the last one: the cut travels with the
     * click as `atSeq`, so a pill on turn 2 branches off the conversation as it
     * stood at the end of turn 2, with nothing from turn 3 onward. The
     * confirmations and refusals are the header control's own sentences, so the
     * two surfaces cannot drift apart.
     *
     * A row with no completed turn, or one that is not a completed turn's closing
     * message, gets no pill: there is no closed boundary to cut at there, and the
     * product disables its own branch button on exactly those rows.
     *
     * @param props - the owner's message identity plus the Session seat.
     * @returns the pill and its menu, or null when this row holds no branch point.
     */
    function BranchModePill(props) {
      const { sessionId } = props
      const useChat = props.useChat
      const readSessions = typeof props.useSessions === 'function' ? props.useSessions : bridgeSessions
      const branchPoint = useChat === undefined
        ? undefined
        : useChat((snapshot) => {
          // This row's branch point, and — for the wording only — the last one.
          // `turn/end.seq` is the value the product's own branch button forks at
          // and the value the engine's cut resolves to; the closing `messageId`
          // is the row identity the owner hands every entry of this slot.
          let mine
          let latest
          const turns = snapshot?.timeline?.turns
          if (turns !== undefined && turns !== null) for (const turn of turns.values()) {
            const tail = turn?.data?.get?.('turn-tail')
            const seq = turn?.end?.seq
            if (seq === undefined || tail === undefined) continue
            const row = {
              seq,
              turn: typeof tail.turn === 'number' ? tail.turn : undefined,
              messageId: tail.closing?.finalNode?.messageId,
            }
            // The Map is in turn order, so the last completed turn wins.
            if (row.messageId === props.messageId) mine = row
            latest = row
          }
          return mine === undefined ? undefined : { seq: mine.seq, turn: mine.turn, atLatest: mine.seq === latest?.seq }
        })
      const currentId = readSessions((state) => {
        const preset = state?.byId?.[sessionId]?.projectionValues?.agentPreset
        return typeof preset === 'string' && preset !== '' ? preset : undefined
      })
      const [roster, setRoster] = useState(null)
      const [rosterError, setRosterError] = useState(null)
      const [open, setOpen] = useState(false)
      const [busy, setBusy] = useState(null)
      const [toast, setToast] = useState(null)
      const toastSeq = useRef(0)

      useEffect(() => {
        setOpen(false)
      }, [sessionId, branchPoint?.seq])

      const announce = useCallback((text) => {
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text })
      }, [])

      const closeMenu = useCallback(() => setOpen(false), [])

      // The roster is read on demand — this row can exist many times over one
      // transcript — and a failed read is reported inside the card rather than
      // as a toast for a menu the user only just opened.
      const load = useCallback(() => {
        fetchRoster().then(
          (value) => {
            setRoster(value)
            setRosterError(null)
          },
          (reason) => setRosterError(reason instanceof Error ? reason.message : String(reason)),
        )
      }, [])

      const toggleMenu = useCallback(() => {
        setOpen((value) => {
          if (!value) load()
          return !value
        })
      }, [load])

      /**
       * Branch this conversation under one mode, cut at this row's turn. One
       * click, one branch: the refusal is reported when it is final, and clicking
       * again starts again.
       */
      const start = (id) => {
        setOpen(false)
        setBusy(id)
        requestBranch({
          sessionId,
          agentPreset: id,
          ...(branchPoint === undefined ? {} : { atSeq: branchPoint.seq }),
        }).then(
          (answer) => {
            setBusy(null)
            if (answer.refusal !== undefined) {
              announce(t('toast.branchFailed', { reason: answer.refusal.reason }))
              return
            }
            announceBranchOutcome(answer, announce, branchPoint)
          },
          (reason) => {
            setBusy(null)
            announce(t('toast.branchFailed', { reason: reason instanceof Error ? reason.message : String(reason) }))
          },
        )
      }

      const row = (entry) => ({
        id: entry.id,
        disabled: busy !== null,
        label: h(PresetRow, { preset: entry, selected: entry.id === currentId }),
      })

      const SEPARATOR = (id) => ({ id, type: 'separator' })

      // No completed turn on this row, or this row is not that turn's closing
      // message → no pill. The product disables its own branch button there too.
      if (branchPoint === undefined) return null

      // Naming the cut is what keeps a historic pill honest: the click branches
      // here, not at the end of the conversation.
      const cutText = branchPoint.turn === undefined
        ? t('pill.seq', { seq: branchPoint.seq })
        : t('pill.cut', { turn: branchPoint.turn })

      const options = roster?.presets ?? []
      const builtIn = options.filter((entry) => typeof entry.name !== 'string' || entry.name === '')
      const custom = options.filter((entry) => typeof entry.name === 'string' && entry.name !== '')
      const items = [
        // The mode this conversation runs, for context: every row below starts a
        // NEW session, so the current one is a label and never a choice.
        currentId === undefined ? null : { id: '__current', type: 'label', text: t('current', { name: presetText({ id: currentId }).name }) },
        // ...and where the copy stops. A historic row says so explicitly, since
        // that is the one thing the shipped branch button never has to say.
        { id: '__cut', type: 'label', text: cutText },
        ...builtIn.map(row),
        builtIn.length > 0 && custom.length > 0 ? SEPARATOR('__custom-sep') : null,
        ...custom.map(row),
        options.length === 0 && rosterError === null ? { id: '__empty', type: 'label', text: t('empty') } : null,
        rosterError === null ? null : { id: '__error', type: 'label', text: t('toast.listFailed', { reason: rosterError }) },
      ].filter((entry) => entry !== null)

      return h(Fragment, null, [
        h(Menu, {
          key: 'menu',
          open,
          onClose: closeMenu,
          items,
          onSelect: start,
          // Left-aligned with the pill and opening to the right, exactly like the
          // header control's card: the portaled list is placed at the anchor's
          // left edge and clamped into the viewport, so a pill near the right
          // edge still gets a fully visible card.
          align: 'start',
          portal: true,
          listClassName: 'dapb-card',
          className: 'dapb-pillWrap',
          anchor: h('button', {
            type: 'button',
            className: 'dapb-pill',
            'data-branch-mode': 'pill',
            'data-cut': branchPoint.atLatest ? 'latest' : 'earlier',
            'data-state': busy === null ? 'idle' : 'busy',
            'aria-haspopup': 'menu',
            'aria-expanded': open,
            'aria-label': t('pill.aria'),
            disabled: busy !== null,
            title: busy !== null
              ? t('pill.pendingHint')
              : (branchPoint.atLatest ? t('pill.hint') : t('pill.hintEarlier', { cut: cutText })),
            onClick: toggleMenu,
            children: [
              h(IconAgentPresetOutlineRegular, { key: 'icon', size: 13, className: 'dapb-pillIcon' }),
              h('span', {
                key: 'text',
                className: 'dapb-pillText',
                children: busy === null
                  ? h('span', { key: 'label', className: 'dapb-pillLabel', children: t('pill.label') })
                  : t('pill.busy', { name: presetText({ id: busy }).name }),
              }),
              h(IconChevronDownOutlineRegular, { key: 'chev', size: 11, className: 'dapb-pillChevron' }),
            ],
          }),
        }),
        toast === null
          ? null
          : h(Toast, {
            key: `toast-${toast.seq}`,
            text: toast.text,
            icon: h(IconWarningOutlineRegular, { size: 14 }),
            holdMs: TOAST_HOLD_MS,
            onDone: () => setToast(null),
          }),
      ])
    }

    /** The pill plus its stylesheet. */
    function BranchModePillWithStyles(props) {
      return h(Fragment, null, [h(Styles, { key: 'style' }), h(BranchModePill, { key: 'control', ...props })])
    }

    return {
      inject: ['slots', 'sessions', 'workspaces', 'uiWorkspace'],
      apply(ctx) {
        const locale = ctx.get?.('locale')
        if (locale !== undefined && typeof locale.register === 'function' && typeof locale.bind === 'function') {
          ctx.effect(() => locale.register(NS, { zh: DICT.zh, en: DICT.en }), `${NS}: locale`)
          translate = locale.bind(NS)
        }

        /** One list service, as an external store, mirrored for React. */
        const bridgeStore = (store) => {
          let current = store?.getSnapshot?.()
          let listeners = new Set()
          const subscribe = (listener) => {
            listeners.add(listener)
            return () => {
              listeners.delete(listener)
            }
          }
          const getSnapshot = () => current
          if (store !== undefined && typeof store.subscribe === 'function' && typeof store.getSnapshot === 'function') {
            ctx.effect(() => store.subscribe(() => {
              const next = store.getSnapshot()
              if (next === current) return
              current = next
              for (const listener of [...listeners]) listener()
            }), `${NS}: store bridge`)
          }
          return {
            hook: (selector) => {
              const subscribeStable = useCallback((listener) => subscribe(listener), [])
              const snapshot = useSyncExternalStore(subscribeStable, getSnapshot, getSnapshot)
              return selector(snapshot)
            },
            reset: () => {
              listeners = new Set()
            },
          }
        }

        const sessionsBridge = bridgeStore(ctx.sessions?.list)
        bridgeSessions = sessionsBridge.hook
        const workspacesBridge = bridgeStore(ctx.workspaces?.list)
        bridgeWorkspaces = workspacesBridge.hook

        /** Reveal a Session in the main view, the way the sidebar does. */
        const workspaceService = ctx.get?.('uiWorkspace')
        openSession = (nextSessionId) => {
          if (workspaceService === undefined || typeof workspaceService.openSession !== 'function') {
            throw new Error('this page has no workspace navigation service to reveal a Session with')
          }
          workspaceService.openSession(nextSessionId)
        }

        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register(
          {
            name: 'conversation.session.header.actions',
            // The shipped label's own cell. A list slot elects one winner per id
            // at the lowest priority, so this replaces that label in place. Any
            // other plugin registering the same cell competes for it; only one
            // control is shown.
            id: 'agent-preset',
            priority: -1,
            order: -10,
            locale: NS,
            registrant: NS,
          },
          AgentPresetBranchWithStyles,
        ))

        ctx.slots.inject('conversation.chat.assistant-actions', () => ctx.slots.register(
          {
            name: 'conversation.chat.assistant-actions',
            // A cell of our own: a fresh id is ADDED beside the shipped entries
            // (the copy and branch icons, and any other plugin's), never a
            // replacement of one. `order` places it after them.
            id: 'branch-mode',
            order: 20,
            locale: NS,
            registrant: NS,
          },
          BranchModePillWithStyles,
        ))

        ctx.effect(() => () => {
          sessionsBridge.reset()
          workspacesBridge.reset()
          bridgeSessions = () => undefined
          bridgeWorkspaces = () => undefined
        }, `${NS}: bridge listeners`)
      },
      AgentPresetBranch,
    }
  },
})
