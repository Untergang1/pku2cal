# 系统设计

本文记录首版系统契约，供实现与验收使用。共用核心、本地入口、Pages workflow 与 Worker 入口已实现；各项实测边界见 [验证记录](verification.md)。开发约定见 [AGENTS.md](../AGENTS.md)，上游线索见 [参考资料](reference.md)。

## 1. 目标与技术路线

单账号自部署，将当前学期主修课表转换为稳定的 ICS 订阅。使用 TypeScript：Node.js 运行本地与 GitHub Actions 入口，Cloudflare Worker 提供动态订阅，通过 Wrangler CLI 部署。共用核心不依赖文件系统或 Cloudflare 绑定，依赖须兼容两个运行时。

首版采用用户名、密码无人值守登录；不支持辅双、扫码、交互式验证或管理界面。需要交互验证时明确报错，不尝试绕过。学期与校历手动配置，不自动抓取。

## 2. 模块与数据契约

```text
认证与会话 → 课表页面获取 → HTML 结构解析 → 时间归一化
                                           ↓
                                    校历展开与例外处理
                                           ↓
                                        ICS 生成
                                     ↙           ↘
                              文件 / Pages     Worker / KV
```

| 模块 | 职责与输出 |
| --- | --- |
| `pku/auth` | IAAA 与选课系统 SSO；管理本次生成过程内的 Cookie 和重定向，不持久化会话 |
| `pku/elective` | 获取课表 HTML；识别登录失效和上游请求失败 |
| `pku/parser` | 校验页面结构，提取课程号、班号、课程名、教师、选课状态及分段时间文本，保留 `<br>` 边界 |
| `schedule` | 将时间文本归一化为教学周集合、星期、起止节次和地点，再结合校历展开事件 |
| `calendar` | 将带稳定身份、起止时间和课程信息的事件序列化为 ICS，不接触 HTML |
| `application` | 校验共用配置，编排课表获取、解析、校历展开与 ICS 生成流程 |
| `entrypoints` | 读取配置与 Secrets、调用共用生成流程；分别负责文件输出或 KV 与 HTTP 行为 |

解析、校历计算和序列化使用纯函数；网络请求与生成时间由外部传入，便于离线测试。只有确认选课成功的课程进入日历；不得把未知状态、缺失表格或无法识别的时间当作空课表。人工确认的无固定时间课程可通过显式标记不生成事件；未确认的异常仍使整次生成失败。

### 目录布局

采用单个 TypeScript 项目、两个运行入口；目录按以下职责组织。

```text
src/
  pku/           # 北大认证、课表请求及 HTML 解析
  schedule/      # 时间归一化、校历展开、停补课与事件身份
  calendar/      # ICS 序列化、转义与折行
  application/   # 共用生成流程、配置校验与模块编排
  entrypoints/   # Node.js 与 Worker 入口及各自的平台行为
tests/
  unit/          # 模块测试
  integration/   # 完整生成流程、入口一致性及故障行为测试
  fixtures/      # 合成或脱敏的页面、课程数据与预期结果
config/          # 可提交的校历、节次配置与配置示例
docs/            # 系统设计、参考资料及验证记录
.github/
  workflows/     # 跨平台 CI、定时生成与 Pages 发布
```

- `pku/` 内分别设置 `auth`、`elective`、`parser` 模块，无需再建目录层级。`entrypoints/node` 负责本地配置读取和文件输出；`entrypoints/pages-prepare` 调用共用生成逻辑，比较线上 ICS 并准备静态发布目录；`entrypoints/worker` 负责令牌、KV、刷新及 HTTP 响应；`worker-deploy` 仅导出部署处理器，避免 workerd 将测试辅助导出当作额外入口。`entrypoints/setup` 负责本地校历目录读取与初始化；`entrypoints/pages-setup` 通过本机 Git 与 GitHub CLI 初始化 GitHub 配置和触发首次发布。Pages 发布由 workflow 承担。
- 入口调用 `application`，由它编排 `pku → schedule → calendar`，核心不反向依赖入口。模块导出自己的数据类型，通过明确契约传递，不预设公共 `utils` 或全局 `types` 目录。
- `config/` 存放配置数据；共用配置校验属于 `application`，环境相关的读取与注入属于入口。网络、时钟等外部能力通过参数传入；文件系统、KV 和部署操作留在对应入口或 workflow。
- 根目录放置包清单、依赖锁文件、TypeScript、测试与 Wrangler 配置，随实现引入。本地私密数据放在已忽略的 `data/`，凭据使用未跟踪的环境文件；构建及工具缓存目录在引入时加入 `.gitignore`。测试样例不得包含真实个人数据。

## 3. 校历与事件规则

- 配置包含学期标识、首周周一、教学周数、节次起止时间表、停课日期和补课日期映射；两个入口读取相同含义的配置。
- 日期按 `Asia/Shanghai` 解释；单双周以教学周编号判断，支持同一课程多个时段。每次上课生成一个 `VEVENT`，首版不使用重复规则。
- 例外作用于整日课表：停课日期移除当日事件；补课映射“目标日期 → 原教学日期”从标准周课表取出原日课程，移至目标日并替换目标日课表，原日不再保留这些事件。源日期与目标日期一一对应且不重叠，目标日不得同时停课；例外不递归应用，冲突配置报错。
- UID 使用稳定日历命名空间、学期、课程号、班号、原教学日期和原时段身份计算摘要；不使用生成时间、标题、教师、地点或数组顺序。补课沿用原事件身份；新增与取消课程通过完整订阅快照反映。
- 校验必填字段、时间范围、文本转义、CRLF 与 UTF-8 折行。配置或解析异常使整次生成失败，不发布残缺日历。

实现约定：配置使用 JSON，`namespace`、`semester`、`firstMonday`、`teachingWeeks`、`timetable`、`holidays`、`makeups` 为用户配置必填项；不接受内联 `periods`。日期限 2000–2099 年，按上海时间计算后以 UTC `DTSTART` / `DTEND` 写入 ICS；折行限制为每行 75 个 UTF-8 字节（含续行空格）。`config/calendar.example.json` 是合成示例，不能作为官方校历。原时段身份由星期和起止节次组成；同课程、同原教学日、同节次的重复时段会报错。课程描述、地点及教学周文本排列均不参与摘要。

页面缺少学期标识时，使用显式 `semesterBinding`：`confirmedSemester` 必须等于顶层学期，`validFrom`、`validThrough` 是包含首尾两天的上海日期范围。仅在范围内允许生成；请求上游前和获取完成后均检查，Node 写入替换前及 Worker 写入 KV 前再检查。该范围限制生成时机，不裁剪课程事件日期。上游存在矛盾学期标识时拒绝生成；没有人工绑定时仍要求上游标识匹配。

用户配置 `CalendarSourceConfig` 通过 `timetable` 选择 `pku-main` 或 `pku-ss`，对应 `config/timetables/` 中的独立 JSON 文件。时间表包含 `label` 和 `periods`，与学期分离；软微由用户按实际观察维护，当前第 8 节映射为 13:00–13:50，以修正系统课时。`entrypoints/calendar-config` 使用相对于项目自身的固定 URL 映射，只读取所选表，统一用于 Node、状态检查、初始化、Pages 预检查与生成、Worker 构建。无效标识、文件缺失或所选表为空均拒绝，不回退；未选中表不会影响运行。节次编号作为映射键，不要求随实际时间递增。校验按编号规范化输出，另外按实际时间检查重叠，覆盖节次范围、时刻格式和重复编号。课程引用缺失节次，或连续节次内实际时间倒序，均在展开时拒绝，避免只取首尾而遗漏实际时段；不自动重排课程节次。

加载器将来源配置转换为仅含实际 `periods` 的 `CalendarConfig`，之后注入私密确认项。日历核心和 Worker 运行时只接收解析后的配置，不读取文件。Worker 构建嵌入解析结果，表内容变更需重新部署；Pages 在下一次生成时读取仓库中的表。时间表名称与标识不进入配置指纹；保留规范化字段顺序，使本部配置迁移后指纹保持一致。实际时间内容变化隔离缓存，但不改变基于节次身份的 UID。一份日历统一采用一套作息，选择不改变学期日期或假期。

`application/setup` 按北京时间从经过整理的官方校历中选择唯一有效学期，也支持显式学期参数；不按月份猜测或在定时生成时切换学期。`config/semesters.json` 记录学期、显示名称、校历文件、有效期末日和官方来源；初日取首周周一，末日取校历确定的学期结束日，教学周数独立配置。初始化写入显式绑定，保留已有不同配置及命名空间；系统日期匹配不替代用户对选课系统学期的确认。

无固定时间课程使用 `unscheduledCourses` 确认列表：每项包含学期、课程号、班号、`confirmed: true` 和完整 `expectedSegments`。只跳过匹配且说明未改变的课程；可解析的固定时段不能标记为无固定时间。确认列表属于个人选课数据，来自忽略的本地校历、Node 私密 JSON 文件（`--confirmations` 或 `PKU_UNSCHEDULED_COURSES_FILE`），或 `PKU_UNSCHEDULED_COURSES` 环境变量／Secret；多个来源冲突时报错。文件读取留在 Node 入口，Worker 使用运行时 Secret。确认项与校历一起组成有效配置指纹。Worker 构建不打包非空个人列表。列表中的课程退选后可正常生成完整快照。

## 4. 运行入口与失败处理

**静态入口**：本地生成 ICS；Actions 每天北京时间 06:17（UTC `17 22 * * *`）检查并支持手动触发。Pages 通过 `<token>/calendar.ics` 提供固定随机订阅地址，持有链接即可访问。仅在内容变化、首次返回 404 或 `force_publish=true` 时上传并部署；无变化时保留现有线上文件。artifact 显式保留一天，不提交源码或另存缓存基准。公开仓库的 artifact 在有效期内可被有读取权限的登录用户下载，这一边界不会因 Secret 遮蔽而改变。

`pages-prepare` 使用共用生成逻辑完整生成候选 ICS，再通过 HTTPS 读取实际 Pages base URL 下的当前订阅。请求禁止重定向、30 秒超时并要求缓存重新验证；仅 404 表示没有基准，网络异常、其他状态码和损坏内容均停止发布。`calendar/compare` 使用运行依赖 ical.js 解析并校验日历及事件必要字段、唯一 UID 和时间范围，规范化参数键、属性及组件排列，仅排除 VEVENT 的 DTSTAMP。其他内容与参数均参与比较；不依赖原始文件哈希。

需要发布时再次检查生成有效期，重建专用 `site/`，只写入当前令牌目录中的 ICS。部署成功后旧根路径和旧令牌路径随整站替换而移除，无兼容跳转；CDN 缓存可能延迟失效。无需发布时不写发布目录、不上传或部署。准备入口读取 `PAGES_CALENDAR_TOKEN`、`PAGES_BASE_URL`、`PAGES_FORCE_PUBLISH`，向 GITHUB_OUTPUT 仅写 changed 布尔值及 reason（missing/changed/unchanged/forced）；强制发布只绕过线上比较。

workflow 使用 configure-pages 的 base_url 支持实际项目路径和自定义域名，生成任务只增加 pages:read，部署任务保留 pages:write 和 id-token:write。所有上传／部署受 changed 控制；无变化时执行固定名 Calendar unchanged 步骤，作为初始化检查的明确成功标志。继续串行运行同一 Pages 工作流。令牌通过环境注入并在打包列出路径前注册遮蔽，错误不含私密 URL、原始响应或课表。

`npm run pages:setup -- --publish` 是显式公开发布命令。用户预先安装并登录 `gh`，手动提交和推送。命令从标准 `github.com` origin 地址确定目标，检查读取／推送目标一致、工作区干净且 HEAD 等于远端默认分支，再检查公共校历绑定、有效期和本地私密配置。公共校历拒绝个人确认字段；私密文件读取复用 Node 入口。GitHub 初始化逻辑不进入共用生成核心。

初始化前置检查完成后从 `data/pages/<owner>/<repo>.json` 读取令牌（仓库名小写）。首次以 32 字节安全随机数生成 base64url 令牌，原子保存，文件权限为 0600；远端已有 PAGES_CALENDAR_TOKEN 而本地缺失时停止，要求恢复文件或显式轮换。损坏文件不自动覆盖。`--rotate-token` 保存新令牌并强制发布，失败后普通重跑复用新值；`--force-publish` 仅强制发布。令牌与 Worker 的 CALENDAR_TOKEN 独立。

初始化先查询 Pages：仅 HTTP 404 作为未创建处理，其他错误停止；已有站点仅更新发布来源。随后通过子进程标准输入上传四个所需 Secrets（包括 PAGES_CALENDAR_TOKEN）（无确认项时写入 `[]`），启用工作流、复核远端提交、设置发布变量，使用 [GitHub REST API](https://docs.github.com/en/rest/actions/workflows#create-a-workflow-dispatch-event) `2026-03-10` 触发发布并获取返回的运行 ID。仅跟踪该 ID，核对其提交、运行结论及 generate/deploy 两个任务。接受 generate 与 deploy 均成功，或 generate 成功、Calendar unchanged 步骤成功且 deploy 跳过；强制发布或轮换时不接受跳过。根据 Pages API 实际站点地址和令牌构造订阅 URL，仅在本机结果中显示；禁止在 Actions 中运行初始化。每次子进程限时 60 秒，发布轮询限时 15 分钟。不会读取生成的个人 ICS 或打印远端原始错误；子进程移除私密课表环境变量和 gh 调试开关，Secrets 不进入参数或日志。

初始化可重复执行，不自动提交／推送、修改组织策略或绕过部署审批，不代替 CI 或日历客户端验收。失败保留已完成的配置并报告阶段，不尝试删除站点或回滚无法读取的旧 Secrets；已经开启的发布保持开启，等待超时不取消远端任务。

**Worker 部署初始化**：`npm run worker:setup -- --deploy` 在本机读取 `.env`、公共校历、所选时间表及私密确认列表；先验证学期与配置并执行不发布构建，再确定 Cloudflare 账号、Worker 和资源。它从本地构建发布，不依赖 GitHub 提交／推送状态。`--account` 优先于 `CLOUDFLARE_ACCOUNT_ID`、Wrangler `account_id` 和唯一可访问账号；`--name` 可覆盖 Worker 名称。入口只支持默认 workers.dev 部署，拒绝自定义环境、域名及额外 Wrangler 配置，关闭预览 URL。

部署职责分为 `entrypoints/worker-setup`（编排、公共配置生成及本机锁）、`worker-state`（私密状态验证和原子写入）与 `worker-cloudflare`（受控 Wrangler 子进程、Cloudflare 配置读取及 HTTP 验证）。Wrangler JSONC 使用 jsonc-parser 解析。认证、课表生成和 Worker HTTP 运行逻辑不依赖这些部署模块。

初始化通过 Wrangler `whoami --json`、`auth token --json` 使用已有 OAuth／API Token 登录，不解析 Wrangler 私有凭据存储格式（[官方命令说明](https://developers.cloudflare.com/workers/wrangler/commands/general/)）。子进程固定使用 `WRANGLER_LOG=log`，保留认证令牌和 KV 列表命令的 JSON 输出；`info` 会屏蔽这些输出。输出仅在进程内解析，不转发到终端。Cloudflare REST API 仅用于读取账号子域名、Worker bindings 与 workers.dev 启用状态；请求固定 API origin、拒绝重定向、30 秒超时，并隐藏原始错误。KV 的分页查询与创建、代码和 Secrets 发布均通过项目锁定版本的 Wrangler CLI 完成；部署固定目标账号和认证令牌。代码与 Secrets 同次发布使用官方 [`--secrets-file` 接口](https://developers.cloudflare.com/workers/configuration/secrets/#upload-secrets-alongside-code)。

首次随机令牌与 Pages 独立，以 `0600` 权限原子保存到忽略的 `data/worker/<account>/<name>.json`，字段为 `accountId`、`name`、`token` 和可选 `namespaceId`；令牌必须先于任何云端写入保存。KV 创建后补全 namespace ID。命令重跑复用 KV 和令牌；若创建响应丢失，本地已有状态时可按确定名称 `<name>-CALENDAR_KV` 恢复。没有本地状态时不自动接管同名 KV。远端已有订阅令牌而本地状态缺失时停止，要求恢复文件或显式 `--rotate-token`；损坏文件始终停止。本地、公开配置与远端 KV 冲突或 namespace 不可访问时停止，不替换缓存。

部署配置保存在同目录的 `<name>.wrangler.json`，运行时设置来自受验证的仓库 Wrangler 配置，构建 cwd 与主入口使用绝对路径；长期文件不包含密码或个人确认列表。一次部署将四个 Secrets 通过受限权限临时 JSON 交给 `wrangler deploy --secrets-file`；无课程确认项时显式同步 `[]`。Wrangler 子进程不继承 PKU／Pages 私密变量、调试选项、隐式 Cloudflare 环境或 API 地址覆盖；只向构建提供公共校历路径。临时 Secrets 与可能包含认证 stdout 的 Wrangler 日志均置于私密运行目录，正常完成或异常退出时清理，不转发原始子进程输出。强制终止可能残留临时目录和本机锁，需人工确认没有运行任务后清理。

部署成功后检查 workers.dev 路由，并用有界重试验证 GET 返回可解析 ICS、`fresh` 状态、Last-Modified、no-store，以及错误令牌 404；只在验证通过后输出完整订阅地址。验证失败与部署失败区分报告，保留已部署资源，不宣称完成云端验收，也不自动回滚。初始化拒绝 CI，以免完整订阅地址进入公共日志；macOS／Linux CI 只使用合成输入执行测试和两种部署配置的 dry-run。

**动态入口**：`GET /calendar/<token>.ics` 使用 Secret 中的长随机令牌校验，错误令牌返回 `404`。持有完整地址即可读取日历，令牌轮换后需重新配置订阅。

KV 保存最近成功的 ICS、生成时间和配置指纹，按账号、学期及有效配置隔离。成功版本不足 6 小时直接返回；过期或不存在时请求触发刷新，成功才替换副本。刷新失败返回同一配置下的旧版并标示其生成时间；无可用副本时返回 `503`，不能返回空日历。旧版不因超过刷新周期而删除。合并同一 Worker 实例内的并发刷新，不假设 KV 提供全局锁。

人工绑定有效期外不触发刷新；同配置下在有效期内生成的缓存仍可作为旧版返回，即使缓存不足六小时也标为 `stale`。有效期外生成的副本不作为有效缓存。修改有效期、确认学期或无固定时间确认列表会隔离缓存。

成功响应使用 `text/calendar; charset=utf-8`；日历客户端自行决定订阅刷新时间。凭据仅来自 Actions Secrets、Worker Secrets 或未跟踪的本地配置。日志只记录阶段、错误类别和耗时，不记录凭据、会话、原始页面、课表或完整订阅地址（本机初始化成功结果会显示私密订阅地址）。

入口接口：`npm run setup` 初始化校历，`npm run status` 校验所选时间表并显示其名称和日期状态；`npm run generate` 默认读取 `config/calendar.json`，输出 `data/calendar.ics`，可用 `--config <json> --output <ics>` 覆盖。成功后同目录临时文件原子替换。Worker 使用 `CALENDAR_KV` 绑定和 `PKU_USERNAME`、`PKU_PASSWORD`、`CALENDAR_TOKEN` Secrets。Wrangler 的 custom build 从 `PKU_CONFIG_PATH`（默认 `config/calendar.json`）读取并校验配置，打包进 Worker；不将 Secrets 打包。`npm run worker:check` 使用合成示例完成不发布的构建检查。

Worker 成功响应使用 `Last-Modified` 表示快照生成时间、`X-Calendar-Status: fresh|stale` 标示缓存状态，设置 `Cache-Control: private, no-store`，防止令牌轮换后中间缓存继续提供日历。KV 写入失败也保留旧版；配置错误与无可用副本返回 `503`。Pages workflow 通过仓库变量 `PUBLISH_CALENDAR=true` 显式启用，生成和上传成功后才执行部署。

## 5. 开发顺序与验收

1. **先验证上游与运行时**：按参考资料核实 RSA 加密、SSO、Cookie、重定向、页面字段、选课状态及学期识别；优先验证认证在 Node.js 与 Worker 均可运行。课程号、时段身份与校历匹配必须可靠，不能静默猜测。外部代码复用前检查许可证；不复制未经确认的 GPL 实现。
2. **实现共用核心**：使用合成或脱敏样例覆盖教学周、单双周、多时段、停补课、合法空课表及异常页面；验证 ICS 格式、中文折行、稳定 UID、字段修改与补课身份。
3. **接入两个入口**：相同输入与生成时间产生一致 ICS；覆盖令牌错误、缓存命中与过期、上游失败保留旧版、无副本 `503`、配置切换隔离和静态发布失败保留产物。
4. **配置跨平台验证**：macOS、Linux 使用相同的依赖安装、构建及测试命令，提交依赖锁文件；Wrangler 使用构建或 dry-run 检查。真实账号联调使用本地私密数据，CI 不依赖登录凭据。

真实账号认证、课表获取与日历生成已在 Node.js 和本地 workerd 验证。实际课表缺少学期标识，并含无可解析时间的已选课程；已按用户确认绑定秋季学期及无固定时间课程，并核对两入口事件一致性。离线验证、云端验证与待办边界详见 [验证记录](verification.md)。
