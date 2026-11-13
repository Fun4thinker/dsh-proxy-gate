/**
 * 零依赖的工具定义助手。
 *
 * 为什么不用 `@deepseek-ai/dsh-tools` 的 `defineTool`：插件的安装形态是
 * 「profile node_modules 里的一个包」，而 harness 自带的包在应用侧（app.asar）
 * 解析，插件侧不可见。真正的注册入口 `ctx.tools.register(definition)` 只要求
 * definition 是 `{name, description, parameters, output:{schema, render}, execute}`
 * 形状，`parameters` 就是发给模型的原始 JSON Schema，所以这里自己拼。
 */

/** 参数校验失败。消息会原样进入工具结果，所以要写成人能读的文本。 */
export class ToolInputError extends Error {
  /** @param {string[]} violations 逐条违规说明 */
  constructor(violations) {
    super(`参数不合法：${violations.join('；')}`)
    this.name = 'ToolInputError'
    this.code = 'INVALID_ARGS'
    this.violations = violations
  }
}

const JSON_TYPES = new Set(['string', 'number', 'integer', 'boolean', 'array', 'object', 'null'])

/**
 * 把「属性名 → 紧凑 spec」编译成对象根 JSON Schema。
 *
 * spec 形状：`{type, required?: true, enum?, items?, description?, minimum?, maximum?}`；
 * 传入已写好的对象根 schema（`{type:'object', properties:{…}}`）时原样返回。
 *
 * @param {Record<string, any>} spec
 * @returns {Record<string, any>}
 */
export function buildParameters(spec) {
  if (!spec || typeof spec !== 'object') return { type: 'object', properties: {} }
  if (spec.type === 'object' && spec.properties) return spec
  const properties = {}
  const required = []
  for (const [name, raw] of Object.entries(spec)) {
    const { required: isRequired, ...rest } = raw || {}
    const node = { ...rest }
    if (!JSON_TYPES.has(node.type)) node.type = 'string'
    properties[name] = node
    if (isRequired) required.push(name)
  }
  const schema = { type: 'object', properties }
  if (required.length) schema.required = required
  return schema
}

/**
 * 校验并按类型归一化参数（只做本插件用到的子集）。
 *
 * @param {Record<string, any>} schema 对象根 JSON Schema
 * @param {unknown} args 模型给的原始参数
 * @returns {Record<string, any>}
 * @throws {ToolInputError}
 */
export function normalizeArgs(schema, args) {
  const input = args && typeof args === 'object' && !Array.isArray(args) ? args : {}
  const out = {}
  const violations = []
  const properties = schema?.properties || {}
  const required = new Set(Array.isArray(schema?.required) ? schema.required : [])
  for (const name of required) {
    if (input[name] === undefined || input[name] === null) violations.push(`缺少必填参数 ${name}`)
  }
  for (const [name, node] of Object.entries(properties)) {
    const value = input[name]
    if (value === undefined || value === null) continue
    const checked = coerce(node, value, name, violations)
    if (checked.ok) out[name] = checked.value
  }
  if (violations.length) throw new ToolInputError(violations)
  return out
}

/** @returns {{ok:boolean, value?:any}} */
function coerce(node, value, path, violations) {
  switch (node?.type) {
    case 'string': {
      if (typeof value === 'string') return checkEnum(node, value, path, violations)
      if (typeof value === 'number' || typeof value === 'boolean') {
        return checkEnum(node, String(value), path, violations)
      }
      violations.push(`${path} 应为字符串`)
      return { ok: false }
    }
    case 'number':
    case 'integer': {
      const num = typeof value === 'number' ? value : typeof value === 'string' && value.trim() !== '' ? Number(value) : NaN
      if (!Number.isFinite(num)) {
        violations.push(`${path} 应为数字`)
        return { ok: false }
      }
      if (node.type === 'integer' && !Number.isInteger(num)) {
        violations.push(`${path} 应为整数`)
        return { ok: false }
      }
      if (typeof node.minimum === 'number' && num < node.minimum) violations.push(`${path} 不能小于 ${node.minimum}`)
      if (typeof node.maximum === 'number' && num > node.maximum) violations.push(`${path} 不能大于 ${node.maximum}`)
      return checkEnum(node, num, path, violations)
    }
    case 'boolean': {
      if (typeof value === 'boolean') return { ok: true, value }
      if (value === 'true' || value === 'false') return { ok: true, value: value === 'true' }
      violations.push(`${path} 应为布尔值`)
      return { ok: false }
    }
    case 'array': {
      if (!Array.isArray(value)) {
        violations.push(`${path} 应为数组`)
        return { ok: false }
      }
      if (!node.items) return { ok: true, value }
      const items = []
      for (let i = 0; i < value.length; i += 1) {
        const checked = coerce(node.items, value[i], `${path}[${i}]`, violations)
        if (checked.ok) items.push(checked.value)
      }
      return { ok: true, value: items }
    }
    case 'object': {
      if (typeof value !== 'object' || Array.isArray(value)) {
        violations.push(`${path} 应为对象`)
        return { ok: false }
      }
      return { ok: true, value }
    }
    default:
      return { ok: true, value }
  }
}

/** @returns {{ok:boolean, value?:any}} */
function checkEnum(node, value, path, violations) {
  if (Array.isArray(node.enum) && !node.enum.includes(value)) {
    violations.push(`${path} 只能是 ${node.enum.join(' / ')}`)
    return { ok: false }
  }
  return { ok: true, value }
}

/** 纯文本输出：模型看到一段文本，UI 渲染同一段文本。 */
export function textOutput() {
  return {
    schema: { type: 'string' },
    render: (_args, value) => [{ type: 'text', text: String(value) }],
  }
}

/**
 * 定义并返回可直接交给 `ctx.tools.register()` 的 definition。
 *
 * @param {object} def
 * @param {string} def.name
 * @param {string} def.description
 * @param {Record<string, any>} def.parameters 紧凑属性表或对象根 JSON Schema
 * @param {{schema:Record<string,any>, render:(args:any,value:any)=>any[]}} [def.output]
 * @param {(args:any, exec:any)=>Promise<any>|any} def.execute
 * @param {(args:any)=>boolean} [def.isConcurrencySafe]
 * @param {number} [def.timeoutMs]
 * @returns {object} ToolDefinition
 */
export function defineTool(def) {
  const parameters = buildParameters(def.parameters || {})
  const output = def.output || textOutput()
  const definition = {
    name: def.name,
    description: def.description,
    parameters,
    output,
    async execute(rawArgs, exec) {
      const args = normalizeArgs(parameters, rawArgs)
      const value = await def.execute(args, exec)
      if (output.schema?.type === 'string' && typeof value !== 'string') {
        throw new Error(`${def.name}: 输出应为字符串`)
      }
      return value
    },
  }
  if (typeof def.isConcurrencySafe === 'function') definition.isConcurrencySafe = def.isConcurrencySafe
  if (typeof def.timeoutMs === 'number') definition.timeoutMs = def.timeoutMs
  return definition
}
