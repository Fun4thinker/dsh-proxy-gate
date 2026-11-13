/**
 * 自测脚本（不随包发布）：验证纯函数 + 真实拉起内核 + 走代理抓取。
 *
 *   node scripts/smoke.mjs
 *
 * 用独立端口与临时状态目录，跑完会把内核杀干净。
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { resolveConfig, resolvePaths } from '../src/config.js'
import { Store } from '../src/store.js'
import { detectClashVerge, extractProxiesBlock, importFromClashVerge, inspectSubscriptionText, parseVergeProfiles } from '../src/subscription.js'
import { MihomoCore, resolveCorePath, analyzeNodes, renderRuntimeConfig } from '../src/mihomo.js'
import { fetchText, probe } from '../src/net.js'
import { writeProviderFile } from '../src/tools.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEST_DIR = path.join(path.dirname(HERE), '.smoke')

const results = []
function check(name, ok, detail = '') {
  results.push({ name, ok, detail })
  console.log(`${ok ? '✅' : '❌'} ${name}${detail ? ` — ${detail}` : ''}`)
}

const config = resolveConfig({
  port: 17892,
  controllerPort: 19097,
  storeDir: TEST_DIR,
  readyTimeoutMs: 20000,
})
const paths = resolvePaths(config)

console.log('\n== 1. 配置与路径 ==')
check('resolveConfig 端口', config.port === 17892 && config.controllerPort === 19097, `${config.port}/${config.controllerPort}`)
check('状态目录', paths.dir === path.resolve(TEST_DIR), paths.dir)

console.log('\n== 2. Clash Verge 探测与解析 ==')
const verge = detectClashVerge()
check('检测到 Clash Verge', Boolean(verge), verge?.dir ?? '未找到')
if (verge) {
  const profiles = parseVergeProfiles(fs.readFileSync(verge.profilesFile, 'utf8'))
  check('解析 profiles.yaml', profiles.items.length > 0 && Boolean(profiles.current), `current=${profiles.current}, items=${profiles.items.length}`)
  const remote = profiles.items.filter((item) => item.type === 'remote')
  check('存在 remote 订阅', remote.length > 0, remote.map((item) => `${item.uid}:${item.name ?? ''}`).join(', '))
  const imported = importFromClashVerge(verge)
  check('导入订阅快照', imported.proxyCount > 0, `${imported.name} / ${imported.proxyCount} 个节点`)
  const block = extractProxiesBlock(imported.content)
  check('切片出 proxies 段', block.block.startsWith('proxies:') && block.count === imported.proxyCount, `${block.block.split('\n').length} 行`)
  const inspected = inspectSubscriptionText(imported.content)
  check('inspectSubscriptionText 通过', inspected.ok, inspected.reason ?? '')

  console.log('\n== 3. 生成最小运行配置 ==')
  const rendered = renderRuntimeConfig({
    port: config.port,
    controllerPort: config.controllerPort,
    secret: 'smoke-secret',
    providerFile: 'C:\\tmp\\provider.yaml',
    healthCheckUrl: config.healthCheckUrl,
  })
  check('含 mixed-port', rendered.includes(`mixed-port: ${config.port}`))
  check('路径用正斜杠', rendered.includes("path: 'C:/tmp/provider.yaml'"))
  check('不含 GEOIP（避免启动阻塞）', !/GEOIP|GEOSITE/i.test(rendered))
  check('组内带 DIRECT 兜底', rendered.includes('proxies: [AUTO, DIRECT]'))

  console.log('\n== 4. 真实拉起内核 ==')
  fs.rmSync(TEST_DIR, { recursive: true, force: true })
  const store = new Store({ paths, logger: console }).load()
  store.upsert(imported)
  const providerFile = writeProviderFile(paths, imported.content).file
  check('provider 文件写入', fs.existsSync(providerFile), providerFile)

  const core = new MihomoCore({ config, paths, logger: console })
  const started = await core.start({ providerFile })
  check('内核启动', started.ok, started.message.split('\n')[0])
  check('内核可执行文件', Boolean(await resolveCorePath(config)), core.corePath)

  if (started.ok) {
    const version = await core.version()
    check('控制 API 可用', Boolean(version?.version), version?.version ?? '')
    const group = await core.group()
    const analysis = analyzeNodes(group.nodes)
    check('加载到订阅节点', group.nodes.length > 0, `共 ${group.nodes.length}（可用 ${analysis.real.length}，占位 ${analysis.placeholder.length}），当前 ${group.node}`)
    if (analysis.placeholder.length) console.log(`   ⚠️ 占位节点：${analysis.placeholder.slice(0, 3).join(' | ')}`)

    // 切到 DIRECT：验证「本地混合端口 → 出站」这段隧道是通的。
    const switched = await core.switchNode('DIRECT')
    check('切节点到 DIRECT', switched.applied && switched.node === 'DIRECT', `now=${switched.node}`)

    const direct = await probe('https://www.gstatic.com/generate_204', { timeoutMs: 15000 })
    const throughProxy = await probe('https://www.gstatic.com/generate_204', { timeoutMs: 25000, proxyUrl: core.proxyUrl })
    check('直连基线可达', direct.reached, `${direct.status} ${direct.ms}ms ${direct.error ?? ''}`)
    check('经本地代理端口可达（隧道正常）', throughProxy.reached, `${throughProxy.status} ${throughProxy.ms}ms ${throughProxy.error ?? ''}`)

    const fetched = await fetchText('https://www.gstatic.com/generate_204', { proxyUrl: core.proxyUrl, timeoutMs: 20000, maxChars: 2000 })
    check('fetchText 走代理', fetched.reached, `HTTP ${fetched.status} ${fetched.ms}ms`)

    // 切回真实节点，验证代理侧语义（这份订阅是占位节点，预期不通，用来验证归因文案）
    const realNode = analysis.real[0] ?? analysis.placeholder[0] ?? ''
    if (realNode) {
      const back = await core.switchNode(realNode)
      const viaNode = await probe('https://www.gstatic.com/generate_204', { timeoutMs: 25000, proxyUrl: core.proxyUrl })
      check(
        `切换到真实节点（${realNode}）并测试`,
        back.applied,
        viaNode.reached ? `可达（${viaNode.status}）` : `不可达：${viaNode.error ?? '未知'}（订阅节点状态决定，非插件问题）`,
      )
    }
  }

  await core.stop()
  check('内核已停止', !core.running, `端口 17892 释放`)
  const stillOpen = await probe('https://www.gstatic.com/generate_204', { timeoutMs: 5000, proxyUrl: `http://127.0.0.1:${config.port}` })
  check('停止后端口不再服务', !stillOpen.reached, stillOpen.error ?? '')
}

fs.rmSync(TEST_DIR, { recursive: true, force: true })

const failed = results.filter((item) => !item.ok)
console.log(`\n== 结果：${results.length - failed.length}/${results.length} 通过 ==`)
if (failed.length) {
  console.log(`失败项：${failed.map((item) => item.name).join('；')}`)
  process.exitCode = 1
}
