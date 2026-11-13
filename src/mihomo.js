/**
 * mihomo 内核的探测、配置生成与生命周期管理。
 *
 * 做法：不碰系统代理、不依赖 Clash Verge 是否在运行，而是用**内核本体**
 * （Clash Verge 自带的 verge-mihomo.exe，或 PATH 里的 mihomo/clash-meta）
 * 在本机拉起一个只监听 127.0.0.1 的 mixed 端口（HTTP+SOCKS 同端口）。
 *
 * 节点来源是订阅快照里切出来的 proxies 段，经 mihomo 的 file 类型
 * proxy-provider 载入 —— 解析工作全部交给内核，我们不实现任何协议。
 *
 * 生成的最小运行配置只有：我们的端口/控制器、一个 select 组、一个 url-test 组、
 * 一条 MATCH 规则。订阅里的 dns / rules / listeners 一律不继承，行为可预测。
 */

import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { spawn } from 'node:child_process'

import { enableSystemProxy, readSystemProxy, restoreSystemProxy } from './system-proxy.js'

/** provider / 组名常量（固定值，避免订阅里的怪字符污染生成的 YAML）。 */
export const PROVIDER_ID = 'sub'
export const SELECT_GROUP = 'PROXY'
export const AUTO_GROUP = 'AUTO'

/** 可能的内核可执行文件名。 */
const CORE_BINARIES = ['verge-mihomo.exe', 'mihomo.exe', 'clash-meta.exe', 'clash.exe']

/** 探测顺序里的「常见安装位置」。 */
function commonCoreDirs() {
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  const programFiles = process.env.ProgramFiles || 'C:\\Program Files'
  const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)'
  return [
    path.join(localAppData, 'Programs', 'Clash Verge'),
    path.join(localAppData, 'Programs', 'clash-verge'),
    path.join(localAppData, 'Programs', 'Clash Verge Rev'),
    path.join(programFiles, 'Clash Verge'),
    path.join(programFiles, 'Clash Verge Rev'),
    path.join(programFiles, 'Mihomo'),
    path.join(programFilesX86, 'Clash Verge'),
  ]
}

/** 在一个目录里（含 resources 子目录）找内核。 */
function findCoreIn(dir) {
  if (!dir) return ''
  for (const sub of ['', 'resources']) {
    for (const binary of CORE_BINARIES) {
      const candidate = path.join(dir, sub, binary)
      try {
        if (fs.statSync(candidate).isFile()) return candidate
      } catch {
        /* 不存在 */
      }
    }
  }
  return ''
}

/** PATH 里的内核。 */
function findCoreInPath() {
  const pathValue = process.env.PATH || ''
  for (const dir of pathValue.split(path.delimiter)) {
    const found = findCoreIn(dir)
    if (found) return found
  }
  return ''
}

/**
 * 从注册表的卸载项里挖安装目录（Clash Verge 装在非默认盘时只有这条路）。
 *
 * 实测 Clash Verge 2.5.7 写在 HKLM\...\Uninstall\Clash Verge，
 * InstallLocation 的值带引号（`"D:\Clash Verge"`），这里一并处理。
 *
 * @returns {Promise<string[]>}
 */
async function registryInstallDirs() {
  const roots = [
    'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
    'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\Uninstall',
  ]
  const lists = await Promise.all(roots.map((root) => queryInstallLocations(root)))
  return [...new Set(lists.flat())]
}

/**
 * 查一个卸载根键下所有 InstallLocation。
 *
 * @param {string} root
 * @returns {Promise<string[]>}
 */
function queryInstallLocations(root) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('reg.exe', ['query', root, '/s', '/v', 'InstallLocation'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve([])
      return
    }
    const chunks = []
    let settled = false
    const finish = (dirs) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(dirs)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish(parseInstallLocations(Buffer.concat(chunks).toString('utf8')))
    }, 6000)
    child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => finish([]))
    child.on('close', () => finish(parseInstallLocations(Buffer.concat(chunks).toString('utf8'))))
  })
}

/** `reg query /s /v InstallLocation` 的输出里每一行 InstallLocation 都是一条。 */
function parseInstallLocations(text) {
  const dirs = []
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /InstallLocation\s+REG_\w+\s+(.+)$/i.exec(line)
    if (!match) continue
    const value = match[1].trim().replace(/^"(.*)"$/, '$1').replace(/[\\/]+$/, '')
    if (!value) continue
    dirs.push(value.replace(/%([^%]+)%/g, (whole, name) => process.env[name] ?? whole))
  }
  return dirs
}

/**
 * 定位内核可执行文件。
 *
 * @param {{corePath?: string}} config
 * @returns {Promise<string>} 绝对路径；找不到返回空串
 */
export async function resolveCorePath(config) {
  const explicit = [config?.corePath, process.env.MIHOMO_PATH, process.env.CLASH_CORE].filter(
    (item) => typeof item === 'string' && item.trim() !== '',
  )
  for (const item of explicit) {
    const resolved = path.resolve(item)
    try {
      if (fs.statSync(resolved).isFile()) return resolved
    } catch {
      /* 落空，继续探测 */
    }
  }
  const fromPath = findCoreInPath()
  if (fromPath) return fromPath
  for (const dir of commonCoreDirs()) {
    const found = findCoreIn(dir)
    if (found) return found
  }
  for (const dir of await registryInstallDirs()) {
    const found = findCoreIn(dir)
    if (found) return found
  }
  return ''
}

/** Windows 路径进 YAML 时统一用正斜杠，省掉转义问题。 */
export function toYamlPath(filePath) {
  return String(filePath).replace(/\\/g, '/')
}

/**
 * 生成 mihomo 的最小运行配置。
 *
 * @param {{port: number, controllerPort: number, secret: string, providerFile: string, healthCheckUrl: string}} input
 * @returns {string}
 */
export function renderRuntimeConfig({ port, controllerPort, secret, providerFile, healthCheckUrl, tun }) {
  const lines = [
    '# Generated by dsh-proxy-gate. 每次启动都会重写，请勿手工编辑。',
    `mixed-port: ${port}`,
    'allow-lan: false',
    'mode: rule',
    'log-level: warning',
    'ipv6: true',
    `external-controller: 127.0.0.1:${controllerPort}`,
    `secret: '${secret}'`,
    'unified-delay: true',
    'tcp-concurrent: true',
    'profile:',
    '  store-selected: true',
  ]
  if (tun) {
    // TUN 需要管理员权限与 wintun 驱动；没权限时内核会在启动阶段报错，由分类逻辑说明。
    lines.push(
      'tun:',
      '  enable: true',
      '  stack: gvisor',
      '  auto-route: true',
      '  auto-detect-interface: true',
      '  device: DshProxyGate',
      '  dns-hijack:',
      '    - any:53',
    )
  }
  lines.push(
    'proxy-providers:',
    `  ${PROVIDER_ID}:`,
    '    type: file',
    `    path: '${toYamlPath(providerFile)}'`,
    '    health-check:',
    '      enable: true',
    `      url: '${healthCheckUrl}'`,
    '      interval: 600',
    'proxy-groups:',
    `  - name: ${SELECT_GROUP}`,
    '    type: select',
    // 把内置 DIRECT 也放进来：订阅节点全废时组里仍有可用成员（否则内核会报
    // "group has no usable proxies"），同时它是排查隧道的救命选项。
    `    proxies: [${AUTO_GROUP}, DIRECT]`,
    `    use: [${PROVIDER_ID}]`,
    `  - name: ${AUTO_GROUP}`,
    '    type: url-test',
    `    use: [${PROVIDER_ID}]`,
    `    url: '${healthCheckUrl}'`,
    '    interval: 300',
    '    tolerance: 50',
    'rules:',
    `  - MATCH,${SELECT_GROUP}`,
    '',
  )
  return lines.join('\n')
}

/**
 * 探测端口是否已经有人监听。
 *
 * @param {number} port
 * @param {number} [timeoutMs]
 * @returns {Promise<boolean>}
 */
export function isPortOpen(port, timeoutMs = 500) {
  return new Promise((resolve) => {
    const socket = net.connect({ host: '127.0.0.1', port })
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve(value)
    }
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false))
    socket.once('error', () => finish(false))
  })
}

/** 内核启动失败的三类归因（重试是否有意义完全不同）。 */
export function classifyCoreFailure(logText) {
  const text = String(logText ?? '')
  if (/tun|wintun|operation not permitted|permission denied|access is denied/i.test(text)) {
    return {
      summary: 'TUN 模式启动失败（通常是缺少管理员权限或 wintun 驱动）',
      hint: 'TUN 需要以管理员身份运行 DSH，并允许内核安装 wintun 虚拟网卡；不想提权就改用系统代理（穿透）或只用默认的 AI 专属出口。',
    }
  }
  if (/Parse config error|proxy .* not found|invalid config/i.test(text)) {
    return {
      summary: '内核拒绝了我们生成的最小配置（日志里有 Parse config error）',
      hint: '通常是订阅内容异常或端口配置冲突；可先用 proxy_subscription(action="import") 重新导入一次快照。',
    }
  }
  if (/MMDB|geosite|geoip|context deadline exceeded/i.test(text)) {
    return {
      summary: '内核在加载 geo 资源时失败或长时间阻塞（本插件的最小配置不引用 GEOIP/GEOSITE，出现这个通常意味着订阅正文里带了 dns/geo 相关字段）',
      hint: '可把 Clash Verge 目录下的 Country.mmdb / geoip.metadb / geosite.dat 复制到插件的 runtime 目录后重试。',
    }
  }
  if (/i\/o timeout|connect error|connection refused|no route to host/i.test(text)) {
    return {
      summary: '内核已加载配置，但节点连不上（节点不可用或已过期）',
      hint: '换一个节点（proxy_on(node="节点名")），或用 proxy_status(verify=true) 对比直连与代理。',
    }
  }
  return {
    summary: '内核启动超时：进程起来了但没有在期限内对外提供 API',
    hint: '检查端口是否被占用（Clash Verge 自身常用 7897），或查看 runtime/core.log。',
  }
}

/** 占位节点识别：机场超量/到期时常见「流量用完」「请续费」这类假节点，
 * 以及把套餐信息（剩余流量 / 套餐到期 / 官网地址）直接下发成 ss 节点的写法。 */
export function looksLikePlaceholderNode(name) {
  return /(流量用完|流量耗尽|重置流量|剩余流量|套餐到期|距离下次重置|续费|到期|过期|请到官网|官网地址|更新订阅|expired|traffic.*used|traffic.*exhaust)/i.test(
    String(name ?? ''),
  )
}

/**
 * 把候选节点分成「可用」与「占位」两拨。
 *
 * @param {string[]} nodes
 * @returns {{real: string[], placeholder: string[], hasDirect: boolean}}
 */
export function analyzeNodes(nodes) {
  const list = Array.isArray(nodes) ? nodes : []
  const real = []
  const placeholder = []
  let hasDirect = false
  for (const name of list) {
    if (name === 'DIRECT') {
      hasDirect = true
      continue
    }
    if (looksLikePlaceholderNode(name)) placeholder.push(name)
    else real.push(name)
  }
  return { real, placeholder, hasDirect }
}

/**
 * 规范化用户/模型给的外部代理地址：接受 `7897`、`127.0.0.1:7897`、
 * `http://127.0.0.1:7897`，统一成 `http://host:port`。
 *
 * @param {string} raw
 * @returns {string} 规范化结果；无法识别返回空串
 */
export function normalizeProxyUrl(raw) {
  const text = String(raw ?? '').trim()
  if (!text) return ''
  if (/^\d{2,5}$/.test(text)) {
    const port = Number(text)
    return port > 0 && port < 65536 ? `http://127.0.0.1:${port}` : ''
  }
  if (/^[a-z0-9.-]+:\d{2,5}$/i.test(text)) return `http://${text}`
  if (/^https?:\/\/[^\s]+$/i.test(text)) {
    try {
      const url = new URL(text)
      if (!url.port) return ''
      return `${url.protocol}//${url.host}`
    } catch {
      return ''
    }
  }
  return ''
}

/** 从代理 URL 里取端口。 */
function portOfProxyUrl(proxyUrl) {
  try {
    return Number(new URL(proxyUrl).port) || 0
  } catch {
    return 0
  }
}

/**
 * 找出本机正在监听的候选代理端口（跨界云、Clash Verge 这类官方客户端）。
 *
 * @param {number[]} ports
 * @returns {Promise<number[]>}
 */
export async function detectOpenProxyPorts(ports) {
  const list = Array.isArray(ports) ? ports : []
  const results = await Promise.all(list.map(async (port) => ((await isPortOpen(port, 250)) ? port : 0)))
  return results.filter(Boolean)
}

/** 进程是否还活着。 */
function isAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return error?.code === 'EPERM'
  }
}

/** 内核实例：一次 start/stop 对应一个子进程。 */
export class MihomoCore {
  /**
   * @param {{config: any, paths: any, logger?: any}} options
   */
  constructor({ config, paths, logger }) {
    this.config = config
    this.paths = paths
    this.logger = logger
    this.child = null
    this.corePath = ''
    this.secret = ''
    this.startedAt = 0
    this.lastError = ''
    this.savedEnv = null
    /** 借用外部客户端端口时记录的地址（非空即表示 borrow 模式）。 */
    this.borrowUrl = ''
    /** 是否是我们主动要求停止（用来区分「正常关闭」和「内核自己挂了」）。 */
    this.stopping = false
    /** 开启系统代理前记录的原值（用于还原）。 */
    this.savedSystemProxy = null
    /** 当前是否已把系统代理指向本插件。 */
    this.systemProxyOn = false
    /** 本次是否用 TUN 模式启动。 */
    this.tunOn = false
    /** 内核意外退出时的回调（由插件层提供，用于自动重启）。 */
    this.onUnexpectedExit = null
  }

  /** 往 runtime/lifecycle.log 追加一行，方便事后判断内核为什么没了。 */
  trace(message) {
    try {
      const line = `${new Date().toISOString()} ${message}\n`
      fs.appendFileSync(path.join(this.paths.runtimeDir, 'lifecycle.log'), line, 'utf8')
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  /** 当前模式：core（自己拉内核）/ borrow（借用外部客户端）/ null（关闭）。 */
  get mode() {
    if (this.borrowUrl) return 'borrow'
    return this.child ? 'core' : null
  }

  /** 当前是否持有可用出口。 */
  get running() {
    if (this.borrowUrl) return true
    return Boolean(this.child && this.child.pid && isAlive(this.child.pid))
  }

  /** mixed 代理地址。 */
  get proxyUrl() {
    return this.borrowUrl || `http://127.0.0.1:${this.config.port}`
  }

  /** SOCKS 地址（mixed 端口同时支持；借用外部端口时沿用同一 HTTP 口）。 */
  get socksUrl() {
    if (this.borrowUrl) return this.borrowUrl
    return `socks5h://127.0.0.1:${this.config.port}`
  }

  /**
   * 借用本机已经运行的代理客户端端口（官方客户端不给订阅时用这个）。
   *
   * 此时插件不启动内核、不管节点，只负责「把出口告诉 AI」：写环境变量 +
   * 让 proxy_fetch 指向该端口。节点选择由那个客户端自己负责。
   *
   * @param {{url: string}} input
   * @returns {Promise<{ok: boolean, message: string}>}
   */
  async startUpstream({ url, systemProxy }) {
    const normalized = normalizeProxyUrl(url)
    if (!normalized) {
      return { ok: false, message: `无法识别的代理地址：${url}。可以写 7897、127.0.0.1:7897 或 http://127.0.0.1:7897。` }
    }
    if (this.running) await this.stop()
    const port = portOfProxyUrl(normalized)
    if (!port || !(await isPortOpen(port, 800))) {
      const candidates = await detectOpenProxyPorts(this.config.upstreamPorts)
      const hint = candidates.length
        ? `本机正在监听的候选端口：${candidates.join(', ')}。`
        : `已扫描 ${this.config.upstreamPorts.join(', ')}，都没有在监听——请先启动那个客户端。`
      return { ok: false, message: `${normalized} 没有在监听。${hint}` }
    }
    this.borrowUrl = normalized
    this.startedAt = Date.now()
    this.applyEnv()
    this.lastError = ''
    let systemNote = ''
    if (systemProxy === true) {
      const applied = await this.applySystemProxy()
      systemNote = applied.ok
        ? `\n系统代理已开启：全机 HTTP(S) 走 ${normalized}`
        : `\n系统代理开启失败：${applied.error ?? '未知原因'}`
    }
    return {
      ok: true,
      message: `已借用外部代理客户端：${normalized}（插件不启动内核，节点与开关策略由该客户端决定）${systemNote}`,
    }
  }

  /**
   * 拉起内核。
   *
   * @param {{providerFile: string, node?: string, selectedNode?: string}} input
   * @returns {Promise<{ok: boolean, message: string, node?: string, nodes?: string[]}>}
   */
  async start({ providerFile, node, selectedNode, systemProxy, tun }) {
    if (this.borrowUrl) {
      return {
        ok: true,
        message: `当前是「借用外部客户端」模式（${this.borrowUrl}），不启动自有内核；节点由该客户端管理。`,
        node: '',
        nodes: [],
      }
    }
    if (this.running) {
      const current = await this.switchNode(node || selectedNode || '')
      return { ok: true, message: '代理已经在运行，已按需切换节点。', node: current.node, nodes: current.nodes }
    }
    await this.killStale()

    const corePath = await resolveCorePath(this.config)
    if (!corePath) {
      this.lastError = '找不到 mihomo 内核'
      return {
        ok: false,
        message:
          '找不到 mihomo 内核。请确认本机装了 Clash Verge（会直接复用它的 verge-mihomo.exe），' +
          '或在 profile patch 里给 proxy-gate 这一行设置 corePath 指向 mihomo/clash-meta 可执行文件。',
      }
    }
    this.corePath = corePath

    if (!fs.existsSync(providerFile)) {
      this.lastError = '订阅快照缺失'
      return { ok: false, message: `订阅快照文件不存在：${providerFile}。请先导入订阅。` }
    }
    if (await isPortOpen(this.config.port)) {
      this.lastError = '端口被占用'
      return {
        ok: false,
        message:
          `端口 ${this.config.port} 已被占用（可能是 Clash Verge 自己，或上一个内核没退干净）。` +
          '请在 profile patch 里改 proxy-gate 的 port，或先关掉占用该端口的程序。',
      }
    }

    fs.mkdirSync(this.paths.runtimeDir, { recursive: true })
    this.secret = crypto.randomBytes(16).toString('hex')
    const configFile = path.join(this.paths.runtimeDir, 'config.yaml')
    fs.writeFileSync(
      configFile,
      renderRuntimeConfig({
        port: this.config.port,
        controllerPort: this.config.controllerPort,
        secret: this.secret,
        providerFile,
        healthCheckUrl: this.config.healthCheckUrl,
        tun: tun === true,
      }),
      'utf8',
    )
    this.tunOn = tun === true

    let logFd = null
    try {
      logFd = fs.openSync(this.paths.logFile, 'a')
    } catch {
      logFd = null
    }

    try {
      this.child = spawn(corePath, ['-d', this.paths.runtimeDir, '-f', configFile], {
        windowsHide: true,
        stdio: ['ignore', logFd ?? 'ignore', logFd ?? 'ignore'],
      })
    } catch (error) {
      this.lastError = `启动内核失败：${error?.message ?? error}`
      return { ok: false, message: this.lastError }
    }
    this.child.on('exit', (code, signal) => {
      const unexpected = !this.stopping
      this.logger?.info?.(`proxy-gate: mihomo 退出 code=${code} signal=${signal} unexpected=${unexpected}`)
      this.trace(`exit code=${code ?? 'null'} signal=${signal ?? 'null'} unexpected=${unexpected} pid=${this.child?.pid ?? '?'}`)
      if (unexpected) {
        // 内核自己没了（崩溃/被杀）：把原因留在状态里，别让用户只看到「代理突然关了」
        this.lastError = `内核意外退出（code=${code ?? 'null'}, signal=${signal ?? 'null'}），可能是节点异常或进程被系统/安全软件结束`
      }
      if (this.child) this.child = null
      this.restoreEnv()
      try {
        fs.rmSync(this.paths.pidFile, { force: true })
      } catch {
        /* 无关紧要 */
      }
      if (unexpected) {
        try {
          this.onUnexpectedExit?.({ code, signal })
        } catch (error) {
          this.logger?.warn?.(`proxy-gate: 意外退出回调出错：${error?.message ?? error}`)
        }
      }
    })
    if (logFd !== null) {
      try {
        fs.closeSync(logFd)
      } catch {
        /* 已由子进程继承 */
      }
    }

    if (this.child.pid) {
      try {
        fs.writeFileSync(this.paths.pidFile, String(this.child.pid), 'utf8')
      } catch {
        /* 无关紧要 */
      }
    }
    this.startedAt = Date.now()

    const ready = await this.waitReady()
    if (!ready) {
      const tail = this.readLogTail()
      const reason = classifyCoreFailure(tail)
      this.lastError = reason.summary
      await this.stop()
      return {
        ok: false,
        message: `${reason.summary}${reason.hint ? `\n建议：${reason.hint}` : ''}${tail ? `\n日志尾部：\n${tail}` : ''}`,
      }
    }

    this.applyEnv()
    // provider 是异步加载的：不等它就去切节点，会误判「没有这个节点」。
    const providerNodes = await this.waitProviders()
    const switched = await this.switchNode(node || selectedNode || '')
    // 启动成功 = 上一次的错误已经不再是「当前状态」，清掉它，
    // 否则面板会一直挂着一条过期的「内核意外退出」（自己修好了还吓人）。
    this.lastError = ''
    /** 系统代理（穿透）——失败不回滚内核，只如实报告。 */
    let systemNote = ''
    if (systemProxy === true) {
      const applied = await this.applySystemProxy()
      systemNote = applied.ok
        ? `\n系统代理已开启：全机 HTTP(S) 走 ${this.proxyUrl}（浏览器等会立即生效）`
        : `\n系统代理开启失败：${applied.error ?? '未知原因'}（内核与 AI 出口不受影响）`
    }
    return {
      ok: true,
      message: `代理已开启：127.0.0.1:${this.config.port}（内核 ${path.basename(corePath)}）${systemNote}`,
      node: switched.node,
      nodes: switched.nodes,
      providerNodes,
    }
  }

  /** 打开系统代理（记录原值以便还原）。 */
  async applySystemProxy() {
    if (this.systemProxyOn) return { ok: true }
    const previous = await readSystemProxy()
    if (!previous.available) return { ok: false, error: '读不到系统代理设置（仅支持 Windows）' }
    this.savedSystemProxy = { enable: previous.enable, server: previous.server }
    const bypass = (this.config.noProxy || 'localhost;127.0.0.1')
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean)
      .join(';')
    const result = await enableSystemProxy(`127.0.0.1:${this.config.port}`, bypass)
    if (!result.ok) {
      this.savedSystemProxy = null
      return result
    }
    this.systemProxyOn = true
    return { ok: true }
  }

  /** 还原系统代理（关代理时必须调用，绝不能把用户的设置留在我们这里）。 */
  async restoreSystemProxyIfNeeded() {
    if (!this.systemProxyOn) return
    const previous = this.savedSystemProxy
    this.systemProxyOn = false
    this.savedSystemProxy = null
    try {
      await restoreSystemProxy(previous ?? { enable: false, server: '' })
    } catch (error) {
      this.logger?.warn?.(`proxy-gate: 还原系统代理失败：${error?.message ?? error}`)
    }
  }

  /**
   * 等内核真正可用。
   *
   * 只看端口是不够的：内核会在监听前阻塞在 geo 资源下载上（失败还会 fatal），
   * 所以这里以控制 API 能返回 /version 作为「配置已加载」的判据（实测内核在
   * `Start initial configuration complete` 之后才对外服务）。
   */
  async waitReady() {
    const deadline = Date.now() + this.config.readyTimeoutMs
    while (Date.now() < deadline) {
      if (!this.running) return false
      if (await isPortOpen(this.config.port, 300)) {
        try {
          const info = await this.api('/version', { timeoutMs: 1200 })
          if (info && typeof info.version === 'string') return true
        } catch {
          /* 还没起来，继续等 */
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return false
  }

  /**
   * 等 proxy-provider 异步加载完。
   *
   * 实测：`/version` 可用的瞬间 provider 往往还没就绪，此刻读组会只看到
   * `AUTO` / `DIRECT`，于是「刚开启时看不到任何节点」——必须再等一轮。
   * 超时不算失败（订阅本身可能就是空的），交给上层如实报告。
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<number>} 最终看到的候选节点数（不含 AUTO）
   */
  async waitProviders(timeoutMs = 5000) {
    const deadline = Date.now() + timeoutMs
    let last = 0
    while (Date.now() < deadline) {
      const group = await this.group()
      last = group.nodes.length
      // 组里恒有 DIRECT，所以 >1 才说明 provider 的节点已经进来
      if (last > 1) return last
      await new Promise((resolve) => setTimeout(resolve, 200))
    }
    return last
  }

  /** 内核版本信息（同时用作就绪探针）。 */
  async version() {
    try {
      return await this.api('/version', { timeoutMs: 2000 })
    } catch {
      return null
    }
  }

  /**
   * 测单个节点的延迟。
   *
   * 注意：mihomo 的 `/proxies/{name}/delay` 路由**不接受非 ASCII 节点名**——
   * 机场节点几乎都带 emoji/中文（如 `🇭🇰香港HY2-001|家宽`），请求会 404
   * `Resource not found`。所以这里只用它测 ASCII 名（DIRECT / 组名），
   * 真实节点的批量测速走 `testNodes()` 的 provider 方案。
   *
   * @param {string} name 节点名
   * @param {{timeoutMs?: number, url?: string}} [options]
   * @returns {Promise<number | null>} 毫秒；失败返回 null
   */
  async delayOf(name, options = {}) {
    if (!this.child) return null
    if (!/^[\x20-\x7e]+$/.test(String(name ?? ''))) return null
    const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000
    const url = options.url || this.config.healthCheckUrl
    try {
      const data = await this.api(
        `/proxies/${encodeURIComponent(name)}/delay?timeout=${timeoutMs}&url=${encodeURIComponent(url)}`,
        { timeoutMs: timeoutMs + 2500 },
      )
      const delay = Number(data?.delay)
      return Number.isFinite(delay) && delay > 0 ? delay : null
    } catch {
      return null
    }
  }

  /**
   * 读 provider 的节点测速结果。
   *
   * mihomo 的 `/providers/proxies/{provider}` 返回的 `proxies` 是**数组**，
   * 每项带 `name` / `alive` / `history[]`（末尾是最近一次延迟）。
   * 这条路一次拿全量，且完全避开非 ASCII 路径问题。
   *
   * @returns {Promise<Array<{name: string, alive: boolean, delay: number | null}>>}
   */
  async providerNodes() {
    if (!this.child) return []
    const data = await this.api(`/providers/proxies/${PROVIDER_ID}`, { timeoutMs: 8000 })
    const raw = data?.proxies
    const list = Array.isArray(raw) ? raw : raw && typeof raw === 'object' ? Object.values(raw) : []
    return list
      .filter((item) => item && typeof item.name === 'string')
      .map((item) => {
        const history = Array.isArray(item.history) ? item.history : []
        const last = history.length ? Number(history[history.length - 1]?.delay) : NaN
        const delay = Number.isFinite(last) && last > 0 ? last : null
        return { name: item.name, alive: item.alive === true && delay !== null, delay }
      })
  }

  /**
   * 触发整个 provider 的健康检查（内核内部并发测全部节点）。
   *
   * @param {number} [timeoutMs]
   * @returns {Promise<boolean>} 是否成功触发
   */
  async healthcheckProvider(timeoutMs = 120000) {
    if (!this.child) return false
    try {
      await this.api(`/providers/proxies/${PROVIDER_ID}/healthcheck`, { timeoutMs })
      return true
    } catch (error) {
      this.logger?.warn?.(`proxy-gate: 触发健康检查失败：${error?.message ?? error}`)
      return false
    }
  }

  /**
   * 批量测速：触发 provider 健康检查，再读回每个节点的延迟。
   *
   * @param {{timeoutMs?: number, onProgress?: Function}} [options]
   * @returns {Promise<Array<{name: string, delay: number | null, alive: boolean}>>}
   */
  async measureAll(options = {}) {
    if (!this.child) return []
    await this.healthcheckProvider(options.timeoutMs ?? 120000)
    return this.providerNodes()
  }

  /**
   * 兼容旧调用面：按名字数组返回测速结果。
   *
   * @param {string[]} names
   * @param {{timeoutMs?: number, onProgress?: Function}} [options]
   * @returns {Promise<Array<{name: string, delay: number | null, alive?: boolean}>>}
   */
  async testNodes(names, options = {}) {
    const wanted = Array.isArray(names) ? names.filter(Boolean) : []
    const measured = await this.measureAll(options)
    const map = new Map(measured.map((item) => [item.name, item]))
    return wanted.map((name) => {
      const hit = map.get(name)
      if (hit) return { name, delay: hit.delay, alive: hit.alive }
      // provider 里没有（例如 DIRECT）→ 回落到单点接口（仅 ASCII 名有效）
      return { name, delay: null, alive: false }
    })
  }

  /** 停止内核（或解除借用）并还原环境变量。 */
  async stop(reason = 'requested') {
    this.borrowUrl = ''
    this.stopping = true
    this.trace(`stop reason=${reason} pid=${this.child?.pid ?? 'none'}`)
    // 先还原系统代理：无论后面内核怎么死，都不能把用户的系统设置留在我们这里
    await this.restoreSystemProxyIfNeeded()
    this.tunOn = false
    const child = this.child
    this.child = null
    this.restoreEnv()
    if (child && child.pid) {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      const deadline = Date.now() + 4000
      while (Date.now() < deadline) {
        if (!isAlive(child.pid)) break
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      if (isAlive(child.pid)) {
        try {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
        } catch {
          /* 尽力而为 */
        }
      }
    }
    try {
      fs.rmSync(this.paths.pidFile, { force: true })
    } catch {
      /* 无关紧要 */
    }
    this.startedAt = 0
    return true
  }

  /** 清理上次没退干净的自己（pid 文件里记的进程）。 */
  async killStale() {
    let pid = 0
    try {
      pid = Number.parseInt(fs.readFileSync(this.paths.pidFile, 'utf8').trim(), 10)
    } catch {
      return
    }
    if (!Number.isInteger(pid) || pid <= 0) return
    if (!isAlive(pid)) {
      try {
        fs.rmSync(this.paths.pidFile, { force: true })
      } catch {
        /* 无关紧要 */
      }
      return
    }
    this.logger?.warn?.(`proxy-gate: 清理遗留内核进程 ${pid}`)
    try {
      process.kill(pid)
    } catch {
      /* 已退出 */
    }
    await new Promise((resolve) => setTimeout(resolve, 300))
  }

  /** 把代理写进宿主进程环境，让后续 spawn 出来的 pwsh/git/npm/curl 自动继承。 */
  applyEnv() {
    if (this.savedEnv) return
    const keys = ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY', 'http_proxy', 'https_proxy', 'all_proxy', 'no_proxy']
    this.savedEnv = new Map(keys.map((key) => [key, process.env[key]]))
    const http = this.proxyUrl
    const socks = this.socksUrl
    process.env.HTTP_PROXY = http
    process.env.HTTPS_PROXY = http
    process.env.ALL_PROXY = this.borrowUrl ? http : socks
    process.env.http_proxy = http
    process.env.https_proxy = http
    process.env.all_proxy = this.borrowUrl ? http : socks
    process.env.NO_PROXY = this.config.noProxy
    process.env.no_proxy = this.config.noProxy
    process.env.DSH_PROXY_GATE = 'on'
    process.env.DSH_PROXY_URL = http
  }

  /** 还原被我们改过的环境变量。 */
  restoreEnv() {
    const saved = this.savedEnv
    this.savedEnv = null
    delete process.env.DSH_PROXY_GATE
    delete process.env.DSH_PROXY_URL
    if (!saved) return
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
  }

  /** 读日志尾部，启动失败时贴给模型看。 */
  readLogTail(lines = 12) {
    try {
      const text = fs.readFileSync(this.paths.logFile, 'utf8')
      return text.split(/\r?\n/).filter(Boolean).slice(-lines).join('\n')
    } catch {
      return ''
    }
  }

  /**
   * 调控制 API。
   *
   * @param {string} pathname
   * @param {{method?: string, body?: any, timeoutMs?: number}} [options]
   * @returns {Promise<any>}
   */
  api(pathname, options = {}) {
    const method = options.method || 'GET'
    const payload = options.body === undefined ? null : Buffer.from(JSON.stringify(options.body), 'utf8')
    const timeoutMs = options.timeoutMs ?? 4000
    return new Promise((resolve, reject) => {
      const request = http.request(
        {
          host: '127.0.0.1',
          port: this.config.controllerPort,
          path: pathname,
          method,
          headers: {
            Authorization: `Bearer ${this.secret}`,
            ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(payload.length) } : {}),
          },
        },
        (response) => {
          const chunks = []
          response.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
          response.on('end', () => {
            const text = Buffer.concat(chunks).toString('utf8')
            if ((response.statusCode ?? 0) >= 400) {
              reject(new Error(`内核返回 HTTP ${response.statusCode}：${text.slice(0, 300)}`))
              return
            }
            if (!text) {
              resolve(null)
              return
            }
            try {
              resolve(JSON.parse(text))
            } catch {
              resolve(text)
            }
          })
        },
      )
      request.setTimeout(timeoutMs, () => request.destroy(new Error('内核 API 超时')))
      request.on('error', (error) => reject(error))
      if (payload) request.write(payload)
      request.end()
    })
  }

  /** 读 PROXY 组：候选节点与当前节点。 */
  async group() {
    if (!this.child) return { nodes: [], node: '' }
    try {
      const data = await this.api(`/proxies/${encodeURIComponent(SELECT_GROUP)}`)
      const nodes = Array.isArray(data?.all) ? data.all.filter((name) => name !== AUTO_GROUP) : []
      return { nodes, node: typeof data?.now === 'string' ? data.now : '' }
    } catch (error) {
      this.logger?.warn?.(`proxy-gate: 读取节点列表失败：${error?.message ?? error}`)
      return { nodes: [], node: '' }
    }
  }

  /**
   * 切换 PROXY 组的节点。
   *
   * @param {string} node 节点名；空 = 不动（只读当前状态）
   * @returns {Promise<{node: string, nodes: string[], applied: boolean, error?: string}>}
   */
  async switchNode(node) {
    if (this.borrowUrl) {
      const wanted = String(node ?? '').trim()
      return {
        node: '',
        nodes: [],
        applied: false,
        ...(wanted ? { error: '当前是「借用外部客户端」模式，节点请在那个客户端里切换。' } : {}),
      }
    }
    const current = await this.group()
    const wanted = String(node ?? '').trim()
    if (!wanted) return { ...current, applied: false }
    if (!current.nodes.includes(wanted)) {
      return {
        ...current,
        applied: false,
        error: `没有名为「${wanted}」的节点。可选节点：${current.nodes.slice(0, 30).join(' / ') || '(空)'}`,
      }
    }
    try {
      await this.api(`/proxies/${encodeURIComponent(SELECT_GROUP)}`, {
        method: 'PUT',
        body: { name: wanted },
      })
      const after = await this.group()
      return { ...after, applied: after.node === wanted }
    } catch (error) {
      return { ...current, applied: false, error: `切换节点失败：${error?.message ?? error}` }
    }
  }

  /** 简短状态，供工具与系统提示使用。 */
  summary() {
    return {
      running: this.running,
      mode: this.mode,
      borrowUrl: this.borrowUrl,
      systemProxy: this.systemProxyOn,
      tun: this.tunOn,
      port: this.config.port,
      controllerPort: this.config.controllerPort,
      proxyUrl: this.proxyUrl,
      corePath: this.corePath,
      startedAt: this.startedAt,
      lastError: this.lastError,
    }
  }
}
