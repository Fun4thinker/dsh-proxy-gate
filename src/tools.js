/**
 * 模型可见的五个工具：proxy_status / proxy_on / proxy_off / proxy_subscription / proxy_fetch。
 *
 * 设计取舍：
 * - 工具名逐个动词化，而不是一个万能 `proxy(action=...)`：模型对「开/关」的
 *   意图最明确，动词名能让它在需要时直接选中，不必先想参数。
 * - description 里直接写**触发条件**（境外站点超时、被墙、需要国外源），
 *   这是「让 AI 自动用起来」的主要手段；系统提示里再补一段更完整的策略。
 * - 所有失败都返回可执行的中文文本（缺订阅 → 直接说怎么导入；缺内核 → 说怎么配
 *   corePath），绝不把堆栈丢给模型。
 * - proxy_fetch 存在的原因：harness 内置的 web_fetch 用的是 app.asar 里的 undici，
 *   插件无法给它装代理 dispatcher；而 curl 一定能带 -x。
 */

import fs from 'node:fs'
import path from 'node:path'

import { defineTool } from './tool-kit.js'
import { detectClashVerge, importFromClashVerge, inspectSubscriptionText, parseVergeProfiles } from './subscription.js'
import { analyzeNodes, PROVIDER_ID, resolveCorePath } from './mihomo.js'
import { measureNodes, snapshot } from './ops.js'
import { fetchText, probe, SUBSCRIPTION_USER_AGENT } from './net.js'
import { safeId } from './store.js'

/**
 * 写下 mihomo 的 file 类型 provider 文件（只含 proxies 段）。
 *
 * @param {any} paths
 * @param {string} content 订阅正文
 * @returns {{file: string, count: number}}
 */
export function writeProviderFile(paths, content) {
  const inspected = inspectSubscriptionText(content)
  if (!inspected.ok) throw new Error(`订阅内容不可用：${inspected.reason}`)
  const file = path.join(paths.runtimeDir, 'provider.yaml')
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, inspected.block, 'utf8')
  return { file, count: inspected.count }
}

/** 从订阅正文算出 provider 文件（必要时先落订阅快照）。 */
function providerForActive({ store, paths }) {
  const active = store.active()
  if (!active) return { active: null, providerFile: '', count: 0 }
  const snapshot = store.snapshotPath(active.id)
  if (!fs.existsSync(snapshot)) return { active, providerFile: '', count: 0 }
  const { file, count } = writeProviderFile(paths, fs.readFileSync(snapshot, 'utf8'))
  return { active, providerFile: file, count }
}

/** 首次使用时若无订阅，自动从 Clash Verge 搬一份过来。 */
export function autoImportFromClashVerge({ store, logger }) {
  if (store.list().length) return null
  const verge = detectClashVerge()
  if (!verge) return null
  try {
    const imported = importFromClashVerge(verge)
    const entry = store.upsert(imported)
    logger?.info?.(`proxy-gate: 已从 Clash Verge 导入订阅「${entry.name}」（${entry.proxyCount} 个节点）`)
    return entry
  } catch (error) {
    logger?.warn?.(`proxy-gate: 从 Clash Verge 自动导入失败：${error?.message ?? error}`)
    return null
  }
}

/** 把订阅清单写成模型可读的一行。 */
function describeSubscription(entry, activeId) {
  const mark = entry.id === activeId ? ' ← 当前生效' : ''
  const source = entry.source || 'unknown'
  const url = entry.url ? '有订阅地址，可 refresh' : '仅本地快照，无法 refresh'
  return `- ${entry.id}｜${entry.name}｜约 ${entry.proxyCount} 个节点｜来源 ${source}（${url}）${mark}`
}

/**
 * 组装五个工具定义。
 *
 * @param {{core: any, store: any, paths: any, config: any, logger?: any}} deps
 * @returns {object[]} ToolDefinition[]
 */
export function buildProxyTools(deps) {
  const { core, store, paths, config } = deps
  const logger = deps.logger ?? console
  const trackNode = typeof deps.trackNode === 'function' ? deps.trackNode : () => {}
  /** 持有者登记表（引用计数）。没有传进来时退化成单持有者，行为与旧版一致。 */
  const holds = deps.holds ?? { hold: () => true, release: () => false, releaseAll: () => 0, hasAny: false, size: 0, list: () => [] }

  /**
   * 当前调用者是哪个持有者：
   *  - 智能体走工具 → 用它的 session id（各自独立，互不影响）
   *  - 面板/命令行（无 agent）→ 统一记成 'ui'（人工持有）
   */
  const holderKey = (exec) => {
    const id = exec?.agent?.id
    return typeof id === 'string' && id ? String(id) : 'ui'
  }

  const status = defineTool({
    name: 'proxy#status',
    description:
      '查看代理网关状态：是否已开启、本地端口、当前订阅与节点、已导入的订阅数。' +
      '当你不确定「代理开没开」「有哪些节点」时先调用它。' +
      'verify=true 会做一次「直连 vs 走代理」的对照探测，用来证明某个境外站点是否真的能通（会多花几秒）。',
    parameters: {
      verify: { type: 'boolean', description: '同时做连通性对照探测（默认 false）' },
      showNodes: { type: 'boolean', description: '列出候选节点名（默认只列前 15 个，true 时列全部）' },
    },
    execute: async ({ verify, showNodes }) => {
      const summary = core.summary()
      const active = store.active()
      const modeLabel = summary.mode === 'borrow' ? '借用外部客户端' : summary.mode === 'core' ? '自有内核' : '未运行'
      const lines = [`代理：${summary.running ? `已开启（ON，${modeLabel}）` : '已关闭（OFF）'}`]
      if (summary.running && summary.mode === 'borrow') {
        lines.push(`出口：${summary.borrowUrl}（借用你本机的代理客户端端口，节点由该客户端管理）`)
        lines.push('已写入环境变量：HTTP_PROXY / HTTPS_PROXY / ALL_PROXY（子进程 curl、git、npm 等会自动继承）')
      } else if (summary.running) {
        lines.push(`本地出口：127.0.0.1:${summary.port}（HTTP 与 SOCKS 同端口，控制器 127.0.0.1:${summary.controllerPort}）`)
        lines.push(`已写入环境变量：HTTP_PROXY / HTTPS_PROXY / ALL_PROXY（子进程 curl、git、npm 等会自动继承）`)
      }
      if (summary.mode !== 'borrow') {
        lines.push(`内核：${summary.corePath || (await resolveCorePath(config)) || '未探测到'}`)
      }
      if (active) {
        lines.push(
          `当前订阅：${active.name}（${active.id}，约 ${active.proxyCount} 个节点，导入于 ${new Date(active.importedAt).toLocaleString('zh-CN')}）`,
        )
      } else {
        const verge = detectClashVerge()
        lines.push(
          `当前订阅：未导入。${verge ? '检测到本机 Clash Verge，可调用 proxy_subscription(action="import", source="clash-verge") 直接搬过来。' : '本机未检测到 Clash Verge，可用 source="url" 导入订阅地址。'}`,
        )
      }
      lines.push(`已导入订阅数：${store.list().length}`)

      const holders = holds.list()
      if (holders.length) {
        lines.push(
          `持有者（${holders.length}）：${holders.map((item) => item.label).join('、')}` +
            (holds.hasManual ? '——其中「人工面板」是人在面板上开的，AI 的 off 关不掉它' : ''),
        )
      }

      if (summary.mode === 'core') {
        const group = await core.group()
        const analysis = analyzeNodes(group.nodes)
        lines.push(`当前节点：${group.node || '未选择'}（候选 ${group.nodes.length} 个）`)
        const latencies = store.latencies()
        /** 有测速记录时把延迟带在节点名后面，模型一眼能看出哪个能用。 */
        const label = (name) => {
          const record = latencies[name]
          if (!record) return name
          return Number.isFinite(record.delay) ? `${name}(${record.delay}ms)` : `${name}(不通)`
        }
        const shown = showNodes ? analysis.real : analysis.real.slice(0, 15)
        if (shown.length) {
          lines.push(`可用节点：${shown.map(label).join(' / ')}${shown.length < analysis.real.length ? ' …' : ''}`)
        }
        const measured = analysis.real.filter((name) => Number.isFinite(latencies[name]?.delay)).length
        if (measured) lines.push(`已测速 ${measured} 个节点；重新测速用 proxy_nodes(action="test")。`)
        else if (analysis.real.length > 1) lines.push('还没测过速：用 proxy_nodes(action="test") 找出最快/可用的节点。')
        if (analysis.placeholder.length) {
          lines.push(
            `⚠️ 占位节点 ${analysis.placeholder.length} 个（机场超量/到期时会下发这种假节点，选中它们必然连不通）：${analysis.placeholder.slice(0, 6).join(' / ')}`,
          )
        }
        if (analysis.hasDirect) lines.push('组内还有 DIRECT：节点全废时可用它验证「本地隧道是否正常」。')
        if (!analysis.real.length) {
          lines.push('⚠️ 没有任何看起来可用的节点：请更新/重置机场订阅后，用 proxy_subscription(action="refresh") 重新拉取。')
        }
      } else if (summary.mode === 'borrow') {
        lines.push('节点列表：借用模式下由外部客户端管理，插件不枚举节点。')
      }
      if (summary.lastError) lines.push(`上次错误：${summary.lastError}`)

      if (verify) {
        lines.push('', '连通性对照（直连 vs 走代理）：')
        const proxyUrl = summary.running ? core.proxyUrl : ''
        for (const url of config.testUrls) {
          const direct = await probe(url, { timeoutMs: 12000 })
          const through = proxyUrl ? await probe(url, { timeoutMs: 25000, proxyUrl }) : null
          const fmt = (result) => {
            if (!result) return '未测（代理已关闭）'
            if (result.reached) {
              return result.ok ? `通（HTTP ${result.status}，${result.ms}ms）` : `链路通、被站点拒绝（HTTP ${result.status}，${result.ms}ms；常见于限流，不代表隧道故障）`
            }
            return `不通（${result.error ?? '未知'}）`
          }
          lines.push(`- ${url}\n    直连：${fmt(direct)}\n    代理：${fmt(through)}`)
        }
        if (!proxyUrl) lines.push('（代理当前关闭；需要走代理时先调用 proxy_on）')
        lines.push('判读：代理侧「链路通」即代表本地内核 + 节点隧道正常；两侧都不通通常是本机网络或目标站点问题。')
      }
      return lines.join('\n')
    },
    isConcurrencySafe: () => true,
  })

  const on = defineTool({
    name: 'proxy#on',
    description:
      '开启代理（必要时自动拉起本地 mihomo 内核），可顺带指定节点。' +
      '当访问境外资源失败/超时/被拦截，或任务明确需要国外网络（GitHub、PyPI/npm 境外源、HuggingFace、Google 系服务等）时，先调用本工具再重试原请求。' +
      '已开启时再调用只做「确保开启 + 切换节点」，不会重复起进程。返回后会顺带验证一次真实连通性。',
    parameters: {
      node: { type: 'string', description: '要切换到的节点名（可选，留空用上次或自动选择）' },
      systemProxy: {
        type: 'boolean',
        description:
          '同时把 Windows 系统代理指向本插件端口，让浏览器等其他程序也走代理（「穿透」模式）。' +
          '关闭代理时会自动还原原设置。仅手动模式下由人决定是否开启',
      },
      tun: {
        type: 'boolean',
        description: '用 TUN 模式启动内核（接管全部流量）。需要管理员权限与 wintun 驱动，普通权限会启动失败',
      },
      upstream: {
        type: 'string',
        description:
          '借用本机已运行的代理客户端端口（跨界云 / Clash Verge 这类官方客户端），如 "7897"、"127.0.0.1:7897"。' +
          '给了它就不启动自有内核，AI 直接走那个客户端的本地代理口。留空则按插件配置或自己拉内核。',
      },
    },
    execute: async ({ node, upstream, systemProxy, tun }, exec) => {
      const key = holderKey(exec)
      // 借用外部客户端：官方客户端不给订阅时，这是让 AI 用上它的唯一通道。
      const upstreamInput = String(upstream ?? '').trim() || config.upstreamProxy
      if (upstreamInput) {
        const borrowed = await core.startUpstream({ url: upstreamInput, systemProxy: systemProxy === true })
        if (!borrowed.ok) return `借用外部代理失败：${borrowed.message}`
        holds.hold(key, { kind: key === 'ui' ? 'ui' : 'agent' })
        void trackNode()
        const check = await probe(config.testUrls[0], { timeoutMs: 20000, proxyUrl: core.proxyUrl })
        const lines = [borrowed.message, `出口：${core.proxyUrl}（HTTP_PROXY / ALL_PROXY 已写入，子进程自动继承）`]
        lines.push(
          check.reached
            ? `连通性验证：走 ${core.proxyUrl} 访问 ${config.testUrls[0]} ${check.ok ? '成功' : '链路通（站点返回非 2xx）'}（HTTP ${check.status}，${check.ms}ms）`
            : `连通性验证：走 ${core.proxyUrl} 访问 ${config.testUrls[0]} 失败（${check.error ?? '未知'}）。请确认那个客户端当前是「已连接」状态、且它的代理口确实是 HTTP 而不是 SOCKS-only。`,
        )
        lines.push('', '抓取自外页面/JSON 用 proxy_fetch；pwsh 里的 curl/git/npm 会自动走这个出口。收尾记得 proxy(action="off")。')
        return lines.join('\n')
      }

      let prepared = providerForActive({ store, paths })
      if (!prepared.active) {
        // 第一次用：如果本机装了 Clash Verge，就直接把它当前选的订阅搬过来，
        // 让「让 AI 自动用起来」不必先等用户手工配置。
        const imported = autoImportFromClashVerge({ store, logger })
        if (!imported) {
          return (
            '还没有可用订阅，代理无法开启。请先导入订阅：\n' +
            '1) Clash Verge 在本机：proxy_subscription(action="import", source="clash-verge")（可带 value=uid）\n' +
            '2) 有机场订阅地址：proxy_subscription(action="import", source="url", value="https://...")'
          )
        }
        prepared = providerForActive({ store, paths })
      }
      const { active, providerFile, count } = prepared
      if (!providerFile) {
        return `订阅「${active?.name ?? ''}」的快照文件缺失，请先 proxy_subscription(action="import", source="clash-verge") 重新导入。`
      }

      const result = await core.start({
        providerFile,
        node: node || store.state.selectedNode || '',
        systemProxy: systemProxy === true,
        tun: tun === true,
      })
      if (!result.ok) return `代理开启失败：${result.message}`
      holds.hold(key, { kind: key === 'ui' ? 'ui' : 'agent' })
      store.rememberStarted()
      const lines = [`${result.message}`, `订阅：${active.name}（约 ${count} 个节点）`]
      const group = await core.group()
      const analysis = analyzeNodes(group.nodes)
      if (group.node) {
        store.rememberNode(group.node)
        lines.push(`当前节点：${group.node}（候选 ${group.nodes.length} 个）`)
      }
      if (analysis.real.length) {
        lines.push(`看起来可用的节点（前 15 个）：${analysis.real.slice(0, 15).join(' / ')}${analysis.real.length > 15 ? ' …' : ''}`)
      }
      if (analysis.placeholder.length) {
        lines.push(
          `⚠️ 这个订阅里有 ${analysis.placeholder.length} 个占位节点（机场超量或到期时下发的假节点，名字如「${analysis.placeholder[0]}」），选中它们一定连不通。`,
        )
      }

      const verifyUrl = config.testUrls[0]
      const check = await probe(verifyUrl, { timeoutMs: 25000, proxyUrl: core.proxyUrl })
      if (check.reached) {
        lines.push(
          check.ok
            ? `连通性验证：走代理访问 ${verifyUrl} 成功（HTTP ${check.status}，${check.ms}ms）`
            : `连通性验证：隧道是通的，但目标站点返回 HTTP ${check.status}（限流/拒绝，非代理故障）。`,
        )
      } else {
        lines.push(
          `连通性验证：走代理访问 ${verifyUrl} 失败（${check.error ?? '未知'}）。` +
            `${analysis.placeholder.length && !analysis.real.length ? '这份订阅的节点全是占位节点，请先重置/续费机场并 proxy_subscription(action="refresh")。' : '可换节点：proxy_on(node="节点名")，或用 proxy_status(verify=true) 对比直连。'}`,
        )
      }
      if (!analysis.real.length && analysis.hasDirect) {
        lines.push('诊断建议：proxy_on(node="DIRECT") 可验证本地隧道本身是否正常（此时流量直连，不走节点）。')
      }
      void trackNode()
      lines.push(
        '',
        '提醒：harness 内置的 web_fetch 不走本代理；抓取境外页面/JSON 请用 proxy_fetch，' +
          '或在 pwsh 里直接 curl/`git`/`npm`（环境变量已设置，会自动走代理）。',
      )
      return lines.join('\n')
    },
  })

  const off = defineTool({
    name: 'proxy#off',
    description: '关闭代理（释放自己持有的引用，计数归零才真正停内核）。',
    parameters: {
      force: { type: 'boolean', description: '强制释放所有持有者并停止代理（人工面板用；智能体不要用它）' },
    },
    execute: async ({ force }, exec) => {
      const key = holderKey(exec)
      if (force) {
        const released = holds.releaseAll()
        if (!core.running) {
          core.restoreEnv()
          return `已清空 ${released} 个持有记录；代理本来就是关闭状态。`
        }
        const port = core.config.port
        await core.stop('force-off')
        void trackNode()
        return `已强制关闭代理（127.0.0.1:${port} 已停止，环境变量已还原）。`
      }

      const released = holds.release(key)
      if (!core.running) {
        core.restoreEnv()
        return '代理本来就是关闭状态，未做改动。'
      }
      if (holds.hasAny) {
        const others = holds.list().map((item) => item.label)
        const manual = holds.hasManual ? '（其中「人工面板」那份是人在面板上开的，AI 关不掉它）' : ''
        return (
          `已释放你的代理引用。还有 ${holds.size} 个持有者在使用：${others.join('、')}${manual}，因此**代理保持开启**。`
        )
      }
      const port = core.config.port
      await core.stop('last-holder-released')
      void trackNode()
      return released
        ? `已释放你的代理引用，没有其他持有者了，代理已关闭（127.0.0.1:${port} 已停止，环境变量已还原）。`
        : `代理已关闭（127.0.0.1:${port} 已停止，环境变量已还原）。`
    },
  })

  const nodes = defineTool({
    name: 'proxy_nodes',
    description:
      '查看和测速代理节点。action="list" 列出节点与已知延迟；' +
      'action="test" 触发一次全量测速并按延迟排序，返回真正可用的节点（机场常有大量死节点，开代理前先测最省事）。' +
      '切换节点用 proxy(action="on", node="节点名")。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'test'], description: '要执行的操作' },
      filter: { type: 'string', description: 'action="test" 时只报告名字包含该关键字的节点（如 "美国"、"HK"）' },
      limit: { type: 'integer', description: 'action="test" 时的报告条数上限（测速本身总是全量）', minimum: 1, maximum: 200 },
      timeoutMs: { type: 'integer', description: '整批测速的超时（默认 120000）', minimum: 5000, maximum: 180000 },
    },
    timeoutMs: 200000,
    execute: async ({ action, filter, limit, timeoutMs }) => {
      if (action === 'use') {
        return '切换节点请用 proxy(action="on", node="节点名")。先用 action="list" 或 "test" 看有哪些。'
      }

      const state = await snapshot({ core, store, config })
      if (state.mode === 'borrow') {
        return '当前是「借用外部客户端」模式，节点由那个客户端管理，插件无法列节点或测速。'
      }
      if (state.mode !== 'core') {
        return '代理未开启，没有可用的节点列表。请先 proxy_on（或先测速前先开代理：测速依赖内核）。'
      }

      const latencies = store.latencies()
      const label = (item) => {
        const record = latencies[item.name]
        const delay = Number.isFinite(record?.delay) ? `${record.delay}ms` : record ? '不通' : '未测'
        const flags = [item.placeholder ? '占位' : '', item.isDirect ? '内置直连' : ''].filter(Boolean).join('、')
        return `${item.name}｜${delay}${flags ? `｜${flags}` : ''}`
      }

      if (action === 'list') {
        if (!state.nodes.length) return '节点列表为空：内核可能还没加载完 provider，稍后重试，或检查订阅是否有效。'
        const lines = [
          `节点共 ${state.nodes.length} 个（看起来可用 ${state.counts.usable}，占位 ${state.counts.placeholder}）`,
          `当前：${state.node || '未选择'}`,
        ]
        for (const item of state.nodes.slice(0, 60)) lines.push(`- ${label(item)}`)
        if (state.nodes.length > 60) lines.push(`… 还有 ${state.nodes.length - 60} 个（用 filter 缩小范围）`)
        return lines.join('\n')
      }

      if (action === 'test') {
        const measured = await measureNodes({ core, store, timeoutMs })
        const keyword = String(filter ?? '').trim().toLowerCase()
        let sorted = measured.sorted
        if (keyword) sorted = sorted.filter((item) => item.name.toLowerCase().includes(keyword))
        const limitValue = Number(limit) > 0 ? Number(limit) : 0
        if (limitValue) sorted = sorted.slice(0, limitValue)

        const lines = [
          `测速完成：全部 ${measured.results.length} 个节点里 ${measured.sorted.length} 个可用（占位/失效已计入不通）。`,
        ]
        if (sorted.length) {
          lines.push('按延迟排序：')
          for (const item of sorted.slice(0, 25)) lines.push(`- ${item.name}｜${item.delay}ms`)
          const fastest = sorted[0]
          lines.push('', `建议：proxy_nodes(action="use", node="${fastest.name}") 或 proxy_on(node="${fastest.name}")。`)
        } else if (keyword) {
          lines.push(`没有名字含「${filter}」的可用节点，去掉 filter 重试。`)
        } else {
          lines.push('全部不通。若整份订阅都这样，通常是机场超量/到期：请续费后 proxy_subscription(action="refresh")。')
        }
        if (measured.dead.length) lines.push(`不通：${measured.dead.length} 个（占位节点也在其中，可用 action="list" 查看）。`)
        return lines.join('\n')
      }

      return `不认识 action：${action}`
    },
  })

  const subscription = defineTool({
    name: 'proxy_subscription',
    description:
      '管理代理订阅（就是「把梯子订阅搬到 DSH 上」的入口）。' +
      'action=list 列出 DSH 里已导入的订阅，以及本机 Clash Verge 里可直接搬的配置；' +
      'action=import 导入：source="clash-verge"（复用 Clash Verge 的订阅快照，value 可为 uid，省略则取它当前选中的）, source="url"（下载订阅地址，value=URL）, source="path"（读本地 yaml 文件，value=路径）；' +
      'action=use 切换生效订阅（value=订阅 id）；action=refresh 重新下载当前订阅（value 可覆盖 URL）；' +
      'action=remove 删除订阅（value=订阅 id，会同时删掉本地快照）。' +
      '导入的是**快照**，之后即使 Clash Verge 关闭或订阅地址失效也不影响使用。',
    parameters: {
      action: { type: 'string', required: true, enum: ['list', 'import', 'use', 'refresh', 'remove'], description: '要执行的操作' },
      source: {
        type: 'string',
        enum: ['clash-verge', 'url', 'path'],
        description: 'import 时的来源类型（默认 clash-verge）',
      },
      value: { type: 'string', description: 'import 的 uid / URL / 文件路径；use 的订阅 id；refresh 可选的新 URL' },
      name: { type: 'string', description: '给导入的订阅起个显示名（可选）' },
    },
    execute: async ({ action, source, value, name }) => {
      if (action === 'list') {
        const items = store.list()
        const activeId = store.active()?.id ?? ''
        const lines = ['DSH 里已导入的订阅：']
        lines.push(items.length ? items.map((item) => describeSubscription(item, activeId)).join('\n') : '- （空）')
        const verge = detectClashVerge()
        if (verge) {
          try {
            const profiles = parseVergeProfiles(fs.readFileSync(verge.profilesFile, 'utf8'))
            const remote = profiles.items.filter((item) => item.type === 'remote')
            lines.push('', `本机 Clash Verge（${verge.dir}）里可搬的订阅：`)
            if (remote.length) {
              for (const item of remote) {
                const mark = item.uid === profiles.current ? ' ← 它当前选中' : ''
                lines.push(`- uid=${item.uid}｜${item.name || '(未命名)'}${mark}`)
              }
            } else {
              lines.push('- （没有 remote 类型订阅）')
            }
          } catch (error) {
            lines.push(`（读取 Clash Verge 配置失败：${error?.message ?? error}）`)
          }
        } else {
          lines.push('', '本机未检测到 Clash Verge 配置目录。')
        }
        lines.push('', '导入示例：proxy_subscription(action="import", source="clash-verge")')
        return lines.join('\n')
      }

      if (action === 'import') {
        const kind = source || 'clash-verge'
        if (kind === 'clash-verge') {
          const verge = detectClashVerge()
          if (!verge) return '本机没有找到 Clash Verge 配置目录，请改用 source="url" 或 source="path" 导入。'
          const imported = importFromClashVerge(verge, value)
          const entry = store.upsert({ ...imported, name: name || imported.name })
          if (!store.active()) store.use(entry.id)
          const restartNote = core.running ? '\n代理正在运行，已按新订阅重启内核。' : ''
          if (core.running) await restartWithActive(deps)
          return `已从 Clash Verge 导入订阅「${entry.name}」（约 ${entry.proxyCount} 个节点，id=${entry.id}）。当前生效：${store.active()?.id}${restartNote}`
        }
        if (kind === 'url') {
          const url = String(value ?? '').trim()
          if (!/^https?:\/\//i.test(url)) return 'source="url" 需要 value 是一个 http(s) 订阅地址。'
          const fetched = await fetchText(url, {
            proxyUrl: core.running ? core.proxyUrl : '',
            timeoutMs: Math.max(config.fetchTimeoutMs, 20000),
            maxChars: 8_000_000,
            userAgent: SUBSCRIPTION_USER_AGENT,
          })
          if (!fetched.ok && !fetched.body) return `下载订阅失败：${fetched.error ?? '未知错误'}`
          const inspected = inspectSubscriptionText(fetched.body)
          if (!inspected.ok) return `下载到内容但不可用：${inspected.reason}`
          const id = safeId(name || new URL(url).hostname || 'subscription')
          const entry = store.upsert({
            id,
            name: name || new URL(url).hostname,
            source: 'url',
            url,
            content: fetched.body,
            proxyCount: inspected.count,
          })
          if (store.list().length === 1) store.use(entry.id)
          if (core.running) await restartWithActive(deps)
          return `已导入订阅「${entry.name}」（约 ${inspected.count} 个节点，id=${entry.id}）。当前生效：${store.active()?.id ?? entry.id}${core.running ? '\n代理正在运行，已重启内核。' : ''}`
        }
        if (kind === 'path') {
          const file = String(value ?? '').trim()
          if (!file) return 'source="path" 需要 value 是本地 yaml 文件的绝对路径。'
          let content = ''
          try {
            content = fs.readFileSync(path.resolve(file), 'utf8')
          } catch (error) {
            return `读取文件失败：${error?.message ?? error}`
          }
          const inspected = inspectSubscriptionText(content)
          if (!inspected.ok) return `文件内容不可用：${inspected.reason}`
          const id = safeId(name || path.basename(file, path.extname(file)))
          const entry = store.upsert({ id, name: name || id, source: 'path', content, proxyCount: inspected.count })
          if (store.list().length === 1) store.use(entry.id)
          if (core.running) await restartWithActive(deps)
          return `已导入订阅「${entry.name}」（约 ${inspected.count} 个节点，id=${entry.id}）。`
        }
        return `不认识的 source：${kind}`
      }

      if (action === 'use') {
        const id = String(value ?? '').trim()
        if (!id) return 'action="use" 需要 value=订阅 id（先用 action="list" 看有哪些）。'
        const entry = store.use(id)
        if (core.running) {
          const result = await restartWithActive(deps)
          return `已切换到订阅「${entry.name}」，并按新订阅重启了内核。${result}`
        }
        return `已切换到订阅「${entry.name}」（${entry.proxyCount} 个节点）。下次 proxy_on 生效。`
      }

      if (action === 'refresh') {
        const active = store.active()
        if (!active) return '还没有生效的订阅，请先 action="import"。'
        const url = String(value ?? active.url ?? '').trim()
        if (!/^https?:\/\//i.test(url)) return '这条订阅没有记录来源地址，无法自动刷新；请用 action="import" 重新导入。'
        const fetched = await fetchText(url, {
          proxyUrl: core.running ? core.proxyUrl : '',
          timeoutMs: Math.max(config.fetchTimeoutMs, 20000),
          maxChars: 8_000_000,
          userAgent: SUBSCRIPTION_USER_AGENT,
        })
        if (!fetched.ok && !fetched.body) return `刷新失败：${fetched.error ?? '未知错误'}`
        const inspected = inspectSubscriptionText(fetched.body)
        if (!inspected.ok) return `刷新到的内容不可用：${inspected.reason}`
        const entry = store.upsert({
          id: active.id,
          name: active.name,
          source: active.source,
          url,
          content: fetched.body,
          proxyCount: inspected.count,
        })
        if (core.running) await restartWithActive(deps)
        return `已刷新订阅「${entry.name}」（约 ${entry.proxyCount} 个节点）。${core.running ? '内核已重启。' : ''}`
      }

      if (action === 'remove') {
        const id = String(value ?? '').trim()
        if (!id) return 'action="remove" 需要 value=订阅 id（先用 action="list" 看有哪些）。'
        const result = store.remove(id)
        const lines = [`已移除订阅「${result.removed.name}」（${result.removed.proxyCount} 节点）及其本地快照。`]
        if (result.wasActive) {
          lines.push(
            result.nextActive
              ? `它原本是当前生效订阅，已自动切到「${result.nextActive.name}」。`
              : '它是唯一的订阅，现在没有生效订阅了：请用 action="import" 再导入一个。',
          )
        }
        if (core.running) {
          if (store.active()) {
            lines.push(await restartWithActive(deps))
          } else {
            await core.stop('subscription-removed')
            lines.push('代理已停止（没有可用订阅）。')
          }
        }
        return lines.join('\n')
      }

      return `不认识 action：${action}`
    },
  })

  const fetchTool = defineTool({
    name: 'proxy_fetch',
    description:
      '通过代理抓取一个 URL 的文本内容（一定走代理，返回正文，长内容会截断）。' +
      '当 web_fetch 因网络受限失败、或你要读的页面/API 在境外（GitHub、npm、PyPI、HuggingFace、各类境外文档站）时用它。' +
      '代理未开启时会直接报错并提示先调用 proxy_on。只做文本抓取，不执行页面脚本。',
    parameters: {
      url: { type: 'string', required: true, description: '要抓取的 http(s) URL' },
      maxChars: { type: 'integer', description: '正文最多返回多少字符（默认 60000）', minimum: 1000, maximum: 400000 },
      timeoutMs: { type: 'integer', description: '超时毫秒（默认用配置的 fetchTimeoutMs）', minimum: 2000, maximum: 120000 },
      userAgent: { type: 'string', description: '自定义 User-Agent（某些站点需要浏览器 UA）' },
    },
    timeoutMs: 150000,
    execute: async ({ url, maxChars, timeoutMs, userAgent }) => {
      if (!/^https?:\/\//i.test(String(url ?? ''))) return 'url 必须是 http(s) 地址。'
      if (!core.running) {
        return `代理当前是关闭的，无法走代理抓取 ${url}。请先调用 proxy_on，再重试本工具。`
      }
      const result = await fetchText(url, {
        proxyUrl: core.proxyUrl,
        timeoutMs: timeoutMs ?? config.fetchTimeoutMs,
        maxChars: maxChars ?? 60000,
        userAgent,
      })
      const header = `URL: ${url}\n状态: ${result.status}${result.ok ? '' : `（失败：${result.error ?? '未知'}）`}\n耗时: ${result.ms}ms${result.truncated ? '｜正文已截断' : ''}`
      return `${header}\n\n${result.body || '(空响应)'}`
    },
    isConcurrencySafe: () => true,
  })

  // ---- 合并后的控制工具：status / on / off 用 action 区分
  //
  // 为什么不保留三个独立工具：工具 schema 是每轮 prompt 的固定开销，三个开关类
  // 工具的参数几乎相同（node/upstream/verify），合并成一个可省下两份 schema。
  // 判断语义也更容易：模型想问"现在什么状态"就 action="status"。
  const proxy = defineTool({
    name: 'proxy',
    description:
      '开关代理并查看状态。action="status" 看当前是否开启、走的哪个节点、有哪些订阅；' +
      'action="on" 开启（必要时自动拉起本地内核），可带 node 指定节点；' +
      'action="off" 释放自己持有的引用，引用归零时才真正关闭。' +
      '访问境外资源失败/超时/被拦截，或任务明确需要国外网络时先 on 再重试，收尾 off。' +
      '出口是**进程级共享**的：同一 DSH 里的主智能体、队友、子智能体共用一个出口，用引用计数管理——' +
      '你 off 只释放自己那份，别人还在用时代理会保持开启；智能体结束时会自动释放你持有的引用。',
    parameters: {
      action: { type: 'string', required: true, enum: ['status', 'on', 'off'], description: '要执行的操作' },
      node: { type: 'string', description: 'action="on" 时要使用的节点名；已开启时传它即切换节点。留空用上次的节点或自动选择' },
      upstream: {
        type: 'string',
        description:
          'action="on" 时借用本机已运行代理客户端的本地 HTTP 端口（如 "7897"），不启动自有内核。' +
          '仅当该客户端关闭了系统代理/TUN、只暴露本地 HTTP 口时适用',
      },
      verify: { type: 'boolean', description: 'action="status" 时做「直连 vs 走代理」对照探测（多花几秒）' },
      systemProxy: {
        type: 'boolean',
        description:
          'action="on" 时同时打开 Windows 系统代理（穿透：浏览器等程序也走代理）。关闭时自动还原原设置',
      },
      tun: { type: 'boolean', description: 'action="on" 时用 TUN 模式（接管全部流量，需管理员权限）' },
      force: { type: 'boolean', description: 'action="off" 时强制释放所有持有者并停止代理（仅人工面板使用；智能体不要传它）' },
      showNodes: { type: 'boolean', description: 'action="status" 时列出全部候选节点名（默认只列前 15 个）' },
    },
    timeoutMs: 300000,
    execute: async (args, exec) => {
      const { action } = args
      if (action === 'status') return status.execute({ verify: args.verify, showNodes: args.showNodes })
      if (action === 'on') {
        return on.execute(
          { node: args.node, upstream: args.upstream, systemProxy: args.systemProxy, tun: args.tun },
          exec,
        )
      }
      if (action === 'off') return off.execute({ force: args.force === true }, exec)
      return `不认识 action：${action}（可用 status / on / off）`
    },
  })

  return [proxy, nodes, subscription, fetchTool]
}

/** 订阅变更后重启内核（沿用当前节点名，切不过去就让内核自己挑）。 */
async function restartWithActive(deps) {
  const { core, store, paths } = deps
  const selected = store.state.selectedNode || ''
  await core.stop()
  const { providerFile } = providerForActive({ store, paths })
  if (!providerFile) return '（但订阅快照缺失，内核未重启）'
  const result = await core.start({ providerFile, node: selected })
  if (!result.ok) return `（重启失败：${result.message}）`
  const group = await core.group()
  if (group.node) store.rememberNode(group.node)
  void deps.trackNode?.()
  return `当前节点：${group.node || '自动'}`
}

/** 供 index.js 组装 provider 文件时复用。 */
export { providerForActive, PROVIDER_ID }
