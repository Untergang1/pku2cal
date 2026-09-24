# pku2cal

将北京大学个人课表转换为 ICS 日历，导入或订阅到 Apple Calendar 等支持 iCalendar 的日历应用。

支持主修课表的教学周、单双周、多个上课时段及停补课安排，时间按 `Asia/Shanghai` 解释。重新生成时保持事件 UID 稳定，避免订阅重复。需要扫码或交互验证的登录暂不支持。

## 选择使用方式

| 方式 | 适合的需求 | 更新方式 |
| --- | --- | --- |
| [本地生成](#本地生成) | 在自己的电脑上生成 ICS 文件 | 手动生成并导入日历应用 |
| [GitHub Actions 与 Pages](#github-actions-与-pages) | 使用固定随机地址订阅，接受链接及 artifact 的访问边界 | 每天 06:17 检查，内容变化时发布 |
| [Cloudflare Worker](#cloudflare-worker) | 使用带私密令牌的地址订阅 | 请求时检查缓存，超过六小时尝试更新 |

订阅地址更新后，日历应用仍按自身的刷新机制获取变化。个人课表、登录凭据、会话和 ICS 文件不要提交到仓库或公开日志；凭据通过本地环境文件或部署平台的 Secrets 配置。

## 本地生成

### 1. 安装依赖

将仓库克隆或下载到本地并进入项目目录。macOS 和 Linux 均使用 Node.js 22（至少 22.12）和 npm：

```sh
npm ci
```

### 2. 填写账号

复制 `.env.example` 为 `.env`，填写北大账号和密码：

```dotenv
PKU_USERNAME=你的账号
PKU_PASSWORD=你的密码
```

`.env` 已被 Git 忽略，不要提交。已有的系统环境变量优先于 `.env` 中的值，无需通过命令行参数传递密码。

### 3. 确认学期并生成日历

先确认选课系统中的学期，再运行：

```sh
npm run setup
npm run status
npm run generate
```

- `setup` 根据北京时间选择已收录的官方校历，写入 `config/calendar.json`；已有不同配置会保留。
- `status` 不登录账号，检查并显示所选时间表、学期和允许生成的日期状态。请核对学期是否正确。
- `generate` 登录并读取课表，成功后生成 `data/calendar.ics`。生成失败会保留旧文件。

仓库目前提供校本部 2026–2027 秋季学期配置。其他学期、校区或特殊课程安排请先核对并调整[校历与学期配置](#校历与学期配置)。如果课表包含无固定时间课程，需先[人工确认](#确认无固定时间课程)，再重新生成。

### 4. 导入或订阅

将 `data/calendar.ics` 导入日历应用即可查看课程。本地文件导入后不会自动更新；需要持续同步时，按下面任一方式部署，并在日历应用中添加对应的订阅 URL。

## GitHub Actions 与 Pages

Pages 使用固定随机地址降低被猜到的风险，**持有完整链接即可访问课表**。公开仓库的登录用户可下载尚未过期的 Actions artifact，获得路径和课表；本项目将发布 artifact 保留期设为一天，接受此风险后再启用。完整订阅地址应当保密。

推荐使用一键初始化。先将项目放到自己的 GitHub 仓库，完成上面的本地生成与校历确认，安装 [GitHub CLI（gh）](https://cli.github.com/)，并登录有权管理该仓库的账号：

```sh
gh auth login
```

将公开校历 `config/calendar.json`、所选时间表和代码提交并手动推送到 `origin` 的默认分支。在项目根目录运行（下例假设默认分支为 `main`）：

```sh
git push origin main
npm run pages:setup -- --publish
```

`--publish` 表示同意公开课表并立即检查，需要时发布。命令会：

1. 检查 `gh` 登录、Git 工作区干净、`origin` 读取与推送地址指向同一 GitHub 仓库，以及本地 HEAD 与远端默认分支一致。命令不会自动提交或推送。
2. 检查公共校历的学期绑定与生成有效期，读取本地凭据和私密课程确认列表。请先人工核对当前学期；该检查不登录北大，也不能验证密码是否正确。
3. 首次生成 32 字节随机令牌，以 `0600` 权限原子保存到忽略的 `data/pages/<owner>/<repo>.json`（仓库名小写）；重复运行复用。随后创建 Pages 或切换其发布来源为 GitHub Actions，保留自定义域名等其他设置。
4. 上传 `PKU_USERNAME`、`PKU_PASSWORD`、`PKU_UNSCHEDULED_COURSES` 及独立的 `PAGES_CALENDAR_TOKEN`，共四个 Actions Secrets。系统环境变量优先于 `.env`；文件形式的确认列表会上传 JSON 内容，不上传本地路径。没有确认项时上传 `[]`，替换远端旧列表。不会上传整个 `.env` 或 Worker 令牌。
5. 启用工作流，设置仓库变量 `PUBLISH_CALENDAR=true`，触发检查并跟踪本次运行。部署成功或明确确认课表未变化后，在本地输出实际 Pages 地址下的 `<令牌>/calendar.ics` 订阅 URL；支持自定义域名。

命令仅支持 `github.com` 的标准 HTTPS／SSH `origin` 地址。需要账号拥有配置 Pages、Actions Secrets、Variables 和运行工作流的权限；组织策略或部署环境审批仍由 GitHub 控制。校历不得包含 `unscheduledCourses` 字段，个人确认项应使用 `.env` 中的私密来源。

可重复运行以更新 Secrets 并检查变化；默认最多等待 15 分钟。中途失败会报告所在阶段，已经完成的配置保留，已有站点和旧日历不会被删除；已经开启的定时发布不会自动关闭，超时也不会取消远端任务。修复后可以重跑。首次使用前建议确认推送触发的 Linux／macOS CI 通过；初始化命令不会等待或代替 CI。

在日历应用中添加输出的订阅 URL。GitHub 上的部署成功不代替客户端显示验收。首次迁移会在新部署成功后移除旧 `/calendar.ics`，不保留跳转，请更新客户端订阅；CDN 缓存可能延迟旧地址失效。

请备份 `data/pages/` 中的私密令牌文件。换电脑后如果本地文件丢失而远端已有 Secret，初始化会停止，避免意外更换订阅地址；GitHub 无法返回 Secret 的值。恢复文件后重跑，或显式轮换：

```sh
npm run pages:setup -- --publish --rotate-token
```

轮换会保存新令牌、上传 Secret 并强制发布，成功后旧随机地址不再包含在站点中。若中途失败，修复后使用普通 `--publish` 重试，复用已保存的新令牌；不要再次附加 `--rotate-token`，否则会再生成一个令牌。已下载的课表无法收回，本地损坏的令牌文件需恢复，初始化不会自动覆盖。

需要跳过对比、修复线上内容时使用 `npm run pages:setup -- --publish --force-publish`；它仍要求配置有效、课表完整生成成功。初始化仅供本机运行，避免将完整订阅链接写入 Actions 日志。

也可以手动配置：

1. 将核实后的非私密校历保存为 `config/calendar.json`，与所选时间表一起提交。勿提交 `.env`、原始页面和 ICS。
2. 在仓库 Actions Secrets 设置 `PKU_USERNAME`、`PKU_PASSWORD`。
   如有已确认无固定时间课程，再设置 `PKU_UNSCHEDULED_COURSES` Secret。
3. 用 `npm run token` 生成并私密备份令牌，将其设置为 Actions Secret `PAGES_CALENDAR_TOKEN`；将 Pages 的发布来源设为 GitHub Actions。手动配置后若要改用一键初始化，应恢复对应的本地 JSON 文件（格式为 `{"repository":"owner/repo","token":"<令牌>"}`）或显式轮换。
4. 确认课表可以公开访问后，设置仓库变量 `PUBLISH_CALENDAR=true`，手动运行 Generate calendar and publish Pages。
5. 订阅 Pages 地址下的 `<令牌>/calendar.ics`；不要公开此地址。

工作流每天北京时间 **06:17** 检查（UTC `17 22 * * *`），也支持手动触发；手动运行的 `force_publish` 默认关闭。调度可能延迟，日历客户端自行决定刷新时间，因此不保证当天临时调课即时同步。公开仓库长期无活动时 GitHub 可能停用定时任务，应留意 Actions 状态。

每次完整生成候选 ICS 后，以当前随机 URL 上的日历作为比较基准。比较忽略事件 `DTSTAMP`、属性顺序及折行差异，保留课程、时间、地点、说明等其余有效内容。内容相同则**不上传 artifact、不部署**，线上文件保持不变；内容变化、首次地址返回 `404` 或强制发布时才部署。artifact 显式保留一天，不使用额外 artifact 或 Actions cache 保存课表基准；产物不进入源码历史。

线上读取使用 HTTPS、30 秒超时和缓存重新验证，不接受重定向。网络、非 `200`/`404` 响应、损坏日历、上游获取或生成失败都会使检查失败，已有站点保留。新部署仅包含当前随机目录，因此移除旧根地址及旧令牌目录。令牌提前遮蔽，公开日志不输出完整 URL 或课表。

`npm run pages:prepare` 是工作流使用的准备入口，读取 `PAGES_CALENDAR_TOKEN`、`PAGES_BASE_URL`、`PAGES_FORCE_PUBLISH`（默认 `false`）及现有课表配置。需要发布时重建专用 `site/`；其 `GITHUB_OUTPUT` 仅包含 `changed` 和 `reason`（`missing`、`changed`、`unchanged`、`forced`）。普通本地导出继续使用 `npm run generate`。

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
```

运行 `npm run token` 后，将生成的随机令牌作为 `CALENDAR_TOKEN` 输入。如有已确认的无固定时间课程，还需在部署前运行 `npx wrangler secret put PKU_UNSCHEDULED_COURSES`，输入[确认列表](#确认无固定时间课程)的 JSON。

配置完成后部署：

```sh
npm run worker:deploy
```

持有 `https://<worker-host>/calendar/<token>.ics` 即可读取日历，请将完整地址作为秘密保管。令牌轮换后旧地址返回 `404`，客户端需更新订阅地址。部署命令会实际发布；本项目的自动验证只执行 dry-run。

本地开发可在忽略的 `.dev.vars` 中配置三个 Secrets，运行 `npm run worker:dev`。本地 KV 数据位于忽略的 `.wrangler/`。Wrangler 日志及云端观测不要启用记录完整请求 URL 的选项；配置默认关闭 Worker observability。

KV 不持久化登录会话，仅保存最近成功的 ICS、生成时间和配置指纹。缓存按账号、学期、有效配置隔离；密码或订阅令牌轮换不会改变缓存身份。旧副本没有自动删除期限，需要撤销保留时自行删除对应 KV 数据或 namespace。

## 校历与学期配置

`setup` 按当前北京时间选择已收录的校本部校历，写入学期和允许生成的日期范围。请先在选课系统确认账号当前学期与配置一致；系统日期无法代替这一步确认。

可用 `npm run setup -- --semester 2026-2027-1 --output data/calendar.json` 显式选择学期和输出位置。重复初始化相同配置不会修改文件，已有不同配置不会覆盖。未收录或有多个匹配学期时会给出提示，不猜测日期。新学期需先依据官方校历补充 `config/semesters.json` 目录及对应校历文件，再选择新配置；生成任务不会自动切换学期。`config/calendar.example.json` 仅用于离线测试，不是官方校历。

`config/pku-main-2026-2027-1.json` 根据 [北京大学官方校历](https://www.pku.edu.cn/detail/3377.html) 整理，仅适用校本部 2026–2027 第一学期：2026 年 9 月 7 日起上课，12 月 28 日至 2027 年 1 月 10 日停课复习考试，1 月 11 日起放寒假。生成有效期为 **2026-09-07 至 2027-01-10**（含首尾两天），普通授课按 16 周计算，至 12 月 27 日结束；考试周不会凭空生成考试事件。配置选择本部 12 节作息，并含中秋、国庆停课。官方明确部分公休日课程照常进行，因此没有套用社会通用调休或添加补课映射。选用前需确认校区及课程特殊安排。

| 字段 | 含义 |
| --- | --- |
| `namespace` | 自行选定并长期保持不变的日历命名空间；更改会改变所有 UID |
| `semester` | 学期标识，例如 `2026-2027-1` |
| `semesterBinding` | 人工确认的学期及允许生成的日期范围，见下文 |
| `firstMonday` | 第 1 教学周周一，`YYYY-MM-DD` |
| `teachingWeeks` | 教学周数，单双周按此编号判断 |
| `timetable` | 时间表标识：`pku-main`（本部）或 `pku-ss`（软微）；必填 |
| `holidays` | 整日停课日期数组 |
| `makeups` | `"目标日期": "原教学日期"` 映射 |
| `unscheduledCourses` | 可选的无固定时间课程确认列表，含个人选课信息，限私密配置使用 |

### 选择和维护上课时间表

日历配置用 `"timetable": "pku-main"` 选择本部，用 `"timetable": "pku-ss"` 选择软件与微电子学院。两份时间表独立于学期保存：

- [本部时间表](config/timetables/pku-main.json)：现有官方 12 节作息。
- [软微时间表](config/timetables/pku-ss.json)：`periods` 初始为空，需要按学院实际安排手动填写；尚无已核实的官方节次数据。

时间表文件包含 `label`（显示名称）和 `periods` 数组。每节使用 `{ "period": 1, "start": "08:00", "end": "08:50" }` 的结构（这里只演示本部第一节的格式，不是软微时间）。编号为 1–30 的整数，时间按 `Asia/Shanghai` 解释，须为 `HH:MM`；编号不能重复、开始须早于结束、各节不能重叠，且必须覆盖课程涉及的全部节次。

填写软微表后，修改日历配置中的 `timetable` 即可使用。运行 `npm run status` 检查所选时间表和学期；其他日历文件可用 `npm run status -- --config data/calendar.json`。所选文件缺失、内容无效或为空时会报错，不会回退本部。未选中的时间表不读取，软微留空不影响本部使用。生成时发现课程需要的节次缺失，也会停止生成。

本地生成使用所选表的最新内容；Pages 需提交并推送日历配置和时间表，下一次生成发布时生效；Worker 在构建时嵌入所选表，改变选择或编辑节次后须重新部署。`--config` 与 `PKU_CONFIG_PATH` 只选择日历文件，时间表始终从项目的 `config/timetables/` 读取，与当前工作目录及日历文件位置无关。

`setup` 默认选择本部，保留已有不同配置，且不会写入两份时间表；换学期时可以继续引用已维护的软微表。选择时间表只改变节次起止时间，不改变教学周、假期或学期绑定，也不支持同一日历按课程混用作息。修正时间时保持 `namespace` 不变，事件 UID 不会因此改变。

日历文件不再接受内联 `periods`。若有自行保留的旧配置，将其中的节次整理到对应时间表文件，再将日历中的 `periods` 替换为 `timetable`；两者不能同时出现。

补课从标准课表取原日课程，替换目标日课程，原日不再保留；原日可同时列入停课日期。源、目标不得重叠，目标不得停课，同一源不能补到多个目标。本地生成、Actions 和 Worker 使用相同的校历配置。

```sh
npm run generate -- --config data/calendar.json --output data/calendar.ics
```

仅在完整生成成功后替换旧文件。配置错误、上游失败、未知选课状态或无法识别时间均返回非零退出码。只支持“已选上”课程，排除“未选上”；其他状态拒绝生成。页面必须为完整单页结果，检测到多页时拒绝发布残缺结果。

### 人工绑定学期

上游页面没有学期编号时，请先确认当前选课学期，再通过 `setup` 写入 `semesterBinding`；也可手动配置。2026–2027 秋季学期示例如下：

```json
{
  "semesterBinding": {
    "confirmedSemester": "2026-2027-1",
    "validFrom": "2026-09-07",
    "validThrough": "2027-01-10"
  }
}
```

`confirmedSemester` 必须与顶层 `semester` 一致；修改学期需重新确认。起止日期都按 `Asia/Shanghai` 解释，包含首日和末日完整一天，与教学周范围分开配置。程序在请求上游前及生成完成时检查有效期；到期或尚未开始时不登录、不生成。Node 在替换文件前再次检查。若上游明确给出另一个学期，即使有人工绑定也报错。没有绑定时，仍要求上游给出匹配的学期标识。

有效期外，Worker 不刷新、不替换 KV；仍可提供同配置下在有效期内生成的旧副本，标记为 `stale` 并保留 `Last-Modified`，无副本返回 `503`。静态入口失败保留已有文件和 Pages 部署。学期绑定或有效期变更会改变配置指纹，不能读取原配置的缓存。

### 确认无固定时间课程

程序不会自动把无法解析的时间当作无固定时间。只有人工核对课程安排后，才能用课程号、班号和当时完整的分段说明明确标记：

```json
[
  {
    "semester": "2026-2027-1",
    "courseId": "SYN002",
    "classId": "01",
    "confirmed": true,
    "expectedSegments": ["(合成无固定时间说明)"]
  }
]
```

这些值都是合成示例，不能直接用于真实账号。列表项的学期必须匹配当前配置，`confirmed` 必须为 `true`；时间说明必须与解析后的分段文本逐项一致。如果说明改变，或课程包含可解析的固定时段，会报错要求复核。未确认的其他课程仍严格解析；退选后不再出现的确认项不会阻碍生成。确认仅影响是否生成事件，不改变其他课程 UID。

列表含个人选课信息，不得提交。提供方式任选一种：

- 本地：推荐将数组保存在忽略的 JSON 文件中，在 `.env` 设置 `PKU_UNSCHEDULED_COURSES_FILE=data/unscheduled-courses.review.json`，或使用 `--confirmations <json>` 参数。也可在忽略的校历中加入 `unscheduledCourses` 数组，或在 `.env` 的 `PKU_UNSCHEDULED_COURSES` 中放置数组 JSON 字符串。
- Actions：将数组 JSON 保存为 `PKU_UNSCHEDULED_COURSES` Secret，workflow 已接入；不在可提交的校历文件中加入个人列表。
- Worker：通过 `npx wrangler secret put PKU_UNSCHEDULED_COURSES` 配置运行时 Secret；本地开发在 `.dev.vars` 中设置。Worker 构建拒绝打包包含非空个人列表的校历。

本地内联写法为 `PKU_UNSCHEDULED_COURSES='[{"semester":"...",...}]'`，外层单引号用于包住完整 JSON。文件来源与非空内联值不能同时使用，校历和外部来源也不能同时提供列表。未设置任何来源表示没有外部确认项。文件路径选项仅用于本地生成；部署时将文件内容保存为 Secret。确认列表加入有效配置指纹，因此修改确认项会隔离旧缓存。

## 故障排查

日志仅含阶段、错误类别和耗时，不包含原始异常或个人数据。

| 类别／响应 | 排查方向 |
| --- | --- |
| `pku:credentials` | 凭据未配置 |
| `pku:authentication` / `pku:interaction_required` | 密码或交互验证要求，后者超出首版范围 |
| `pku:network` / `pku:response` / `pku:redirect` | 网络、上游维护或重定向变化；用私密探测命令复现 |
| `parse:structure` / `parse:status` / `parse:pagination` | 页面结构、状态或分页不符合已核实契约 |
| `parse:semester` | 学期缺失或与配置不符 |
| `semester:not_started` / `semester:expired` | 尚未进入或已经离开人工绑定的允许生成日期范围 |
| `schedule:time` / `schedule:weeks` / `schedule:periods` | 上课时间无法识别、周数越界或节次配置不足 |
| `schedule:unscheduled_changed` / `schedule:unscheduled_has_time` | 已确认课程的说明改变或含固定时段，需要重新核对，不能继续忽略 |
| `configuration:invalid` | 校历字段、日期或停补课冲突 |
| Worker `200` + `X-Calendar-Status: stale` | 刷新失败或已超出生成有效期，仍提供旧版；`Last-Modified` 为旧版生成时间 |
| Worker `503` | 配置不可用或刷新失败且同配置无可用副本 |

本地 Worker 实例内合并并发刷新；KV 不提供全局锁，也不保证跨实例即时一致。真实 Cloudflare 网络可用性只能在云端验证，本地探测成功不代表云端一定可访问上游。

### 私密诊断

若需要检查上游页面，在本地 `.env` 配好账号后运行：

```sh
npm run probe
npm run probe:worker
```

两个命令分别通过 Node.js 和本地 Worker 进行真实只读登录，将原始页面保存至 `data/upstream.html`、`data/upstream-worker.html`，不会发布 ICS。页面与会话不得提交、粘贴到公开日志或作为 CI 测试样例。遇到交互验证会报错，不绕过验证。

## 开发与验证

macOS 和 Linux 使用相同的检查命令：

```sh
npm ci
npm run check
npm run worker:check
```

`check` 包含类型检查、构建、单元测试和双运行时集成测试。`worker:check` 使用合成配置运行 Wrangler dry-run，不加载本地凭据、不发布。Miniflare 与 Wrangler 使用匹配的 Worker 运行时，依赖以锁文件为准。CI 已配置两种系统的同一套检查。

已完成 2026–2027 秋季学期在 Node.js 与本地 Worker 的真实日历生成及事件一致性验证。Cloudflare 云端部署、公开 Pages 发布、日历客户端显示及远端 CI 仍待验证，详见[验证记录](docs/verification.md)。

- [开发约定](AGENTS.md)：开发边界、数据处理与维护约定。
- [系统设计](docs/design.md)：技术路线、模块边界、日历规则与验收要求。
- [参考资料](docs/reference.md)：认证、课表获取、课程时间解析及 ICS 导出的外部实现线索。
