/**
 * 本机代理客户端识别。
 *
 * 目的是解决「新设备装完插件怎么开始用」：不是每个人都有 Clash 订阅，
 * 但很多人已经在跑某个官方客户端（跨界云这类）。识别出它监听的本地端口，
 * 就能用「借用模式」把它接上，不需要订阅、不需要 mihomo 内核。
 */

import { spawn } from 'node:child_process'

import { detectOpenProxyPorts } from './mihomo.js'

/** 常见代理客户端进程名关键字（小写匹配）。 */
const KNOWN_CLIENTS = [
  { pattern: /kuajie|跨界/, label: '跨界云' },
  { pattern: /clash|verge|mihomo/, label: 'Clash Verge / mihomo' },
  { pattern: /v2ray|xray/, label: 'v2ray / xray' },
  { pattern: /sing-?box/, label: 'sing-box' },
  { pattern: /nekobox|nekoray/, label: 'NekoBox' },
  { pattern: /hiddify/, label: 'Hiddify' },
  { pattern: /karing/, label: 'Karing' },
  { pattern: /flclash/, label: 'FlClash' },
  { pattern: /shadowsocks|\bssr\b/, label: 'Shadowsocks' },
  { pattern: /netch/, label: 'Netch' },
  { pattern: /sstap/, label: 'SSTap' },
  { pattern: /quantumult|surge|loon/, label: 'Surge / Quantumult / Loon' },
]

/**
 * 列出当前进程名（去重）。
 *
 * @returns {Promise<string[]>}
 */
function listProcessNames() {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn('tasklist', ['/fo', 'csv', '/nh'], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'ignore'],
      })
    } catch {
      resolve([])
      return
    }
    const chunks = []
    let settled = false
    const finish = (names) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(names)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已退出 */
      }
      finish([])
    }, 6000)
    child.stdout?.on('data', (chunk) => chunks.push(Buffer.from(chunk)))
    child.on('error', () => finish([]))
    child.on('close', () => finish(parseTasklist(Buffer.concat(chunks).toString('utf8'))))
  })
}

/** 从 tasklist CSV 里取进程名。 */
function parseTasklist(text) {
  const names = new Set()
  for (const line of String(text ?? '').split(/\r?\n/)) {
    const match = /^"([^"]+)"/.exec(line.trim())
    if (match) names.add(match[1])
  }
  return [...names]
}

/**
 * 识别本机可能提供代理的客户端。
 *
 * @param {{upstreamPorts?: number[]}} config
 * @returns {Promise<{clients: Array<{label: string, process: string}>, ports: number[], suggestions: string[]}>}
 */
export async function detectProxyClients(config = {}) {
  const [names, ports] = await Promise.all([
    listProcessNames(),
    detectOpenProxyPorts(Array.isArray(config.upstreamPorts) ? config.upstreamPorts : []),
  ])

  const clients = []
  for (const name of names) {
    const lower = name.toLowerCase()
    for (const entry of KNOWN_CLIENTS) {
      if (entry.pattern.test(lower)) {
        clients.push({ label: entry.label, process: name })
        break
      }
    }
  }

  const suggestions = []
  for (const port of ports) {
    suggestions.push(`proxy_on(upstream="${port}")`)
  }
  if (!ports.length && clients.length) {
    suggestions.push('检测到代理客户端在运行，但常见端口都没在监听：请到它的设置里确认「HTTP 代理端口」，然后 proxy_on(upstream="端口号")')
  }

  return { clients, ports, suggestions }
}
