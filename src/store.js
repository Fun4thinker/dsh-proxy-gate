/**
 * 插件自己的持久化状态。
 *
 * 只存「运行期自己会变」的东西：当前选中的订阅、上次选中的节点、启动时间。
 * 可调参数留在 Loader patch 的 config 里（用户改 profile patch 即可，升级不丢）。
 * 订阅正文单独落成 `<subsDir>/<id>.yaml` 快照 —— 这就是「把梯子订阅搬到 DSH 上」，
 * 之后即使 Clash Verge 卸载、订阅地址失效，代理依然能用。
 */

import fs from 'node:fs'
import path from 'node:path'

/** 订阅 id 只允许安全字符，避免拼进文件名时穿越目录。 */
export function safeId(raw) {
  return String(raw ?? '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64)
}

/** 读 JSON；文件不存在或损坏时返回 fallback（并在 logger 上留痕）。 */
export function readJson(file, fallback, logger) {
  try {
    const text = fs.readFileSync(file, 'utf8')
    const parsed = JSON.parse(text)
    return parsed && typeof parsed === 'object' ? parsed : fallback
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      logger?.warn?.(`proxy-gate: 读取 ${path.basename(file)} 失败，按默认值继续：${error?.message ?? error}`)
    }
    return fallback
  }
}

/** 原子写 JSON（先写 .tmp 再 rename），避免半截文件。 */
export function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
  fs.renameSync(tmp, file)
}

/** 状态仓库：state.json（运行期状态）+ subscriptions.json（订阅清单）+ 快照文件。 */
export class Store {
  /**
   * @param {{paths: ReturnType<typeof import('./config.js').resolvePaths>, logger?: any}} options
   */
  constructor({ paths, logger }) {
    this.paths = paths
    this.logger = logger
    this.state = {
      version: 1,
      activeSubscriptionId: '',
      selectedNode: '',
      lastStartedAt: 0,
      latencies: {},
      /**
       * 自动模式：true = 给 AI 注册代理工具，由它自主开关代理；
       * false = 不注册工具（隐藏、省 context、不扰动缓存），由人在面板里开关。
       */
      autoMode: true,
      /** 自动模式下，任务结束是否自动关闭（false = 常驻）。 */
      autoOffWhenDone: true,
    }
    this.subscriptions = { version: 1, items: [] }
  }

  /** 建目录并读入两份 JSON。 */
  load() {
    fs.mkdirSync(this.paths.subsDir, { recursive: true })
    fs.mkdirSync(this.paths.runtimeDir, { recursive: true })
    const state = readJson(this.paths.stateFile, null, this.logger)
    if (state) this.state = { ...this.state, ...state }
    const subs = readJson(this.paths.subsFile, null, this.logger)
    if (subs && Array.isArray(subs.items)) this.subscriptions = { version: 1, items: subs.items.filter((item) => item && safeId(item.id) === item.id) }
    return this
  }

  /** 落盘运行期状态。 */
  saveState() {
    try {
      writeJson(this.paths.stateFile, this.state)
    } catch (error) {
      this.logger?.warn?.(`proxy-gate: 保存 state.json 失败：${error?.message ?? error}`)
    }
  }

  /** 落盘订阅清单。 */
  saveSubscriptions() {
    try {
      writeJson(this.paths.subsFile, this.subscriptions)
    } catch (error) {
      this.logger?.warn?.(`proxy-gate: 保存 subscriptions.json 失败：${error?.message ?? error}`)
    }
  }

  /** @returns {Array<any>} 订阅清单（按导入时间倒序） */
  list() {
    return [...this.subscriptions.items].sort((a, b) => (b.importedAt ?? 0) - (a.importedAt ?? 0))
  }

  /** @returns {any | undefined} */
  get(id) {
    const key = safeId(id)
    return this.subscriptions.items.find((item) => item.id === key)
  }

  /** @returns {any | undefined} 当前生效的订阅 */
  active() {
    const id = safeId(this.state.activeSubscriptionId)
    if (!id) return undefined
    return this.get(id)
  }

  /** 快照文件绝对路径。 */
  snapshotPath(id) {
    return path.join(this.paths.subsDir, `${safeId(id)}.yaml`)
  }

  /**
   * 写入一份订阅（快照 + 清单条目）。
   *
   * @param {{id: string, name: string, source: string, url?: string, content: string, proxyCount: number}} input
   * @returns {any} 写入后的条目
   */
  upsert({ id, name, source, url, content, proxyCount }) {
    const key = safeId(id)
    if (!key) throw new Error('订阅 id 为空')
    const file = this.snapshotPath(key)
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, content, 'utf8')
    const existing = this.get(key)
    const entry = {
      id: key,
      name: name || existing?.name || key,
      source: source || existing?.source || 'unknown',
      url: url || existing?.url || '',
      proxyCount: Number.isInteger(proxyCount) ? proxyCount : existing?.proxyCount ?? 0,
      importedAt: Date.now(),
    }
    this.subscriptions.items = [entry, ...this.subscriptions.items.filter((item) => item.id !== key)]
    if (!this.state.activeSubscriptionId) {
      this.state.activeSubscriptionId = key
      this.saveState()
    }
    this.saveSubscriptions()
    return entry
  }

  /** 选中一份订阅。 */
  use(id) {
    const entry = this.get(id)
    if (!entry) throw new Error(`没有 id 为 ${id} 的订阅`)
    this.state.activeSubscriptionId = entry.id
    this.saveState()
    return entry
  }

  /**
   * 移除一份订阅（连同快照文件）。若移除的是当前生效项，则清空生效项。
   *
   * @param {string} id
   * @returns {{removed: any, wasActive: boolean, nextActive?: any}}
   */
  remove(id) {
    const entry = this.get(id)
    if (!entry) throw new Error(`没有 id 为 ${id} 的订阅`)
    this.subscriptions.items = this.subscriptions.items.filter((item) => item.id !== entry.id)
    try {
      fs.rmSync(this.snapshotPath(entry.id), { force: true })
    } catch {
      /* 文件可能已被删除 */
    }
    const wasActive = this.state.activeSubscriptionId === entry.id
    if (wasActive) {
      this.state.activeSubscriptionId = ''
      this.saveState()
    }
    this.saveSubscriptions()
    const nextActive = wasActive ? this.list()[0] : undefined
    if (nextActive) this.use(nextActive.id)
    return { removed: entry, wasActive, nextActive }
  }

  /** 记录本次启动时选中的节点。 */
  rememberNode(node) {
    this.state.selectedNode = typeof node === 'string' ? node : ''
    this.saveState()
  }

  /** 标记一次成功启动。 */
  rememberStarted() {
    this.state.lastStartedAt = Date.now()
    this.saveState()
  }

  /**
   * 记录一批测速结果。失败（null）也存，用来区分「没测过」和「测过但不通」。
   *
   * @param {Array<{name: string, delay: number | null}>} results
   */
  rememberLatencies(results) {
    const map = { ...(this.state.latencies ?? {}) }
    for (const item of Array.isArray(results) ? results : []) {
      if (!item?.name) continue
      map[item.name] = { delay: Number.isFinite(item.delay) ? item.delay : null, at: Date.now() }
    }
    this.state.latencies = map
    this.saveState()
  }

  /** @returns {Record<string, {delay: number|null, at: number}>} */
  latencies() {
    return this.state.latencies ?? {}
  }

  /** 自动模式开关（持久化）。 */
  setAutoMode(enabled) {
    this.state.autoMode = enabled === true
    this.saveState()
    return this.state.autoMode
  }

  /** @returns {boolean} */
  autoMode() {
    return this.state.autoMode !== false
  }
}
