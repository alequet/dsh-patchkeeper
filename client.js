/**
 * dsh-patchkeeper 客户端 UI（免构建手写 bundle，形态参照 dsh-meme/dshmarket）。
 *
 * 槽位：
 *   plugins.detail.badge            —— 失配插件详情页标题旁的「补丁未加载」徽章
 *   plugins.detail.section          —— 失配插件详情页底部的适配卡片
 *   plugins.bundle.config (key=dsh-patchkeeper) —— patchkeeper 自己详情页的补丁管理台
 *   shell.overlay                   —— 开机绿泡泡（正向确认）/ 常驻红黄牌警告
 *
 * 数据来源：Node 侧 /dsh-patchkeeper-api（GET 清单 / POST 操作）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-patchkeeper',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/dsh-patchkeeper-api'

    // 需要在详情页挂牌的异常状态（disabled 是用户主动关的，不算异常）
    const BAD_STATUSES = ['version-mismatch', 'conflict', 'apply-failed', 'missing-target']

    async function fetchList() {
      try {
        const res = await fetch(API)
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      }
    }

    async function postAction(action, name, extra) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name, ...(extra || {}) }),
      })
      return res.json()
    }

    // 取某个插件的异常补丁记录（无异常 → null → 不渲染）
    function useMismatch(subject) {
      const [tick, setTick] = React.useState(0)
      const [data, setData] = React.useState(null)
      React.useEffect(() => {
        let live = true
        fetchList().then((s) => live && setData(s))
        return () => {
          live = false
        }
      }, [tick])
      const pkgName = subject && subject.kind === 'bundle' ? subject.pkg && subject.pkg.name : null
      const record =
        pkgName && data && Array.isArray(data.patches)
          ? data.patches.find((r) => r.name === pkgName && BAD_STATUSES.includes(r.status)) || null
          : null
      return { record, refresh: () => setTick((t) => t + 1) }
    }

    const badgeStyle = {
      display: 'inline-block',
      marginLeft: 8,
      padding: '1px 8px',
      borderRadius: 8,
      fontSize: 12,
      lineHeight: '18px',
      color: '#8a5a00',
      background: 'rgba(250, 173, 20, 0.18)',
      border: '1px solid rgba(250, 173, 20, 0.45)',
      verticalAlign: 'middle',
      whiteSpace: 'nowrap',
    }

    function MismatchBadge(props) {
      const { record } = useMismatch(props.subject)
      if (!record) return null
      return h('span', { style: badgeStyle, title: `补丁版本 ${record.version}，已装版本 ${record.installedVersion || '未知'}` }, '补丁未加载')
    }

    const cardStyle = {
      margin: '12px 0',
      padding: '12px 14px',
      borderRadius: 10,
      border: '1px solid rgba(250, 173, 20, 0.45)',
      background: 'rgba(250, 173, 20, 0.08)',
      fontSize: 13,
      lineHeight: 1.7,
    }
    const btnStyle = {
      marginRight: 8,
      marginTop: 8,
      padding: '4px 12px',
      borderRadius: 6,
      border: '1px solid rgba(250, 173, 20, 0.6)',
      background: 'transparent',
      color: 'inherit',
      cursor: 'pointer',
      fontSize: 13,
    }

    function MismatchSection(props) {
      const { record, refresh } = useMismatch(props.subject)
      const [busy, setBusy] = React.useState('')
      const [msg, setMsg] = React.useState(null)
      if (!record) return null

      const run = async (action) => {
        setBusy(action)
        setMsg(null)
        try {
          const j = await postAction(action, record.name)
          if (j.error) {
            setMsg(`失败：${j.error}`)
          } else if (action === 'adapt') {
            const r = j.result && j.result.results && j.result.results[0]
            const st = r && r.status
            setMsg(
              st === 'applied-now'
                ? '已强行打上旧补丁（有 fuzz 风险），重启 DSH 后生效；若插件异常请在管理台禁用。'
                : st === 'applied'
                  ? '补丁其实已处于应用状态。'
                  : `未能应用（${st || '未知'}），请手动合并 rejects/ 后用「以当前代码重建补丁」。`,
            )
          } else if (action === 'extract') {
            const r = j.result && j.result.results && j.result.results[0]
            setMsg(r && r.error ? `重建失败：${r.error}` : '已按当前代码重建补丁并入库，重启 DSH 后自动生效。')
          } else {
            setMsg('已回退该插件的补丁。')
          }
        } catch (err) {
          setMsg(`请求失败：${err && err.message ? err.message : err}`)
        } finally {
          setBusy('')
          refresh()
        }
      }

      const statusText = {
        'version-mismatch': `插件已升级到 ${record.installedVersion || '?'}，补丁是按 ${record.version} 做的，为避免加载失败本次未打。`,
        conflict: '补丁与当前代码冲突，未能应用。',
        'apply-failed': '补丁应用失败，reject 详情见数据目录 rejects/。',
        'missing-target': '补丁目标插件当前未安装。',
      }[record.status] || record.status

      return h('section', { style: cardStyle }, [
        h('div', { key: 't', style: { fontWeight: 600 } }, '⚠ 本地补丁未加载'),
        h('div', { key: 'd' }, statusText),
        h('div', { key: 'b' }, [
          h(
            'button',
            { key: 'adapt', style: btnStyle, disabled: !!busy, onClick: () => run('adapt') },
            busy === 'adapt' ? '适配中…' : '尝试重新适配（force）',
          ),
          h(
            'button',
            { key: 'extract', style: btnStyle, disabled: !!busy, onClick: () => run('extract') },
            busy === 'extract' ? '重建中…' : '以当前代码重建补丁',
          ),
        ]),
        msg ? h('div', { key: 'm', style: { marginTop: 8, opacity: 0.85 } }, msg) : null,
      ])
    }

    // ---------- patchkeeper 自己的详情页：补丁管理台 ----------

    const statusMeta = {
      applied: ['· 挂载中', '#2ea043'],
      'applied-now': ['✓ 刚挂载', '#2ea043'],
      'not-applied': ['○ 未挂载', '#8b8b8b'],
      disabled: ['⏸ 已禁用', '#8b8b8b'],
      'version-mismatch': ['⊘ 版本不匹配', '#d29922'],
      conflict: ['✗ 冲突', '#dc3c3c'],
      'apply-failed': ['✗ 挂载失败', '#dc3c3c'],
      'missing-target': ['✗ 目标缺失', '#dc3c3c'],
    }

    const toggleStyle = (on) => ({
      width: 36,
      height: 20,
      borderRadius: 10,
      border: 'none',
      cursor: 'pointer',
      background: on ? '#2ea043' : 'rgba(128,128,128,0.4)',
      position: 'relative',
      flexShrink: 0,
      transition: 'background 0.15s',
    })
    const knobStyle = (on) => ({
      position: 'absolute',
      top: 2,
      left: on ? 18 : 2,
      width: 16,
      height: 16,
      borderRadius: 8,
      background: '#fff',
      transition: 'left 0.15s',
    })

    // 常驻红字维测：失败状态必须给出足够的诊断信息
    function diagOf(p) {
      switch (p.status) {
        case 'version-mismatch':
          return `未挂载：补丁按 v${p.version} 制作，当前安装 v${p.installedVersion || '?'}，版本闸已拦截（防止旧补丁打崩新代码）。点「尝试重新适配」或改补丁后 remount。`
        case 'conflict':
          return `挂载失败：补丁与当前代码冲突${p.lastError ? `（${p.lastError}）` : ''}，reject 详情见数据目录 rejects/。`
        case 'apply-failed':
          return `挂载失败${p.lastError ? `：${p.lastError}` : '（原因见 state.json）'}`
        case 'missing-target':
          return '目标插件未安装，补丁悬空。'
        default:
          return null
      }
    }

    function PatchRow({ p, busy, op, onToggle, onSaveNote }) {
      const [note, setNote] = React.useState(p.note || '')
      const [dirty, setDirty] = React.useState(false)
      const meta = statusMeta[p.status] || [p.status, '#8b8b8b']
      const diag = diagOf(p)
      return h(
        'div',
        {
          style: {
            padding: '10px 0',
            borderBottom: '1px solid rgba(128,128,128,0.2)',
            display: 'flex',
            gap: 12,
            alignItems: 'flex-start',
          },
        },
        h(
          'button',
          {
            style: toggleStyle(p.enabled),
            title: p.enabled ? '点击禁用（恢复原插件、清除副本）' : '启用（创建副本并挂载）',
            disabled: busy,
            onClick: () => onToggle(p),
          },
          h('span', { style: knobStyle(p.enabled) }),
        ),
        h('div', { style: { flex: 1, minWidth: 0 } }, [
          h('div', { key: 'n', style: { fontWeight: 600, fontSize: 13 } }, [
            `${p.name} `,
            h('span', { key: 'v', style: { fontWeight: 400, opacity: 0.7, fontSize: 12 } }, `补丁 ${p.version} / 已装 ${p.installedVersion || '?'}`),
          ]),
          h('div', { key: 's', style: { fontSize: 12, color: meta[1], marginTop: 2 } }, meta[0] + (p.files?.length ? ` · ${p.files.length} 个文件` : '')),
          p.files?.length
            ? h('div', { key: 'f', style: { fontSize: 11, opacity: 0.6, marginTop: 2, wordBreak: 'break-all' } }, p.files.join('、'))
            : null,
          diag ? h('div', { key: 'diag', style: { fontSize: 12, color: '#dc3c3c', marginTop: 4, lineHeight: 1.6 } }, diag) : null,
          op
            ? h('div', { key: 'op', style: { fontSize: 12, fontWeight: 600, marginTop: 4, color: op.ok ? '#2ea043' : '#dc3c3c' } }, op.text)
            : null,
          h('div', { key: 'note', style: { display: 'flex', gap: 6, marginTop: 6 } }, [
            h('input', {
              key: 'i',
              value: note,
              placeholder: '补丁效果说明（点击填写…）',
              onChange: (e) => {
                setNote(e.target.value)
                setDirty(true)
              },
              style: {
                flex: 1,
                fontSize: 12,
                padding: '3px 8px',
                borderRadius: 6,
                border: '1px solid rgba(128,128,128,0.35)',
                background: 'transparent',
                color: 'inherit',
              },
            }),
            dirty
              ? h(
                  'button',
                  {
                    key: 'sv',
                    style: { ...btnStyle, marginTop: 0, padding: '2px 10px', fontSize: 12 },
                    disabled: busy,
                    onClick: () => onSaveNote(p, note).then(() => setDirty(false)),
                  },
                  '保存',
                )
              : null,
          ]),
        ]),
      )
    }

    function PatchPanel() {
      const [data, setData] = React.useState(null)
      const [busy, setBusy] = React.useState(false)
      const [hint, setHint] = React.useState(null)
      const [ops, setOps] = React.useState({}) // 每个补丁最近一次操作的结果反馈
      const refresh = () => fetchList().then(setData)
      React.useEffect(() => {
        refresh()
      }, [])
      if (!data) return h('div', { style: { padding: 8, opacity: 0.6 } }, '补丁清单加载中…')
      const patches = data.patches || []

      const setOp = (name, ok, text) => setOps((m) => ({ ...m, [name]: { ok, text } }))

      const act = async (action, p, extra) => {
        setBusy(true)
        setHint(null)
        try {
          const j = await postAction(action, p.name, extra)
          if (j.error) {
            setOp(p.name, false, `操作失败：${j.error}`)
          } else {
            const r = j.result && j.result.results && j.result.results[0]
            if (action === 'enable') {
              if (r && (r.status === 'applied-now' || r.status === 'applied')) setOp(p.name, true, '✓ 已启用：副本已创建并挂载（后端代码重启 DSH 后切换）')
              else setOp(p.name, false, `✗ 启用失败：${(r && (r.error || r.status)) || '未知原因'}`)
            } else if (action === 'disable') {
              if (r && (r.status === 'reverted' || r.status === 'not-applied')) setOp(p.name, true, '✓ 已禁用：恢复原插件、副本已清除（重启后完全生效）')
              else setOp(p.name, false, `✗ 禁用失败：${(r && (r.error || r.status)) || '未知原因'}`)
            } else if (action === 'note') {
              setOp(p.name, true, '✓ 说明已保存')
            }
            if (j.list) setData(j.list)
          }
        } catch (err) {
          setOp(p.name, false, `请求失败：${err && err.message ? err.message : err}`)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { style: { fontSize: 13 } }, [
        data.alarm
          ? h('div', { key: 'alarm', style: { ...cardStyle, borderColor: 'rgba(220,60,60,0.5)', background: 'rgba(220,60,60,0.1)', fontWeight: 600 } }, data.alarm)
          : null,
        patches.length
          ? h('div', { key: 'rows' }, patches.map((p) =>
              h(PatchRow, {
                key: p.name,
                p,
                busy,
                op: ops[p.name],
                onToggle: (pp) => act(pp.enabled ? 'disable' : 'enable', pp),
                onSaveNote: (pp, note) => act('note', pp, { note }),
              }),
            ))
          : h('div', { key: 'empty', style: { opacity: 0.6, padding: '8px 0' } }, '补丁库为空——改了插件代码后跑 extract 入库。'),
        hint ? h('div', { key: 'hint', style: { marginTop: 8, fontSize: 12, opacity: 0.75 } }, hint) : null,
        h('div', { key: 'ft', style: { marginTop: 10, fontSize: 11, opacity: 0.55 } },
          '补丁库：~/.dsh/patch-manager/patches（git 管理）· 副本挂载于运行期，原版插件永远干净'),
      ])
    }

    // ---------- 开机 toast ----------

    function BootToast() {
      const [info, setInfo] = React.useState(null)
      const [gone, setGone] = React.useState(false)
      React.useEffect(() => {
        let live = true
        fetchList().then((s) => {
          if (!live || !s) return
          if (s.alarm) {
            setInfo({ level: 'alarm', text: s.alarm })
            return
          }
          const patches = Array.isArray(s.patches) ? s.patches : []
          const mounted = patches.filter((r) => r.mounted).length
          const bad = patches.filter((r) => BAD_STATUSES.includes(r.status)).length
          if (bad) setInfo({ level: 'warn', text: `补丁管家：${bad} 个补丁未挂载，请到插件管理页处理` })
          else if (mounted) setInfo({ level: 'ok', text: `补丁管家：${mounted} 个补丁已挂载 ✓` })
        })
        return () => {
          live = false
        }
      }, [])
      React.useEffect(() => {
        if (info && info.level === 'ok') {
          const t = setTimeout(() => setGone(true), 6000)
          return () => clearTimeout(t)
        }
      }, [info])
      if (!info || gone) return null
      const palette = {
        ok: { bg: 'rgba(46, 160, 67, 0.95)', fg: '#fff' },
        warn: { bg: 'rgba(250, 173, 20, 0.95)', fg: '#3a2a00' },
        alarm: { bg: 'rgba(220, 60, 60, 0.95)', fg: '#fff' },
      }[info.level]
      return h(
        'div',
        {
          style: {
            position: 'fixed',
            top: 16,
            right: 16,
            zIndex: 99999,
            padding: '10px 14px',
            borderRadius: 10,
            background: palette.bg,
            color: palette.fg,
            fontSize: 13,
            lineHeight: 1.5,
            maxWidth: 360,
            boxShadow: '0 4px 16px rgba(0,0,0,0.25)',
            display: 'flex',
            gap: 10,
            alignItems: 'flex-start',
          },
        },
        h('span', { style: { flex: 1 } }, info.text),
        h(
          'button',
          {
            style: { background: 'none', border: 'none', color: palette.fg, cursor: 'pointer', fontSize: 14, padding: 0 },
            onClick: () => setGone(true),
          },
          '×',
        ),
      )
    }

    function apply(ctx) {
      const slots = ctx.slots ?? (typeof ctx.get === 'function' ? ctx.get('slots') : null)
      if (!slots || typeof slots.inject !== 'function') return
      // slots.inject：槽被宿主声明时才注册，未声明时安全静默（宿主版本差异不炸 UI）
      slots.inject('plugins.detail.badge', () => {
        try {
          return slots.register({ name: 'plugins.detail.badge', id: 'patchkeeper-mismatch', order: 100 }, MismatchBadge)
        } catch {
          return () => {}
        }
      })
      slots.inject('plugins.detail.section', () => {
        try {
          return slots.register({ name: 'plugins.detail.section', id: 'patchkeeper-mismatch', order: 100 }, MismatchSection)
        } catch {
          return () => {}
        }
      })
      slots.inject('plugins.bundle.config', () => {
        try {
          return slots.register({ name: 'plugins.bundle.config', key: 'dsh-patchkeeper' }, PatchPanel)
        } catch {
          return () => {}
        }
      })
      slots.inject('shell.overlay', () => {
        try {
          return slots.register({ name: 'shell.overlay', id: 'patchkeeper-boot-toast', order: 100 }, BootToast)
        } catch {
          return () => {}
        }
      })
    }

    return { name: 'dsh-patchkeeper', inject: ['slots'], apply }
  },
})
