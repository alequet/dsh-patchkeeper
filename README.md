# dsh-patchkeeper

给 DeepSeek Harness 插件的本地魔改一个家。

你改过某个插件的代码（加模型、修 bug、调行为）？官方一升级，改动就被冲掉；带着改动升级，插件可能加载失败、整个客户端起不来。patchkeeper 用**影子副本挂载**解决这个问题：

- **原版插件永远干净**：补丁打在用后即焚的克隆副本上（APFS clonefile 秒级），node_modules 条目只是指向副本的软链
- **启动时**：保底清除上次残留 → 版本匹配检查 → 匹配才把补丁打进副本并挂载，本轮即生效
- **版本不匹配**（插件刚升级）：跳过不打，插件以原版启动保证能开机；插件管理页详情页出现「补丁未加载」提示卡 + 适配按钮
- **退出时**：摘除挂载、销毁副本、原版归位；崩溃没执行到也不要紧，下次启动自动收拾
- **补丁即资产**：`patches/*.patch` 存在独立数据目录（默认 `~/.dsh/patch-manager`），建议 git 管理

## 安装

设置 → 插件 → 添加 → 安装第三方插件，输入：

```
github:alequet/dsh-patchkeeper
```

重启后生效。

## 使用

```bash
CLI=~/.dsh/profiles/desktop/node_modules/dsh-patchkeeper/bin/cli.mjs

node $CLI status                     # 补丁状态总览
node $CLI extract --pkg <包名>       # 把对某插件的改动收成补丁入库
node $CLI apply                      # 保底清除 + 挂载版本匹配的副本
node $CLI remount --pkg <包名>       # 改了补丁文件后一键重建副本
node $CLI revert                     # 摘除全部挂载，恢复原版
```

### 调试循环

1. 改挂载中的副本（node_modules 条目就指向它），重启验证
2. `extract --pkg <包名>` 从副本提补丁入库
3. 改错了：`git checkout -- patches/` 回滚补丁，再 `remount`

数据目录可用 `DSH_PATCHKEEPER_HOME` 环境变量覆盖；管理的 profile 用 `DSH_PROFILE` 覆盖（默认 desktop）。

## 与「在线更新」共处（不重启客户端更新插件时）

- 副本与原版备份都在 profile 的 node_modules **之外**（数据目录 `shadows/`），pnpm 的在线安装/ reconcile 剪枝碰不到它们。
- 插件被在线更新：条目被换成新版干净目录，下次启动按版本闸处理（匹配就重打，不匹配就跳过+管理页提示卡）。
- 运行中用 CLI 手动 remount/revert 会让运行中进程缓存的解析路径失效，之后若再做在线插件操作可能报 stale 路径错误——**重启即愈**，不是数据损坏。
- 在线更新后补丁功能要重启 DSH 才恢复（运行中的进程已加载旧代码，换磁盘文件不影响内存）。
- patchkeeper 自身的更新：管理页对 git 源插件不显示更新按钮时，用同样的 git 地址重新「安装」一次即可。

## License

MIT
