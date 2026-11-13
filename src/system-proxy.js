/**
 * Windows 系统代理（WinINET）读写。
 *
 * 用途：手动模式下把代理「穿透」到全机 —— 浏览器、其他应用都会走它。
 * 这**不是** TUN：只影响遵守系统代理设置的程序（WinINET/WinHTTP 系）。
 *
 * 原则：
 *  1. 开启前**记录原值**，关闭时原样还原（绝不覆盖用户自己配的 Clash Verge 端口）；
 *  2. 只改 `HKCU\...\Internet Settings`，不需要管理员权限；
 *  3. 写完必须广播设置变更，否则浏览器不会立刻生效。
 */

import { spawn } from 'node:child_process'

const REG_KEY = 'HKCU\\Software\\Microsoft\\Windows\\CurrentVersion\\Internet Settings'

/** 执行一个进程并收输出。 */
function run(command, args, timeoutMs = 8000) {
  return new Promise((resolve) => {
    let child
    try {
      child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, out: '', err: String(error?.message ?? error) })
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
        /* 已退出 */
      }
      finish({ ok: false, out: Buffer.concat(out).toString('utf8'), err: 'timeout' })
    }, timeoutMs)
    child.stdout?.on('data', (chunk) => out.push(Buffer.from(chunk)))
    child.stderr?.on('data', (chunk) => err.push(Buffer.from(chunk)))
    child.on('error', (error) => finish({ ok: false, out: '', err: String(error?.message ?? error) }))
    child.on('close', (code) =>
      finish({
        ok: code === 0,
        out: Buffer.concat(out).toString('utf8'),
        err: Buffer.concat(err).toString('utf8'),
      }),
    )
  })
}

/**
 * 读当前系统代理设置。
 *
 * @returns {Promise<{available: boolean, enable: boolean, server: string}>}
 */
export async function readSystemProxy() {
  if (process.platform !== 'win32') return { available: false, enable: false, server: '' }
  const result = await run('reg.exe', ['query', REG_KEY])
  if (!result.ok) return { available: false, enable: false, server: '' }
  const enableMatch = /ProxyEnable\s+REG_DWORD\s+0x([0-9a-f]+)/i.exec(result.out)
  const serverMatch = /ProxyServer\s+REG_SZ\s+(\S+)/i.exec(result.out)
  return {
    available: true,
    enable: Boolean(enableMatch && Number.parseInt(enableMatch[1], 16) === 1),
    server: serverMatch ? serverMatch[1].trim() : '',
  }
}

/**
 * 写一次 REG_DWORD / REG_SZ。
 *
 * @param {string} name
 * @param {string} value
 * @param {'REG_DWORD'|'REG_SZ'} type
 */
async function writeValue(name, value, type) {
  const args = type === 'REG_DWORD'
    ? ['add', REG_KEY, '/v', name, '/t', 'REG_DWORD', '/d', value, '/f']
    : ['add', REG_KEY, '/v', name, '/t', 'REG_SZ', '/d', value, '/f']
  return run('reg.exe', args)
}

/** 通知系统设置已变更（不广播的话浏览器仍用旧值）。 */
async function notifyChange() {
  const script = [
    '$sig = \'[DllImport("wininet.dll", SetLastError=true)] public static extern bool InternetSetOption(IntPtr h, int o, IntPtr b, int l);\'',
    '$t = Add-Type -MemberDefinition $sig -Name W -Namespace Pg -PassThru',
    '[void]$t::InternetSetOption([IntPtr]::Zero, 39, [IntPtr]::Zero, 0)',
    '[void]$t::InternetSetOption([IntPtr]::Zero, 37, [IntPtr]::Zero, 0)',
  ].join('; ')
  return run('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], 12000)
}

/**
 * 打开系统代理并指向本地端口。
 *
 * @param {string} server 例如 '127.0.0.1:7892'
 * @param {string} [bypass] 绕行列表（; 分隔）
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function enableSystemProxy(server, bypass = 'localhost;127.0.0.1;::1') {
  const setServer = await writeValue('ProxyServer', server, 'REG_SZ')
  if (!setServer.ok) return { ok: false, error: setServer.err || '写入 ProxyServer 失败' }
  const setBypass = await writeValue('ProxyOverride', bypass, 'REG_SZ')
  if (!setBypass.ok) return { ok: false, error: setBypass.err || '写入 ProxyOverride 失败' }
  const enable = await writeValue('ProxyEnable', '1', 'REG_DWORD')
  if (!enable.ok) return { ok: false, error: enable.err || '写入 ProxyEnable 失败' }

  // 先广播变更，再回读「最终状态」。
  // 实测坑：某些安全软件（如 Kaspersky）会拦截 InternetSetOption 广播并把
  // ProxyEnable 直接改回 0，所以回读必须放在广播之后，否则会误报成功。
  await notifyChange()
  const check = await readSystemProxy()
  if (!check.available) return { ok: false, error: '回读失败：读不到系统代理设置' }
  if (!check.enable) {
    return {
      ok: false,
      error:
        '系统代理设置被拦截：写入成功但立刻被改回关闭。常见原因是安全软件（Kaspersky 等）或组策略禁止修改代理设置。' +
        'AI 专属出口（环境变量方式）不受影响，可继续使用。',
    }
  }
  const expectedPort = String(server).split(':').pop()
  if (!check.server.endsWith(`:${expectedPort}`)) {
    return { ok: false, error: `系统代理指向了「${check.server}」，不是期望的「${server}」` }
  }
  return { ok: true }
}

/**
 * 还原系统代理到指定状态。
 *
 * @param {{enable: boolean, server: string}} previous readSystemProxy() 的结果
 * @returns {Promise<{ok: boolean, error?: string}>}
 */
export async function restoreSystemProxy(previous) {
  const enable = await writeValue('ProxyEnable', previous?.enable ? '1' : '0', 'REG_DWORD')
  if (enable.ok && previous?.server) await writeValue('ProxyServer', previous.server, 'REG_SZ')
  await notifyChange()
  const check = await readSystemProxy()
  if (!check.available) return { ok: false, error: '回读失败：读不到系统代理设置' }
  const expected = Boolean(previous?.enable)
  if (check.enable !== expected) {
    return { ok: false, error: `系统代理未还原：期望 ProxyEnable=${expected ? 1 : 0}，实际 ${check.enable ? 1 : 0}（可能被安全软件强制改写，请手工确认）` }
  }
  return { ok: true }
}
