/**
 * dsh-proxy-gate —— 给 AI 一个真正的「代理开关」。
 *
 * 这个文件只做组装：
 *   1. 解析配置、打开状态仓库（$DSH_HOME/proxy-gate）
 *   2. 首次使用时静默从 Clash Verge 搬一份订阅（零配置即可用）
 *   3. 注册 4 个工具：proxy / proxy_nodes / proxy_subscription / proxy_fetch
 *   4. 注入一段系统提示（什么时候该开代理）+ 一条每步刷新的动态上下文（当前开没开）
 *   5. 可选的 autoStart，以及卸载时杀干净内核
 *
 * 为什么工具是全局注册而不是按 agent：代理是进程级资源，子 agent 也常常需要
 * 出境网络（例如让子 agent 去查境外文档），按 agent 注册反而会让子 agent 缺工具。
 */

import { resolveConfig, resolvePaths } from './src/config.js'
import { Store } from './src/store.js'
import { MihomoCore } from './src/mihomo.js'
import { autoImportFromClashVerge, buildProxyTools, providerForActive } from './src/tools.js'
import { mountProxyApi } from './src/server.js'

/** Cordis 插件名。 */
export const name = 'proxy-gate'

/** `tools` 是硬依赖；systemPrompt 可选（用 ctx.get 取）。 */
export const inject = ['tools']

/** 系统提示 section 的排序号（放在较后面，属于「工具使用策略」）。 */
const SECTION_ORDER = 860

/** 动态上下文的排序号。 */
const CONTEXT_ORDER = 861

/**
 * 组装并启动插件。
 *
 * @param {any} ctx Cordis 插件上下文
 * @param {Record<string, any>} [userConfig] Loader patch 里这一行的 config
 */
export function apply(ctx, userConfig) {
  const logger = ctx.logger ?? console
  const config = resolveConfig(userConfig)

  if (!config.enabled) {
    logger.info?.('proxy-gate: 配置为 disabled，不注册任何工具')
    return
  }

  const paths = resolvePaths(config)
  const store = new Store({ paths, logger }).load()

  // 首次使用若本机有 Clash Verge，直接把它当前选中的订阅搬过来。
  autoImportFromClashVerge({ store, logger })

  const core = new MihomoCore({ config, paths, logger })
  /** 最近一次已知的节点名，供同步的系统提示使用。 */
  const promptState = { node: store.state.selectedNode || '' }

  /** 每次成功开关/切换后刷新，让系统提示里的状态跟得上。 */
  const trackNode = async () => {
    if (!core.running) {
      promptState.node = ''
      return
    }
    const group = await core.group()
    promptState.node = group.node || ''
  }

  const disposers = []
  const register = (dispose) => {
    if (typeof dispose === 'function') disposers.push(dispose)
  }

  // ---- 1. 工具：**只在自动模式下注册**
  //
  // 为什么要能「一个工具都不注册」：工具 schema 是 prompt 前缀的一部分，
  // 增删工具会让整段前缀失效、打断缓存。手动模式下人自己在面板里开关代理，
  // 模型完全不需要这些工具，也就不该为它们付 context 与缓存代价。
  const deps = { core, store, paths, config, logger, trackNode }
  const toolList = buildProxyTools(deps)
  const toolByName = new Map(toolList.map((definition) => [definition.name, definition]))

  /** 当前已注册工具的卸载句柄（切换模式时整体撤掉/重建）。 */
  let toolDisposers = []
  /** 「何时该开代理」指引的卸载句柄（只在自动模式下存在）。 */
  let guidanceDispose = null

  const systemPrompt = typeof ctx.get === 'function' ? ctx.get('systemPrompt') : undefined

  const unregisterAutoTools = () => {
    while (toolDisposers.length) {
      const dispose = toolDisposers.pop()
      try {
        dispose()
      } catch {
        /* 已释放 */
      }
    }
    if (guidanceDispose) {
      try {
        guidanceDispose()
      } catch {
        /* 已释放 */
      }
      guidanceDispose = null
    }
  }

  const registerAutoTools = () => {
    for (const definition of toolList) {
      try {
        const dispose = ctx.tools.register(definition)
        if (typeof dispose === 'function') toolDisposers.push(dispose)
      } catch (error) {
        logger.warn?.(`proxy-gate: 注册工具 ${definition.name} 失败：${error?.message ?? error}`)
      }
    }
    if (systemPrompt && config.promptGuidance) {
      try {
        const dispose = systemPrompt.section({
          name: 'proxy-gate/guidance',
          order: SECTION_ORDER,
          text: buildGuidance(config),
        })
        if (typeof dispose === 'function') guidanceDispose = dispose
      } catch (error) {
        logger.warn?.(`proxy-gate: 注入使用指引失败：${error?.message ?? error}`)
      }
    }
  }

  /**
   * 自动模式开关：开 = 注册全部代理工具 + 使用指引；关 = 一个都不留。
   *
   * @param {boolean} enabled
   * @param {{persist?: boolean}} [options]
   * @returns {boolean}
   */
  const setAutoMode = (enabled, options = {}) => {
    const next = enabled === true
    unregisterAutoTools()
    if (next) registerAutoTools()
    if (options.persist !== false) store.setAutoMode(next)
    logger.info?.(
      next ? 'proxy-gate: 自动模式开启（AI 可自主开关代理）' : 'proxy-gate: 自动模式关闭（仅人工在面板操作，工具已隐藏）',
    )
    return next
  }

  deps.setAutoMode = setAutoMode
  deps.getAutoMode = () => store.autoMode()

  // 按上次保存的模式装载（首次默认开启）
  setAutoMode(store.autoMode(), { persist: false })

  // ---- 1b. 浏览器接口（面板与工具共用同一份实现）
  try {
    register(mountProxyApi({ ctx, deps, tools: toolByName, logger }))
  } catch (error) {
    logger.warn?.(`proxy-gate: 挂载浏览器接口失败：${error?.message ?? error}`)
  }

  // ---- 2. 实时状态上下文：两种模式都注入
  //
  // 它只有一行、且只在「开关/切节点」时改变文本，所以每次状态变化最多让缓存
  // 失效一次，不会逐步抖动。手动模式下它尤其重要：人开了代理，模型得知道自己
  // 的 shell 此刻在走代理。
  if (systemPrompt && config.liveStateContext !== false) {
    try {
      register(
        systemPrompt.context({
          name: 'proxy-gate/state',
          order: CONTEXT_ORDER,
          text: () => describeLiveState(core, store, promptState),
        }),
      )
    } catch (error) {
      logger.warn?.(`proxy-gate: 注入实时状态失败：${error?.message ?? error}`)
    }
  }

  // ---- 3. 可选自动开启
  if (config.autoStart) {
    const prepared = providerForActive({ store, paths })
    if (prepared.providerFile) {
      void core
        .start({ providerFile: prepared.providerFile, node: store.state.selectedNode || '' })
        .then((result) => {
          logger.info?.(`proxy-gate: autoStart → ${result.message}`)
          return trackNode()
        })
        .catch((error) => logger.warn?.(`proxy-gate: autoStart 失败：${error?.message ?? error}`))
    } else {
      logger.warn?.('proxy-gate: autoStart 已开启但没有可用订阅，跳过')
    }
  }

  // ---- 4. 卸载/退出时别留野进程
  const exitHandler = () => {
    try {
      core.child?.kill()
    } catch {
      /* 已退出 */
    }
  }
  process.once('exit', exitHandler)

  ctx.effect?.(
    () => () => {
      process.removeListener('exit', exitHandler)
      for (const dispose of disposers.splice(0).reverse()) {
        try {
          dispose()
        } catch {
          /* 已释放 */
        }
      }
      void core.stop()
    },
    'proxy-gate: tools + prompt + core',
  )
}

/**
 * 「什么时候该开代理」的指引。
 *
 * 这段文字是「AI 自动使用」的核心：工具描述会被大量工具挤在一起看，
 * 而这段说明能给出完整的判断策略（触发条件、使用顺序、收尾动作、常见坑）。
 *
 * @param {ReturnType<typeof resolveConfig>} config
 * @returns {string}
 */
function buildGuidance(config) {
  return [
    '## 代理网关（proxy-gate）',
    `本机装了一个可控出口：本地 mixed 代理 127.0.0.1:${config.port}（HTTP 与 SOCKS 同端口），由代理网关工具按需开/关；节点来自已导入 DSH 的机场订阅快照。`,
    '',
    '什么时候要开（满足任意一条就先开再重试，不要直接放弃任务）：',
    '- 访问境外资源失败：超时、连接被重置、TLS handshake 失败、DNS 解析失败、HTTP 403/451/502 且怀疑是地域限制。',
    '- 任务本身就需要国外网络：git clone / 下载 GitHub Release、npm 或 PyPI 境外源、HuggingFace、Docker Hub、Google/YouTube/Telegram API 等。',
    '- 上一次 dry run 已经确认「直连不通、走代理能通」（用 proxy(action="status", verify=true) 看对照结果）。',
    '',
    '使用顺序：',
    '1. proxy(action="status") 看现在开没开、有哪些节点。',
    '2. proxy(action="on")（需要指定出口时 proxy(action="on", node="节点名")）。它是幂等的，已开时只做「确保开 + 切节点」。',
    '3. 重试原请求。读网页/JSON 用 proxy_fetch；命令行工具（curl / git / npm / pip / python requests）会自动继承 HTTP_PROXY、HTTPS_PROXY、ALL_PROXY，直接跑即可。',
    '4. 任务收尾时 proxy(action="off")。除非后续步骤还要出境，不要一直开着。',
    '',
    config.upstreamProxy
      ? `当前配置为「借用外部客户端」模式：出口是 ${config.upstreamProxy}，proxy(action="on") 会把环境变量指过去，节点由那个客户端管理。`
      : '若本机用的是自带官方客户端的梯子（跨界云等）且它已经在运行，可用 proxy(action="on", upstream="端口号") 借用它的本地代理口，不必导入订阅。',
    '',
    '必须知道的限制：',
    '- 内置的 web_fetch / web_search 走宿主进程自己的 HTTP 栈，**不经过本代理**。遇到境外页面抓不下来时，改用 proxy_fetch 或 pwsh 里的 curl。',
    '- 国内站点、内网地址不要走代理（no_proxy 已配好 localhost/127.0.0.1）。',
    '- 端口被占用（例如 Clash Verge 自己占着 7897）时 开启会报错并说明，不要反复重试。',
    '',
    '排错姿势：',
    '- 开了代理却全部不通：先看 proxy(action="status") 是否提示「占位节点」（机场超量/到期会下发假节点）；必要时 proxy_subscription(action="refresh") 重新拉订阅。',
    '- 想确认是节点问题还是本地隧道问题：proxy(action="on", node="DIRECT") 走直连，能通则说明本地隧道正常、问题在节点。',
    '- 403 不等于代理坏了：API 限流也会 403，代理侧「链路通」就是正常。',
  ].join('\n')
}

/**
 * 每步刷新的动态状态。必须同步：只读内存里的事实。
 *
 * @param {MihomoCore} core
 * @param {Store} store
 * @param {{node: string}} promptState
 * @returns {string}
 */
function describeLiveState(core, store, promptState) {
  const active = store.active()
  const subscription = active ? `${active.name}（${active.proxyCount} 节点）` : '未导入订阅'
  if (!core.running) {
    return `代理网关：关闭中。当前订阅：${subscription}。需要境外网络时调用 proxy(action="on")。`
  }
  if (core.mode === 'borrow') {
    return `代理网关：已开启（借用外部客户端 ${core.borrowUrl}），插件不管理节点。订阅 ${subscription} 暂未参与。不需要时记得 proxy(action="off")。`
  }
  const node = promptState.node || store.state.selectedNode || '自动选择'
  return `代理网关：已开启，出口 127.0.0.1:${core.config.port}，当前节点 ${node}，订阅 ${subscription}。不需要时记得 proxy(action="off")。`
}

export default { name, inject, apply }
