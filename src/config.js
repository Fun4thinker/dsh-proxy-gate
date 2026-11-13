/**
 * 插件配置解析与落盘路径。
 *
 * 配置来源是 Loader patch 里那一行的 `config`（见 cordis.patch.yml），本插件
 * 不导出 schemastery `Config`：profile 侧的 node_modules 不含
 * `@deepseek-ai/schemastery`，插件包又只有零依赖才能在任何 profile 里装上。
 * 因此这里手工做「默认值 + 校验 + 归一化」，与 dsh-recorder 的做法一致。
 */

import os from 'node:os'
import path from 'node:path'

/** 全部可调项及其默认值。 */
export const DEFAULT_CONFIG = {
  /** 总开关；false 时不注册任何工具。 */
  enabled: true,
  /** 本地 mixed（HTTP + SOCKS 同端口）代理端口。 */
  port: 7892,
  /** mihomo 控制端口，只监听 127.0.0.1。 */
  controllerPort: 7893,
  /** 内核可执行文件；空 = 自动探测。 */
  corePath: '',
  /** 插件加载时自动拉起代理。 */
  autoStart: false,
  /** 不走代理的地址。 */
  noProxy: 'localhost,127.0.0.1,::1,.local',
  /** 节点健康检查 URL。 */
  healthCheckUrl: 'https://www.gstatic.com/generate_204',
  /** proxy_status(verify=true) 使用的验证 URL。 */
  testUrls: ['https://www.gstatic.com/generate_204', 'https://api.github.com/zen'],
  /** 是否注入「何时该开代理」的系统提示。 */
  promptGuidance: true,
  /** 是否注入一行实时状态（开着没有、走的哪个节点）。 */
  liveStateContext: true,
  /** 代理抓取单次超时。 */
  fetchTimeoutMs: 30000,
  /** 内核启动后等待端口就绪的上限。 */
  readyTimeoutMs: 15000,
  /** 状态目录；空 = $DSH_HOME/proxy-gate。 */
  storeDir: '',
  /**
   * 借用本机已运行代理客户端的端口（跨界云、Clash Verge 等官方客户端）。
   * 形如 '7897' / '127.0.0.1:7897' / 'http://127.0.0.1:7897'；空 = 默认自己拉内核。
   */
  upstreamProxy: '',
  /** 自动探测外部客户端端口时依次尝试的端口。 */
  upstreamPorts: [7897, 7890, 10808, 10809, 1080, 20171],
}

/**
 * 把 patch 里的 config 归一化成确定形状。
 *
 * @param {Record<string, any>} [userConfig]
 * @returns {typeof DEFAULT_CONFIG}
 */
export function resolveConfig(userConfig) {
  const config = userConfig && typeof userConfig === 'object' ? userConfig : {}
  const port = toPort(config.port, DEFAULT_CONFIG.port)
  let controllerPort = toPort(config.controllerPort, DEFAULT_CONFIG.controllerPort)
  if (controllerPort === port) controllerPort = port + 1
  return {
    ...DEFAULT_CONFIG,
    ...config,
    enabled: config.enabled !== false,
    port,
    controllerPort,
    corePath: typeof config.corePath === 'string' ? config.corePath.trim() : '',
    storeDir: typeof config.storeDir === 'string' ? config.storeDir.trim() : '',
    upstreamProxy: typeof config.upstreamProxy === 'string' ? config.upstreamProxy.trim() : '',
    upstreamPorts: toPortList(config.upstreamPorts, DEFAULT_CONFIG.upstreamPorts),
    autoStart: config.autoStart === true,
    promptGuidance: config.promptGuidance !== false,
    noProxy: typeof config.noProxy === 'string' ? config.noProxy : DEFAULT_CONFIG.noProxy,
    healthCheckUrl: toUrl(config.healthCheckUrl, DEFAULT_CONFIG.healthCheckUrl),
    testUrls: toUrlList(config.testUrls, DEFAULT_CONFIG.testUrls),
    fetchTimeoutMs: toPositiveInt(config.fetchTimeoutMs, DEFAULT_CONFIG.fetchTimeoutMs),
    readyTimeoutMs: toPositiveInt(config.readyTimeoutMs, DEFAULT_CONFIG.readyTimeoutMs),
  }
}

/** @returns {number} 合法端口，否则回落默认值 */
function toPort(value, fallback) {
  const num = Number(value)
  return Number.isInteger(num) && num > 0 && num < 65536 ? num : fallback
}

/** @returns {number} */
function toPositiveInt(value, fallback) {
  const num = Number(value)
  return Number.isSafeInteger(num) && num > 0 ? num : fallback
}

/** @returns {string} */
function toUrl(value, fallback) {
  if (typeof value !== 'string') return fallback
  const trimmed = value.trim()
  return /^https?:\/\/\S+$/.test(trimmed) ? trimmed : fallback
}

/** @returns {string[]} */
function toUrlList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const urls = value.map((item) => toUrl(item, '')).filter(Boolean)
  return urls.length ? urls : [...fallback]
}

/** @returns {number[]} */
function toPortList(value, fallback) {
  if (!Array.isArray(value)) return [...fallback]
  const ports = value.map((item) => Number(item)).filter((num) => Number.isInteger(num) && num > 0 && num < 65536)
  return ports.length ? ports : [...fallback]
}

/**
 * 解析插件自己的目录布局。
 *
 * @param {typeof DEFAULT_CONFIG} config
 * @returns {{home: string, dir: string, subsDir: string, runtimeDir: string, stateFile: string, subsFile: string, pidFile: string, logFile: string}}
 */
export function resolvePaths(config) {
  const home = process.env.DSH_HOME || path.join(os.homedir(), '.dsh')
  const dir = config.storeDir ? path.resolve(config.storeDir) : path.join(home, 'proxy-gate')
  const subsDir = path.join(dir, 'subscriptions')
  const runtimeDir = path.join(dir, 'runtime')
  return {
    home,
    dir,
    subsDir,
    runtimeDir,
    stateFile: path.join(dir, 'state.json'),
    subsFile: path.join(dir, 'subscriptions.json'),
    pidFile: path.join(runtimeDir, 'core.pid'),
    logFile: path.join(runtimeDir, 'core.log'),
  }
}
