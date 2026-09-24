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
docs/            # 系统设计、参考资料及使用说明
.github/
  workflows/     # 跨平台 CI、定时生成与 Pages 发布
```

- `pku/` 内分别设置 `auth`、`elective`、`parser` 模块，无需再建目录层级。`entrypoints/node` 供本地与 Actions 共用，负责配置读取和文件输出；`entrypoints/worker` 负责令牌、KV、刷新及 HTTP 响应；`worker-deploy` 仅导出部署处理器，避免 workerd 将测试辅助导出当作额外入口。`entrypoints/setup` 负责本地校历目录读取与初始化。Pages 发布由 workflow 承担。
- 入口调用 `application`，由它编排 `pku → schedule → calendar`，核心不反向依赖入口。模块导出自己的数据类型，通过明确契约传递，不预设公共 `utils` 或全局 `types` 目录。
- `config/` 存放配置数据；共用配置校验属于 `application`，环境相关的读取与注入属于入口。网络、时钟等外部能力通过参数传入；文件系统、KV 和部署操作留在对应入口或 workflow。
- 根目录放置包清单、依赖锁文件、TypeScript、测试与 Wrangler 配置，随实现引入。本地私密数据放在已忽略的 `data/`，凭据使用未跟踪的环境文件；构建及工具缓存目录在引入时加入 `.gitignore`。测试样例不得包含真实个人数据。

## 3. 校历与事件规则

- 配置包含学期标识、首周周一、教学周数、节次起止时间表、停课日期和补课日期映射；两个入口读取相同含义的配置。
- 日期按 `Asia/Shanghai` 解释；单双周以教学周编号判断，支持同一课程多个时段。每次上课生成一个 `VEVENT`，首版不使用重复规则。
- 例外作用于整日课表：停课日期移除当日事件；补课映射“目标日期 → 原教学日期”从标准周课表取出原日课程，移至目标日并替换目标日课表，原日不再保留这些事件。源日期与目标日期一一对应且不重叠，目标日不得同时停课；例外不递归应用，冲突配置报错。
- UID 使用稳定日历命名空间、学期、课程号、班号、原教学日期和原时段身份计算摘要；不使用生成时间、标题、教师、地点或数组顺序。补课沿用原事件身份；新增与取消课程通过完整订阅快照反映。
- 校验必填字段、时间范围、文本转义、CRLF 与 UTF-8 折行。配置或解析异常使整次生成失败，不发布残缺日历。

实现约定：配置使用 JSON，`namespace`、`semester`、`firstMonday`、`teachingWeeks`、`periods`、`holidays`、`makeups` 为必填项。日期限 2000–2099 年，按上海时间计算后以 UTC `DTSTART` / `DTEND` 写入 ICS；折行限制为每行 75 个 UTF-8 字节（含续行空格）。`config/calendar.example.json` 是合成示例，不能作为官方校历。原时段身份由星期和起止节次组成；同课程、同原教学日、同节次的重复时段会报错。课程描述、地点及教学周文本排列均不参与摘要。

页面缺少学期标识时，使用显式 `semesterBinding`：`confirmedSemester` 必须等于顶层学期，`validFrom`、`validThrough` 是包含首尾两天的上海日期范围。仅在范围内允许生成；请求上游前和获取完成后均检查，Node 写入替换前及 Worker 写入 KV 前再检查。该范围限制生成时机，不裁剪课程事件日期。上游存在矛盾学期标识时拒绝生成；没有人工绑定时仍要求上游标识匹配。

`application/setup` 按北京时间从经过整理的官方校历中选择唯一有效学期，也支持显式学期参数；不按月份猜测或在定时生成时切换学期。`config/semesters.json` 记录学期、显示名称、校历文件、有效期末日和官方来源；初日取首周周一，末日取校历确定的学期结束日，教学周数独立配置。初始化写入显式绑定，保留已有不同配置及命名空间；系统日期匹配不替代用户对选课系统学期的确认。

无固定时间课程使用 `unscheduledCourses` 确认列表：每项包含学期、课程号、班号、`confirmed: true` 和完整 `expectedSegments`。只跳过匹配且说明未改变的课程；可解析的固定时段不能标记为无固定时间。确认列表属于个人选课数据，来自忽略的本地校历、Node 私密 JSON 文件（`--confirmations` 或 `PKU_UNSCHEDULED_COURSES_FILE`），或 `PKU_UNSCHEDULED_COURSES` 环境变量／Secret；多个来源冲突时报错。文件读取留在 Node 入口，Worker 使用运行时 Secret。确认项与校历一起组成有效配置指纹。Worker 构建不打包非空个人列表。列表中的课程退选后可正常生成完整快照。

## 4. 运行入口与失败处理

**静态入口**：本地生成 ICS；Actions 默认每 6 小时运行并支持手动触发。完整生成成功后才部署 Pages，失败保留原产物。产物通过部署流程发布，不提交源码仓库；Pages 地址公开可访问。

**动态入口**：`GET /calendar/<token>.ics` 使用 Secret 中的长随机令牌校验，错误令牌返回 `404`。持有完整地址即可读取日历，令牌轮换后需重新配置订阅。

KV 保存最近成功的 ICS、生成时间和配置指纹，按账号、学期及有效配置隔离。成功版本不足 6 小时直接返回；过期或不存在时请求触发刷新，成功才替换副本。刷新失败返回同一配置下的旧版并标示其生成时间；无可用副本时返回 `503`，不能返回空日历。旧版不因超过刷新周期而删除。合并同一 Worker 实例内的并发刷新，不假设 KV 提供全局锁。

人工绑定有效期外不触发刷新；同配置下在有效期内生成的缓存仍可作为旧版返回，即使缓存不足六小时也标为 `stale`。有效期外生成的副本不作为有效缓存。修改有效期、确认学期或无固定时间确认列表会隔离缓存。

成功响应使用 `text/calendar; charset=utf-8`；日历客户端自行决定订阅刷新时间。凭据仅来自 Actions Secrets、Worker Secrets 或未跟踪的本地配置。日志只记录阶段、错误类别和耗时，不记录凭据、会话、原始页面、课表或完整订阅地址。

入口接口：`npm run setup` 初始化校历，`npm run status` 仅显示日期状态；`npm run generate` 默认读取 `config/calendar.json`，输出 `data/calendar.ics`，可用 `--config <json> --output <ics>` 覆盖。成功后同目录临时文件原子替换。Worker 使用 `CALENDAR_KV` 绑定和 `PKU_USERNAME`、`PKU_PASSWORD`、`CALENDAR_TOKEN` Secrets。Wrangler 的 custom build 从 `PKU_CONFIG_PATH`（默认 `config/calendar.json`）读取并校验配置，打包进 Worker；不将 Secrets 打包。`npm run worker:check` 使用合成示例完成不发布的构建检查。

Worker 成功响应使用 `Last-Modified` 表示快照生成时间、`X-Calendar-Status: fresh|stale` 标示缓存状态，设置 `Cache-Control: private, no-store`，防止令牌轮换后中间缓存继续提供日历。KV 写入失败也保留旧版；配置错误与无可用副本返回 `503`。Pages workflow 通过仓库变量 `PUBLISH_CALENDAR=true` 显式启用，生成和上传成功后才执行部署。

## 5. 开发顺序与验收

1. **先验证上游与运行时**：按参考资料核实 RSA 加密、SSO、Cookie、重定向、页面字段、选课状态及学期识别；优先验证认证在 Node.js 与 Worker 均可运行。课程号、时段身份与校历匹配必须可靠，不能静默猜测。外部代码复用前检查许可证；不复制未经确认的 GPL 实现。
2. **实现共用核心**：使用合成或脱敏样例覆盖教学周、单双周、多时段、停补课、合法空课表及异常页面；验证 ICS 格式、中文折行、稳定 UID、字段修改与补课身份。
3. **接入两个入口**：相同输入与生成时间产生一致 ICS；覆盖令牌错误、缓存命中与过期、上游失败保留旧版、无副本 `503`、配置切换隔离和静态发布失败保留产物。
4. **配置跨平台验证**：macOS、Linux 使用相同的依赖安装、构建及测试命令，提交依赖锁文件；Wrangler 使用构建或 dry-run 检查。真实账号联调使用本地私密数据，CI 不依赖登录凭据。

真实账号认证、课表获取与日历生成已在 Node.js 和本地 workerd 验证。实际课表缺少学期标识，并含无可解析时间的已选课程；已按用户确认绑定秋季学期及无固定时间课程，并核对两入口事件一致性。离线验证、云端验证与待办边界详见 [验证记录](verification.md)。
