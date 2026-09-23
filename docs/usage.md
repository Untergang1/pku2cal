# 使用与部署

## 环境与检查

macOS 和 Linux 使用 Node.js 22（至少 22.12）及 npm。安装及验证命令相同：

```sh
npm ci
npm run check
npm run worker:check
```

`check` 包含类型检查、构建、单元测试和双运行时集成测试。`worker:check` 使用合成配置运行 Wrangler dry-run，不加载本地凭据、不发布。Miniflare 与 Wrangler 使用同一版本的 Worker 运行时；依赖以锁文件为准。工作流也在两种系统执行这些命令。

## 本地私密配置

依据 `.env.example` 创建未跟踪的 `.env`，设置 `PKU_USERNAME` 和 `PKU_PASSWORD`。无需在命令行参数中传递密码。Node 的环境文件加载不覆盖已存在的环境变量。

```sh
npm run probe
npm run probe:worker
```

这两个命令进行真实只读登录，将原始页面分别保存至 `data/upstream.html`、`data/upstream-worker.html`。页面与会话不得提交、粘贴到公开日志或作为 CI fixture。探测不会发布 ICS；遇到交互验证会报错，不绕过验证。

## 校历与生成

从 `config/calendar.example.json` 创建校历配置。示例仅用于离线测试，不是官方校历。个人试验配置放在 `data/calendar.json`；部署使用经过核实且可公开的 `config/calendar.json`。

| 字段 | 含义 |
| --- | --- |
| `namespace` | 自行选定并长期保持不变的日历命名空间；更改会改变所有 UID |
| `semester` | 学期标识，例如 `2026-2027-1` |
| `firstMonday` | 第 1 教学周周一，`YYYY-MM-DD` |
| `teachingWeeks` | 教学周数，单双周按此编号判断 |
| `periods` | `{ "period": 1, "start": "08:00", "end": "08:50" }` 等节次表，时间为上海当地时间 |
| `holidays` | 整日停课日期数组 |
| `makeups` | `"目标日期": "原教学日期"` 映射 |

补课从标准课表取原日课程，替换目标日课程，原日不再保留；原日可同时列入停课日期。源、目标不得重叠，目标不得停课，同一源不能补到多个目标。两个入口消费相同配置结构。

```sh
npm run generate -- --config data/calendar.json --output data/calendar.ics
```

仅在完整生成成功后替换旧文件。配置错误、上游失败、未知选课状态或无法识别时间均返回非零退出码。只支持“已选上”课程，排除“未选上”；其他状态拒绝生成。页面必须为完整单页结果，检测到多页时拒绝发布残缺结果。

**当前真实联调限制：**已测页面没有学期编号，且有已选上课程未提供可解析的上课时间。当前严格拒绝生成，尚不能将该账号作为端到端日历验收通过。不能通过删除失败检查或静默忽略课程绕过；详见 [验证记录](verification.md)。

## GitHub Actions 与 Pages

1. 将核实后的非私密校历保存为 `config/calendar.json` 并提交。勿提交 `.env`、原始页面和 ICS。
2. 在仓库 Actions Secrets 设置 `PKU_USERNAME`、`PKU_PASSWORD`。
3. 将 Pages 的发布来源设为 GitHub Actions。
4. 确认课表可以公开访问后，设置仓库变量 `PUBLISH_CALENDAR=true`，手动运行 Generate calendar and publish Pages。
5. 订阅 Pages 地址下的 `calendar.ics`；此地址公开可访问。

工作流每六小时运行，也支持手动触发。生成失败不会上传或部署，已有 Pages 部署保留。发布物通过 artifact 传递，不进入源码历史。日历客户端自行决定何时重新获取订阅。

## Cloudflare Worker

先准备校历 `config/calendar.json`。使用其他路径时，在 shell 中 `export PKU_CONFIG_PATH=...`；配置在构建时载入，改变校历后需要重新部署。

```sh
npx wrangler login
npx wrangler kv namespace create CALENDAR_KV
```

将创建的 namespace ID 写入 `wrangler.jsonc` 的 `CALENDAR_KV` 绑定，替换全零占位值。然后设置 Secrets：

```sh
npx wrangler secret put PKU_USERNAME
npx wrangler secret put PKU_PASSWORD
npm run token
npx wrangler secret put CALENDAR_TOKEN
npm run worker:deploy
```

`token` 生成 32 随机字节的 base64url 值，作为 `CALENDAR_TOKEN` 输入。持有 `https://<worker-host>/calendar/<token>.ics` 即可读取日历，请将完整地址作为秘密保管。令牌轮换后旧地址返回 `404`，客户端需更新订阅地址。部署命令会实际发布；本项目的自动验证只执行 dry-run。

本地开发可在忽略的 `.dev.vars` 中配置三个 Secrets，运行 `npm run worker:dev`。本地 KV 数据位于忽略的 `.wrangler/`。Wrangler 日志及云端观测不要启用记录完整请求 URL 的选项；配置默认关闭 Worker observability。

KV 不持久化登录会话，仅保存最近成功的 ICS、生成时间和配置指纹。缓存按账号、学期、有效配置隔离；密码或订阅令牌轮换不会改变缓存身份。旧副本没有自动删除期限，需要撤销保留时自行删除对应 KV 数据或 namespace。

## 故障定位

日志仅含阶段、错误类别和耗时，不包含原始异常或个人数据。

| 类别／响应 | 排查方向 |
| --- | --- |
| `pku:credentials` | 凭据未配置 |
| `pku:authentication` / `pku:interaction_required` | 密码或交互验证要求，后者超出首版范围 |
| `pku:network` / `pku:response` / `pku:redirect` | 网络、上游维护或重定向变化；用私密探测命令复现 |
| `parse:structure` / `parse:status` / `parse:pagination` | 页面结构、状态或分页不符合已核实契约 |
| `parse:semester` | 学期缺失或与配置不符 |
| `schedule:time` / `schedule:weeks` / `schedule:periods` | 上课时间无法识别、周数越界或节次配置不足 |
| `configuration:invalid` | 校历字段、日期或停补课冲突 |
| Worker `200` + `X-Calendar-Status: stale` | 刷新失败，仍提供旧版；`Last-Modified` 为旧版生成时间 |
| Worker `503` | 配置不可用或刷新失败且同配置无可用副本 |

本地 Worker 实例内合并并发刷新；KV 不提供全局锁，也不保证跨实例即时一致。真实 Cloudflare 网络可用性只能在云端验证，本地探测成功不代表云端一定可访问上游。
