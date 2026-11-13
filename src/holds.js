/**
 * 代理持有者登记（引用计数）。dsh-proxy-gate
 *
 * 为什么需要它：代理是**进程级**资源，主智能体、Agent Teams 队友、subagent 共用
 * 同一个出口。如果只用一个全局开关，子智能体执行完 `off` 就会把主智能体正在用的
 * 代理一起关掉——这在实际协作里几乎一定会发生。
 *
 * 所以改成「按持有者引用计数」：
 *   - 谁开代理，就为它登记一个持有（同一个持有者重复开启不会重复计数）；
 *   - 谁关代理，只释放自己的那一份；
 *   - 计数归零时才真正停止内核。
 *
 * 另外两条自动释放规则避免泄漏：
 *   1. 智能体被销毁（agent/disposed）时自动释放它持有的引用；
 *   2. 面板上的「关闭」是**强制**关闭（释放全部），因为那是人的明确意图。
 */

/** 一个持有者。kind 目前只有 agent（智能体）与 ui（人工面板/命令行）。 */
const UI_KEY = 'ui'

/** 持有者的可读名字（'ui' 这种内部键不要直接给模型/用户看）。 */
function labelFor(id) {
  if (id === UI_KEY) return '人工面板'
  // session id 形如 session-1ecb61b0-...，去掉前缀再取前 8 位便于辨认
  const short = id.replace(/^session-/i, '').slice(0, 8)
  return short ? `智能体 ${short}` : '智能体'
}
export class HoldRegistry {
  constructor() {
    /** @type {Map<string, {kind: string, label: string, at: number}>} */
    this.holds = new Map()
  }

  /**
   * 登记一份持有。
   *
   * @param {string} key 持有者标识（智能体用 session id，人工用 'ui'）
   * @param {{kind?: string, label?: string}} [meta]
   * @returns {boolean} 是否是新增持有（false 表示本来就有）
   */
  hold(key, meta = {}) {
    const id = String(key ?? '').trim() || 'ui'
    if (this.holds.has(id)) return false
    this.holds.set(id, { kind: meta.kind ?? 'agent', label: meta.label ?? labelFor(id), at: Date.now() })
    return true
  }

  /**
   * 释放一份持有。
   *
   * @param {string} key
   * @returns {boolean} 是否真的释放了一个存在过的持有
   */
  release(key) {
    return this.holds.delete(String(key ?? '').trim() || 'ui')
  }

  /** 释放全部（人工强制关闭）。 */
  releaseAll() {
    const count = this.holds.size
    this.holds.clear()
    return count
  }

  /** 当前持有多久。 */
  get size() {
    return this.holds.size
  }

  /** 是否还有持有者。 */
  get hasAny() {
    return this.holds.size > 0
  }

  /** 快速查询。 */
  has(key) {
    return this.holds.has(String(key ?? '').trim() || 'ui')
  }

  /** @returns {Array<{key: string, kind: string, label: string, at: number}>} */
  list() {
    return [...this.holds.entries()].map(([key, value]) => ({ key, ...value }))
  }

  /** 是否存在「人工持有」（人工开的代理，AI 关不掉）。 */
  get hasManual() {
    return this.holds.has(UI_KEY)
  }
}
