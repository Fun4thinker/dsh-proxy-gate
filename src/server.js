/**
 * Host 侧的浏览器接口。
 *
 * 为什么自己挂路由、而不是用 typert/Remote：本插件是零依赖的纯 JS 包，
 * Remote 需要构建期生成的服务命名空间，插件侧解析不到 `@deepseek-ai/*`。
 * `ctx.webServer.register()` 收普通 node http handler，是这里唯一零成本的通道。
 *
 * 安全：只在**同源**请求下工作，并要求自定义请求头 `x-proxy-gate: 1`。
 * 自定义头会让浏览器对跨站请求先发 preflight，而本路由不响应 OPTIONS，
 * 于是外部网页无法用 CSRF 的方式切代理；非浏览器进程本来就能直接操作本机，
 * 不构成额外风险。
 */

import { measureNodes, snapshot } from './ops.js'
import { detectProxyClients } from './detect.js'

/** 路由前缀。
 *
 * 刻意不走 `/api`：那个前缀由 harness 自己的连接处理器持有（它带鉴权与 CSRF
 * 校验，普通插件请求会被 401）。这里用自己的顶级前缀，只靠下面的同源 + 自定义
 * 请求头做保护。 */
export const API_PREFIX = '/proxy-gate-api'

/** 请求体上限。 */
const MAX_BODY_BYTES = 64 * 1024

/** 取字符串参数（统一空串兜底）。 */
function str(value) {
  return typeof value === 'string' ? value : ''
}

/**
 * 挂上路由。
 *
 * @param {{ctx: any, deps: any, tools: Map<string, any>, logger?: any}} options
 * @returns {() => void} 卸载函数
 */
export function mountProxyApi({ ctx, deps, tools, logger }) {
  const webServer = (typeof ctx.get === 'function' ? ctx.get('webServer') : undefined) ?? ctx.webServer
  if (!webServer || typeof webServer.register !== 'function') {
    logger?.info?.('proxy-gate: 当前部署没有 webServer，跳过浏览器接口')
    return () => {}
  }

  const handler = async (req, res) => {
    const respond = (status, payload) => {
      const body = JSON.stringify(payload ?? null)
      res.writeHead(status, {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
        'content-length': Buffer.byteLength(body),
      })
      res.end(body)
    }

    try {
      if (req.headers['x-proxy-gate'] !== '1') {
        respond(400, { ok: false, error: '缺少 x-proxy-gate 请求头' })
        return
      }
      const origin = req.headers.origin
      if (origin) {
        const self = typeof webServer.getOrigin === 'function' ? webServer.getOrigin() : ''
        if (self && origin !== self) {
          respond(403, { ok: false, error: '拒绝跨源请求' })
          return
        }
      }

      const url = new URL(req.url ?? '/', 'http://127.0.0.1')
      const route = url.pathname.slice(API_PREFIX.length).replace(/^\/+/, '')
      const method = (req.method ?? 'GET').toUpperCase()

      if (method === 'GET' && route === 'state') {
        respond(200, { ok: true, state: await snapshot(deps) })
        return
      }
      if (method === 'GET' && route === 'detect') {
        respond(200, { ok: true, detected: await detectProxyClients(deps.config) })
        return
      }
      if (method === 'GET' && route === 'diag') {
        // 诊断：把 Host 进程里读到的系统代理原始值返回，用于判断宿主是否做了注册表虚拟化。
        const { readSystemProxy } = await import('./system-proxy.js')
        const read = await readSystemProxy()
        respond(200, {
          ok: true,
          platform: process.platform,
          arch: process.arch,
          execPath: process.execPath,
          user: process.env.USERNAME ?? '',
          read,
        })
        return
      }
      if (route === 'diag-write') {
        // 诊断：在 Host 进程内直接写一次系统代理并回读，区分「进程权限问题」与「模块代际问题」。
        const sp = await import('./system-proxy.js')
        const before = await sp.readSystemProxy()
        const write = await sp.enableSystemProxy('127.0.0.1:7892')
        const after = await sp.readSystemProxy()
        respond(200, { ok: true, before, write, after })
        return
      }
      if (method !== 'POST') {
        respond(405, { ok: false, error: `不支持的方法 ${method}` })
        return
      }

      const body = await readJsonBody(req)

      if (route === 'mode') {
        if (typeof deps.setAutoMode !== 'function') {
          respond(501, { ok: false, error: '当前部署不支持切换自动模式' })
          return
        }
        const enabled = deps.setAutoMode(body.auto === true)
        const state = await snapshot(deps)
        let message = enabled
          ? '已开启自动模式：AI 现在可以自己开关代理。'
          : '已关闭自动模式：AI 看不到代理工具，请在上方面板里手动开关。'
        if (enabled && state.running && state.manualHold) {
          message +=
            '\n注意：当前出口是你在面板上开的（人工持有），AI 无法关闭它；' +
            '它会一直保持开启，直到你在面板上点「关闭」。'
        }
        respond(200, { ok: true, message, state })
        return
      }

      if (route === 'test') {
        const state = await snapshot(deps)
        if (state.mode !== 'core') {
          respond(409, { ok: false, error: '只有自有内核模式才能测速节点' })
          return
        }
        const measured = await measureNodes({ ...deps, timeoutMs: body.timeoutMs })
        const keyword = String(body.filter ?? '').trim().toLowerCase()
        let sorted = measured.sorted
        if (keyword) sorted = sorted.filter((item) => item.name.toLowerCase().includes(keyword))
        if (Number(body.limit) > 0) sorted = sorted.slice(0, Number(body.limit))
        respond(200, {
          ok: true,
          message: `测速完成：全部 ${measured.results.length} 个节点里 ${measured.sorted.length} 个可用`,
          alive: sorted.map((item) => `${item.name}（${item.delay}ms）`),
          dead: measured.dead,
          state: await snapshot(deps),
        })
        return
      }

      // 开关、切节点、订阅操作：直接复用工具实现，保证 UI 与模型走同一份逻辑。
      const routeSpec =
        route === 'on'
          ? {
              tool: 'proxy',
              args: {
                action: 'on',
                node: str(body.node),
                upstream: str(body.upstream),
                systemProxy: body.systemProxy === true,
                tun: body.tun === true,
              },
            }
          : route === 'off'
            ? { tool: 'proxy', args: { action: 'off', force: body.force !== false } }
            : route === 'node'
              ? { tool: 'proxy', args: { action: 'on', node: str(body.node) } }
              : route === 'subscription'
                ? { tool: 'proxy_subscription', args: { action: body.action, source: body.source, value: body.value, name: body.name } }
                : null
      const tool = routeSpec ? tools.get(routeSpec.tool) : undefined
      if (!routeSpec || !tool) {
        respond(404, { ok: false, error: `未知操作 ${route}` })
        return
      }

      // 人工在面板上动开关 → 自动切到手动模式，避免「人以为是手动、其实 AI 还
      // 在自主开关」的错乱。这是面板专属行为，智能体走工具不会带 fromUi。
      let autoNote = ''
      if (body.fromUi === true && route !== 'subscription') {
        const autoMode = deps.getAutoMode?.()
        if (autoMode && typeof deps.setAutoMode === 'function') {
          deps.setAutoMode(false)
          autoNote = '已自动切到手动模式（AI 不再自主开关代理）。\n'
        }
      }

      const message = `${autoNote}${await tool.execute(routeSpec.args, {})}`
      respond(200, { ok: true, message: String(message ?? ''), state: await snapshot(deps) })
    } catch (error) {
      logger?.warn?.(`proxy-gate: 浏览器接口出错：${error?.message ?? error}`)
      try {
        respond(500, { ok: false, error: String(error?.message ?? error) })
      } catch {
        /* 响应已发出 */
      }
    }
  }

  const dispose = webServer.register({ kind: 'prefix', path: API_PREFIX, handler })
  logger?.info?.(`proxy-gate: 已挂载浏览器接口 ${API_PREFIX}`)
  return dispose
}

/**
 * 读 JSON 请求体。
 *
 * @param {import('node:http').IncomingMessage} req
 * @returns {Promise<any>}
 */
function readJsonBody(req) {
  return new Promise((resolve) => {
    const chunks = []
    let total = 0
    req.on('data', (chunk) => {
      total += chunk.length
      if (total > MAX_BODY_BYTES) {
        req.destroy()
        resolve({})
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => resolve({}))
    req.on('end', () => {
      const text = Buffer.concat(chunks).toString('utf8').trim()
      if (!text) {
        resolve({})
        return
      }
      try {
        const parsed = JSON.parse(text)
        resolve(parsed && typeof parsed === 'object' ? parsed : {})
      } catch {
        resolve({})
      }
    })
  })
}
