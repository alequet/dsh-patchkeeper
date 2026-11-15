/**
 * dsh-patchkeeper — cordis 插件壳（热加载模式）。
 *
 * 生命周期：
 *   加载时（bundles 首位，早于其他插件 import）：
 *     同步跑 `cli.mjs apply`——版本匹配的补丁打上，不匹配的跳过（保证客户端一定能启动）。
 *   退出时（dispose / process exit 双保险）：
 *     同步跑 `cli.mjs revert`——磁盘上的插件恢复原版干净状态。
 *   崩溃保护：revert 幂等；非正常退出留有补丁时，下次启动的版本匹配检查依然成立。
 *
 * UI 通道：注册 /dsh-patchkeeper-api
 *   GET            → 实时 status（插件管理页的徽章/提示卡取数）
 *   POST {action, name} → adapt（apply --force 单包）/ extract（以当前代码重建补丁）/ revert（单包回退）
 */
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-patchkeeper'
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

function revertPatches(logger) {
  // 退出路径短超时：宁可放弃回退（下次启动自愈），也不拖着客户端退不掉
  const out = runCli(logger, ['revert'], 30_000)
  if (!out) return
  const reverted = out.results.filter((r) => r.status === 'reverted')
  const failed = out.results.filter((r) => r.status === 'revert-failed')
  if (reverted.length) {
    logger.info(`退出清理：已回退 ${reverted.length} 个插件的补丁，磁盘恢复原版`)
  }
  for (const r of failed) {
    logger.warn(`退出清理：${r.name} 补丁回退失败，下次启动将按版本匹配重新校验`)
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
            return sendJson(res, 200, out || { patches: [], error: 'list failed' })
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
            // 操作后附上一份最新清单，前端直接刷新
            const list = runCli(logger, ['list'])
            return sendJson(res, 200, { action, result: out, list })
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

  // 启动：版本匹配检查 + 热打补丁（此时后续 bundle 的代码还没被 import，本轮即生效）
  applyPatches(logger)

  // UI 通道
  registerApi(ctx, logger)

  // 退出：回退干净。dispose 与 exit 双保险（revert 幂等，重复执行无副作用）
  const cleanup = () => revertPatches(logger)
  ctx.on('dispose', () => {
    cleanup()
    process.removeListener('exit', cleanup) // HMR 自更新场景：老实例的 exit 监听不累积
  })
  process.once('exit', cleanup)
}
