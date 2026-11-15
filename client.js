/**
 * dsh-patchkeeper 客户端 UI（免构建手写 bundle，形态参照 dsh-meme/dshmarket）。
 *
 * 往宿主插件管理页注册两个槽位：
 *   plugins.detail.badge   —— 失配插件详情页标题旁的金色徽章「补丁未加载」
 *   plugins.detail.section —— 详情页底部的适配卡片（说明 + 操作按钮）
 * 数据来源：Node 侧 /dsh-patchkeeper-api（GET 状态 / POST 操作）。
 */
window.__ModuleLoader__.load({
  id: 'dsh-patchkeeper',
  factory: (require) => {
    const React = require('react')
    const h = React.createElement
    const API = '/dsh-patchkeeper-api'

    const BAD_STATUSES = ['version-mismatch', 'conflict', 'apply-failed', 'missing-target']

    async function fetchStatus() {
      try {
        const res = await fetch(API)
        if (!res.ok) return null
        return await res.json()
      } catch {
        return null
      }
    }

    async function postAction(action, name) {
      const res = await fetch(API, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action, name }),
      })
      return res.json()
    }

    // 取当前 subject 对应插件的异常补丁记录（无异常 → null → 不渲染）
    function useMismatch(subject) {
      const [tick, setTick] = React.useState(0)
      const [status, setStatus] = React.useState(null)
      React.useEffect(() => {
        let live = true
        fetchStatus().then((s) => live && setStatus(s))
        return () => {
          live = false
        }
      }, [tick])
      const pkgName = subject && subject.kind === 'bundle' ? subject.pkg && subject.pkg.name : null
      const record =
        pkgName && status && Array.isArray(status.results)
          ? status.results.find((r) => r.name === pkgName && BAD_STATUSES.includes(r.status)) || null
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
      return h('span', { style: badgeStyle, title: `补丁版本 ${record.patchVersion}，已装版本 ${record.installedVersion || '未知'}` }, '补丁未加载')
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
                ? '已强行打上旧补丁（有 fuzz 风险），重启 DSH 后生效；若插件异常请回退。'
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
        'version-mismatch': `插件已升级到 ${record.installedVersion || '?'}，补丁是按 ${record.patchVersion} 做的，为避免加载失败本次未打。`,
        conflict: '补丁与当前代码冲突，未能应用。',
        'apply-failed': '补丁应用失败，reject 详情见 ~/.dsh/patch-manager/rejects/。',
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

    // 开机正向确认：绿泡泡 = N 个补丁活着；红色常驻 = 有事没挂成。
    // 哪天开机没见到绿泡泡，就说明补丁管家出事了（包括它自己没加载以外的存活场景）。
    function BootToast() {
      const [info, setInfo] = React.useState(null)
      const [gone, setGone] = React.useState(false)
      React.useEffect(() => {
        let live = true
        fetchStatus().then((s) => {
          if (!live || !s) return
          if (s.alarm) {
            setInfo({ level: 'alarm', text: s.alarm })
            return
          }
          const results = Array.isArray(s.results) ? s.results : []
          const mounted = results.filter((r) => r.mounted).length
          const bad = results.filter((r) => BAD_STATUSES.includes(r.status)).length
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
