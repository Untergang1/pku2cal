# 验证记录

## 上游依据

- pkucli：核查版本 `0ad6dea1802abc98825dc57b07b75da4dee1c9f4`，MIT，版权归 pkuinfo team。认证字段和 URL 参考其 `iaaa.rs`、`elective/client.rs`、`elective/login.rs` 与 `elective/api.rs`；本项目独立实现，未复制源码。
- [pkucli 许可证](https://github.com/pkuinfo/pkucli/blob/0ad6dea1802abc98825dc57b07b75da4dee1c9f4/LICENSE)。其结果结构未保留课程号、未校验预期表头，不能直接作为本项目完整数据契约。
- [PekingParser](https://github.com/dIT8Zv/WakeupSchedule_BUPT/blob/master/app/src/main/java/com/suda/yzune/wakeupschedule/schedule_import/parser/PekingParser.kt)：用于理解分段时间与单双周；已核对根目录 Apache-2.0 许可证，不复用固定列号或默认时间。
- ICS 依据 [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545)，不复制 Sleepy 实现。

## 验证边界

认证使用 RSA PKCS#1 v1.5 加密及 Base64 编码，Worker 启用 `nodejs_compat`，与 Node 共用 `node:crypto`。会话仅在单次生成中存活。仅允许 IAAA 和选课系统两个 origin，手动处理 Cookie 和重定向；文档中的 HTTP 选课回调升级为 HTTPS 请求。

离线测试覆盖两个运行时中的合成认证交换，不证明真实账号、真实页面或 Cloudflare 云端出站请求可用。真实页面的成功状态、学期标识、空课表及主修选择结构必须通过本地私密联调确认；不以测试样例冒充实测结果。

真实联调使用本地未跟踪 `.env` 中的 `PKU_USERNAME`、`PKU_PASSWORD`，执行 `npm run probe`；原始页面仅写入 `data/upstream.html`。测试、构建和 CI 不读取真实凭据。

## 本地实测

- Node.js 22：真实账号完成认证和主修课表请求；不记录账号、课程或会话。
- 本地 workerd：真实账号完成同一认证与课表请求；原始页面仅保存在 `data/upstream-worker.html`。执行命令为 `npm run probe:worker`。
- 真实课表表头含课程号、课程名、课程类别、学分、周学时、教师、班号、开课单位、教室信息、选课结果、IP地址、操作时间；状态为“已选上”“未选上”。表尾有空行和跨列分页行。
- 当前结果页的 caption 仅写“学期课程表”，没有可验证的学期编号。用户已确认 2026–2027 秋季学期；以官方校历和当前北京时间核对，显式绑定生成期为 2026-09-07 至 2027-01-10（含首尾两天）。
- Node 与实际部署入口打包后的本地 workerd 均完成真实认证、课表解析和 ICS 生成，忽略生成时间 `DTSTAMP` 后，两份日历事件内容一致；重复 Worker 请求命中本地 KV，内容不变。产物仅保存为忽略的 `data/calendar.ics` 和 `data/calendar-worker.ics`。
- 合成认证用例在 Node.js 和 workerd 中通过，包含 RSA 填充、多个 Set-Cookie、相对跳转、Cookie 隔离、非法跳转和交互验证拒绝。
- macOS 与 GitHub 托管 Linux CI 已配置，尚未在远端执行。Cloudflare 云端尚未部署或验证。

## 核心验证

离线用例覆盖成功与失败选课状态、异常表格、分页拒绝、多时段、单双周、停补课、重复事件身份、配置冲突、中文与 emoji 折行、转义和独立 ICS 解析器回读。

完整生成流程在 Node 文件入口和 Worker 入口产生相同字节，并在 workerd 与本地 KV 绑定中通过。覆盖六小时缓存边界、失败回退、无副本 `503`、配置隔离、令牌轮换、并发刷新、损坏快照和原子文件替换。Linux 上 Wrangler dry-run 已通过，未向 Cloudflare 发布。

真实页面已通过结构解析。用户已确认仅有括号说明的相应课程无需线下上课，并将私密 JSON 的 `confirmed` 设为 `true`；该列表已绑定确认学期，从本地文件注入，日历不为该课程生成事件。独立 ICS 解析器检查真实产物非空、UID 唯一、节次时间、上海日期范围、停课排除、CRLF 与 UTF-8 折行通过；普通授课事件均落在 2026-09-07 至 2026-12-27 内。

## 交付检查（2026-09-24）

- 本地 Linux / Node.js 22.23.2：从锁文件 `npm ci` 安装成功，审计报告无已知漏洞；`npm run check` 通过类型检查、构建和 130 项测试；`npm run worker:check` 通过 Wrangler dry-run。
- Markdown 相对链接及 Git diff 空白检查通过；Git 未跟踪 `.env`、`data/`、ICS 或运行时缓存。
- 已整理官方校历目录及 `config/pku-main-2026-2027-1.json`，来源为 [北大官方校历与作息](https://www.pku.edu.cn/detail/3377.html)。已用 `setup` 将用户确认的学期和校历日期写入公开配置 `config/calendar.json`；未加入个人选课数据。
- 已落实：人工学期绑定、上海日期边界、到期禁止生成且保留旧版、跨截止时间的写入保护，以及按学期和原始说明逐项确认无固定时间课程。确认列表通过私密配置／Secrets 注入，两个入口和 workerd 用例通过。
- 新增验证覆盖官方目录选择、上海起止日期边界、无匹配或歧义时拒绝猜测、保留已有配置、状态提示和私密确认文件来源冲突。实际部署入口在 workerd 中启动并读取 KV 的回归用例通过。
- Pages 一键初始化新增 37 项离线测试：覆盖显式发布授权、origin 目标与提交检查、gh 缺失／未登录、配置失效、Pages 创建／切换／复用、HTTP 错误区分、私密输入与日志隔离、空确认列表同步、远端提交变化、指定运行跟踪、失败／跳过／超时及自定义域名。GitHub 响应使用模拟，真实子进程测试使用合成输入；未上传真实 Secrets、修改 GitHub 设置或触发发布。命令帮助入口已在 Linux 执行验证。
- 仍待：macOS／托管 Linux CI 执行、日历客户端订阅显示验收。公开 Pages 与云端 Worker 未发布。

## Pages 随机地址与按需发布验证（2026-09-24）

- Pages 每天北京时间 06:17 检查，使用固定随机路径；内容比较仅排除 VEVENT 的 DTSTAMP，并规范化折行、属性及组件顺序。无变化不上传 artifact、不部署；首次缺失、有效内容变化或显式强制才准备新站点。
- 新增离线用例覆盖：内容等价、属性参数及课程增删／教师／停补课变化、合法空课表、损坏结构和重复 UID；404 初次发布、强制发布、非正常 HTTP 状态、网络错误脱敏、生成失败、到期保护，以及发布目录不含旧根文件或旧令牌。
- 初始化用例覆盖：令牌首次持久化、复用、显式轮换、保存失败、文件损坏、本地丢失而远端已有 Secret、正常跳过与强制发布结果识别，以及 Actions 初始化禁用、子进程私密环境隔离。文件原子写入与 0600 权限已在本地 Linux 验证。
- 本地 Linux：类型检查、构建和 163 项测试通过；Worker Wrangler dry-run 通过，未发布。actionlint 1.7.7 检查 Pages 与 CI 工作流通过（未启用 shellcheck）。新增用例纳入已有 macOS／Linux CI 的相同命令。
- 本次未读取真实线上 ICS、生成实际 Pages 令牌、上传 Secrets、推送或触发云端部署。GitHub runner 的实际日志遮蔽、artifact／部署条件、托管 macOS／Linux CI、旧地址缓存失效及客户端迁移仍待上线验收；离线测试不代替这些实测。

## 独立时间表选择验证（2026-09-24）

- 用户校历通过 `timetable` 引用独立本部／软微时间表；本部数据已迁移，软微表由用户按实际观察填写。软微时间尚未经官方资料独立核实，合成软微测试数据不作为实际时间依据。
- 回归验证本部迁移前后的规范化配置、ICS 字节、UID 和既有 Worker 配置指纹一致。切换合成时间表或编辑节次会更新起止时间及缓存指纹，不改变 UID；未选中表和显示名称不影响指纹。
- 覆盖旧内联格式与混合格式拒绝、未知标识、缺失或损坏文件、空表、非法及重叠节次、课程引用缺失节次、初始化保留用户选择、仓库外配置路径和状态检查。空软微测试使用注入的合成草稿，不依赖用户维护的真实软微文件保持为空。
- 本地、Pages 和 Worker 对两套合成作息生成一致内容；实际 Worker 部署入口在本地 workerd 中对两种解析结果均成功读取 KV。Pages 初始化在所选表无效时停止，不上传 Secrets 或修改 GitHub 设置。
- 本地 Linux / Node.js 22.23.2：`npm run check` 通过类型检查、构建及 185 项测试；`npm run worker:check` 通过 Wrangler 不发布构建；状态命令、Markdown 相对链接和 diff 空白检查通过。现有 macOS／Linux CI 矩阵沿用相同命令，远端尚未执行；本次未推送或部署。


## 软微课时映射修正验证（2026-09-24）

- 用户填写软微 12 节时间并将当前日历切换到 `pku-ss`，确认第 8 节的 13:00–13:50 是针对选课系统课时问题的手动映射修正。README 记录该依据与后续恢复方式；未将该观察表述为官方作息。
- 校验允许编号与时间顺序不一致，仍拒绝重复编号、无效时刻及实际时间重叠，规范化输出继续按节次编号排序。连续节次内时间倒序报 `schedule:periods`，不靠首尾端点猜测事件范围。
- 合成回归验证第 8 节转换为上海时间 13:00–13:50、修正前后 UID 稳定、缓存隔离及编号排序稳定；覆盖 7–8 节和端点正常但内部倒序的 5–9 节拒绝、非相邻编号的实际重叠拒绝，以及本地／Pages／Worker 对映射事件生成一致内容。
- 本地 Linux：`npm run check` 通过类型检查、构建和 189 项测试；当前软微配置的状态检查及 Wrangler `deploy --dry-run` 均通过。未登录真实账号生成课表，未推送或部署；macOS 验证仍待现有 CI 执行。

## Worker 一键初始化验证（2026-09-24）

- 新增 `npm run worker:setup -- --deploy`，自动检查本地配置、确定账号、管理 KV 和独立订阅令牌、部署四个 Secrets 与代码，并检查云端 ICS 和错误令牌响应。运行时与课表生成逻辑未改变；原手动 Wrangler 入口保留。
- 新增 42 项离线测试，覆盖首次初始化、重跑复用、明确部署参数、CI 禁用、凭据／学期／私密列表／时间表无效、JSONC 和自定义校历路径、多账号选择、同名 Worker 冲突、本地令牌丢失／损坏、KV 冲突／丢失、令牌保存失败、KV 创建后恢复、轮换失败重试、Cloudflare 错误与空响应、缺失子域名、部署与验证结果区分、503／损坏 ICS／stale／网络错误／错误令牌检查失败、传播重试及日志脱敏。
- 私密状态原子替换、0600 权限、运行目录 0700 权限、本机并发锁以及失败后的 Secrets／日志／锁清理均用真实临时文件验证。Cloudflare 账号、资源、部署和 HTTP 课表响应使用合成数据模拟，不构成云端实测。
- 本地 Linux / Node.js 22.23.2：类型检查、构建和全部 231 项测试通过；帮助命令可用。`npm run worker:check` 对仓库配置和一键命令生成的配置均执行真实 Wrangler `deploy --dry-run`；后者包含合成 `--secrets-file`，验证配置路径、构建 cwd 和 Secrets 参数可用，未发布。
- 相同的测试与两种 dry-run 已纳入现有 macOS／Linux CI 命令；本次未执行远端 CI，macOS 结果仍待验证。README 和设计文档已更新，私密状态、运行目录和生成配置均由现有 `/data/` 忽略规则覆盖。
- 用户已报告 GitHub Pages 部署完成；本次未独立访问其私密订阅链接。未登录 Cloudflare、上传真实 Secrets、创建云端资源、发布 Worker 或推送提交。Cloudflare 云端访问北大、真实订阅地址及日历客户端显示仍须首次部署后验收。

## Worker 初始化 JSON 输出修复（2026-09-24）

- 确认 Wrangler 4.137.0 在 `WRANGLER_LOG=info` 下会屏蔽 `auth token --json` 的标准输出，导致账号识别后解析空字符串失败；改为 `log`，同时保留输出捕获、日志脱敏和临时目录清理。
- 新增使用合成 API Token 调用真实 Wrangler CLI 的离线回归，验证认证 JSON 可正常解析；不使用真实凭据或请求 Cloudflare。此用例纳入现有 macOS／Linux CI 测试命令。
- 本地 Linux：`npm test -- tests/integration/worker-setup.test.ts` 的 43 项测试通过。macOS 尚待 CI 验证；本次修复未创建云端资源、上传 Secrets 或部署 Worker。

## 软微跨节次时段修复（2026-09-24）

- 按用户确认，保留第 8 节 13:00–13:50 和第 5–7 节原有映射；5–7 节应为 14:00–16:50，5–8 节应为 13:00–16:50，不重新编号。
- Node、Pages 和 Worker 共用的时段展开逻辑改为读取范围内全部节次，按实际时间确定最早开始和最晚结束；保留缺失节次、重叠和重复事件检查，UID 仍由原始节次身份确定。
- 合成回归覆盖实际软微表的 5–7、5–8、7–8 和含内部提前节次的 5–9 时段、ICS 起止时间、稳定 UID，以及 Node／Pages／Worker 输出一致性。本地 Linux 类型检查和 `npm test -- tests/integration/timetables.test.ts tests/unit/core.test.ts` 的 60 项测试通过；macOS 尚待 CI 验证。
- 只读核对确认 Pages 最近成功发布使用本部时间表；后续使用软微配置的运行在 `pages:prepare` 阶段失败、部署跳过，线上继续提供旧日历。本次仅修复本地共用逻辑，未推送或重新部署任一入口。


## 私密课程补充配置验证（2026-09-24）

- 新增独立私密 JSON，支持按课程号、班号覆盖整门课程教室，以及添加系统完全缺失的课程。结构化时段支持多时段、教学周单双周，共用节次映射和停补课；不替换已有课程时间。
- 合成用例验证教室覆盖（包括系统已有地点）、ICS 解析回读、稳定 UID、缺失覆盖忽略、单双周日期、多时段及非时间顺序节次、停补课、可选字段、重复时段、非法周数及缺失节次。手动课程与上游、无固定时间确认或教室覆盖冲突时停止生成，修正来源后相同事件身份保持不变。
- 验证私密文件／内联来源互斥、空文件拒绝、公共校历拒绝嵌入补充、配置排序规范化、未启用时原指纹不变、修改补充后缓存隔离，以及同配置 stale／无副本 503。Node 文件、Pages 产物和 Worker 响应一致；真实本地 workerd 通过运行时 Secret 生成含补充的日历并读取 KV。
- Pages／Worker 一键初始化使用模拟远端验证新增 Secret 内容同步、清空为 `null`、错误前置拒绝和日志脱敏。失败时原本地 ICS、Pages 产物及 Worker 同配置缓存保留，上游失败不单独发布手动课程。
- 本地 Linux：类型检查、直接相关单元及集成测试、两种 Wrangler dry-run（含合成 Secrets 文件）通过。相关用例已纳入现有 macOS／Linux CI；远端 CI 与 macOS 尚未执行，未上传真实 Secrets、推送或部署，也未用实际个人课表验证补充内容。
