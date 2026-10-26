/**
 * dsh-context-window 浏览器端 bundle（单文件，经 __ModuleLoader__ 加载）。
 *
 * ## 做什么
 *
 * 输入框右侧一个胶囊控件，显示/设置**当前对话**的上下文窗口。
 * 值经 Typert RPC 读写宿主侧，最终落在会话日志里（`context-window/set`），
 * 所以切对话、重开 DSH、导出导入都保留，删对话即随之消失。
 *
 * ## 界面设计（2026-10-26 响应式重做）
 *
 * 两种形态，按视口宽度切换（断点 640px）：
 *   - **桌面（≥640px）**：胶囊按钮 + 向上弹出的气泡面板，贴按钮右缘。
 *   - **手机（<640px）**：更紧凑的胶囊 + **底部抽屉**（全宽、圆角、遮罩、
 *     避开 safe-area-inset-bottom），因为手机上贴边气泡会溢出且难点。
 *
 * 触摸友好：按钮最小 32px 高、滑块加粗到 24px 触控区、预设档位网格化、
 * 面板打开时锁背景滚动、点遮罩/关闭按钮收起。
 *
 * ## 为什么这样取值（历史坑，勿改）
 *
 * 1. **codec 必须包成 `{mode:'strict', typeSymbol, schema}`**。
 *    直接把 `{parse}` 当 codec 传给 `remote.$mount()` 会报
 *    `field "patch" has no strict codec`，$mount 抛错 → 后面的 slot 注册全不执行
 *    → UI 什么都不出现。这是 2026-10-26 实测踩到的第一个坑。
 * 2. **sessionId 取双路**：`conversation.input.right` 座位的 owner props 是空对象
 *    （`renderSlot("conversation.input.right", {})`，dsh-client-ui-conversation:15642），
 *    所以优先用 slot inject 直传的 sessionId，缺失时读 `sessions.list.getSnapshot().current`。
 * 3. **RPC 失败是 resolve 出 `{ok:false,error}`，不是抛异常**，必须显式判信封。
 */

window.__ModuleLoader__.load({
  // id 必须与 package.json "name" 完全一致，否则前端报 loaded without registering。
  id: 'dsh-context-window',
  factory: (require) => {
    const React = require('react')
    const el = React.createElement

    /** 浏览器端诊断：控制台过滤 `[dsh-context-window]`。 */
    function diag(label, detail) {
      try {
        console.info('[dsh-context-window] ' + label + (detail === undefined ? '' : ' :: ' + detail))
      } catch {}
    }

    // ── Typert codec ──────────────────────────────────────────────────────
    /** 客户端 codec 的 schema 面：本地 registry 只要求 `{parse}`。 */
    const codecOf = (parse) => ({ parse })
    const patchCodec = codecOf((v) => {
      if (v === null || typeof v !== 'object' || typeof v.sessionId !== 'string') throw new Error('patch: expected {sessionId}')
      return v
    })
    const stateCodec = codecOf((v) => {
      if (v === null || typeof v !== 'object' || typeof v.sessionId !== 'string') throw new Error('state: expected {sessionId}')
      return v
    })
    const okCodec = codecOf((v) => {
      if (v === null || typeof v !== 'object') throw new Error('result: expected an object')
      return v
    })

    /**
     * 包装成严格 codec —— `remote.$mount()` 强制要求这个形状，
     * 缺了它整条 RPC 注册会被拒（见文件头注释 1）。
     */
    const strict = (schema, typeName) => ({
      mode: 'strict',
      typeSymbol: 'dsh-context-window#' + typeName,
      schema,
    })

    /** Typert 描述符：本地 registry 条目，必须与宿主侧 typert.js 完全对齐。 */
    const CONTRIBUTION = {
      package: 'dsh-context-window',
      descriptors: [
        {
          id: 'dsh-context-window#contextWindow/getState',
          service: 'contextWindow',
          namespace: 'contextWindow',
          method: 'getState',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: strict(patchCodec, 'ContextWindowPatch') }],
          result: strict(stateCodec, 'ContextWindowState'),
        },
        {
          id: 'dsh-context-window#contextWindow/setWindow',
          service: 'contextWindow',
          namespace: 'contextWindow',
          method: 'setWindow',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: strict(patchCodec, 'ContextWindowPatch') }],
          result: strict(okCodec, 'ContextWindowOk'),
        },
        {
          id: 'dsh-context-window#contextWindow/clearWindow',
          service: 'contextWindow',
          namespace: 'contextWindow',
          method: 'clearWindow',
          invocation: { kind: 'direct' },
          parameters: [{ name: 'patch', wire: 'patch', source: 'json', codec: strict(patchCodec, 'ContextWindowPatch') }],
          result: strict(okCodec, 'ContextWindowOk'),
        },
      ],
    }

    // ── 常量 ──────────────────────────────────────────────────────────────
    /** 预设档位（单位 K）。 */
    const PRESETS = [64, 128, 256, 512, 1024, 2048]
    /** 滑块覆盖的 token 区间（对数刻度，否则 16K~2M 线性挤成一团）。 */
    const SLIDER_MIN_K = 16
    const SLIDER_MAX_K = 2048
    /** 移动端断点。 */
    const MOBILE_MAX = 640

    /** 主题变量回退（不同 DSH 版本变量名不完全一致，逐个兜底）。 */
    const C = {
      text: 'var(--dsw-text, var(--dsw-fg, #1f2328))',
      dim: 'var(--dsw-text-secondary, var(--dsw-dim, #6b7280))',
      border: 'var(--dsw-border, rgba(127,127,127,0.28))',
      surface: 'var(--dsw-surface, var(--dsw-bg-elevated, #ffffff))',
      hover: 'var(--dsw-hover-background, rgba(128,128,128,0.10))',
      accent: 'var(--dsw-accent, #4d6bfe)',
      warn: 'var(--dsw-warning, #b45309)',
      danger: 'var(--dsw-danger, #dc2626)',
    }

    /**
     * 把 token 数格式化成短标签。
     * @param n - token 数（可空）。
     * @returns 例如 `1.0M` / `512K` / `—`。
     */
    function fmtTokens(n) {
      if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return '—'
      if (n >= 1000000) {
        const m = n / 1000000
        return (Number.isInteger(m) ? String(m) : m.toFixed(1)) + 'M'
      }
      if (n >= 1000) return Math.round(n / 1000) + 'K'
      return String(n)
    }

    /** 对数刻度：滑块整数 0~100 → token 数。 */
    function sliderToTokens(v) {
      const t = Number(v) / 100
      const span = Math.log2(SLIDER_MAX_K / SLIDER_MIN_K)
      return Math.round(SLIDER_MIN_K * Math.pow(2, t * span) * 1000)
    }

    /** 对数刻度：token 数 → 滑块整数 0~100。 */
    function tokensToSlider(tokens) {
      const k = Math.max(SLIDER_MIN_K, Math.min(SLIDER_MAX_K, tokens / 1000))
      const span = Math.log2(SLIDER_MAX_K / SLIDER_MIN_K)
      return Math.round((Math.log2(k / SLIDER_MIN_K) / span) * 100)
    }

    /** 订阅视口是否窄屏（手机）。 */
    function useIsMobile() {
      const query = '(max-width: ' + MOBILE_MAX + 'px)'
      const read = () => {
        try {
          return window.matchMedia(query).matches
        } catch {
          return false
        }
      }
      const [mobile, setMobile] = React.useState(read)
      React.useEffect(() => {
        let mq
        try {
          mq = window.matchMedia(query)
        } catch {
          return undefined
        }
        const onChange = (event) => setMobile(event.matches)
        if (typeof mq.addEventListener === 'function') {
          mq.addEventListener('change', onChange)
          return () => mq.removeEventListener('change', onChange)
        }
        // 老 Safari
        mq.addListener(onChange)
        return () => mq.removeListener(onChange)
      }, [])
      return mobile
    }

    // ── 组件 ──────────────────────────────────────────────────────────────
    /**
     * 输入框右侧的窗口控件（桌面气泡 / 手机底部抽屉）。
     *
     * @param props - `{ sessionId, getSessionId, call }`（inject 提供）。
     */
    function ContextWindowControl(props) {
      const getSessionId = props.getSessionId
      const call = props.call
      const mobile = useIsMobile()

      const readSessionId = React.useCallback(() => {
        const direct = props.sessionId
        if (typeof direct === 'string' && direct !== '') return direct
        try {
          return typeof getSessionId === 'function' ? getSessionId() : null
        } catch {
          return null
        }
      }, [getSessionId, props.sessionId])

      const [sessionId, setSessionId] = React.useState(readSessionId)
      const [state, setState] = React.useState(null)
      const [open, setOpen] = React.useState(false)
      const [draft, setDraft] = React.useState('')
      const [error, setError] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [notice, setNotice] = React.useState(null)
      const rootRef = React.useRef(null)

      /** 拉一次宿主状态。 */
      const reload = React.useCallback(() => {
        if (typeof sessionId !== 'string' || sessionId === '') return
        call('getState', [{ sessionId }])
          .then((next) => {
            setState(next)
            setError(null)
          })
          .catch((e) => setError(String(e?.message ?? e)))
      }, [sessionId, call])

      // 用户切对话时组件不会自动重挂，所以每秒对一次当前会话 id。
      React.useEffect(() => {
        const timer = setInterval(() => {
          const next = readSessionId()
          setSessionId((prev) => (prev === next ? prev : next))
        }, 1000)
        return () => clearInterval(timer)
      }, [readSessionId])

      React.useEffect(() => {
        reload()
      }, [reload])

      // 面板打开时刷新，并每 2.5s 轻量重拉：切换模型后能立刻看到「模型默认」变化
      // （DSH 没有给插件暴露 model-selection 变更事件）。
      React.useEffect(() => {
        if (!open) return undefined
        reload()
        const timer = setInterval(reload, 2500)
        return () => clearInterval(timer)
      }, [open, reload])

      // 打开时同步草稿值。
      React.useEffect(() => {
        if (!open) return
        const current = state !== null && typeof state.window === 'number' ? state.window : null
        setDraft(current === null ? '' : String(current))
      }, [open, state])

      // 点外部关面板（桌面气泡用；手机抽屉有遮罩，走遮罩自己的 handler）。
      React.useEffect(() => {
        if (!open || mobile) return undefined
        const onDown = (event) => {
          const root = rootRef.current
          if (root !== null && root !== undefined && root.contains(event.target)) return
          setOpen(false)
        }
        document.addEventListener('mousedown', onDown, true)
        return () => document.removeEventListener('mousedown', onDown, true)
      }, [open, mobile])

      // 手机抽屉打开时锁背景滚动，避免后面内容跟着滑。
      React.useEffect(() => {
        if (!open || !mobile) return undefined
        const previous = document.body.style.overflow
        document.body.style.overflow = 'hidden'
        return () => {
          document.body.style.overflow = previous
        }
      }, [open, mobile])

      // Esc 关闭（桌面）。
      React.useEffect(() => {
        if (!open) return undefined
        const onKey = (event) => {
          if (event.key === 'Escape') setOpen(false)
        }
        document.addEventListener('keydown', onKey)
        return () => document.removeEventListener('keydown', onKey)
      }, [open])

      const applyWindow = React.useCallback(
        (value) => {
          const numeric = typeof value === 'number' ? value : Number(String(value).trim())
          if (!Number.isFinite(numeric) || numeric <= 0) {
            setError('请输入正数（单位 token）')
            return
          }
          const rounded = Math.round(numeric)
          setBusy(true)
          call('setWindow', [{ sessionId, window: rounded }])
            .then(async (result) => {
              diag('setWindow:ok', JSON.stringify(result))
              setError(null)
              setNotice('已设为 ' + fmtTokens(rounded))
              setState((prev) => (prev === null ? prev : { ...prev, window: rounded }))
              // 立刻回读，验证「写进去了没有」—— 这是持久化链路的唯一可信证据
              try {
                const after = await call('getState', [{ sessionId }])
                diag('setWindow:readback', JSON.stringify(after))
              } catch (e) {
                diag('setWindow:readback-FAILED', String(e?.message ?? e))
              }
              reload()
            })
            .catch((e) => setError(String(e?.message ?? e)))
            .finally(() => setBusy(false))
        },
        [sessionId, call, reload],
      )

      const clearWindow = React.useCallback(() => {
        setBusy(true)
        call('clearWindow', [{ sessionId }])
          .then(() => {
            setError(null)
            setNotice('已回到模型默认')
            setDraft('')
            setState((prev) => (prev === null ? prev : { ...prev, window: null }))
            reload()
          })
          .catch((e) => setError(String(e?.message ?? e)))
          .finally(() => setBusy(false))
      }, [sessionId, call, reload])

      // 提示 2 秒后自动消失
      React.useEffect(() => {
        if (notice === null) return undefined
        const timer = setTimeout(() => setNotice(null), 2000)
        return () => clearTimeout(timer)
      }, [notice])

      // 挂载/空渲染诊断（定位「UI 不出现」用，确认后保留成本极低）
      React.useEffect(() => {
        diag('component:mounted', 'sessionId=' + String(sessionId) + ' mobile=' + String(mobile) + ' directProp=' + String(props.sessionId))
      }, [])

      if (typeof sessionId !== 'string' || sessionId === '') {
        diag('component:returned-null', 'sessionId=' + String(sessionId) + ' typeof=' + typeof sessionId)
        return null
      }

      const override = state !== null && typeof state.window === 'number' ? state.window : null
      const modelDefault = state !== null && typeof state.modelDefault === 'number' ? state.modelDefault : null
      const overLimit = override !== null && modelDefault !== null && override > modelDefault
      const isCustom = override !== null
      const effective = override === null ? modelDefault : override

      // 胶囊标签：手机更短但仍要能认出是什么控件（纯数字会和 DSH 自带的用量计混淆）。
      const chipLabel = mobile
        ? 'ctx ' + fmtTokens(effective)
        : isCustom
          ? '上下文 ' + fmtTokens(override)
          : '上下文 默认 ' + fmtTokens(modelDefault)

      const chipStyle = {
        display: 'inline-flex',
        alignItems: 'center',
        justifyContent: 'center',
        gap: 4,
        minHeight: mobile ? 32 : 26,
        padding: mobile ? '0 10px' : '2px 8px',
        fontSize: mobile ? 13 : 12,
        lineHeight: 1,
        borderRadius: 8,
        border: '1px solid ' + (overLimit ? C.warn : isCustom ? C.accent : C.border),
        background: 'transparent',
        color: overLimit ? C.warn : C.text,
        cursor: busy ? 'progress' : 'pointer',
        whiteSpace: 'nowrap',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
      }

      const primaryBtn = {
        minHeight: mobile ? 40 : 30,
        padding: mobile ? '0 14px' : '3px 10px',
        fontSize: mobile ? 14 : 12,
        borderRadius: 8,
        border: '1px solid ' + C.border,
        background: 'transparent',
        color: C.text,
        cursor: busy ? 'progress' : 'pointer',
        touchAction: 'manipulation',
        WebkitTapHighlightColor: 'transparent',
      }

      const accentBtn = {
        ...primaryBtn,
        border: '1px solid ' + C.accent,
        color: C.accent,
        fontWeight: 600,
      }

      /** 面板主体（两种形态共用）。 */
      const body = el(
        'div',
        { style: { display: 'flex', flexDirection: 'column', gap: mobile ? 12 : 9 } },

        // 标题行
        el(
          'div',
          { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8 } },
          el('div', { style: { fontSize: mobile ? 15 : 13, fontWeight: 600, color: C.text } }, '本对话上下文窗口'),
          mobile
            ? el(
                'button',
                {
                  type: 'button',
                  onClick: () => setOpen(false),
                  'aria-label': '关闭',
                  style: {
                    ...primaryBtn,
                    minWidth: 40,
                    padding: 0,
                    fontSize: 18,
                    lineHeight: 1,
                    color: C.dim,
                  },
                },
                '×',
              )
            : null,
        ),

        // 对比信息
        el(
          'div',
          { style: { fontSize: mobile ? 12 : 11, color: C.dim, lineHeight: 1.6 } },
          '模型默认 ' + fmtTokens(modelDefault),
          state !== null && typeof state.model === 'string' && state.model !== '' ? ' · ' + state.model : '',
          ' · ',
          isCustom
            ? el('span', { style: { color: C.accent, fontWeight: 600 } }, '当前 ' + fmtTokens(override) + '（自定义）')
            : '当前用默认',
        ),

        // 滑块
        el(
          'div',
          { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
          el('input', {
            type: 'range',
            min: 0,
            max: 100,
            step: 1,
            // 把手位置跟 draft 走 —— 拖动时立刻反映，但**不提交**。
            // 之前这里绑的是已提交值，拖动后把手被受控值拉回原位，看着像没反应；
            // 另外 onPointerUp 自动提交，导致「没点应用就生效」，且闭包里的
            // draft 还是拖动前的旧值，提交的数字也不是用户看到的那一个。
            value: tokensToSlider(
              draft === ''
                ? (override === null ? (modelDefault ?? SLIDER_MIN_K * 1000) : override)
                : Number(draft),
            ),
            disabled: busy,
            onChange: (event) => {
              setDraft(String(sliderToTokens(event.target.value)))
            },
            'aria-label': '上下文窗口滑块',
            style: {
              width: '100%',
              height: mobile ? 32 : 24,
              accentColor: C.accent,
              touchAction: 'pan-y',
              cursor: 'pointer',
            },
          }),
          el(
            'div',
            { style: { display: 'flex', justifyContent: 'space-between', fontSize: 10, color: C.dim } },
            el('span', {}, fmtTokens(SLIDER_MIN_K * 1000)),
            el('span', { style: { color: C.text, fontWeight: 600 } }, draft === '' ? fmtTokens(effective) : fmtTokens(Number(draft))),
            el('span', {}, fmtTokens(SLIDER_MAX_K * 1000)),
          ),
        ),

        // 精确输入
        el(
          'div',
          { style: { display: 'flex', gap: 8, alignItems: 'stretch' } },
          el('input', {
            type: 'number',
            inputMode: 'numeric',
            value: draft,
            placeholder: modelDefault === null ? 'token 数' : String(modelDefault),
            disabled: busy,
            onChange: (event) => setDraft(event.target.value),
            onKeyDown: (event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                applyWindow(draft)
              }
            },
            'aria-label': '上下文窗口 token 数',
            style: {
              flex: 1,
              minWidth: 0,
              minHeight: mobile ? 40 : 30,
              fontSize: mobile ? 16 : 12, // 16px 以下 iOS 会自动放大页面
              padding: '0 10px',
              borderRadius: 8,
              border: '1px solid ' + C.border,
              background: 'transparent',
              color: C.text,
              boxSizing: 'border-box',
            },
          }),
          el(
            'button',
            { type: 'button', onClick: () => applyWindow(draft), disabled: busy, style: accentBtn },
            '应用',
          ),
        ),

        // 预设档位
        el(
          'div',
          {
            style: {
              display: 'grid',
              gridTemplateColumns: mobile ? 'repeat(3, 1fr)' : 'repeat(3, 1fr)',
              gap: 8,
            },
          },
          ...PRESETS.map((k) =>
            el(
              'button',
              {
                key: k,
                type: 'button',
                onClick: () => applyWindow(k * 1000),
                disabled: busy,
                style: {
                  ...primaryBtn,
                  padding: 0,
                  fontWeight: override === k * 1000 ? 700 : 400,
                  border: '1px solid ' + (override === k * 1000 ? C.accent : C.border),
                  color: override === k * 1000 ? C.accent : C.text,
                },
              },
              k >= 1024 ? k / 1024 + 'M' : k + 'K',
            ),
          ),
        ),

        // 用模型默认
        el(
          'button',
          { type: 'button', onClick: clearWindow, disabled: busy || !isCustom, style: { ...primaryBtn, width: '100%', opacity: isCustom ? 1 : 0.45 } },
          '用模型默认',
        ),

        // 超窗警告
        overLimit
          ? el(
              'div',
              { style: { fontSize: mobile ? 12 : 11, color: C.warn, lineHeight: 1.6 } },
              '⚠ 超过模型真实窗口 ' + fmtTokens(modelDefault) + '：DSH 不会提前压缩，真撞墙时 provider 会报上下文超限。',
            )
          : null,

        // 错误 / 成功提示
        error !== null ? el('div', { style: { fontSize: mobile ? 12 : 11, color: C.danger, lineHeight: 1.6 } }, error) : null,
        notice !== null ? el('div', { style: { fontSize: mobile ? 12 : 11, color: C.accent, lineHeight: 1.6 } }, notice) : null,

        // 说明
        el(
          'div',
          { style: { fontSize: mobile ? 11 : 10, color: C.dim, lineHeight: 1.6 } },
          '只影响这个对话的自动压缩时机；模型真实容量不会变。值存在会话里，删对话即消失。',
        ),
      )

      /** 桌面气泡面板。 */
      const desktopPanel = el(
        'div',
        {
          role: 'dialog',
          'aria-label': '上下文窗口设置',
          style: {
            position: 'absolute',
            bottom: 'calc(100% + 8px)',
            right: 0,
            zIndex: 60,
            width: 300,
            maxWidth: 'calc(100vw - 24px)',
            padding: 14,
            borderRadius: 12,
            border: '1px solid ' + C.border,
            background: C.surface,
            boxShadow: '0 10px 30px rgba(0,0,0,0.18)',
          },
        },
        body,
      )

      /** 手机底部抽屉（含遮罩）。 */
      const mobilePanel = el(
        React.Fragment,
        null,
        el('div', {
          onClick: () => setOpen(false),
          'aria-hidden': 'true',
          style: {
            position: 'fixed',
            inset: 0,
            zIndex: 59,
            background: 'rgba(0,0,0,0.38)',
          },
        }),
        el(
          'div',
          {
            role: 'dialog',
            'aria-modal': 'true',
            'aria-label': '上下文窗口设置',
            style: {
              position: 'fixed',
              left: 0,
              right: 0,
              bottom: 0,
              zIndex: 60,
              padding: 16,
              paddingBottom: 'calc(16px + env(safe-area-inset-bottom, 0px))',
              borderTopLeftRadius: 18,
              borderTopRightRadius: 18,
              border: '1px solid ' + C.border,
              borderBottom: 'none',
              background: C.surface,
              boxShadow: '0 -10px 30px rgba(0,0,0,0.20)',
              maxHeight: '78vh',
              overflowY: 'auto',
              WebkitOverflowScrolling: 'touch',
            },
          },
          // 手机上加一个拖拽把手，视觉上表明这是抽屉
          el(
            'div',
            { style: { display: 'flex', justifyContent: 'center', paddingBottom: 10 } },
            el('div', { style: { width: 36, height: 4, borderRadius: 2, background: C.border } }),
          ),
          body,
        ),
      )

      return el(
        'div',
        { ref: rootRef, style: { position: 'relative', display: 'inline-flex', alignItems: 'center' } },
        el(
          'button',
          {
            type: 'button',
            onClick: () => setOpen((v) => !v),
            title: '本对话的上下文窗口（点开调整，只影响这个对话）',
            'aria-expanded': open,
            'aria-label': '上下文窗口 ' + fmtTokens(effective),
            style: chipStyle,
          },
          chipLabel,
        ),
        open ? (mobile ? mobilePanel : desktopPanel) : null,
      )
    }

    // ── 插件入口 ──────────────────────────────────────────────────────────
    /**
     * 插件入口。
     *
     * @param ctx - client 根上下文。
     */
    async function apply(ctx) {
      diag('apply:start')
      const remote = ctx.get('remote')
      if (remote === undefined || remote === null || typeof remote.$mount !== 'function') {
        diag('apply:abort', 'remote unavailable: ' + typeof remote)
        return
      }
      let unmount
      try {
        unmount = await remote.$mount(CONTRIBUTION)
        diag('apply:mount-ok', 'descriptors=' + CONTRIBUTION.descriptors.length)
      } catch (error) {
        diag('apply:mount-FAILED', String(error?.message ?? error))
        return
      }
      if (typeof unmount === 'function') {
        ctx.effect(() => () => unmount(), 'dsh-context-window: remote contribution')
      }

      const svc = ctx.get('remote.contextWindow')
      if (svc === undefined || svc === null) {
        diag('apply:abort', 'remote.contextWindow service unavailable — typert 清单没被宿主认领')
        return
      }
      diag('apply:service-ok', 'methods=' + Object.keys(svc).slice(0, 8).join(','))

      /**
       * RPC 调用。
       *
       * 两个必须处理的约定（2026-10-26 实测踩坑）：
       * 1. 失败是 resolve 出 `{ok:false, error}`，不是抛异常 → 显式判信封。
       * 2. **成功时服务返回值被包在 `value` 里**（`{ok:true, value:{...}}`）。
       *    直接把信封当数据用会让 `state.window` 永远是 undefined，
       *    表现就是界面永远显示「默认 —」、设了值也读不回来。
       *
       * @param method - 方法名。
       * @param args - 参数数组。
       * @returns 解包后的服务返回值。
       */
      const call = async (method, args) => {
        const envelope = await svc[method](...(args ?? []))
        if (envelope !== null && typeof envelope === 'object' && envelope.ok === false) {
          const err = envelope.error ?? {}
          const failure = new Error(String(err.message ?? err.code ?? 'unknown RPC failure'))
          failure.code = err.code
          diag('rpc:envelope-failed', method + ' code=' + String(err.code ?? '-'))
          throw failure
        }
        return envelope !== null && typeof envelope === 'object' && 'value' in envelope ? envelope.value : envelope
      }

      const slots = ctx.get('slots')
      if (slots === undefined || slots === null || typeof slots.inject !== 'function') {
        diag('apply:abort', 'slots service unavailable: ' + typeof slots)
        return
      }

      const sessionsSvc = ctx.get('sessions')
      const getSessionId = () => {
        try {
          const snap = sessionsSvc?.list?.getSnapshot?.()
          return snap?.current ?? null
        } catch {
          return null
        }
      }

      try {
        slots.inject('conversation.input.right', () =>
          slots.register(
            {
              name: 'conversation.input.right',
              id: 'dsh-context-window-control',
              order: 30,
              inject: (sessionId) => ({ sessionId: sessionId ?? null, getSessionId, call }),
            },
            ContextWindowControl,
          ),
        )
        diag('apply:slot-registered', 'conversation.input.right')
      } catch (error) {
        diag('apply:slot-FAILED', String(error?.message ?? error))
      }
    }

    /** client 侧必须声明的服务（缺声明时属性访问会抛）。 */
    const inject = ['remote', 'slots', 'sessions']

    return { apply, inject }
  },
})
