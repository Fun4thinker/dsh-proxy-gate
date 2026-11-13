/**
 * 共享操作层：面板（浏览器）和 AI 工具调用**同一份**逻辑。
 *
 * 这一层的存在是为了避免「UI 一套逻辑、工具一套逻辑」——按钮点击和模型调用
 * 走的是同一份实现，因此状态变化和失败原因天然一致。
 */

import { analyzeNodes, detectOpenProxyPorts } from './mihomo.js'
import { detectClashVerge } from './subscription.js'

/**
 * 生成一次完整的状态快照（面板与 proxy_status 共用）。
 *
 * @param {{core: any, store: any, config: any}} deps
 * @returns {Promise<object>}
 */
export async function snapshot({ core, store, config, holds }) {
  const summary = core.summary()
  const active = store.active()
  const latencies = store.latencies()

  let rawNodes = []
  let currentNode = ''
  if (summary.mode === 'core') {
    const group = await core.group()
    rawNodes = group.nodes
    currentNode = group.node
  }
  const analysis = analyzeNodes(rawNodes)

  const nodes = rawNodes.map((name) => {
    const record = latencies[name]
    return {
      name,
      placeholder: analysis.placeholder.includes(name),
      isDirect: name === 'DIRECT',
      delay: record && Number.isFinite(record.delay) ? record.delay : null,
      measuredAt: record?.at ?? 0,
    }
  })

  return {
    running: summary.running,
    mode: summary.mode,
    autoMode: store.autoMode(),
    holders: Array.isArray(holds?.list?.()) ? holds.list() : [],
    holderCount: holds?.size ?? 0,
    /** 系统代理（穿透）与 TUN 的当前状态。 */
    systemProxy: summary.systemProxy === true,
    tun: summary.tun === true,
    port: summary.port,
    controllerPort: summary.controllerPort,
    proxyUrl: summary.proxyUrl,
    borrowUrl: summary.borrowUrl,
    core: summary.corePath,
    startedAt: summary.startedAt,
    lastError: summary.lastError,
    node: currentNode,
    nodes,
    counts: {
      total: nodes.length,
      usable: analysis.real.length,
      placeholder: analysis.placeholder.length,
      measured: nodes.filter((item) => Number.isFinite(item.delay)).length,
    },
    hasDirect: analysis.hasDirect,
    subscription: active
      ? {
          id: active.id,
          name: active.name,
          proxyCount: active.proxyCount,
          source: active.source,
          importedAt: active.importedAt,
        }
      : null,
    subscriptions: store.list().map((item) => ({
      id: item.id,
      name: item.name,
      proxyCount: item.proxyCount,
      source: item.source,
      importedAt: item.importedAt,
      active: item.id === active?.id,
    })),
    clashVergeDetected: Boolean(detectClashVerge()),
    upstreamCandidates: summary.running ? [] : await detectOpenProxyPorts(config.upstreamPorts),
    testUrls: config.testUrls,
  }
}

/**
 * 测全部节点并记进 store（面板与工具共用）。
 *
 * 走 provider 健康检查：一次触发、内核内部并发，然后一次读回全部延迟。
 * 这条路同时解决了「mihomo 的 /proxies/{name}/delay 不支持非 ASCII 节点名」的问题。
 *
 * @param {{core: any, store: any, names?: string[], timeoutMs?: number}} deps
 * @returns {Promise<{results: Array<{name: string, delay: number|null, alive: boolean}>, sorted: any[], alive: string[], dead: string[]}>}
 */
export async function measureNodes({ core, store, names, timeoutMs }) {
  const measured = await core.measureAll({ timeoutMs })
  // 全部结果都记下来，面板下次打开就有延迟
  store.rememberLatencies(measured)
  const wanted = Array.isArray(names) && names.length ? new Set(names) : null
  const scoped = wanted ? measured.filter((item) => wanted.has(item.name)) : measured
  const sorted = scoped
    .filter((item) => Number.isFinite(item.delay))
    .sort((a, b) => a.delay - b.delay)
  const dead = scoped.filter((item) => !Number.isFinite(item.delay))
  return {
    results: scoped,
    sorted,
    alive: sorted.map((item) => `${item.name}（${item.delay}ms）`),
    dead: dead.map((item) => item.name),
  }
}

/**
 * 从快照里挑出要测的节点名。
 *
 * @param {object} snap snapshot() 结果
 * @param {{filter?: string, limit?: number, includePlaceholder?: boolean, includeDirect?: boolean}} [options]
 * @returns {string[]}
 */
export function pickNodeNames(snap, options = {}) {
  const keyword = String(options.filter ?? '').trim().toLowerCase()
  const limit = Number(options.limit) > 0 ? Number(options.limit) : 0
  let list = (snap.nodes ?? []).filter((item) => {
    if (item.isDirect && !options.includeDirect) return false
    if (item.placeholder && !options.includePlaceholder) return false
    if (keyword && !item.name.toLowerCase().includes(keyword)) return false
    return true
  })
  if (limit) list = list.slice(0, limit)
  return list.map((item) => item.name)
}
