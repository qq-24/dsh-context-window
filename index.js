/**
 * dsh-context-window — 每个对话独立的上下文窗口（Host 侧）。
 *
 * ## 为什么需要这个插件
 *
 * DSH 的 compact 触发线是 `contextWindow × thresholdRatio`（源码实锤：
 * `dsh-compaction-basic/lib/index.js:111` 算 thresholdTokens，`:883` 用
 * `resolveCompactSpec(policy, context.contextWindow)`，`:884` 比较）。两个因子：
 *   - `contextWindow` 来自 adapter 的 model catalog（`dsh-llm-deepseek/lib/index.js:1566`
 *     `configured?.contextWindow ?? connection.defaultContextWindow`，默认 1e6），粒度是
 *     provider+model，写死在 settings.yaml 里；
 *   - `thresholdRatio` 来自 compaction-basic 的插件配置，粒度是全局或 provider+model。
 *
 * **没有任何一层是"按会话"的。** 本插件补的就是这一层：在会话日志里存一份覆盖值，
 * 让 compact 判定读到它。
 *
 * ## 怎么做到不改 DSH 核心
 *
 * compaction-basic 每次 `agent/pre-step` 都会调
 * `ctx.llm.resolveModelInfo(provider, model).context.contextWindow`（`:879`）。
 * `resolveModelInfo` 本身没有 session 参数，所以插件不能只包这个方法。
 * 但 `agent/pre-step` 是 waterfall 事件（`dsh-agent/lib/types/runtime-types.d.ts:237`），
 * cordis 的 waterfall 是"每个 listener 包住 rest of chain"
 * （`cordis/lib/index.js:317-325`）。于是：
 *
 *   1. 用 `prepend: true` 把本插件挂在 pre-step 链的最前面；
 *   2. 在 listener 里 `AsyncLocalStorage.run(session, () => next())`，
 *      让**后续所有 listener（含 compaction-basic 的）**都跑在这个 async 上下文里；
 *   3. 包一层 `llm.resolveModelInfo`，在 ALS 上下文内把 `context.contextWindow`
 *      换成会话覆盖值。
 *
 * 结果：compaction-basic 完全不知道自己被改了，按覆盖后的窗口算阈值；
 * 而阈值之外的消费者（token-meter 的占用显示、pi-ai 的溢出检测）走的是
 * `request/context` 事件里的原始值，**不受影响**——这正是我们要的隔离。
 *
 * 并发安全：ALS 按 async 链隔离，多个 agent（主对话 + 子代理 + goal 轮次）
 * 同时 pre-step 不会互相串值。
 *
 * ## 持久化
 *
 * 写进会话日志（`session.append`），不碰 settings.yaml：
 *   - `context-window/set`   `{ window }`
 *   - `context-window/clear` `{}`
 *
 * DSH 核心明确接受插件自定义事件类型（`dsh-session/lib/types/index.js:106-108`：
 * "SessionEventMap is merge-extensible; plugin-owned events carry no core message"），
 * 且 envelope 校验只要求 type 是 string（`:159-165`）。所以会话重开、fork、
 * 导出导入都天然带着这个值走，删会话就跟着删，不留孤儿文件。
 *
 * ## 设计边界（用户定案 2026-10-26）
 *
 * - **不限制、仅提示**：允许把窗口设得比模型真实窗口大。插件不做钳制，
 *   只把"超过真实窗口"这个事实报给 UI 去提示（真超了 provider 会返 400）。
 * - **不改 settings**：模型默认值永远是 adapter 那份，覆盖只是会话级叠加。
 * - **可增可减**：调大调小都生效，因为改的是 compact 判定用的窗口，不是真实容量。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { appendFileSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'

/** 本插件的会话事件类型（写进 session log）。 */
const EVENT_SET = 'context-window/set'
const EVENT_CLEAR = 'context-window/clear'

/** typert 命名空间 / 服务键。 */
const NS = 'contextWindow'

/**
 * 每次 pre-step 期间存放"当前正在跑的 session"。
 * 只在 waterfall listener 的 next() 链上有效，链外 `getStore()` 返回 undefined。
 */
const als = new AsyncLocalStorage()

/** 标记 llm 实例已被本插件包过，避免重复 patch。 */
const PATCH_MARK = Symbol.for('dsh-context-window.llm-patched')
const PREPARE_MARK = Symbol.for('dsh-context-window.llm-prepare-patched')
const APPEND_MARK = Symbol.for('dsh-context-window.session-append-patched')
/** 记录"本次请求用的窗口"的事件类型（agent-loop 每次请求前写）。 */
const EVENT_REQUEST_CONTEXT = 'request/context'

export const name = 'context-window'
export const inject = ['llm']

/** 诊断日志：只在显式开启时写，默认不产生任何文件。 */
function debugLog() {
  if (process.env.DSH_CONTEXT_WINDOW_DEBUG !== '1') return
  try {
    const parts = Array.from(arguments).map((v) => (typeof v === 'string' ? v : JSON.stringify(v)))
    process.stderr.write(`[context-window] ${parts.join(' ')}\n`)
  } catch {}
}

/**
 * 无条件的文件日志。
 *
 * 专门用来排查「补丁看起来装上了、实际没生效」这类问题——那种情况下
 * 环境变量式的 debug 开关往往根本打不开（要重启、要改启动参数），
 * 而把证据直接落到文件里是唯一不依赖外部条件的手段。
 * 路径：`~/.dsh/diagnostics/dsh-context-window.log`
 */
function fileLog(message) {
  try {
    const home = process.env.USERPROFILE ?? process.env.HOME ?? '.'
    const dir = join(home, '.dsh', 'diagnostics')
    mkdirSync(dir, { recursive: true })
    appendFileSync(join(dir, 'dsh-context-window.log'), `${new Date().toISOString()} ${message}\n`)
  } catch {}
}

/**
 * 从会话日志里读会话级窗口覆盖。
 * 从后往前扫，遇到 `set` 取它，遇到 `clear` 说明已被清除 —— 都返回 undefined。
 *
 * `snapshotEvents()` 是缓存快照（"reused until the next append"），
 * 所以连续 pre-step 不会重复深拷贝整个日志。
 *
 * @param session - 目标会话（live 或持久化实例均可）。
 * @returns 覆盖窗口（正数），没有覆盖时 undefined。
 */
export function readWindow(session) {
  if (session === null || session === undefined) return undefined
  if (typeof session.snapshotEvents !== 'function') return undefined
  let events
  try {
    events = session.snapshotEvents()
  } catch {
    return undefined
  }
  if (!Array.isArray(events)) return undefined
  for (let index = events.length - 1; index >= 0; index -= 1) {
    const event = events[index]
    if (event === null || typeof event !== 'object') continue
    if (event.type === EVENT_SET) {
      const value = event.data === null || typeof event.data !== 'object' ? undefined : event.data.window
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined
    }
    if (event.type === EVENT_CLEAR) return undefined
  }
  return undefined
}

/**
 * 找会话实例：live agent 优先（带 append 能力），退到持久化 store。
 *
 * @param ctx - host 根上下文。
 * @param sessionId - 会话 id。
 * @returns Session 实例，找不到时 undefined。
 */
function findSession(ctx, sessionId) {
  if (typeof sessionId !== 'string' || sessionId === '') return undefined
  try {
    const agents = ctx.get('agents')
    const agent = agents === undefined || agents === null ? undefined : agents.get?.(sessionId)
    const live = agent === null || agent === undefined ? undefined : agent.session
    if (live !== undefined && live !== null) return live
  } catch (error) {
    debugLog('findSession: agents lookup failed', String(error?.message ?? error))
  }
  try {
    const sessions = ctx.get('sessions')
    const stored = sessions === undefined || sessions === null ? undefined : sessions.get?.(sessionId)
    if (stored !== undefined && stored !== null) return stored
  } catch (error) {
    debugLog('findSession: sessions lookup failed', String(error?.message ?? error))
  }
  return undefined
}

/**
 * 往会话日志追加一条覆盖事件。
 *
 * @param session - 目标会话。
 * @param type - 事件类型（set / clear）。
 * @param data - 事件负载。
 * @returns 写入的事件。
 * @throws 会话不可写时抛出可读错误。
 */
function appendEvent(session, type, data) {
  if (session === null || session === undefined) throw new Error('session not found')
  if (typeof session.append !== 'function') {
    throw new Error('this session is not writable (no live agent and no writable store entry)')
  }
  // Plugin-owned state remains in the log for this plugin to replay; the core
  // harness may safely skip it when it does not know this event vocabulary.
  return session.append(type, data, { ignorable: true })
}

/**
 * 读当前会话路由的 provider / model。
 *
 * @param session - 目标会话。
 * @returns `{ provider, model }`，拿不到时 undefined。
 */
function readRoute(ctx, session) {
  // 1) 会话自己的 request/header —— 只有发过消息的会话才有。
  try {
    const header = typeof session.requestHeader === 'function' ? session.requestHeader() : undefined
    const config = header === null || header === undefined ? undefined : header.config
    if (config !== null && config !== undefined && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model, source: 'session' }
    }
  } catch {
    // 落到下面的兜底
  }
  // 2) 兜底：全局默认模型。新会话还没发消息时 request/header 为空，
  //    没有这层兜底「模型默认」会一直显示 —，用户就看不到对比基准。
  //    仅用于展示，不参与 compact 判定（判定走真实路由）。
  try {
    const defaults = ctx.get('agentDefaultModel')
    const selection = defaults === null || defaults === undefined ? undefined : defaults.currentSelection?.()
    if (
      selection !== null &&
      selection !== undefined &&
      typeof selection.provider === 'string' &&
      typeof selection.model === 'string'
    ) {
      return { provider: selection.provider, model: selection.model, source: 'default' }
    }
  } catch (error) {
    debugLog('readRoute: default model fallback failed', String(error?.message ?? error))
  }
  return undefined
}

/**
 * 查一个 provider/model 的真实默认上下文窗口（adapter 那份，不含会话覆盖）。
 *
 * 注意：必须在 ALS 上下文之外调用，否则会被自己的 patch 改写成覆盖值。
 * 本函数只在 RPC 入口调用，那里天然没有 ALS store。
 *
 * @param ctx - host 根上下文。
 * @param provider - provider 路由名。
 * @param model - 模型 id。
 * @returns 默认窗口，查不到时 undefined。
 */
async function readModelDefault(ctx, provider, model) {
  try {
    const llm = ctx.get('llm')
    if (llm === undefined || llm === null || typeof llm.resolveModelInfo !== 'function') return undefined
    const info = await llm.resolveModelInfo(provider, model)
    const context = info === null || info === undefined ? undefined : info.context
    const window = context === null || context === undefined ? undefined : context.contextWindow
    return typeof window === 'number' && Number.isFinite(window) && window > 0 ? window : undefined
  } catch (error) {
    debugLog('readModelDefault failed', `${provider}/${model}`, String(error?.message ?? error))
    return undefined
  }
}

/**
 * 把一个 llm 实例的 `resolveModelInfo` 包成"ALS 上下文内返回会话覆盖窗口"。
 *
 * 包装是幂等的（用 Symbol 标记），并且卸载时只在仍是自己那份实现时还原，
 * 不会踩掉别人后装的 patch。
 *
 * @param ctx - 拥有该 effect 的上下文。
 * @param llm - LlmRuntime 实例。
 */
function patchResolveModelInfo(ctx, llm) {
  if (llm === null || llm === undefined) return
  if (typeof llm.resolveModelInfo !== 'function') return
  if (llm[PATCH_MARK] === true) return

  const original = llm.resolveModelInfo
  const patched = async function resolveModelInfo(provider, model, signal) {
    const info = await original.call(this, provider, model, signal)
    let session
    try {
      session = als.getStore()
    } catch {
      session = undefined
    }
    if (session === undefined) return info
    let override
    try {
      override = readWindow(session)
    } catch {
      return info
    }
    if (override === undefined) return info
    if (info === null || typeof info !== 'object') return info
    const context = info.context
    if (context === null || typeof context !== 'object') {
      return { ...info, context: { contextWindow: override } }
    }
    if (context.contextWindow === override) return info
    return { ...info, context: { ...context, contextWindow: override } }
  }

  try {
    llm.resolveModelInfo = patched
    llm[PATCH_MARK] = true
  } catch (error) {
    debugLog('patchResolveModelInfo: assignment failed', String(error?.message ?? error))
    return
  }

  // 用外层 ctx 注册卸载 effect：inject 回调给的 scope 不保证带 effect()。
  try {
    ctx.effect(
      () => () => {
        try {
          if (llm.resolveModelInfo === patched) {
            llm.resolveModelInfo = original
            delete llm[PATCH_MARK]
          }
        } catch {}
      },
      'dsh-context-window: llm.resolveModelInfo patch',
    )
  } catch (error) {
    debugLog('patchResolveModelInfo: effect registration failed', String(error?.message ?? error))
  }
  debugLog('patched llm.resolveModelInfo')
}

/**
 * 把 `llm.prepareCall` 的返回也套上会话覆盖窗口。
 *
 * 为什么必须单独 patch 这一个：`request/context` 事件里记的窗口不是来自
 * `resolveModelInfo`，而是 `dsh-agent-loop/lib/index.js:757`
 * 的 `preparedCall?.context?.contextWindow`，那个对象是 `llm.prepareCall()`
 * 造的（`dsh-llm/lib/index.js:1595-1624`）。
 * 只包 `resolveModelInfo` 的话，压缩判定用的是覆盖值（对），
 * 但界面上的上下文环分母仍然是配置文件里的原值（用户看到的"没更新"）。
 *
 * 返回对象本身被 `Object.freeze`，所以这里不修改它，而是展开成新对象；
 * `stream` 是自有属性、闭包状态共享，替换 `context` 不影响真实派发。
 *
 * @param ctx - 拥有该 effect 的上下文。
 * @param llm - LlmRuntime 实例。
 */
function patchPrepareCall(ctx, llm) {
  if (llm === null || llm === undefined) return
  if (typeof llm.prepareCall !== 'function') return
  if (llm[PREPARE_MARK] === true) return

  const original = llm.prepareCall
  const patched = async function prepareCall(config, signal) {
    const prepared = await original.call(this, config, signal)
    let session
    try {
      session = als.getStore()
    } catch {
      session = undefined
    }
    if (session === undefined) return prepared
    let override
    try {
      override = readWindow(session)
    } catch {
      return prepared
    }
    if (override === undefined) return prepared
    if (prepared === null || typeof prepared !== 'object') return prepared
    const context = prepared.context
    if (context === null || typeof context !== 'object') {
      return { ...prepared, context: { contextWindow: override } }
    }
    if (context.contextWindow === override) return prepared
    return { ...prepared, context: { ...context, contextWindow: override } }
  }

  try {
    llm.prepareCall = patched
    llm[PREPARE_MARK] = true
  } catch (error) {
    debugLog('patchPrepareCall: assignment failed', String(error?.message ?? error))
    return
  }

  try {
    ctx.effect(
      () => () => {
        try {
          if (llm.prepareCall === patched) {
            llm.prepareCall = original
            delete llm[PREPARE_MARK]
          }
        } catch {}
      },
      'dsh-context-window: llm.prepareCall patch',
    )
  } catch (error) {
    debugLog('patchPrepareCall: effect registration failed', String(error?.message ?? error))
  }
  debugLog('patched llm.prepareCall')
}

/**
 * 让会话的 `request/context` 记录带上覆盖值 —— 同时改「读」和「写」两端。
 *
 * ## 环的分母从哪来
 *
 * 界面上下文环的分母来自 `request/context` 事件的 `data.contextWindow`
 * （`dsh-token-meter/lib/index.js:373`），该事件由 agent-loop 写：
 *
 * ```js
 * const contextWindow = preparedCall?.context?.contextWindow;            // :757
 * const previousContext = session.requestContext();                      // :763
 * if (previousContext?.contextWindow !== requestContext.contextWindow)   // :764
 *   session.append('request/context', requestContext);
 * ```
 *
 * ## 为什么前面两版都没成
 *
 * 1. `prepareCall` 在 step 主体里执行（`:726`），而 DSH 没有任何能包住整个 step 的钩子
 *    ——`agent/pre-step` 的 `next()` 返回 `PreStepDecision`（进不进这一步），
 *    `agent/request` 的 `next()` 返回 config，都在 step 主体之前就返回了。
 *    所以 AsyncLocalStorage 够不到 `prepareCall`，那里面永远读不到会话。
 *
 * 2. **只拦 `append` 是死路**：`preparedCall` 的窗口恒等于原始值，
 *    `:764` 的判断恒为"没变化"，agent-loop 压根不调 `append`，拦不到任何东西。
 *    实测证据：9246 个事件的会话里 `request/context` 只有 1 条（停在 seq=14 会话开头），
 *    而同会话有十几条 `context-window/set`（41000/37000/881000/1250000/1369000/21407/116970…）。
 *
 * ## 现在怎么做
 *
 * 两端一起改，让判断"看起来变了"：
 * - `requestContext()` 读：返回覆盖值 → `:764` 判断成立，agent-loop 会写
 * - `append` 写：把落盘的 `contextWindow` 换成覆盖值
 *
 * 代价：每次请求都会多写一条 `request/context`（因为比较恒不等）。事件很小，可接受。
 *
 * @param session - 目标会话。
 */
function patchSessionRequestContext(session) {
  if (session === null || session === undefined) return
  if (session[APPEND_MARK] === true) return
  if (typeof session.append !== 'function') return
  if (typeof session.requestContext !== 'function') return

  const originalAppend = session.append
  const originalRequestContext = session.requestContext

  const patchedAppend = function append(type, data, ...opts) {
    if (type === EVENT_REQUEST_CONTEXT && data !== null && typeof data === 'object') {
      let override
      try {
        override = readWindow(this)
      } catch {
        override = undefined
      }
      if (override !== undefined && data.contextWindow !== override) {
        return originalAppend.call(this, type, { ...data, contextWindow: override }, ...opts)
      }
    }
    return originalAppend.call(this, type, data, ...opts)
  }

  const patchedRequestContext = function requestContext() {
    const current = originalRequestContext.call(this)
    let override
    try {
      override = readWindow(this)
    } catch {
      override = undefined
    }
    if (override === undefined) return current
    if (current === null || typeof current !== 'object') return { contextWindow: override }
    if (current.contextWindow === override) return current
    return { ...current, contextWindow: override }
  }

  let appendOk = false
  let readOk = false
  try {
    session.append = patchedAppend
    appendOk = session.append === patchedAppend
  } catch (error) {
    fileLog('patch session: append assignment FAILED ' + String(error?.message ?? error))
  }
  try {
    session.requestContext = patchedRequestContext
    readOk = session.requestContext === patchedRequestContext
  } catch (error) {
    fileLog('patch session: requestContext assignment FAILED ' + String(error?.message ?? error))
  }

  if (appendOk && readOk) {
    session[APPEND_MARK] = true
    fileLog('patch session: ok (append+requestContext), frozen=' + String(Object.isFrozen(session)))
  } else {
    // 写不上就明确记下来 —— 上一版的教训就是"看起来装上了其实没生效"必须留下证据
    fileLog(
      'patch session: PARTIAL appendOk=' + String(appendOk) +
      ' readOk=' + String(readOk) +
      ' frozen=' + String(Object.isFrozen(session)) +
      ' protoFrozen=' + String(Object.isFrozen(Object.getPrototypeOf(session))),
    )
  }
}

/**
 * 构建 typert RPC 服务（浏览器端 `remote.contextWindow.*`）。
 *
 * 所有方法返回 `{ ok: true, ... }` 或 `{ ok: false, error: { code, message } }`
 * —— 失败必须走信封，不要抛（抛出去客户端只会看到 gateway/internal）。
 *
 * @param ctx - host 根上下文。
 * @returns 带 `typertRemote` 属性的服务对象。
 */
function createService(ctx) {
  /**
   * 统一的失败信封。
   * @param code - 稳定错误码。
   * @param message - 可读原因。
   * @returns 失败信封。
   */
  const fail = (code, message) => ({ ok: false, error: { code, message } })

  const service = {
    /**
     * 读一个会话的窗口状态：覆盖值、模型默认值、当前路由。
     * @param patch - `{ sessionId }`。
     * @returns 状态信封。
     */
    getState: async (patch) => {
      const sessionId = patch === null || patch === undefined ? undefined : patch.sessionId
      const session = findSession(ctx, sessionId)
      if (session === undefined) return fail('SESSION_NOT_FOUND', `no session "${String(sessionId)}"`)
      const override = readWindow(session)
      const route = readRoute(ctx, session)
      const modelDefault = route === undefined ? undefined : await readModelDefault(ctx, route.provider, route.model)
      return {
        ok: true,
        sessionId,
        window: override === undefined ? null : override,
        modelDefault: modelDefault === undefined ? null : modelDefault,
        provider: route === undefined ? null : route.provider,
        model: route === undefined ? null : route.model,
      }
    },

    /**
     * 设置会话窗口覆盖（写入会话日志，立即影响下一次 compact 判定）。
     * @param patch - `{ sessionId, window }`。
     * @returns 结果信封。
     */
    setWindow: async (patch) => {
      const sessionId = patch === null || patch === undefined ? undefined : patch.sessionId
      const window = patch === null || patch === undefined ? undefined : patch.window
      if (typeof window !== 'number' || !Number.isFinite(window) || window <= 0) {
        return fail('BAD_WINDOW', 'window must be a positive finite number')
      }
      const session = findSession(ctx, sessionId)
      if (session === undefined) return fail('SESSION_NOT_FOUND', `no session "${String(sessionId)}"`)
      try {
        const rounded = Math.round(window)
        appendEvent(session, EVENT_SET, { window: rounded })
        debugLog('setWindow', sessionId, rounded)
        return { ok: true, sessionId, window: rounded }
      } catch (error) {
        return fail('APPEND_FAILED', String(error?.message ?? error))
      }
    },

    /**
     * 清除会话窗口覆盖，回到模型默认值。
     * @param patch - `{ sessionId }`。
     * @returns 结果信封。
     */
    clearWindow: async (patch) => {
      const sessionId = patch === null || patch === undefined ? undefined : patch.sessionId
      const session = findSession(ctx, sessionId)
      if (session === undefined) return fail('SESSION_NOT_FOUND', `no session "${String(sessionId)}"`)
      try {
        appendEvent(session, EVENT_CLEAR, {})
        debugLog('clearWindow', sessionId)
        return { ok: true, sessionId }
      } catch (error) {
        return fail('APPEND_FAILED', String(error?.message ?? error))
      }
    },
  }

  Object.defineProperty(service, 'typertRemote', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: { service, serviceKey: NS, namespace: NS },
  })
  return service
}

/**
 * 插件入口。
 *
 * @param ctx - host 根上下文。
 */
export function apply(ctx) {
  // ── 1. 把会话覆盖值接进 compact 判定 ────────────────────────────────────
  // 注意 effect 必须挂在根 ctx 上：inject 回调收到的 scope 不保证带 effect()。
  ctx.inject(['llm'], (scope) => {
    patchResolveModelInfo(ctx, scope.llm)
    patchPrepareCall(ctx, scope.llm)
  })

  // ── 2. pre-step 链最前面注入 ALS 上下文 ────────────────────────────────
  // waterfall listener：必须把 next() 的返回值原样返回，否则整个 step 被否决。
  // global: true 让监听器绕过 context filter（pre-step 带 Scoped<Agent> this）。
  ctx.on(
    'agent/pre-step',
    (payload, next) => {
      const session = payload === null || payload === undefined ? undefined : payload.agent?.session
      if (session === undefined) return next()
      // 顺手把这个会话的 requestContext/append 拦上，让 request/context 带上覆盖值（幂等）
      patchSessionRequestContext(session)
      let entered = false
      try {
        return als.run(session, () => {
          entered = true
          return next()
        })
      } catch (error) {
        // next() 已经开跑时不能重跑（会双执行后续 listener），只能原样抛回去。
        if (entered) throw error
        debugLog('pre-step ALS failed, falling back to plain next()', String(error?.message ?? error))
        return next()
      }
    },
    { prepend: true, global: true },
  )

  // ── 3. 暴露 RPC 服务给浏览器端 ─────────────────────────────────────────
  try {
    ctx.provide(NS, createService(ctx))
    debugLog('service registered', NS)
  } catch (error) {
    debugLog('service registration failed', String(error?.message ?? error))
  }
}
