/**
 * dsh-patchkeeper — cordis 插件壳（常驻挂载模式）。
 *
 * 生命周期（0.5.0 起改为常驻）：
 *   DSH 启动时先用 createRuntimeResolution 冻结包路径快照，再加载插件——
 *   所以补丁必须在进程启动前就挂在磁盘上，「退出时回退」会让补丁永远赶不上快照。
 *   挂载常驻：启动时只做保底清除（崩溃残留/升级替换的修复）+ 版本匹配检查补挂。
 *   升级安全由结构保证：原版完整备份在数据目录 shadows/orig/，node_modules 条目只是
 *   一根软链，pnpm/安装器随时可以用新包替换它（保底清除会识别并丢弃过时备份）。
 *
 * UI 通道：注册 /dsh-patchkeeper-api
 *   GET            → 实时清单（插件管理页的徽章/提示卡/管理台取数）
 *   POST {action, name} → adapt / extract / revert / enable / disable / note
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-patchkeeper'
// 本进程（≈冻结快照）时刻：快照之后挂载的补丁要下次启动才进运行代码
const BOOT_TS = Date.now()
// cordis 规矩：访问 ctx 上的服务必须先在这里声明；声明后服务不可用时仍为 null（参照 dsh-meme 同款写法）
export const inject = ['webServer']

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'cli.mjs')
const ROUTE = '/dsh-patchkeeper-api'

function runCli(logger, args, timeoutMs = 180_000) {
  let res
  try {
    res = spawnSync(process.execPath, [CLI, ...args, '--json'], {
      encoding: 'utf8',
      timeout: timeoutMs,
    })
  } catch (err) {
    logger.warn(`patchkeeper ${args[0]} 执行失败: ${err.message}`)
    return null
  }
  if (res.status !== 0 && res.status !== 2) {
    logger.warn(`patchkeeper ${args[0]} 异常退出 (${res.status}): ${(res.stderr || '').slice(0, 500)}`)
    return null
  }
  try {
    return JSON.parse(res.stdout)
  } catch {
    logger.warn(`patchkeeper ${args[0]} 输出无法解析: ${(res.stdout || '').slice(0, 300)}`)
    return null
  }
}

function applyPatches(logger) {
  const out = runCli(logger, ['apply'])
  if (!out) return
  const applied = out.results.filter((r) => r.status === 'applied-now')
  const skipped = out.results.filter((r) => r.status === 'version-mismatch')
  const bad = out.results.filter((r) => ['conflict', 'missing-target', 'apply-failed'].includes(r.status))
  if (applied.length) {
    logger.info(`已为 ${applied.length} 个插件热打补丁: ${applied.map((r) => r.name).join(', ')}`)
  }
  if (skipped.length) {
    logger.info(
      `${skipped.length} 个补丁因版本不匹配未加载: ${skipped.map((r) => `${r.name} 补丁${r.patchVersion}/已装${r.installedVersion}`).join(', ')}——请到插件管理页处理`,
    )
  }
  for (const r of bad) {
    logger.warn(`补丁未打上: ${r.name} [${r.status}]（补丁版本 ${r.patchVersion} / 已装 ${r.installedVersion ?? '无'}）`)
  }
}

// 挂载变更后尝试借插件管理器的机器即时生效：
// 刷新 resolution 快照 + HMR 重载。任一环节缺席/失败就退回「重启后生效」。
async function tryLiveReload(ctx, logger) {
  try {
    const hmr = typeof ctx.get === 'function' ? ctx.get('hmr') : null
    const packages = typeof ctx.get === 'function' ? ctx.get('pluginPackages') : null
    if (!hmr || typeof hmr.runExclusive !== 'function' || typeof hmr.reconcileProfile !== 'function') return 'restart-required'
    if (packages?.resolution !== undefined && typeof packages.refresh === 'function') {
      try {
        await packages.refresh()
      } catch (err) {
        if (!String(err?.name || err).includes('ResolutionRestartRequired')) throw err
        return 'restart-required'
      }
    }
    await hmr.runExclusive(() => hmr.reconcileProfile([]))
    return 'reloaded'
  } catch (err) {
    logger.warn(`热重载未完成（重启后生效）: ${err?.message || err}`)
    return 'restart-required'
  }
}

// ---- UI HTTP 通道 ----

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' })
  res.end(JSON.stringify(obj))
}

function readBody(req) {
  return new Promise((resolve) => {
    let data = ''
    req.on('data', (c) => {
      data += c
      if (data.length > 64 * 1024) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', () => resolve(''))
  })
}

function registerApi(ctx, logger) {
  const webServer = ctx.webServer ?? ctx.get('webServer')
  if (!webServer) {
    logger.info('webServer 服务不可用，插件管理页提示卡不生效（补丁功能本身不受影响）')
    return
  }
  ctx.effect(() =>
    webServer.register({
      kind: 'prefix',
      path: ROUTE,
      async handler(req, res) {
        try {
          if (req.method === 'GET') {
            const out = runCli(logger, ['list'])
            return sendJson(res, 200, { ...(out || { patches: [] }), bootTs: BOOT_TS })
          }
          if (req.method === 'POST') {
            let payload = {}
            try {
              payload = JSON.parse(await readBody(req))
            } catch {
              return sendJson(res, 400, { error: 'bad json' })
            }
            const { action, name: pkgName, note } = payload
            if (!pkgName || typeof pkgName !== 'string') return sendJson(res, 400, { error: 'missing name' })
            let out
            if (action === 'adapt') out = runCli(logger, ['apply', '--force', '--pkg', pkgName])
            else if (action === 'extract') out = runCli(logger, ['extract', '--pkg', pkgName])
            else if (action === 'revert') out = runCli(logger, ['revert', '--pkg', pkgName])
            else if (action === 'enable') out = runCli(logger, ['enable', '--pkg', pkgName])
            else if (action === 'disable') out = runCli(logger, ['disable', '--pkg', pkgName])
            else if (action === 'note') out = runCli(logger, ['note', '--pkg', pkgName, String(payload.note ?? '')])
            else return sendJson(res, 400, { error: 'unknown action' })
            if (!out) return sendJson(res, 500, { error: 'cli failed' })
            // 挂载类操作成功后，借插件管理器的 HMR 机器尝试即时生效
            let reload = null
            if (['enable', 'disable', 'adapt', 'revert'].includes(action)) {
              reload = await tryLiveReload(ctx, logger)
            }
            // 操作后附上一份最新清单，前端直接刷新
            const list = runCli(logger, ['list'])
            return sendJson(res, 200, { action, result: out, reload, list })
          }
          sendJson(res, 405, { error: 'method not allowed' })
        } catch (err) {
          sendJson(res, 500, { error: String(err?.message || err) })
        }
      },
    }),
  )
}

export function apply(ctx, config = {}) {
  if (config.enabled === false) return
  const logger = ctx.logger('patchkeeper')

  // 启动：保底清除 + 版本匹配补挂。挂载是常驻的——本进程的冻结快照已在用它们。
  applyPatches(logger)

  // UI 通道
  registerApi(ctx, logger)

  // 注意：退出时【不要】revert。冻结快照机制要求补丁在下次进程启动前就在磁盘上；
  // 常驻挂载下，原版由 shadows/orig/ 备份保护，升级器替换软链后启动清理会自动归位。
}
