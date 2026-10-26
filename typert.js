/**
 * dsh-context-window 的 Host 面 Typert 清单（`/api/contextWindow/*` 能被宿主认领的唯一途径）。
 *
 * 机制要点（与 dsh-advisor 同款，2026-10-14 实测定案）：
 *   - 客户端 `remote.$mount(CONTRIBUTION)` 只写浏览器本地 registry，一个字节都不发给宿主；
 *     宿主端点表只由宿主侧 `ctx.typert.register()` 写入。
 *   - 写入者 = `@deepseek-ai/dsh-typert-loader`：它按 package.json `exports["./typert"]`
 *     扫包，**没有这个导出的包会被静默跳过**。
 *   - 没有清单 → 宿主 HTTP 路由不认领 `/api/contextWindow/*` → 浏览器端 404。
 *
 * 校验契约（`dsh-typert-loader/lib/index.js:77-211`）：
 *   - `package` 必须等于 package.json 的 name；`face` 必须是 `'host'`；`schemas` 必须是数组
 *   - `model` 必须是对象且含 services / events / objects 三个数组
 *   - 每个 service 必须有 `tags`(数组) + `key` + `exportName` + `members` + `types`
 *   - 每条 invocation 必须有 `id`/`service`/`namespace`/`method` 四个非空字符串 +
 *     `invocation:{kind:'direct'}` + `parameters`（每项 name/wire/source:'json'/codec）+ `result`
 *   - **codec 必须是 `{mode:'strict', typeSymbol, schema}`，且 schema 必须是带 `_zod` 标志、
 *     有 `parse` 方法的 zod v4 实例**（`dsh-typert-loader/lib/index.js:210`
 *     `!("_zod" in codec.schema)` 直接 throw）
 *
 * ## 为什么 zod 加载有兜底
 *
 * 本插件在**功能上不需要 zod 的校验能力**——三个 codec 用的都是直通 schema
 * （不裁字段、不转换）。真正需要的只是一个能过 loader 结构检查的对象。
 *
 * 而 `import { z } from 'zod'` 是静态导入，解析失败会在**模块加载期**抛
 * `ERR_MODULE_NOT_FOUND`，把整个 DSH 启动炸掉（实测踩过：插件源码不在 profile 的
 * node_modules 树里时就复现）。所以这里改成"先试真 zod，试不到就退到结构等价的直通
 * stub"：装好依赖时走正路，依赖解析不到时插件照样能工作，只是丢一句告警。
 */

import { createRequire } from 'node:module'

const require_ = createRequire(import.meta.url)

/** 从若干可能的位置尝试加载 zod v4。 */
function loadRealZod() {
  // 1) 常规安装：与本文件同级或上溯的 node_modules
  try {
    const mod = require_('zod')
    if (mod && typeof mod.z === 'object' && mod.z !== null) return mod.z
  } catch {}

  // 2) 从 profile 的 node_modules 解析（link/junction 安装时 zod 装在这儿）
  const roots = []
  if (process.env.DSH_HOME) roots.push(process.env.DSH_HOME)
  if (process.env.USERPROFILE) {
    roots.push(`${process.env.USERPROFILE}\\.dsh\\profiles\\web\\node_modules`)
    roots.push(`${process.env.USERPROFILE}\\.dsh\\profiles\\node_modules`)
    roots.push(`${process.env.USERPROFILE}\\.dsh\\node_modules`)
  }
  for (const root of roots) {
    try {
      const resolved = require_.resolve('zod', { paths: [root] })
      const mod = require_(resolved)
      if (mod && typeof mod.z === 'object' && mod.z !== null) return mod.z
    } catch {}
  }
  return undefined
}

const realZod = loadRealZod()

/** 真 zod 拿不到时的直通兜底：只满足 loader 的结构检查，行为与 `z.any()` 一致。 */
const passthroughStub = {
  _zod: true,
  parse: (value) => value,
  safeParse: (value) => ({ success: true, data: value }),
}

/** 真正使用的直通 schema。 */
const passthrough = realZod === undefined ? passthroughStub : realZod.any()

if (realZod === undefined) {
  // 不静默：让人知道走了兜底路（但不炸启动）
  process.stderr.write(
    '[dsh-context-window] 未能解析 zod 依赖，已使用直通 codec 兜底（功能不受影响）。\n' +
      '[dsh-context-window] fell back to a passthrough codec because zod could not be resolved.\n',
  )
}

/** `{ sessionId, window }` 入参 codec。 */
const patchCodec = {
  mode: 'strict',
  typeSymbol: 'dsh-context-window#ContextWindowPatch',
  schema: passthrough,
}

/** `getState` 返回 codec。 */
const stateCodec = {
  mode: 'strict',
  typeSymbol: 'dsh-context-window#ContextWindowState',
  schema: passthrough,
}

/** 写操作返回 codec。 */
const okCodec = {
  mode: 'strict',
  typeSymbol: 'dsh-context-window#ContextWindowOk',
  schema: passthrough,
}

/** 三个方法的签名说明（model 段要求 member 必须有 name + signature + kind）。 */
const METHOD_DOCS = [
  {
    name: 'getState',
    signature:
      'getState(patch: { sessionId: string }): { ok: boolean; sessionId: string; window: number | null; modelDefault: number | null; provider: string | null; model: string | null }',
    summary:
      '读取一个对话的上下文窗口状态：会话覆盖值、当前模型默认值、当前 provider/model。Read one conversation\'s context-window state.',
    jsDoc:
      '/** 读一个对话的窗口状态：window 为会话覆盖值（null 表示用模型默认），\n * modelDefault 是 adapter 里该模型的真实默认窗口，provider/model 是当前路由。\n * Read one conversation\'s context-window state. */',
  },
  {
    name: 'setWindow',
    signature: 'setWindow(patch: { sessionId: string; window: number }): { ok: boolean; sessionId: string; window: number }',
    summary:
      '设置某个对话的上下文窗口（写入会话日志，立即影响下一次自动 compact 的触发线）。Set one conversation\'s context window; persisted in the session log.',
    jsDoc:
      '/** 设置某个对话的上下文窗口；写进会话日志的 context-window/set 事件，\n * 重开/切换会话都保留，删会话即随之删除。窗口必须是正数，不钳制到模型真实值（仅由 UI 提示）。\n * Set one conversation\'s context window; persisted in the session log. */',
  },
  {
    name: 'clearWindow',
    signature: 'clearWindow(patch: { sessionId: string }): { ok: boolean; sessionId: string }',
    summary:
      '清除某个对话的窗口覆盖，回到模型默认值。Clear the override so the model default applies again.',
    jsDoc:
      '/** 清除某个对话的窗口覆盖（追加 context-window/clear 事件），回到 adapter 的模型默认窗口。\n * Clear the override and fall back to the model default. */',
  },
]

export const TYPERT = {
  package: 'dsh-context-window',
  face: 'host',
  schemas: [],
  invocations: [
    {
      id: 'dsh-context-window#contextWindow/getState',
      service: 'contextWindow',
      namespace: 'contextWindow',
      method: 'getState',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: patchCodec }],
      result: stateCodec,
    },
    {
      id: 'dsh-context-window#contextWindow/setWindow',
      service: 'contextWindow',
      namespace: 'contextWindow',
      method: 'setWindow',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: patchCodec }],
      result: okCodec,
    },
    {
      id: 'dsh-context-window#contextWindow/clearWindow',
      service: 'contextWindow',
      namespace: 'contextWindow',
      method: 'clearWindow',
      invocation: { kind: 'direct' },
      parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: patchCodec }],
      result: okCodec,
    },
  ],
  model: {
    services: [
      {
        description:
          'dsh-context-window 的会话级上下文窗口服务（ctx.contextWindow）：读/写/清除单个对话的窗口覆盖值，覆盖值存在会话日志里。Per-conversation context-window service backed by the session log.',
        summary: 'dsh-context-window 会话级窗口服务 (per-conversation context window service)。',
        tags: [],
        jsDoc:
          '/** dsh-context-window 会话级窗口服务（ctx.contextWindow）：读/写/清除单个对话的窗口覆盖。\n * Per-conversation context-window service. */',
        key: 'contextWindow',
        exportName: 'ContextWindowService',
        members: METHOD_DOCS.map((doc) => ({ kind: 'method', ...doc })),
        types: [],
      },
    ],
    events: [],
    objects: [],
  },
}

export default TYPERT
