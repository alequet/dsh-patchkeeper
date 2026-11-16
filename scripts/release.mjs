#!/usr/bin/env node
/**
 * 发版闸门： bump 版本 → 更新 CHANGELOG → 语法检查 → commit + tag + push
 *
 * 用法: node scripts/release.mjs <patch|minor|major> "变更说明1；变更说明2"
 * 说明用中文分号或英文分号分隔多条。
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const [bump, ...rest] = process.argv.slice(2)
const notes = rest.join(' ').split(/[；;]/).map((s) => s.trim()).filter(Boolean)

if (!['patch', 'minor', 'major'].includes(bump) || !notes.length) {
  console.error('用法: node scripts/release.mjs <patch|minor|major> "改了什么1；改了什么2"')
  process.exit(1)
}

const pkgFile = path.join(ROOT, 'package.json')
const pkg = JSON.parse(fs.readFileSync(pkgFile, 'utf8'))
const [major, minor, patch] = pkg.version.split('.').map(Number)
const next = bump === 'major' ? `${major + 1}.0.0` : bump === 'minor' ? `${major}.${minor + 1}.0` : `${major}.${minor}.${patch + 1}`

// 闸门 1：工作区可以有改动（它们就是本次发布内容），但三个入口文件必须过语法检查
for (const f of ['index.js', 'client.js', 'bin/cli.mjs']) {
  execFileSync(process.execPath, ['--check', path.join(ROOT, f)], { stdio: 'inherit' })
}

// 闸门 2：CHANGELOG 不能跳过——每次发版必须写清改了什么
const changelogFile = path.join(ROOT, 'CHANGELOG.md')
const today = new Date().toISOString().slice(0, 10)
const entry = `## [${next}] - ${today}\n### Changed\n${notes.map((n) => `- ${n}`).join('\n')}\n\n`
const old = fs.readFileSync(changelogFile, 'utf8')
fs.writeFileSync(changelogFile, old.replace('## [', entry + '## ['))

pkg.version = next
fs.writeFileSync(pkgFile, JSON.stringify(pkg, null, 2) + '\n')

// 闸门 3：README 同步检查——若 README 里有旧版本号的安装示例就报警
const readme = fs.readFileSync(path.join(ROOT, 'README.md'), 'utf8')
const stale = readme.match(/\d+\.\d+\.\d+/g)?.filter((v) => v !== next) || []
if (stale.length) console.warn(`⚠ README 里有旧版本号残留: ${[...new Set(stale)].join(', ')}——请确认是否需要刷新`)

execFileSync('git', ['add', '-A'], { cwd: ROOT })
execFileSync('git', ['-c', 'user.name=alequet', '-c', 'user.email=alequet@users.noreply.github.com', 'commit', '-qm', `release: v${next}\n\n${notes.map((n) => `- ${n}`).join('\n')}`], { cwd: ROOT })
execFileSync('git', ['tag', `v${next}`], { cwd: ROOT })
execFileSync('git', ['push', '-q'], { cwd: ROOT })
execFileSync('git', ['push', '-q', '--tags'], { cwd: ROOT })

console.log(`✓ v${next} 已提交并推送 GitHub（tag v${next}）`)
console.log(`下一步：npm publish --access=public --auth-type=web`)
