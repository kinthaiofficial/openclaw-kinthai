# 方案：openclaw-kinthai 兼容 OpenClaw 2026.6.9 插件契约

> 来源反馈：`kinthai-prod feedback/2026-06-22.md`
> 现象：6.9 gateway 加载 3.0.16 时报
> `plugin must declare contracts.tools before registering agent tools (plugin=kinthai)`
> 结果：kinthai 注册给 agent 的工具被运行时**全部拒绝**，agent 拿不到文件/markdown widget 等工具。

## 1. 根因（已对 6.9 源码逐行确认）

6.9 把"插件工具所有权"做成了**静态契约**，分两道闸校验（均在 `openclaw@2026.6.9` 内）：

| 闸 | 位置 | 行为 |
|----|------|------|
| 闸 A：注册时 | `dist/registry-DibRJtL4.js:3070` `registerTool()` | `contracts.tools` 为空 → 整个 `registerTool` 工厂被拒，报 "must declare contracts.tools before registering agent tools"，**该插件所有 agent 工具消失** |
| 闸 B：工厂解析时 | `dist/tools-DKcsOD7f.js:888` | 工厂运行时返回的每个工具，名字必须出现在 `contracts.tools`，否则**单独丢弃**该工具并报 "plugin tool is undeclared" |

我们的插件 `src/tools/dynamic-registry.js:253` 调用的是 **无 opts 的工厂式** `pluginApi.registerTool((ctx)=>[...])`，
manifest 里又没有 `contracts`，所以**当场撞上闸 A → agent 工具全灭**。这与反馈现象完全吻合。

### 关键发现（比反馈多一层）

- 闸 B 是**逐工具降级**，不是整体失败。即：只要 `contracts.tools` 非空且包含当前 13 个工具名，全部正常加载；
  将来后端**新增**一个工具而插件 manifest 没跟上，只会**少这一个工具**（graceful），不会再次打挂整个 channel。
- 6.9 **没有**通配/命名空间/动态工具声明机制。文档 `docs/plugins/sdk-entrypoints.md:87` 明确："Tool names are static"。
  → 我们这套"工具名由后端 manifest 动态驱动"的设计，和 6.9 的静态契约存在**根本张力**（见 §4）。

### channelConfigs WARN

`dist/manifest-registry-DpTZ39ul.js:375`：channel 类插件未声明 `channelConfigs` → 仅 WARN，
channel 仍出现在列表、收发不受影响，但 6.9 的 config schema / setup 界面无法在加载前就绪。
属于体验性问题，顺带一并补齐。

## 2. 当前需声明的工具全集（取自后端 `agentToolRegistry.js`）

后端 `routes` 实际派发 13 个 handler（`NAME_RE=/^kinthai_[a-z0-9_]+$/`）：

```
kinthai_upload_file_git_add_commit
kinthai_list_files_git_ls_files
kinthai_file_info_git_stat
kinthai_read_file_git_show
kinthai_update_file_git_add_commit
kinthai_run_pipeline
kinthai_search_messages
kinthai_file_changelog_git_log
kinthai_search_files_git_grep
kinthai_delete_file_git_rm
kinthai_move_file_git_mv
kinthai_diff_file_git_diff
kinthai_restore_file_git_restore
```

外加插件本地 fallback `default-manifest.json` 里的 `kinthai_upload_file`（后端不可达时用）——
注意它与后端真名 `kinthai_upload_file_git_add_commit` **不一致**（既有的小漂移），一并放进 contracts 防漏。

## 3. 实施改动

### 3.1 `openclaw.plugin.json`（核心）
- 增 `contracts.tools`：上面 13 个 + `kinthai_upload_file`（共 14）。
- 增 `channelConfigs.kinthai.schema`：参照 bundled signal/imessage 插件，最小含
  `email`（沿用现有 configSchema）、`name`、`enabled`。
- 保留现有 `configSchema` 不动（向后兼容）。

### 3.2 `src/index.js` 注释订正
`registerFull` 里 "New tools ship via backend deploy; the plugin doesn't need a release" 这句**在 6.9 下不再成立**，
改注释说明：新增后端工具需同步 `contracts.tools` 并发版，否则 6.9+ 上该工具被 drop。

### 3.3 防漂移测试（双仓各一）
- **插件仓 unit test**（`test/`）：断言 `openclaw.plugin.json#contracts.tools` ⊇ `default-manifest.json` 工具名，
  且为非空数组；mock 一个 6.9 风格校验，验证工厂返回的工具名都在 contracts 内。
- **后端仓 kinthai `test/test_o_agent_tools.py`**：新增用例，断言 `getManifest()` 的工具名集合 == 一份签入的
  `EXPECTED_AGENT_TOOLS` 常量。后端**加工具时该用例会红**，强制开发者：①更新常量 ②去插件仓同步 contracts + 发版。
  这是跨仓漂移的唯一自动闸（两仓物理分离，只能靠"后端变更触发提醒"）。

## 4. 架构张力（需决策，不在本次 PR 内擅自扩大）

"后端动态驱动工具集" × "6.9 静态契约" 的长期解法有三档，本次只做**短期**，中长期请拍板：

| 方案 | 说明 | 取舍 |
|------|------|------|
| **短期（本方案）** | 手维护 `contracts.tools`，靠后端测试提醒同步 | 改动最小；后端加工具要发插件版，否则新工具在 6.9+ 被 drop（仅降级） |
| 中期 | 写脚本/CI 从后端 registry 生成 `contracts.tools`，发版前自动对齐 | 需打通两仓 CI，省去手抄 |
| 长期 | 推动上游 OpenClaw 支持"channel 插件声明工具命名空间前缀"（`kinthai_*`）的动态契约 | 最契合本设计，但依赖上游排期，不可控 |

## 5. 验证（必须 gateway 模式，10.8.4.11）
1. 插件 unit test：`node test/run.js`
2. 后端 `test_o`：`python3 test/runner.py --module o`
3. bump → publish-test → `rebuild-test`（10.8.4.11 装 6.9 gateway）
4. 看 gateway.log：无 `must declare contracts.tools` / 无 `plugin tool is undeclared`
5. 实跑一次 agent，确认 14 个 `kinthai_*` 工具在 LLM 工具列表里、能 dispatch
6. **双版本兼容**：确认新 manifest 在旧 OpenClaw（≤6.6）下被宽松忽略、不报错（反馈点名要确认）
7. 排查其余生产实例（10.8.4.9 / 10.8.0.14）当前 OpenClaw 版本，评估升级面

## 6. 影响面 / 部署
- 纯插件改动，kinthai backend 代码**不变**（仅加一条后端测试）。
- 走插件自有发版流：bump patch → npm `@kinthaiofficial/openclaw-kinthai` + ClawHub → 10.8.4.11 实测 → `verify-prod`。
- 后端测试改动走 kinthai 仓正常 push + DEPLOY_NOTES。
