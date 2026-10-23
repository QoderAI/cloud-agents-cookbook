/**
 * Web / Desktop client: a 「云端模式」 switch in the New Session row
 * (`conversation.hero.options`). Turning it on selects the `qoder-cloud-agents`
 * agent preset for the blank session, whose turns then run on Qoder Cloud;
 * turning it off returns to the default preset. dsh locks the preset once
 * the session's first turn starts.
 *
 * Hand-written in the ModuleLoader format the Host serves for `exports["./client"]`;
 * React and the UI primitives come from the host.
 */
window.__ModuleLoader__.load({
  id: 'dsh-qoder-cloud-agents',
  factory(require) {
    const React = require('react')
    const { Switch, IconGlobeOutlineRegular } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const PRESET = 'qoder-cloud-agents'
    const NS = 'qoderCloudAgents'

    const zh = {
      label: '云端模式',
      on: '本会话的每一轮都交给 Qoder Cloud 云端 Agent 执行',
      off: '开启后，本会话的每一轮都交给 Qoder Cloud 云端 Agent 执行；当前目录的 git 仓库会挂载到云端',
      locked: '会话开始后不能切换模式',
      failed: '切换失败：',
    }
    const en = {
      label: 'Cloud mode',
      on: 'Every turn of this session runs on a Qoder Cloud agent',
      off: 'Run every turn of this session on a Qoder Cloud agent; the git repository of this workspace is mounted in the cloud',
      locked: 'The mode is fixed once the session starts',
      failed: 'Could not switch: ',
    }

    /** Message of a failed Remote result. */
    function refusal(error) {
      const reason = error && error.details && typeof error.details.reason === 'string' ? error.details.reason : undefined
      return reason || (error && error.message) || 'unknown error'
    }

    function CloudModeSwitch({ useMode, setCloud, t }) {
      // dsh turns `hooks.mode` into a selector hook: always pass a selector.
      const on = useMode(mode => mode.state === 'on')
      const locked = useMode(mode => !mode.blank)
      const [busy, setBusy] = React.useState(false)
      const [error, setError] = React.useState(null)
      const hint = error !== null ? t('failed') + error : locked ? t('locked') : on ? t('on') : t('off')
      return h('div', {
        title: hint,
        style: { display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 13, color: 'var(--text-secondary, inherit)' },
      },
      h(IconGlobeOutlineRegular, { size: 14 }),
      h('span', null, t('label')),
      h(Switch, {
        checked: on,
        label: t('label'),
        title: hint,
        disabled: busy || locked,
        onChange: async (next) => {
          setBusy(true)
          setError(null)
          try {
            const failure = await setCloud(next)
            if (failure !== undefined) setError(failure)
          } finally {
            setBusy(false)
          }
        },
      }))
    }

    return {
      inject: ['slots', 'sessions', 'remote', 'remote.agentPresets', 'locale'],
      apply(ctx) {
        ctx.effect(() => ctx.locale.register(NS, { en, zh }))

        /** Snapshot cache keyed by session so the hook source stays referentially stable. */
        const snapshots = new Map()
        const modeOf = (sessionId) => {
          const summary = ctx.sessions.list.getSnapshot().byId[sessionId]
          const preset = summary && summary.projectionValues ? summary.projectionValues.agentPreset : undefined
          const state = preset === PRESET ? 'on' : 'off'
          const blank = summary !== undefined && summary.blank === true
          const previous = snapshots.get(sessionId)
          if (previous !== undefined && previous.state === state && previous.blank === blank) return previous
          const next = { state, blank }
          snapshots.set(sessionId, next)
          return next
        }

        ctx.slots.inject('conversation.hero.options', () => ctx.slots.register({
          name: 'conversation.hero.options',
          id: 'qoder-cloud-agents-mode',
          order: 100,
          locale: NS,
          inject: (sessionId) => ({
            hooks: {
              mode: {
                getSnapshot: () => modeOf(sessionId),
                subscribe: listener => ctx.sessions.list.subscribe(listener),
              },
            },
            /** Select the cloud preset, or the default one; resolves to a refusal message or undefined. */
            setCloud: async (on) => {
              let target = PRESET
              if (!on) {
                const roster = await ctx.remote.agentPresets.list()
                if (!roster.ok) return refusal(roster.error)
                const presets = roster.value.presets || []
                const fallback = presets.find(preset => preset.isDefault && preset.id !== PRESET)
                  || presets.find(preset => preset.id !== PRESET)
                if (fallback === undefined) return 'no other agent preset is available'
                target = fallback.id
              }
              const result = await ctx.remote.agentPresets.select(sessionId, target)
              return result.ok ? undefined : refusal(result.error)
            },
          }),
        }, CloudModeSwitch))
      },
    }
  },
})
