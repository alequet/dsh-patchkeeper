#!/usr/bin/env node
/**
 * dsh-patchkeeper CLI — 影子副本（shadow mount）架构。
 *
 * 核心思想：永不修改原版插件。
 *   apply  = 复制原版 → 补丁打进副本 → node_modules 条目换名挂载到副本
 *   revert = 摘挂载、销毁副本、原版归位（崩溃没执行也不要紧）
 *   启动时  = 先按 state.json 保底清除上次残留，再做版本匹配挂载
 *
 * 用法:
 *   node cli.mjs extract [--pkg <name>]   从 npm 原版 diff 出补丁，写入 patches/
 *   node cli.mjs apply [--force] [--pkg]  版本匹配则挂载补丁副本
 *   node cli.mjs revert [--pkg]           摘挂载、销毁副本、恢复原版
 *   node cli.mjs status                   只看状态不改文件
 *   node cli.mjs list                     列出补丁清单
 *   node cli.mjs doctor [--fix]           检查/修复插件在 profile 里的注册
 *
 * 通用: --json 输出 JSON；DSH_PROFILE 覆盖 profile 路径。
 */
import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// 代码与数据分离：包可以被升级/重装/公开分发，补丁数据独立于包存在
const TOOL_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const DATA_DIR = process.env.DSH_PATCHKEEPER_HOME || path.join(os.homedir(), '.dsh', 'patch-manager')
const PATCHES_DIR = path.join(DATA_DIR, 'patches')
const BIN_DIR = path.join(PATCHES_DIR, 'bin') // 二进制改动整文件存放
const REJECTS_DIR = path.join(DATA_DIR, 'rejects')
const STATE_FILE = path.join(DATA_DIR, 'state.json')

function resolveProfile() {
  const env = process.env.DSH_PROFILE
  if (!env) return path.join(os.homedir(), '.dsh', 'profiles', 'desktop')
  if (path.isAbsolute(env)) return env
  return path.join(os.homedir(), '.dsh', 'profiles', env)
}
const PROFILE = resolveProfile()
const NM = path.join(PROFILE, 'node_modules')
// 影子副本必须放在 profile 的 node_modules 树内：依赖解析沿目录向上走，能摸到平铺的兄弟依赖
// ≤0.2.0 曾放在 node_modules/.patchkeeper-shadows，被 pnpm reconcile 当游离目录剪掉过（实测）
const LEGACY_SHADOWS = path.join(NM, '.patchkeeper-shadows')
// 副本放数据目录，pnpm 管不着；副本内补 node_modules 软链指回 profile 解决依赖解析
const SHADOWS = path.join(DATA_DIR, 'shadows')
const shadowDir = (slug) => path.join(SHADOWS, slug)
const origDir = (slug) => path.join(SHADOWS, 'orig', slug)

// 挂载时写进副本 package.json 的生效标记（extract 前会摘掉，不污染补丁）
const MOUNT_MARKER = '🩹 补丁生效中（patchkeeper）'

// diff 时排除的东西：运行时缓存、日志、本地备份等
const EXCLUDES = [
  'node_modules', '.git', '.svn', '.DS_Store', 'Thumbs.db',
  '*.log', 'logs', 'tmp', '.cache', 'Cache', '__pycache__',
  '.pnpm-store', '*.tsbuildinfo', '*.rej', '*.orig', '*.bak', '*.bak-*', 'pnpm-lock.yaml',
]

// 不进补丁管理的包（我们自己 / 本地包）
const SKIP_PKGS = new Set(['dsh-patchkeeper'])

// ---------- 小工具 ----------

const slugOf = (name) => name.replace('/', '+') // @scope/name -> @scope+name
const nameOf = (slug) => (slug.startsWith('@') ? slug.replace('+', '/') : slug)

function parsePatchFile(file) {
  const m = /^(?<slug>.+)__(?<version>.+)\.patch$/.exec(file)
  if (!m) return null
  return { file, slug: m.groups.slug, name: nameOf(m.groups.slug), version: m.groups.version }
}

function listPatchFiles() {
  if (!fs.existsSync(PATCHES_DIR)) return []
  return fs.readdirSync(PATCHES_DIR).map(parsePatchFile).filter(Boolean)
}

function readJson(p) {
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

function readState() {
  try {
    return readJson(STATE_FILE)
  } catch {
    return {}
  }
}

function writeState(patch) {
  const state = { ...readState(), ...patch }
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2))
}

// 已装版本一律读 node_modules 条目本身：挂载时软链指向副本（版本与原版一致），
// 未挂载时就是真实安装；orig 备份可能是过时的，不看它。
function installedVersion(name) {
  try {
    return readJson(path.join(NM, name, 'package.json')).version || null
  } catch {
    return null
  }
}

// 当前是否挂载着影子副本（node_modules 条目是指向我们副本的软链）
function isMounted(name, slug) {
  const entry = path.join(NM, name)
  try {
    const lst = fs.lstatSync(entry)
    if (!lst.isSymbolicLink()) return false
    return fs.realpathSync(entry) === fs.realpathSync(shadowDir(slug))
  } catch {
    return false
  }
}

function run(cmd, args, opts = {}) {
  return spawnSync(cmd, args, { encoding: 'utf8', maxBuffer: 512 * 1024 * 1024, ...opts })
}

// patch 检测：返回 'not-applied' | 'applied' | 'conflict'
function probePatch(dir, patchFile) {
  const base = ['--dry-run', '-p1', '-N', '-E', '-d', dir, '-i', patchFile]
  const fwd = run('patch', base)
  if (fwd.status === 0) return 'not-applied'
  const rev = run('patch', [...base, '-R'])
  if (rev.status === 0) return 'applied'
  return 'conflict'
}

function binFilesOf(slug) {
  const binBase = path.join(BIN_DIR, slug)
  if (!fs.existsSync(binBase)) return { binBase, files: [] }
  return {
    binBase,
    files: fs.readdirSync(binBase, { recursive: true }).filter((f) => fs.statSync(path.join(binBase, f)).isFile()),
  }
}

// ---------- 保底清除（每次启动 apply 前必跑） ----------

// 把挂载状态恢复成原版归位、副本销毁。崩溃残留、孤儿副本都在这里清。
function ensureCleanMount({ only } = {}) {
  const repaired = []
  cleanLegacyMounts()
  const state = readState()
  const swaps = state.swaps || {}
  for (const [name, info] of Object.entries(swaps)) {
    if (only && name !== only) continue
    const p = { name, slug: slugOf(name) }
    if (dismount(p)) repaired.push(name)
  }
  // 孤儿副本清扫：state 里没登记但 shadows 里躺着的（比如 state.json 丢了）
  if (fs.existsSync(SHADOWS)) {
    for (const dirent of fs.readdirSync(SHADOWS, { withFileTypes: true })) {
      if (dirent.name === 'orig') continue
      const name = nameOf(dirent.name)
      if (swaps[name]) continue
      // 没登记的副本：如果 orig/ 里有对应原版且 node_modules 条目还指过来，也一并恢复
      const p = { name, slug: dirent.name }
      if (isMounted(name, dirent.name)) dismount(p)
      else fs.rmSync(shadowDir(dirent.name), { recursive: true, force: true })
    }
  }
  return repaired
}

// 旧版（≤0.2.0）挂载遗址清理：条目是指向 node_modules/.patchkeeper-shadows 的软链，
// 原版备份在其 orig/ 下。恢复原位后整个旧目录删除。
function cleanLegacyMounts() {
  if (!fs.existsSync(LEGACY_SHADOWS)) return
  for (const dirent of fs.readdirSync(LEGACY_SHADOWS, { withFileTypes: true })) {
    if (dirent.name === 'orig') continue
    const slug = dirent.name
    const name = nameOf(slug)
    const entry = path.join(NM, name)
    try {
      if (fs.lstatSync(entry).isSymbolicLink() && fs.realpathSync(entry) === fs.realpathSync(path.join(LEGACY_SHADOWS, slug))) {
        fs.rmSync(entry, { force: true })
      }
    } catch {}
    const legacyOrig = path.join(LEGACY_SHADOWS, 'orig', slug)
    if (fs.existsSync(legacyOrig) && !fs.existsSync(entry) && profileLists(name)) {
      fs.mkdirSync(path.dirname(entry), { recursive: true })
      fs.renameSync(legacyOrig, entry)
    }
  }
  fs.rmSync(LEGACY_SHADOWS, { recursive: true, force: true })
}

// 插件是否仍在 profile 依赖清单里（不在 = 用户已卸载，原版备份不能复活它）
function profileLists(name) {
  try {
    const pkg = readJson(path.join(PROFILE, 'package.json'))
    return Object.hasOwn(pkg.dependencies ?? {}, name)
  } catch {
    return true // 读不到清单时保守处理：恢复原版
  }
}

// ---------- 补丁配置（启用开关 + 效果说明，随 patches/ 入 git） ----------

const CONFIG_FILE = path.join(PATCHES_DIR, 'config.json')

function readConfig() {
  try {
    return readJson(CONFIG_FILE)
  } catch {
    return {}
  }
}

function writeConfig(cfg) {
  fs.mkdirSync(PATCHES_DIR, { recursive: true })
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(cfg, null, 2) + '\n')
}

const isEnabled = (name) => readConfig()[name]?.enabled !== false

// 从补丁文件解析被覆盖的文件清单（供 UI 展示）
function patchFileList(p) {
  const files = []
  const patchPath = path.join(PATCHES_DIR, p.file)
  if (fs.existsSync(patchPath)) {
    const text = fs.readFileSync(patchPath, 'utf8')
    for (const m of text.matchAll(/^diff -ruN a\/(?<f>.+?) b\/.+$/gm)) files.push(m.groups.f)
  }
  files.push(...binFilesOf(p.slug).files.map((f) => f + ' (binary)'))
  return files
}

// 摘一个挂载：删我们的软链 → 原版归位 → 销毁副本。返回是否有实际清理动作。
// 竞态防护：若条目已被外部（升级器）换成新安装，原版备份已过时——丢弃备份，保留新装。
function dismount(p) {
  const entry = path.join(NM, p.name)
  const shadow = shadowDir(p.slug)
  const orig = origDir(p.slug)
  const hadWork = isMounted(p.name, p.slug) || fs.existsSync(orig) || fs.existsSync(shadow)
  if (isMounted(p.name, p.slug)) fs.rmSync(entry, { force: true })
  if (fs.existsSync(orig)) {
    if (!fs.existsSync(entry) && profileLists(p.name)) {
      fs.mkdirSync(path.dirname(entry), { recursive: true })
      fs.renameSync(orig, entry) // 同分区 rename，原子
    } else {
      // 条目已被在线更新替换成新版，或插件已被卸载：备份已过时，丢弃不复活
      fs.rmSync(orig, { recursive: true, force: true })
    }
  }
  fs.rmSync(shadow, { recursive: true, force: true })
  // 顺手清掉空壳目录（orig/ 与 shadows 本身，空了才删得掉）
  try { fs.rmdirSync(path.join(SHADOWS, 'orig')) } catch {}
  try { fs.rmdirSync(SHADOWS) } catch {}
  const state = readState()
  if (state.swaps && state.swaps[p.name]) {
    delete state.swaps[p.name]
    writeState({ swaps: state.swaps })
  }
  return hadWork
}

// ---------- extract ----------

function extractOne(name, spec, { log }) {
  const result = { name, ok: false }
  const slug = slugOf(name)
  const mounted = isMounted(name, slug)
  // 挂载中：entry 软链指向副本——从副本提补丁，这正是「在副本上实验 → 入库」的调试循环
  const dir = path.join(NM, name)
  if (!fs.existsSync(dir)) {
    result.error = 'not-installed'
    return result
  }
  if (/^file:|^link:/.test(spec)) {
    result.error = 'local-package-skipped'
    return result
  }
  const version = installedVersion(name)
  result.version = version

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'patchkeeper-'))
  let markedDesc = null // 生效标记的原文（finally 里恢复）
  const entryPkg = path.join(dir, 'package.json') // 提升作用域：finally 要用
  try {
    const packSpec = /^https?:/.test(spec) ? spec : `${name}@${version}`
    const pack = run('npm', ['pack', packSpec, '--pack-destination', tmp, '--silent'], { cwd: tmp })
    if (pack.status !== 0) {
      result.error = `npm pack failed: ${(pack.stderr || '').slice(0, 300)}`
      return result
    }
    const tarball = (pack.stdout || '').trim().split('\n').pop().trim()
    const aDir = path.join(tmp, 'a')
    fs.mkdirSync(aDir)
    const untar = run('tar', ['-xzf', path.join(tmp, tarball), '-C', aDir, '--strip-components=1'])
    if (untar.status !== 0) {
      result.error = `tar failed: ${(untar.stderr || '').slice(0, 300)}`
      return result
    }
    // 副本 package.json 上的生效标记不属于用户改动：临时摘掉，diff 完恢复
    try {
      const epkg = readJson(entryPkg)
      if (String(epkg.description || '').includes(MOUNT_MARKER)) {
        markedDesc = epkg.description
        epkg.description = markedDesc.replace(MOUNT_MARKER, '').trim()
        fs.writeFileSync(entryPkg, JSON.stringify(epkg, null, 2) + '\n')
      }
    } catch {}
    fs.symlinkSync(dir, path.join(tmp, 'b'))
    const exclFile = path.join(tmp, 'excludes.txt')
    fs.writeFileSync(exclFile, EXCLUDES.join('\n') + '\n')

    const diff = run('diff', ['-ruN', '-X', exclFile, 'a', 'b'], { cwd: tmp })
    if (diff.status === 0) {
      result.ok = true
      result.changed = []
      return result // 与原版一致，无补丁
    }
    if (diff.status !== 1) {
      result.error = `diff error: ${(diff.stderr || '').slice(0, 300)}`
      return result
    }

    // 摘出二进制差异：整文件另存，不进文本补丁
    const binFiles = []
    const keptLines = []
    for (const line of diff.stdout.match(/.*(\n|$)/g).filter((l) => l.length)) {
      const bm = /^Binary files a\/(?<p>.+) and b\/.+ differ$/.exec(line)
      if (bm) {
        binFiles.push(bm.groups.p)
        continue
      }
      keptLines.push(line)
    }
    if (binFiles.length) {
      const destBase = path.join(BIN_DIR, slug)
      fs.mkdirSync(destBase, { recursive: true })
      for (const rel of binFiles) {
        const dest = path.join(destBase, rel)
        fs.mkdirSync(path.dirname(dest), { recursive: true })
        fs.copyFileSync(path.join(dir, rel), dest)
      }
    } else {
      fs.rmSync(path.join(BIN_DIR, slug), { recursive: true, force: true })
    }

    // diff 头部会带上 -X 参数与临时路径，统一规范化成 `diff -ruN a/x b/x`
    const body = keptLines.join('').replace(/^diff -ruN.*? (?=a\/)/gm, 'diff -ruN ')
    const changed = [...body.matchAll(/^diff -ruN a\/(?<p>.+?) b\/.+$/gm)].map((m) => m.groups.p)
    result.changed = [...changed, ...binFiles.map((p) => p + ' (binary)')]

    fs.mkdirSync(PATCHES_DIR, { recursive: true })
    const target = path.join(PATCHES_DIR, `${slug}__${version}.patch`)
    if (body.trim()) {
      const header =
        `# dsh-patchkeeper patch\n` +
        `# package: ${name}\n# version: ${version}\n` +
        `# extracted: ${new Date().toISOString()}\n`
      fs.writeFileSync(target, header + body)
    } else {
      fs.rmSync(target, { force: true })
    }
    // 清掉同包旧版本补丁
    for (const p of listPatchFiles()) {
      if (p.slug === slug && p.version !== version) {
        fs.rmSync(path.join(PATCHES_DIR, p.file), { force: true })
        log?.(`  清理旧版本补丁: ${p.file}`)
      }
    }
    // 未挂载时有人直接改了原版：改动已收进补丁，顺手把原版恢复纯净（保住「原版永远干净」）
    if (!mounted && result.changed?.length) {
      let restored = 0
      for (const rawRel of result.changed) {
        const rel = rawRel.replace(/ \(binary\)$/, '')
        const pristine = path.join(aDir, rel)
        const target = path.join(dir, rel)
        if (fs.existsSync(pristine)) fs.copyFileSync(pristine, target)
        else fs.rmSync(target, { force: true }) // pristine 没有 = 新增文件，从原版删掉
        restored++
      }
      if (restored) log?.(`  已把原版恢复纯净（${restored} 个文件的改动已在补丁里）`)
    }
    result.ok = true
    return result
  } finally {
    // 恢复生效标记（finally 兜住所有提前 return 路径）
    if (markedDesc !== null) {
      try {
        const epkg = readJson(entryPkg)
        epkg.description = markedDesc
        fs.writeFileSync(entryPkg, JSON.stringify(epkg, null, 2) + '\n')
      } catch {}
    }
    fs.rmSync(tmp, { recursive: true, force: true })
  }
}

function cmdExtract({ only, log }) {
  const pkgFile = readJson(path.join(PROFILE, 'package.json'))
  const deps = Object.entries(pkgFile.dependencies || {})
  const results = []
  for (const [name, spec] of deps) {
    if (SKIP_PKGS.has(name)) continue
    if (only && name !== only) continue
    log?.(`diff ${name} …`)
    const r = extractOne(name, spec, { log })
    if (r.error) log?.(`  ✗ ${r.error}`)
    else if (r.changed?.length) log?.(`  ✓ ${r.changed.length} 个文件有改动`)
    else log?.(`  - 与原版一致`)
    results.push(r)
  }
  return { command: 'extract', results }
}

// ---------- apply / revert / status（影子副本） ----------

// 把补丁打进指定目录（shadow 副本），失败返回 false
function patchInto(dir, p) {
  const patchPath = path.join(PATCHES_DIR, p.file)
  const hasTextPatch = fs.existsSync(patchPath)
  const { binBase, files: binFiles } = binFilesOf(p.slug)
  if (hasTextPatch) {
    fs.mkdirSync(REJECTS_DIR, { recursive: true })
    const rej = path.join(REJECTS_DIR, `${p.slug}.rej`)
    fs.rmSync(rej, { force: true })
    const ap = run('patch', ['-p1', '-N', '-E', '-f', '-d', dir, '-i', patchPath, '-r', rej])
    if (ap.status !== 0) return false
    if (probePatch(dir, patchPath) !== 'applied') return false
  }
  for (const rel of binFiles) {
    const dest = path.join(dir, rel)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    fs.copyFileSync(path.join(binBase, rel), dest)
    if (!fs.readFileSync(dest).equals(fs.readFileSync(path.join(binBase, rel)))) return false
  }
  return hasTextPatch || binFiles.length > 0
}

function mount(p) {
  const entry = path.join(NM, p.name)
  const shadow = shadowDir(p.slug)
  const orig = origDir(p.slug)
  fs.rmSync(shadow, { recursive: true, force: true })
  fs.mkdirSync(SHADOWS, { recursive: true })
  // 克隆原版（APFS clonefile，近乎零成本；失败退回普通复制）
  let cp = run('cp', ['-Rc', entry + '/', shadow])
  if (cp.status !== 0) cp = run('cp', ['-R', entry + '/', shadow])
  if (cp.status !== 0) {
    fs.rmSync(shadow, { recursive: true, force: true })
    return { ok: false, error: `copy failed: ${(cp.stderr || '').slice(0, 200)}` }
  }
  // 副本在 profile 树外：补 node_modules 软链指回 profile，平铺依赖沿此可达
  const shadowNm = path.join(shadow, 'node_modules')
  if (!fs.existsSync(shadowNm)) fs.symlinkSync(NM, shadowNm)
  if (!patchInto(shadow, p)) {
    fs.rmSync(shadow, { recursive: true, force: true })
    return { ok: false, error: 'patch failed on shadow' }
  }
  // 正向确认标记：挂载期间插件管理页的描述里可见「🩹 补丁生效中」；看不到 = 补丁没生效
  try {
    const sp = path.join(shadow, 'package.json')
    const spkg = readJson(sp)
    if (!String(spkg.description || '').includes(MOUNT_MARKER)) {
      spkg.description = `${spkg.description || ''} ${MOUNT_MARKER}`.trim()
      fs.writeFileSync(sp, JSON.stringify(spkg, null, 2) + '\n')
    }
  } catch {}
  // 换挂载：原版挪进 orig/，条目换成指向副本的软链
  fs.mkdirSync(path.dirname(orig), { recursive: true })
  fs.rmSync(orig, { recursive: true, force: true })
  fs.renameSync(entry, orig)
  fs.symlinkSync(shadow, entry)
  const state = readState()
  writeState({ swaps: { ...(state.swaps || {}), [p.name]: { shadow, orig, at: new Date().toISOString() } } })
  return { ok: true }
}

function applyOne(p, { dryRun, force }) {
  const r = { name: p.name, patchVersion: p.version }
  const entry = path.join(NM, p.name)
  if (!fs.existsSync(entry) && !fs.existsSync(origDir(p.slug))) {
    r.status = 'missing-target'
    return r
  }
  r.enabled = isEnabled(p.name)
  r.mounted = isMounted(p.name, p.slug)
  r.installedVersion = installedVersion(p.name)
  r.versionMatch = r.installedVersion === p.version
  if (!r.enabled) {
    if (r.mounted && !dryRun) dismount(p) // 禁用 = 恢复原插件 + 清副本
    r.mounted = false
    r.status = 'disabled'
    return r
  }
  if (r.versionMatch === false && !force) {
    // 版本不匹配：确保没挂着旧副本（保底清除已处理，这里只是保险）
    if (r.mounted && !dryRun) dismount(p)
    r.mounted = false
    r.status = 'version-mismatch'
    return r
  }
  if (r.mounted && !(force && !dryRun)) {
    r.status = 'applied'
    return r
  }
  if (dryRun) {
    r.status = 'not-applied'
    return r
  }
  // force 时即使已挂载也重建副本（补丁文件可能刚被编辑过）
  if (r.mounted) dismount(p)
  const m = mount(p)
  if (!m.ok) {
    r.status = 'apply-failed'
    r.error = m.error
    return r
  }
  r.mounted = true
  r.status = 'applied-now'
  return r
}

function revertOne(p) {
  const r = { name: p.name, patchVersion: p.version }
  r.installedVersion = installedVersion(p.name)
  r.status = dismount(p) ? 'reverted' : 'not-applied'
  return r
}

function collectStatus({ dryRun, force, only }) {
  const results = listPatchFiles()
    .filter((p) => !only || p.name === only)
    .map((p) => applyOne(p, { dryRun, force }))
  const out = { command: dryRun ? 'status' : 'apply', profile: PROFILE, results }
  // 失明检测：看门狗自己没上岗时，status 必须大声说出来（今天的教训）
  if (results.length) {
    const pkg = readJson(path.join(PROFILE, 'package.json'))
    const enabled = (pkg.dsh?.profile?.bundles || []).includes('dsh-patchkeeper')
    const noneMounted = results.every((r) => !r.mounted)
    if (!enabled) {
      out.alarm = '🚨 patchkeeper 未启用（不在 bundles 列表）：所有补丁正在静默失效！运行 doctor --fix 并重启 DSH'
    } else if (dryRun && noneMounted && results.some((r) => r.versionMatch)) {
      out.alarm = '🚨 有匹配补丁但一个都没挂载——若已重启过 DSH，patchkeeper 可能加载失败，请查日志'
    }
  }
  return out
}

function cmdRevert({ only } = {}) {
  const results = listPatchFiles()
    .filter((p) => !only || p.name === only)
    .map(revertOne)
  return { command: 'revert', profile: PROFILE, results }
}

// ---------- doctor ----------

function cmdDoctor({ fix, log }) {
  const issues = []
  const linkPath = path.join(NM, 'dsh-patchkeeper')
  const pkgFile = path.join(PROFILE, 'package.json')
  const pkg = readJson(pkgFile)

  if (!fs.existsSync(linkPath)) {
    issues.push('node_modules/dsh-patchkeeper 缺失——请通过插件管理页（安装第三方插件）重新安装')
  }
  if (!pkg.dependencies?.['dsh-patchkeeper']) {
    issues.push('profile package.json 缺少 dsh-patchkeeper 依赖——请通过插件管理页安装')
  }
  const bundles = pkg.dsh?.profile?.bundles || []
  if (!bundles.includes('dsh-patchkeeper')) {
    issues.push('profile bundles 列表缺少 dsh-patchkeeper')
    if (fix) {
      pkg.dsh.profile.bundles = ['dsh-patchkeeper', ...bundles]
      fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')
      log?.('已把 dsh-patchkeeper 加回 bundles 首位')
    }
  }
  return { command: 'doctor', fixed: !!fix, issues }
}

// ---------- 入口 ----------

const args = process.argv.slice(2)
const command = args.find((a) => !a.startsWith('-')) || 'help'
const flags = {
  json: args.includes('--json'),
  dryRun: args.includes('--dry-run'),
  fix: args.includes('--fix'),
  force: args.includes('--force'),
  only: args.includes('--pkg') ? args[args.indexOf('--pkg') + 1] : null,
}
const log = flags.json ? null : (s) => console.log(s)

let out
switch (command) {
  case 'extract': out = cmdExtract({ only: flags.only, log }); break
  case 'apply': {
    const repaired = ensureCleanMount({ only: flags.only }) // 启动保底清除
    out = collectStatus({ dryRun: false, force: flags.force, only: flags.only })
    if (repaired.length) out.repaired = repaired
    break
  }
  case 'revert': out = cmdRevert({ only: flags.only }); break
  case 'remount': {
    // 调试循环快捷键：摘旧副本 → 按当前补丁重建并挂载
    cmdRevert({ only: flags.only })
    out = collectStatus({ dryRun: false, force: true, only: flags.only })
    break
  }
  case 'status': out = collectStatus({ dryRun: true, force: flags.force, only: flags.only }); break
  case 'list': {
    const cfg = readConfig()
    const lastApply = readState().lastApply || []
    out = {
      command: 'list',
      patches: listPatchFiles().map((p) => {
        const probe = applyOne(p, { dryRun: true })
        const last = lastApply.find((r) => r.name === p.name)
        return {
          name: p.name,
          version: p.version,
          enabled: cfg[p.name]?.enabled !== false,
          note: cfg[p.name]?.note || '',
          files: patchFileList(p),
          installedVersion: probe.installedVersion,
          status: probe.status,
          mounted: !!probe.mounted,
          // 上次真实挂载留下的错误（probe 是 dry-run，探不到这些）
          lastError: (lastApply && ['apply-failed', 'conflict'].includes(lastApply.status) && (lastApply.error || lastApply.status)) || null,
        }
      }),
    }
    if (out.patches.length) {
      const pkgj = readJson(path.join(PROFILE, 'package.json'))
      if (!(pkgj.dsh?.profile?.bundles || []).includes('dsh-patchkeeper')) {
        out.alarm = '🚨 patchkeeper 未启用（不在 bundles 列表）：所有补丁正在静默失效！运行 doctor --fix 并重启 DSH'
      } else if (out.patches.every((r) => !r.mounted) && out.patches.some((r) => r.enabled !== false && r.installedVersion === r.version)) {
        out.alarm = '🚨 有匹配补丁但一个都没挂载——若已重启过 DSH，patchkeeper 可能加载失败，请查日志'
      }
    }
    break
  }
  case 'enable':
  case 'disable': {
    const target = flags.only
    if (!target) {
      console.error('用法: ' + command + ' --pkg <包名>')
      process.exit(1)
    }
    const cfg = readConfig()
    cfg[target] = { ...(cfg[target] || {}), enabled: command === 'enable' }
    writeConfig(cfg)
    out = collectStatus({ dryRun: false, force: flags.force, only: target })
    break
  }
  case 'note': {
    const rest = []
    for (let i = args.indexOf('note') + 1; i < args.length; i++) {
      if (args[i] === '--pkg') { i++; continue } // 跳过 --pkg 及其值
      if (!args[i].startsWith('-')) rest.push(args[i])
    }
    const noteText = rest.join(' ')
    if (!flags.only || !noteText) {
      console.error('用法: note --pkg <包名> <效果说明>')
      process.exit(1)
    }
    const cfg = readConfig()
    cfg[flags.only] = { ...(cfg[flags.only] || {}), note: noteText }
    writeConfig(cfg)
    out = { command: 'note', name: flags.only, note: noteText }
    break
  }
  case 'doctor': out = cmdDoctor({ fix: flags.fix, log }); break
  default:
    console.log('用法: extract | apply [--force] | remount | revert | status | list | doctor [--fix] [--json] [--pkg <name>]')
    process.exit(command === 'help' ? 0 : 1)
}

if (command === 'apply' || command === 'remount') {
  writeState({ ts: new Date().toISOString(), lastApply: out.results })
}

if (flags.json) {
  console.log(JSON.stringify(out, null, 2))
} else if (command === 'apply' || command === 'status' || command === 'revert' || command === 'remount') {
  const icon = {
    'applied-now': '✓ 已挂载副本', applied: '· 副本已挂载', 'not-applied': '○ 未挂载',
    conflict: '✗ 冲突', 'missing-target': '✗ 目标缺失', 'apply-failed': '✗ 挂载失败',
    empty: '- 空补丁', 'version-mismatch': '⊘ 版本不匹配，已跳过', disabled: '⏸ 已禁用',
    reverted: '✓ 已恢复原版', 'revert-failed': '✗ 恢复失败',
  }
  if (out.alarm) console.log(`\n${out.alarm}\n`)
  for (const r of out.results) {
    const vm = r.versionMatch === false ? ` (补丁 ${r.patchVersion} ≠ 已装 ${r.installedVersion})` : ''
    console.log(`${icon[r.status] || r.status}  ${r.name}${vm}`)
  }
  const skipped = out.results.filter((r) => r.status === 'version-mismatch')
  if (skipped.length && command !== 'revert') {
    console.log(`\n${skipped.length} 个补丁因版本不匹配被跳过（适配后用 extract 重建；硬打可用 apply --force）`)
  }
  const bad = out.results.filter((r) => ['conflict', 'missing-target', 'apply-failed', 'revert-failed'].includes(r.status))
  if (bad.length) {
    console.log(`\n${bad.length} 个补丁需要人工处理，reject 文件见 ${REJECTS_DIR}`)
    process.exitCode = 2
  }
} else if (command === 'list') {
  for (const p of out.patches) {
    const flag = p.enabled ? (p.mounted ? '✓ 挂载中' : '○ 未挂载') : '⏸ 已禁用'
    console.log(`${flag}  ${p.name}@${p.version}${p.note ? '  —— ' + p.note : ''}`)
  }
  if (!out.patches.length) console.log('(还没有补丁，先跑 extract)')
} else if (command === 'doctor') {
  if (!out.issues.length) console.log('注册状态正常 ✓')
  else for (const i of out.issues) console.log((out.fixed ? '已修复: ' : '问题: ') + i)
}
