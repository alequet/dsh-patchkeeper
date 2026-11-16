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
import fsSync from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

export const name = 'dsh-patchkeeper'
// 本进程（≈冻结快照）时刻：快照之后挂载的补丁要下次启动才进运行代码
const BOOT_TS = Date.now()
// cordis 规矩：访问 ctx 上的服务必须先在这里声明；声明后服务不可用时仍为 null（参照 dsh-meme 同款写法）
export const inject = ['webServer', 'llm']

const CLI = path.resolve(path.dirname(fileURLToPath(import.meta.url)), 'bin', 'cli.mjs')
const DATA_DIR = process.env.DSH_PATCHKEEPER_HOME || path.join(process.env.HOME || '~', '.dsh', 'patch-manager')
const STATE_FILE_PATH = path.join(DATA_DIR, 'state.json')
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
  return out.results
}

// ---- AI 适配管线：版本失配 → 机械合 → 冲突交 AI → 成功则下次重启自动挂载；失败记录不再重试 ----

function readAiAdaptConfig(cordisConfig) {
  let fileCfg = {}
  try {
    fileCfg = JSON.parse(fsSync.readFileSync(path.join(DATA_DIR, 'patches', 'config.json'), 'utf8')).$aiAdapt || {}
  } catch {}
  const merged = { enabled: true, provider: '', model: '', ...(cordisConfig?.adaptModel ? { provider: cordisConfig.adaptModel.provider || '', model: cordisConfig.adaptModel.model || '', ...(cordisConfig.adaptModel.enabled !== void 0 ? { enabled: cordisConfig.adaptModel.enabled } : {}) } : {}), ...fileCfg }
  const route = {}
  if (merged.provider) route.provider = merged.provider
  if (merged.model) route.model = merged.model
  return { enabled: merged.enabled !== false, route }
}

function readState() {
  try {
    return JSON.parse(fsSync.readFileSync(STATE_FILE_PATH, 'utf8'))
  } catch {
    return {}
  }
}

async function callAiForPatch(ctx, contextPack, route = {}) {
  const filesText = Object.entries(contextPack.files)
    .map(([f, info]) => `### 文件 ${f}\n没打进去的 hunk（旧版语境）：\n\`\`\`\n${info.rej}\n\`\`\`\n该文件的**新版**内容：\n\`\`\`\n${info_truncate(f, info.newContent)}\n\`\`\``)
    .join('\n\n')
  const prompt = `你是补丁适配器。插件 ${contextPack.name} 从 ${contextPack.fromVersion} 升级到 ${contextPack.toVersion}，旧补丁有几个文件打不进新代码了。

下面按文件给出：没打进去的 hunk（旧版语境）+ 该文件的新版内容。请为每个文件输出能直接打进新版本的 unified diff（路径前缀 a/ b/，patch -p1 可用，diff 头格式：diff -ruN a/<路径> b/<路径>）。只输出补丁本体，不要任何解释。

${filesText}`
  // 路由：默认走 profile 的当前默认模型；可在 cordis.patch.yml 的 patchkeeper 条目里配置
  // config: { adaptModel: { provider: '...', model: '...' } } 指定专用模型
  const call = await ctx.llm.prepareCall({ maxTokens: 8192, ...route })
  let text = ''
  const stream = call.stream({
    ...call.config,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }] }],
    sessionId: 'patchkeeper-adapt',
    purpose: 'patch-adapt',
  })
  for await (const chunk of stream) {
    if (chunk.type === 'text-delta' && typeof chunk.text === 'string') text += chunk.text
  }
  return text
}

function info_truncate(f, content) {
  if (content == null) return '(该文件在新版中不存在)'
  const MAX = 40000
  return content.length > MAX ? content.slice(0, MAX) + '\n…（文件过大已截断）' : content
}

// 从 AI 回复里抠出补丁本体（容错 markdown 围栏）
function extractPatch(text) {
  const fence = /```(?:diff|patch)?\s*\n([\s\S]*?)```/.exec(text)
  let body = fence ? fence[1] : text
  const start = body.search(/^(diff ---|--- a\/)/m)
  return start >= 0 ? body.slice(start) : null
}

async function adaptPipeline(ctx, logger, results, route = {}) {
  const mismatched = results.filter((r) => r.status === 'version-mismatch' && r.enabled !== false)
  if (!mismatched.length) return
  const state = readState()
  const records = state.adapt || {}
  for (const r of mismatched) {
    const key = `${r.name}@${r.installedVersion}`
    if (records[key]) continue // 适配过（成功或失败）都不重复，失败留人工
    logger.info(`检测到版本失配：${r.name} 补丁${r.patchVersion} ≠ 已装${r.installedVersion}，启动 AI 适配…`)
    records[key] = { outcome: 'running', at: new Date().toISOString() }
    fsSync.writeFileSync(STATE_FILE_PATH, JSON.stringify({ ...state, adapt: records }, null, 2))
    try {
      const auto = runCli(logger, ['adapt-auto', '--pkg', r.name, '--to', r.installedVersion])
      if (auto?.outcome === 'auto-merged') {
        records[key] = { outcome: 'adapted', mode: 'auto', at: new Date().toISOString() }
        logger.info(`${r.name} 补丁机械适配成功（${r.patchVersion} → ${r.installedVersion}），重启后自动挂载`)
      } else if (auto?.outcome === 'needs-ai') {
        const contextPack = JSON.parse(fsSync.readFileSync(path.join(auto.contextDir, 'context.json'), 'utf8'))
        const aiText = await callAiForPatch(ctx, contextPack, route)
        const patchText = extractPatch(aiText)
        if (!patchText) throw new Error('AI 回复里没有可用的补丁')
        fsSync.writeFileSync(path.join(auto.contextDir, 'ai.patch'), patchText)
        const applied = runCli(logger, ['adapt-apply', '--pkg', r.name, '--to', r.installedVersion])
        if (applied?.outcome !== 'adapted') throw new Error(`AI 补丁验证失败: ${applied?.outcome || 'unknown'} ${applied?.error || ''}`)
        records[key] = { outcome: 'adapted', mode: 'ai', at: new Date().toISOString() }
        logger.info(`${r.name} 补丁 AI 适配成功（${r.patchVersion} → ${r.installedVersion}），重启后自动挂载`)
      } else {
        throw new Error(`机械合并未启动: ${auto?.outcome || 'unknown'} ${auto?.error || ''}`)
      }
    } catch (err) {
      records[key] = { outcome: 'ai-failed', at: new Date().toISOString(), error: String(err?.message || err).slice(0, 500) }
      logger.warn(`${r.name} AI 适配失败：${err?.message || err}——已记录，不再自动重试，请人工适配`)
    }
    fsSync.writeFileSync(STATE_FILE_PATH, JSON.stringify({ ...readState(), adapt: records }, null, 2))
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
            if (action !== 'ai-config' && (!pkgName || typeof pkgName !== 'string')) return sendJson(res, 400, { error: 'missing name' })
            let out
            if (action === 'adapt') out = runCli(logger, ['apply', '--force', '--pkg', pkgName])
            else if (action === 'extract') out = runCli(logger, ['extract', '--pkg', pkgName])
            else if (action === 'revert') out = runCli(logger, ['revert', '--pkg', pkgName])
            else if (action === 'enable') out = runCli(logger, ['enable', '--pkg', pkgName])
            else if (action === 'disable') out = runCli(logger, ['disable', '--pkg', pkgName])
            else if (action === 'note') out = runCli(logger, ['note', '--pkg', pkgName, String(payload.note ?? '')])
            else if (action === 'ai-config') {
              const args = ['ai-config']
              if (payload.enabled !== undefined) args.push('--enabled', payload.enabled ? 'true' : 'false')
              if (payload.provider !== undefined) args.push('--provider', String(payload.provider))
              if (payload.model !== undefined) args.push('--model', String(payload.model))
              out = runCli(logger, args)
            }
            else if (action === 'adapt-retry') {
              // 人工点重试：清掉该版本的适配记录并重跑管线
              const cur = runCli(logger, ['status', '--pkg', pkgName])
              const row = cur?.results?.[0]
              if (!row) return sendJson(res, 404, { error: 'patch not found' })
              const st = readState()
              const adapt = { ...(st.adapt || {}) }
              delete adapt[`${pkgName}@${row.installedVersion}`]
              fsSync.writeFileSync(STATE_FILE_PATH, JSON.stringify({ ...st, adapt }, null, 2))
              void adaptPipeline(ctx, logger, [row]).catch(() => {})
              out = { command: 'adapt-retry', name: pkgName, started: true }
            }
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
  const results = applyPatches(logger)
  // 版本失配的补丁：后台 AI 适配（不阻塞启动）
  const aiCfg = readAiAdaptConfig(config)
  if (!aiCfg.enabled) {
    if (results?.some((r) => r.status === 'version-mismatch')) logger.info('AI 适配已在设置中关闭；版本失配的补丁请人工适配')
  } else if (results?.some((r) => r.status === 'version-mismatch' && r.enabled !== false)) {
    void adaptPipeline(ctx, logger, results, aiCfg.route).catch((err) => logger.warn(`AI 适配管线异常: ${err?.message || err}`))
  }

  // UI 通道
  registerApi(ctx, logger)

  // 注意：退出时【不要】revert。冻结快照机制要求补丁在下次进程启动前就在磁盘上；
  // 常驻挂载下，原版由 shadows/orig/ 备份保护，升级器替换软链后启动清理会自动归位。
}
