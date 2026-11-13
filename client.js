/**
 * dsh-proxy-gate 的浏览器半部。
 *
 * 入口是输入框工具行里的一个小胶囊（`conversation.input.left`），点开是一个
 * portal 到 body 的弹窗面板 —— 这样**不需要和输入框同步宽度**（弹窗自己定宽），
 * 也不会占用 dock 那一行、不影响任务清单等既有条目。
 *
 * 数据与动作都走 Host 侧 /proxy-gate-api（见 src/server.js），与 AI 工具调用的是
 * 同一份实现，所以界面显示的状态与模型看到的一致。
 *
 * 样式只用主题 token（--dsw-alias-*），不 import 任何 Harness Client 包。
 */

window.__ModuleLoader__.load({
  id: 'dsh-proxy-gate',
  factory(require) {
    const React = require('react')
    const ReactDOM = require('react-dom')
    const h = React.createElement

    const API = '/proxy-gate-api'

    async function call(pathname, body) {
      const response = await fetch(`${API}/${pathname}`, {
        method: body ? 'POST' : 'GET',
        headers: body ? { 'x-proxy-gate': '1', 'content-type': 'application/json' } : { 'x-proxy-gate': '1' },
        body: body ? JSON.stringify(body) : undefined,
        credentials: 'same-origin',
      })
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!response.ok || payload?.ok === false) {
        throw new Error(payload?.error || `请求失败（HTTP ${response.status}）`)
      }
      return payload
    }

    const CSS = `
.pg-chip {
  display: inline-flex; align-items: center; gap: 5px;
  font: inherit; font-size: 12px; line-height: 1;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-secondary);
  border-radius: 999px; padding: 4px 9px; cursor: pointer;
}
.pg-chip:hover { border-color: var(--dsw-alias-border-l2); color: var(--dsw-alias-label-primary); }
.pg-chip.on { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.pg-chip-mode { opacity: .7; font-size: 11px; }
.pg-dot { width: 6px; height: 6px; border-radius: 50%; background: var(--dsw-alias-state-idle-primary); }
/* 手动 + 开启：绿灯常亮 */
.pg-dot.on { background: var(--dsw-alias-state-success-primary); }
/* 自动 + 关闭：天蓝（主题里没有「信息蓝」token，这里用固定天蓝并按明暗各给一档） */
.pg-dot.auto-off { background: #38bdf8; }
@media (prefers-color-scheme: dark) {
  .pg-dot.auto-off { background: #7dd3fc; }
}
/* 自动 + 开启：绿色呼吸灯 */
.pg-dot.breath {
  background: var(--dsw-alias-state-success-primary);
  animation: pg-breath 1.9s ease-in-out infinite;
}
@keyframes pg-breath {
  0%, 100% { opacity: .3; }
  50% { opacity: 1; }
}
@media (prefers-reduced-motion: reduce) {
  .pg-dot.breath { animation: none; opacity: 1; }
}
.pg-dot.warn { background: var(--dsw-alias-state-warn-primary); }

.pg-backdrop {
  position: fixed; inset: 0; z-index: 2147482000;
  background: rgba(0, 0, 0, .38);
  display: flex; align-items: center; justify-content: center;
  padding: 24px;
}
.pg-modal {
  width: 620px; max-width: 100%; max-height: 82vh; overflow: hidden;
  display: flex; flex-direction: column;
  background: var(--dsw-alias-bg-overlay);
  color: var(--dsw-alias-label-primary);
  border: 1px solid var(--dsw-alias-border-l1);
  border-radius: 12px; box-shadow: 0 12px 40px rgba(0,0,0,.28);
  font-size: 13px;
}
.pg-head {
  display: flex; align-items: center; gap: 8px;
  padding: 12px 16px; border-bottom: 1px solid var(--dsw-alias-border-l1);
}
.pg-head-title { font-weight: 600; font-size: 14px; flex: 0 0 auto; }
.pg-head-meta { color: var(--dsw-alias-label-secondary); font-size: 12px; flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-body { padding: 12px 16px; overflow-y: auto; }
.pg-sec { margin-bottom: 16px; }
.pg-sec:last-child { margin-bottom: 0; }
.pg-sec-title { color: var(--dsw-alias-label-secondary); font-size: 12px; margin-bottom: 6px; }
.pg-row { display: flex; align-items: center; gap: 8px; padding: 3px 0; min-width: 0; }
.pg-name { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pg-name.active { font-weight: 600; }
.pg-btn {
  font: inherit; font-size: 12px; line-height: 1; flex: 0 0 auto;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-2);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px; padding: 5px 9px; cursor: pointer;
}
.pg-btn:hover { border-color: var(--dsw-alias-border-l2); }
.pg-btn:disabled { opacity: .5; cursor: default; }
.pg-btn.primary { border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-brand-primary); }
.pg-btn.danger { color: var(--dsw-alias-state-error-primary); }
.pg-badge {
  flex: 0 0 auto; font-size: 11px; padding: 1px 6px; border-radius: 999px;
  border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary);
}
.pg-badge.ok { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.pg-badge.dead { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.pg-badge.warn { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.pg-list { max-height: 190px; overflow-y: auto; margin: 0; padding: 0; list-style: none; }
.pg-input {
  font: inherit; font-size: 12px; flex: 1 1 auto; min-width: 0; box-sizing: border-box;
  border: 1px solid var(--dsw-alias-border-l1);
  background: var(--dsw-alias-bg-layer-1);
  color: var(--dsw-alias-label-primary);
  border-radius: 7px; padding: 6px 8px;
}
.pg-note { margin-top: 10px; font-size: 12px; color: var(--dsw-alias-label-secondary); white-space: pre-wrap; word-break: break-word; }
.pg-note.err { color: var(--dsw-alias-state-error-primary); }
.pg-hint { font-size: 12px; color: var(--dsw-alias-label-secondary); line-height: 1.6; }
.pg-wrap { display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
`

    /**
     * 灯点语义（与面板内一致）：
     *   灰 = 手动 + 关闭   │ 绿常亮 = 手动 + 开启
     *   蓝 = 自动 + 关闭   │ 绿呼吸 = 自动 + 开启
     * 代理开着但一个可用节点都没有时，额外用警示色提示。
     */
    function dotClass(state) {
      if (!state) return 'pg-dot'
      if (state.running && state.mode === 'core' && state.counts && state.counts.usable === 0) return 'pg-dot warn'
      if (state.running) return state.autoMode ? 'pg-dot breath' : 'pg-dot on'
      return state.autoMode ? 'pg-dot auto-off' : 'pg-dot'
    }

    function delayBadge(node) {
      if (node.isDirect) return h('span', { className: 'pg-badge' }, '直连')
      if (node.placeholder) return h('span', { className: 'pg-badge warn' }, '占位')
      if (Number.isFinite(node.delay)) return h('span', { className: 'pg-badge ok' }, `${node.delay}ms`)
      if (node.measuredAt) return h('span', { className: 'pg-badge dead' }, '不通')
      return h('span', { className: 'pg-badge' }, '未测')
    }

    /** 面板本体（放在弹窗里）。 */
    function Panel({ state, detected, busy, note, noteError, actions, onClose }) {
      const [subUrl, setSubUrl] = React.useState('')
      const [upstream, setUpstream] = React.useState('')

      const nodes = state.nodes.filter((node) => !node.placeholder)
      const placeholders = state.nodes.filter((node) => node.placeholder)
      const ports = detected?.ports ?? state.upstreamCandidates ?? []
      const clients = detected?.clients ?? []

      return h('div', { className: 'pg-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': '代理网关' },
        h('div', { className: 'pg-head' },
          h('span', { className: dotClass(state) }),
          h('span', { className: 'pg-head-title' }, '代理网关'),
          h('span', { className: 'pg-head-meta' },
            [
              state.autoMode ? '自动' : '手动',
              state.running ? '已开启' : '已关闭',
              state.mode === 'borrow' ? `借用 ${state.borrowUrl}` : state.mode === 'core' ? `节点 ${state.node || '自动'}` : '',
            ].filter(Boolean).join(' · ')),
          h('button', { className: 'pg-btn primary', disabled: Boolean(busy), onClick: () => actions.toggle() },
            state.running ? '关闭' : '开启'),
          h('button', { className: 'pg-btn', onClick: onClose }, '关闭面板'),
        ),
        h('div', { className: 'pg-body' },

          h('div', { className: 'pg-sec' },
            h('div', { className: 'pg-sec-title' }, '模式'),
            h('div', { className: 'pg-row' },
              h('button', {
                className: `pg-btn${state.autoMode ? ' primary' : ''}`,
                disabled: Boolean(busy),
                onClick: () => actions.setAuto(!state.autoMode),
              }, state.autoMode ? 'AI 自主开关：已开启' : 'AI 自主开关：已关闭'),
            ),
            h('div', { className: 'pg-hint' },
              state.autoMode
                ? 'AI 能自己开关代理（会遇到境外任务时自动开、收尾自动关）。工具集恒定，只切换模式时才变。'
                : 'AI 看不到代理工具，只能由你在这里控制当前会话的出口。'),
          ),

          // ---- 穿透（仅手动模式）：影响全机
          state.autoMode
            ? null
            : h('div', { className: 'pg-sec' },
                h('div', { className: 'pg-sec-title' }, '穿透（影响全机，仅手动模式）'),
                h('div', { className: 'pg-row' },
                  h('button', {
                    className: `pg-btn${state.systemProxy ? ' primary' : ''}`,
                    disabled: Boolean(busy),
                    onClick: () => actions.toggleSystemProxy(),
                  }, state.systemProxy ? '系统代理：已开启' : '开启系统代理'),
                  h('button', {
                    className: `pg-btn${state.tun ? ' primary' : ''}`,
                    disabled: Boolean(busy),
                    onClick: () => actions.toggleTun(),
                  }, state.tun ? 'TUN：已开启' : '用 TUN 模式'),
                ),
                h('div', { className: 'pg-hint' },
                  '系统代理：写 Windows 的 WinINET 设置，浏览器等程序会走代理；关闭代理时自动还原你原来的设置。TUN：接管全部流量，需要以管理员身份运行 DSH，否则会启动失败。'),
              ),

          h('div', { className: 'pg-sec' },
            h('div', { className: 'pg-sec-title' }, `订阅（${state.subscriptions.length}）`),
            state.subscriptions.length
              ? h('ul', { className: 'pg-list' }, state.subscriptions.map((item) =>
                  h('li', { className: 'pg-row', key: item.id },
                    h('span', { className: `pg-name${item.active ? ' active' : ''}`, title: item.id },
                      `${item.name}（${item.proxyCount} 节点 · ${item.source || '未知'}）`),
                    item.active ? h('span', { className: 'pg-badge ok' }, '生效中') : null,
                    item.active ? null : h('button', { className: 'pg-btn', disabled: Boolean(busy), onClick: () => actions.useSub(item.id) }, '使用'),
                    h('button', { className: 'pg-btn danger', disabled: Boolean(busy), onClick: () => actions.removeSub(item.id) }, '移除'),
                  ),
                ))
              : h('div', { className: 'pg-hint' }, '还没有订阅。用下面的输入框添加，或从 Clash Verge 导入。'),
            h('div', { className: 'pg-row', style: { marginTop: '8px' } },
              h('input', {
                className: 'pg-input',
                placeholder: '粘贴机场订阅链接（Clash / 通用格式）',
                value: subUrl,
                onChange: (event) => setSubUrl(event.target.value),
              }),
              h('button', {
                className: 'pg-btn',
                disabled: Boolean(busy) || !subUrl.trim(),
                onClick: () => actions.importUrl(subUrl.trim(), () => setSubUrl('')),
              }, '导入'),
            ),
            state.clashVergeDetected
              ? h('div', { className: 'pg-row', style: { marginTop: '6px' } },
                  h('button', { className: 'pg-btn', disabled: Boolean(busy), onClick: () => actions.importVerge() }, '从 Clash Verge 导入'),
                )
              : null,
          ),

          state.mode === 'core' && state.nodes.length
            ? h('div', { className: 'pg-sec' },
                h('div', { className: 'pg-sec-title' },
                  `节点（可用 ${state.counts.usable} / 共 ${state.counts.total}，已测速 ${state.counts.measured}）`),
                h('ul', { className: 'pg-list' }, nodes.slice(0, 100).map((node) =>
                  h('li', { className: 'pg-row', key: node.name },
                    h('span', { className: `pg-name${node.name === state.node ? ' active' : ''}`, title: node.name }, node.name),
                    delayBadge(node),
                    h('button', {
                      className: 'pg-btn',
                      disabled: Boolean(busy) || node.name === state.node,
                      onClick: () => actions.useNode(node.name),
                    }, node.name === state.node ? '使用中' : '使用'),
                  ),
                )),
                placeholders.length
                  ? h('div', { className: 'pg-hint', style: { marginTop: '6px' } },
                      `另有 ${placeholders.length} 个占位节点（机场超量/到期下发，必然不通）：${placeholders.slice(0, 3).map((n) => n.name).join(' / ')}`)
                  : null,
              )
            : null,

          h('div', { className: 'pg-sec' },
            h('div', { className: 'pg-sec-title' }, '借用本机代理客户端（无需订阅）'),
            h('div', { className: 'pg-hint' },
              clients.length
                ? `检测到进程：${clients.map((item) => item.label).join('、')}`
                : '未检测到常见客户端进程（跨界云 / v2rayN / sing-box 等）。'),
            ports.length
              ? h('div', { className: 'pg-wrap', style: { marginTop: '6px' } }, ports.map((port) =>
                  h('button', { className: 'pg-btn', key: port, disabled: Boolean(busy), onClick: () => actions.borrow(String(port)) },
                    `借用 127.0.0.1:${port}`),
                ))
              : null,
            h('div', { className: 'pg-row', style: { marginTop: '6px' } },
              h('input', {
                className: 'pg-input',
                placeholder: '客户端设置里的 HTTP 代理端口，如 10808',
                value: upstream,
                onChange: (event) => setUpstream(event.target.value),
              }),
              h('button', { className: 'pg-btn', disabled: Boolean(busy) || !upstream.trim(), onClick: () => actions.borrow(upstream.trim()) }, '借用'),
            ),
            h('div', { className: 'pg-hint', style: { marginTop: '6px' } },
              '只借用它的本地 HTTP 代理口，不会改系统代理、不影响你其他程序；它必须暴露 HTTP 代理端口（纯 TUN 模式的客户端无法借用）。'),
          ),

          state.lastError ? h('div', { className: 'pg-note err' }, state.lastError) : null,
          state.holderCount > 1
            ? h('div', { className: 'pg-hint' },
                `当前有 ${state.holderCount} 个持有者在使用这个出口：${state.holders.map((item) => item.label).join('、')}。智能体自己 off 只会释放它那一份。`)
            : null,
          note ? h('div', { className: `pg-note${noteError ? ' err' : ''}` }, note) : null,
        ),
      )
    }

    function ProxyGate() {
      const [open, setOpen] = React.useState(false)
      const [state, setState] = React.useState(null)
      const [detected, setDetected] = React.useState(null)
      const [busy, setBusy] = React.useState('')
      const [note, setNote] = React.useState('')
      const [noteError, setNoteError] = React.useState(false)

      const refresh = React.useCallback(async () => {
        try {
          const payload = await call('state')
          if (payload?.state) setState(payload.state)
        } catch {
          /* 静默：胶囊不该因为接口抖动而报错 */
        }
      }, [])

      React.useEffect(() => {
        refresh()
        const timer = setInterval(refresh, open ? 6000 : 20000)
        return () => clearInterval(timer)
      }, [refresh, open])

      React.useEffect(() => {
        if (!open) return
        call('detect')
          .then((payload) => setDetected(payload?.detected ?? null))
          .catch(() => setDetected(null))
      }, [open])

      // Escape 关闭
      React.useEffect(() => {
        if (!open) return
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [open])

      const run = async (pathname, body, label) => {
        setBusy(label)
        setNote('')
        setNoteError(false)
        try {
          const payload = await call(pathname, body)
          if (payload?.message) setNote(payload.message)
          if (payload?.state) setState(payload.state)
        } catch (error) {
          setNote(String(error?.message ?? error))
          setNoteError(true)
        } finally {
          setBusy('')
        }
      }

      /** 面板只显示摘要：第一行 + 行数提示，避免把整段工具输出糊在面板里。 */
      const summarise = (text) => {
        if (!text) return ''
        const lines = String(text).split('\n').filter((line) => line.trim())
        if (lines.length <= 2) return lines.join('\n')
        return `${lines[0]}\n…（共 ${lines.length} 行，完整内容见对话里的工具结果）`
      }

      const running = Boolean(state?.running)
      const modeLabel = state ? (state.autoMode ? '自动' : '手动') : ''
      const stateLabel = state ? (running ? '开启' : '关闭') : '…'

      const chip = h('button', {
        type: 'button',
        className: `pg-chip${running ? ' on' : ''}`,
        title: state
          ? `代理${stateLabel}｜${modeLabel}管理${running && state.mode === 'core' && state.node ? `｜${state.node}` : ''}｜点击打开面板`
          : '代理网关',
        'aria-label': state ? `代理网关：${modeLabel}管理，当前${stateLabel}` : '代理网关',
        onClick: () => setOpen(true),
      },
      h('span', { className: dotClass(state) }),
      h('span', null, '代理'),
      state ? h('span', { className: 'pg-chip-mode' }, modeLabel) : null)

      if (!open) {
        return h(React.Fragment, null, h('style', null, CSS), chip)
      }

      const actions = {
        // 面板上的开关一律带 fromUi：Host 会先把模式切成手动，避免 AI 还在自主。
        toggle: () => run(running ? 'off' : 'on', running ? { force: true, fromUi: true } : { fromUi: true }, running ? '关闭中' : '开启中'),
        toggleSystemProxy: () =>
          run(running ? 'off' : 'on', running
            ? { force: true, fromUi: true }
            : { fromUi: true, systemProxy: true }, '切换中'),
        toggleTun: () =>
          run(running ? 'off' : 'on', running
            ? { force: true, fromUi: true }
            : { fromUi: true, tun: true }, '切换中'),
        setAuto: (auto) => run('mode', { auto }, '切换中'),
        useSub: (id) => run('subscription', { action: 'use', value: id }, '切换中'),
        removeSub: (id) => run('subscription', { action: 'remove', value: id }, '移除中'),
        importUrl: (value, done) => run('subscription', { action: 'import', source: 'url', value }, '导入中').then(done),
        importVerge: () => run('subscription', { action: 'import', source: 'clash-verge' }, '导入中'),
        useNode: (node) => run('node', { node, fromUi: true }, '切换中'),
        borrow: (upstream) => run('on', { upstream: String(upstream), fromUi: true }, '借用中'),
      }

      const modal = state
        ? ReactDOM.createPortal(
            h('div', {
              className: 'pg-backdrop',
              onMouseDown: (event) => {
                if (event.target === event.currentTarget) setOpen(false)
              },
            }, h(Panel, { state, detected, busy, note: summarise(note), noteError, actions, onClose: () => setOpen(false) })),
            document.body,
          )
        : null

      return h(React.Fragment, null, h('style', null, CSS), chip, modal)
    }

    return {
      inject: ['slots'],
      apply(ctx) {
        ctx.slots.inject('conversation.input.left', () =>
          ctx.slots.register(
            { name: 'conversation.input.left', id: 'proxy-gate', order: 50, label: '代理网关' },
            ProxyGate,
          ),
        )
      },
    }
  },
})
