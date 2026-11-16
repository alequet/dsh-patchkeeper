# dsh-patchkeeper

给 DeepSeek Harness 插件的本地魔改一个家。

你改过某个插件的代码（加模型、修 bug、调行为）？官方一升级，改动就被冲掉；带着改动升级，插件可能加载失败、整个客户端起不来。patchkeeper 用**影子副本常驻挂载**解决这个问题。

## 工作原理

```
补丁库（git 管理）          profile node_modules                数据目录
patches/<pkg>__<ver>.patch  @scope/pkg ──软链──▶ shadows/<pkg>（原版克隆 + 补丁）
                            @scope/pkg 的原版 ──备份──▶ shadows/orig/<pkg>
```

- **常驻挂载**：DSH 启动时用「冻结快照」决定每个包从哪个目录加载，快照早于一切插件代码运行——所以补丁必须在进程启动前就在磁盘上，且**挂载不随退出摘除**
- **启动时**：保底清除（只收拾崩溃残留/升级替换留下的坏挂载，健康挂载原地不动）→ 版本闸（补丁版本 == 插件版本才挂）→ 副本新鲜度校验（补丁文件改过就重建副本）
- **版本不匹配**（插件刚升级）：不挂载，插件以原版启动保证能开机；插件管理页该插件详情页出「补丁未加载」徽章 + 适配卡片
- **升级安全**：pnpm/安装器随时可以换掉软链装新包（实测 pnpm 会保留 link），保底清除识别后丢弃过时备份、基于新版重新评估

## 安装

已发布到 npm：[**@alequet/dsh-patchkeeper**](https://www.npmjs.com/package/@alequet/dsh-patchkeeper)

**方式 A（推荐）**：设置 → 插件 → 添加 → 安装第三方插件，输入：

```
@alequet/dsh-patchkeeper
```

**方式 B（命令行）**：

```bash
dsh plugin --profile desktop add @alequet/dsh-patchkeeper
```

**方式 C（GitHub 源码）**：安装框里输入 `github:alequet/dsh-patchkeeper`

装完重启 DSH 生效。

## 可观测性（不靠「没报错」脑补）

- **🩹 生效标记**：挂载中的插件在插件管理页的列表描述里带「🩹 补丁生效中」；看不到 = 没生效
- **开机 toast**：启动后右上角「N 个补丁生效中 ✓」；异常则常驻红/黄牌
- **补丁管理台**：patchkeeper 自己的详情页——补丁清单、效果说明、版本对照、每补丁启用开关（运行期即时挂载/摘除）、操作结果红绿反馈、失败常驻红字诊断
- **CLI 失明告警**：补丁在库但 patchkeeper 未启用时，`status` 直接吼出来
- **AI 自动适配**：启动时发现插件升级导致补丁失配 → 后台先机械合并（fuzz），冲突文件交 LLM 解冲突 → 成功则补丁自动升级、下次重启挂载；失败则记录原因并**不再自动重试**（管理台可人工重试）

## CLI

```bash
CLI=~/.dsh/profiles/desktop/node_modules/dsh-patchkeeper/bin/cli.mjs

node $CLI list                        # 补丁清单（启用状态/说明/版本/挂载状态）
node $CLI status                      # 状态总览 + 失明告警
node $CLI apply                       # 保底清除 + 挂载版本匹配的副本
node $CLI remount --pkg <包名>        # 改了补丁文件后一键重建副本
node $CLI revert [--pkg <包名>]       # 手动摘除挂载，恢复原版
node $CLI extract --pkg <包名>        # 把当前代码与 npm 原版的差异收成补丁入库
node $CLI enable|disable --pkg <包名> # 单个补丁开关（持久化，随 patches 入 git）
node $CLI note --pkg <包名> <说明>    # 写补丁效果说明
node $CLI risk --pkg <包名> [说明]    # 挂/清禁用风险警告（禁用时弹确认）
node $CLI doctor [--fix]              # 检查/修复插件注册
```

## 调试循环

1. 改挂载中的副本（node_modules 条目就指向它），重启 DSH 验证
2. `extract --pkg <包名>` 从副本提补丁入库（自动剔除生效标记，不污染补丁）
3. 改错了：补丁库是 git 仓库，`git checkout -- patches/` 回滚后 `remount`

## 配置与环境变量

- 补丁库：默认 `~/.dsh/patch-manager`（用 `DSH_PATCHKEEPER_HOME` 覆盖）
- 目标 profile：默认 `desktop`（用 `DSH_PROFILE` 覆盖，接受绝对路径或 profiles/ 下的名字）
- 每补丁的启用/说明/风险：`patches/config.json`（随补丁库入 git）
- AI 适配的模型路由：默认用 profile 的当前默认模型；要指定专用模型，在 profile 的 `cordis.patch.yml` 里给 patchkeeper 条目加配置：

```yaml
- id: patchkeeper
  name: '@alequet/dsh-patchkeeper'
  config:
    adaptModel:
      provider: bailian        # 可选，省略=默认 provider
      model: qwen3.8-max-0902  # 可选，省略=默认模型
```

## 故障排查

- **web boot 崩溃「duplicate factory registration」**：node_modules 里同时存在新旧两个包副本（如改名迁移期），删掉旧副本即可。
- 插件页报错或补丁状态不对：先跑 `node <CLI> doctor --fix` 再重启。

## 发版（维护者）

```bash
npm run release:patch -- "修了什么东西"      # 修 bug
npm run release:minor -- "加了什么功能"      # 新功能
```

脚本会：语法检查三入口 → 把说明写进 CHANGELOG → bump 版本 → commit + tag + 推 GitHub → 提示跑 npm publish。**版本号唯一源头是 package.json**；README 若有旧版本号残留会报警。

## License

MIT
