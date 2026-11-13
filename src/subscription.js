/**
 * 订阅来源：Clash Verge 的本地订阅快照，以及订阅正文的校验/切片。
 *
 * 关键设计：**不解析 YAML**。订阅正文是完整的 clash 配置，我们只做两件事：
 *   1. 文本切片出顶层 `proxies:` 块（缩进规则稳定，切出来仍是合法 YAML）；
 *   2. 数一数里面有多少个 `- name:`，用来给用户一个规模概览。
 * 这样既不需要 js-yaml 依赖（profile 里可能没有），也不会因为订阅里出现
 * 我们没见过的字段而崩掉 —— 真正的解析交给 mihomo 内核。
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { safeId } from './store.js'

/** Clash Verge（含 rev 分支）可能的配置目录，按优先级排列。 */
export function clashVergeDirs() {
  const appData = process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming')
  const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local')
  return [
    path.join(appData, 'io.github.clash-verge-rev.clash-verge-rev'),
    path.join(appData, 'clash-verge'),
    path.join(appData, 'Clash Verge'),
    path.join(appData, 'clash-verge-rev'),
    path.join(localAppData, 'io.github.clash-verge-rev.clash-verge-rev'),
    path.join(os.homedir(), '.config', 'clash-verge'),
  ]
}

/**
 * 找到第一个装着 profiles.yaml 的 Clash Verge 目录。
 *
 * @returns {{dir: string, profilesFile: string, profilesDir: string} | null}
 */
export function detectClashVerge() {
  for (const dir of clashVergeDirs()) {
    const profilesFile = path.join(dir, 'profiles.yaml')
    if (fs.existsSync(profilesFile)) {
      return { dir, profilesFile, profilesDir: path.join(dir, 'profiles') }
    }
  }
  return null
}

/**
 * 解析 Clash Verge 生成的 profiles.yaml（机器写出来的固定格式，行扫描足够）。
 *
 * 只取我们需要的东西：`current` 与每个条目的 uid / type / name / url / file。
 * 嵌套的 selected / extra / option 之类一律忽略。
 *
 * @param {string} text
 * @returns {{current: string, items: Array<{uid:string, type?:string, name?:string, url?:string, file?:string}>}}
 */
export function parseVergeProfiles(text) {
  const lines = String(text ?? '').split(/\r?\n/)
  const items = []
  let current = null
  let inItems = false
  for (const line of lines) {
    if (/^items\s*:\s*$/.test(line)) {
      inItems = true
      continue
    }
    if (/^[A-Za-z_][\w-]*\s*:/.test(line)) {
      inItems = false
      continue
    }
    if (!inItems) continue
    const start = /^\s*-\s+uid\s*:\s*(.+)$/.exec(line)
    if (start) {
      current = { uid: start[1].trim() }
      items.push(current)
      continue
    }
    if (!current) continue
    const kv = /^\s{2,}(type|name|url|file)\s*:\s*(.*)$/.exec(line)
    if (!kv) continue
    const value = kv[2].trim().replace(/^['"]|['"]$/g, '')
    if (value && value !== 'null') current[kv[1]] = value
  }
  const currentMatch = /^current\s*:\s*(.+)$/m.exec(String(text ?? ''))
  return { current: currentMatch ? currentMatch[1].trim().replace(/^['"]|['"]$/g, '') : '', items }
}

/**
 * 从 Clash Verge 目录导入一份订阅快照。
 *
 * @param {{dir: string, profilesFile: string, profilesDir: string}} verge
 * @param {string} [uid] 目标订阅 uid；省略时用 profiles.yaml 的 current
 * @returns {{id: string, name: string, source: string, url: string, uid: string, content: string, proxyCount: number, file: string}}
 */
export function importFromClashVerge(verge, uid) {
  const text = fs.readFileSync(verge.profilesFile, 'utf8')
  const profiles = parseVergeProfiles(text)
  const wanted = String(uid ?? '').trim() || profiles.current
  const item = profiles.items.find((entry) => entry.uid === wanted)
  if (!item) {
    const known = profiles.items.map((entry) => entry.uid).join(', ')
    throw new Error(`Clash Verge 里没有 uid 为 ${wanted || '(空)'} 的配置；现有条目：${known || '(无)'}`)
  }
  if (item.type && item.type !== 'remote') {
    throw new Error(`配置 ${item.uid} 的类型是 ${item.type}，不是可用的远程订阅（remote）`)
  }
  const fileName = item.file || `${item.uid}.yaml`
  const snapshot = path.join(verge.profilesDir, fileName)
  if (!fs.existsSync(snapshot)) throw new Error(`找不到订阅快照文件：${snapshot}`)
  const content = fs.readFileSync(snapshot, 'utf8')
  const block = extractProxiesBlock(content)
  if (!block.count) throw new Error(`订阅快照 ${fileName} 里没有解析到任何节点（proxies 为空）`)
  return {
    id: safeId(`clash-verge-${item.uid}`),
    name: item.name || `Clash Verge ${item.uid}`,
    source: 'clash-verge',
    url: item.url || '',
    uid: item.uid,
    file: fileName,
    content,
    proxyCount: block.count,
  }
}

/**
 * 文本切片：取出顶层 `proxies:` 块。
 *
 * 返回的 block 已经是「只有 proxies 一段」的合法 YAML，可直接当 mihomo 的
 * file 类型 proxy-provider 文件用 —— 这样订阅里的 dns / rules / listeners
 * 之类不会带进我们的最小运行配置。
 *
 * @param {string} content 订阅正文
 * @returns {{block: string, count: number}}
 */
export function extractProxiesBlock(content) {
  const lines = String(content ?? '').split(/\r?\n/)
  let start = -1
  for (let i = 0; i < lines.length; i += 1) {
    if (/^proxies\s*:/.test(lines[i])) {
      start = i
      break
    }
  }
  if (start === -1) return { block: '', count: 0 }

  const head = lines[start]
  const inlineValue = head.replace(/^proxies\s*:\s*/, '')
  if (inlineValue.trim()) {
    // flow 风格：proxies: [{...}, ...]（可能一行也可能多行，交给内核）
    const body = [head]
    for (let i = start + 1; i < lines.length; i += 1) {
      const line = lines[i]
      if (/^[A-Za-z_][\w-]*\s*:/.test(line)) break
      body.push(line)
    }
    const block = body.join('\n')
    return { block, count: countProxies(block) }
  }

  const body = []
  for (let i = start + 1; i < lines.length; i += 1) {
    const line = lines[i]
    if (line.trim() === '') continue
    if (/^\s/.test(line) || /^\s*-\s/.test(line)) {
      body.push(line)
      continue
    }
    break
  }
  const block = body.length ? `proxies:\n${body.join('\n')}\n` : ''
  return { block, count: countProxies(block) }
}

/** 数节点条目数（`- name:` / `{name:` 两种写法都认）。 */
function countProxies(block) {
  const matches = String(block ?? '').match(/(^|\n)\s*-?\s*\{?\s*name\s*:/g)
  return matches ? matches.length : 0
}

/**
 * 校验一份订阅正文是否可用，返回切片结果。
 *
 * @param {string} content
 * @returns {{ok: boolean, block: string, count: number, reason?: string}}
 */
export function inspectSubscriptionText(content) {
  if (typeof content !== 'string' || content.trim() === '') {
    return { ok: false, block: '', count: 0, reason: '内容为空' }
  }
  if (/^\s*</.test(content)) {
    return { ok: false, block: '', count: 0, reason: '返回的是 HTML 而不是订阅正文（可能需要更新订阅地址或 token）' }
  }
  const { block, count } = extractProxiesBlock(content)
  if (!block) return { ok: false, block, count, reason: '没有顶层 proxies 段，不像是 clash 订阅' }
  if (!count) return { ok: false, block, count, reason: 'proxies 段里没有节点' }
  return { ok: true, block, count }
}
