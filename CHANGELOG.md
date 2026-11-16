# Changelog

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/)，版本号遵循 [SemVer](https://semver.org/lang/zh-CN/)。

## [0.7.1] - 2026-11-16
### Changed
- 新增 CHANGELOG（补录 0.1.0-0.7.0 全史）与 release 发版脚本：语法闸门、CHANGELOG 强制、git tag、README 版本残留报警

## [0.7.0] - 2026-11-16
### Added
- 管理台新增「AI 自动适配」设置区：总开关（关闭则失配不跑 AI、零 token 消耗）+ provider/model 路由输入

## [0.6.3] - 2026-11-16
### Added
- AI 适配模型路由可配置（cordis 配置 `adaptModel`）

## [0.6.2] - 2026-11-16
### Fixed
- client 注册防撞守卫：重复注册只警告不崩 web boot

## [0.6.1] - 2026-11-16
### Fixed
- client 模块 id 改为包全名，防改名迁移期双副本撞 id

## [0.6.0] - 2026-11-16
### Added
- AI 自动适配：版本失配时后台机械合并（fuzz）→ 冲突交 LLM → 成功则补丁自动升级、下次重启挂载；失败记录且不再自动重试，管理台可人工重试
### Fixed
- 适配同版本时误删补丁文件的自删 bug

## [0.5.2] - 2026-11-16
### Added
- 挂载变更后尝试借 HMR 即时生效（pluginPackages.refresh + hmr.reconcileProfile），失败优雅退回重启提示

## [0.5.1] - 2026-11-16
### Fixed
- 保底清除不再拆装健康挂载（避开冻结快照窗口）；新增副本新鲜度校验
### Changed
- README 全面重写

## [0.5.0] - 2026-11-16
### Changed
- 架构改为常驻挂载：废除退出回退（与冻结快照机制冲突）
- UI 区分「本轮生效」与「重启后生效」

## [0.4.1] - 2026-11-15
### Added
- 补丁级禁用风险警告（risk 字段 + 禁用确认弹窗）

## [0.4.0] - 2026-11-15
### Added
- 补丁管理台：详情页清单/效果说明/启用开关、运行期挂载变更、红字反馈与常驻维测

## [0.3.0] - 2026-11-15
### Added
- 正向确认：副本描述带「🩹 补丁生效中」标记；开机 toast；status 失明告警

## [0.2.1] - 2026-11-15
### Fixed
- 在线更新加固：副本/备份迁出 node_modules 防 pnpm 剪枝、版本读条目本身、卸载防复活、旧版挂载自动迁移

## [0.2.0] - 2026-11-14
### Changed
- 影子副本架构上线；代码/数据分离；正式发布 GitHub + 官方注册

## [0.1.0] - 2026-11-14
### Added
- 首版：补丁提取（npm 原版 diff）、apply/revert/status、事务式安全、版本闸
