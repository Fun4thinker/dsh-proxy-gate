/**
 * 走代理的 HTTP 抓取。
 *
 * 为什么用 curl.exe 而不是 node 的 fetch/undici：
 *  - harness 自带的 undici 在 app.asar 里，插件侧 import 不到；插件自己再装一份
 *    undici 是**另一个实例**，设它的 global dispatcher 对 web_fetch 毫无影响。
 *  - Windows 10/11 自带 curl.exe，原生支持 HTTP(S) 代理、重定向、超时、证书，
 *    行为确定，且 AI 在 pwsh 里手敲的 curl 与本工具完全一致。
 * 于是「内置 web_fetch 不走代理」这件事有了确定的兜底：proxy_fetch 一定走代理。
 */

import { spawn } from 'node:child_process'

/** 订阅下载用的 UA：不少机场只对 clash/mihomo 的 UA 返回 yaml。 */
export const SUBSCRIPTION_USER_AGENT = 'clash-verge/v2.0.0 clash.meta'

/** 抓网页时用的 UA。 */
export const FETCH_USER_AGENT = 'dsh-proxy-gate/0.1 (+https://github.com/deepseek-ai)'

const META_MARKER = '\n__PROXY_GATE_META__'

/** curl 可执行文件：优先配置/环境变量，其次 PATH 里的 curl.exe。 */
function curlBinary() {
  return process.env.DSH_PROXY_CURL || process.env.CURL_PATH || 'curl.exe'
}

/**
 * 跑一次 curl，收集 stdout/stderr。
 *
 * @param {string[]} args
 * @param {{timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, code: number, stdout: string, stderr: string, error?: string}>}
 */
export function runCurl(args, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(curlBinary(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, code: -1, stdout: '', stderr: '', error: `无法启动 curl：${error?.message ?? error}` })
      return
    }
    const out = []
    const err = []
    let settled = false
    const finish = (payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(payload)
    }
    const timer = setTimeout(() => {
      try {
        child.kill()
      } catch {
        /* 已经退出 */
      }
      finish({
        ok: false,
        code: -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
        error: `curl 超过 ${timeoutMs}ms 未完成`,
      })
    }, timeoutMs + 2000)
    child.stdout?.on('data', (chunk) => out.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => err.push(Buffer.from(chunk)))
    child.on('error', (error) => {
      finish({ ok: false, code: -1, stdout: '', stderr: '', error: `curl 启动失败：${error?.message ?? error}` })
    })
    child.on('close', (code) => {
      finish({
        ok: code === 0,
        code: typeof code === 'number' ? code : -1,
        stdout: Buffer.concat(out).toString('utf8'),
        stderr: Buffer.concat(err).toString('utf8'),
      })
    })
  })
}

/**
 * 抓一个 URL，可选走代理。
 *
 * @param {string} url
 * @param {{proxyUrl?: string, timeoutMs?: number, maxChars?: number, userAgent?: string}} [options]
 * @returns {Promise<{ok: boolean, status: number, body: string, ms: number, truncated: boolean, error?: string}>}
 */
export async function fetchText(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 30000
  const maxChars = Number(options.maxChars) > 0 ? Number(options.maxChars) : 100000
  const seconds = Math.max(5, Math.ceil(timeoutMs / 1000))
  const args = [
    '-sS',
    '-L',
    '--max-time',
    String(seconds),
    '-A',
    options.userAgent || FETCH_USER_AGENT,
    '-w',
    `${META_MARKER}%{http_code} %{time_total}`,
  ]
  if (options.proxyUrl) args.push('-x', options.proxyUrl)
  else args.push('--noproxy', '*')
  args.push('--url', url)

  const result = await runCurl(args, { timeoutMs })
  const raw = result.stdout ?? ''
  const markerAt = raw.lastIndexOf(META_MARKER)
  let body = raw
  let status = 0
  let ms = 0
  if (markerAt >= 0) {
    body = raw.slice(0, markerAt)
    const meta = raw.slice(markerAt + META_MARKER.length).trim().split(/\s+/)
    status = Number(meta[0]) || 0
    ms = Math.round((Number(meta[1]) || 0) * 1000)
  }
  const truncated = body.length > maxChars
  const trimmed = truncated ? body.slice(0, maxChars) : body

  if (!result.ok && !status) {
    return {
      ok: false,
      reached: false,
      status: 0,
      body: trimmed,
      ms,
      truncated,
      error: result.error || cleanCurlError(result.stderr) || `curl 退出码 ${result.code}`,
    }
  }
  // 有 HTTP 状态码就说明**链路是通的**：403/429 是站点限流或拒绝，不是隧道故障。
  const reached = status > 0
  if (status < 200 || status >= 400) {
    return { ok: false, reached, status, body: trimmed, ms, truncated, error: `HTTP ${status}` }
  }
  return { ok: true, reached, status, body: trimmed, ms, truncated }
}

/** curl 的 stderr 是英文原文，截短后拼进结果，够定位就行。 */
function cleanCurlError(stderr) {
  const text = String(stderr ?? '').trim()
  if (!text) return ''
  return text.split(/\r?\n/).slice(-3).join('；')
}

/**
 * 探活：只关心「通不通」，用于 proxy_status(verify) 的对照实验。
 *
 * @param {string} url
 * @param {{proxyUrl?: string, timeoutMs?: number}} [options]
 * @returns {Promise<{ok: boolean, status: number, ms: number, error?: string}>}
 */
export async function probe(url, options = {}) {
  const result = await fetchText(url, { ...options, maxChars: 4000 })
  return { ok: result.ok, reached: result.reached, status: result.status, ms: result.ms, error: result.error }
}
