# 系统设计

## 数据流与职责

```text
显式 schedule:pull / schedule:migrate
  → pku 认证、获取、页面解析
  → 导入结构化课程（未知时间保留 pending）
  → data/schedule.yaml
用户编辑 YAML
  → 校验 + 公共校历/作息表
  → schedule 展开日期与节次 → calendar 序列化 ICS
  → 本地文件 / Pages 快照发布 / Worker 快照部署
```

- `pku/`：仅 Node 手动导入使用。会话只在一次请求流程内存中存活，不保存 HTML、Cookie 或凭据。
- `application/import`：拉取前后检查学期绑定及日期窗口，解析上游课程，生成可编辑文档。
- `schedule/document`：YAML 1.2、安全解析、结构和业务校验，转换为统一 `ScheduledCourse` / `Slot`。
- `application/generate`：纯离线函数，接收文档、解析后的校历和生成时间，无凭据、网络或文件依赖。
- `schedule/expand`、`calendar/ics`：课程展开和 ICS 生成；不知道上游 HTML、补丁或部署方式。
- `entrypoints/`：文件保护、命令参数、部署编排、HTTP 响应；`migration/` 隔离旧人工配置读取，仅显式迁移可达。

## 当前数据契约

`ScheduleDocument` 包含 `version: 1`、`semester`、`courses` 和可选 `importedAt`。课程必须包含字符串 `courseId/classId/name/teacher` 和非空 `slots`；课程号和班号组合唯一。合法空课表使用空课程数组。

时段为判别联合：

| status | 字段 | 生成行为 |
| --- | --- | --- |
| scheduled | weekday、startPeriod、endPeriod、weeks、parity、location | 展开为事件 |
| pending | sourceText | 阻止整份日历生成与发布 |
| ignored | sourceText、reason | 明确不生成该时段 |

星期 1–7，节次 1–30，节次范围必须完全存在于所选作息表。`weeks` 是数字或闭区间的逗号列表，范围限定在公共校历教学周内；`parity` 为 all/odd/even。先取区间并集，再按教学周编号筛选单双周，结果不得为空。相同课程同周、同星期及同节次的重复事件拒绝；不同课程允许时间重叠。

公共 `CalendarSourceConfig` 使用 `namespace/semester/firstMonday/teachingWeeks/timetable/holidays/makeups` 及可选 `semesterBinding`。不含个人确认或补丁字段。作息表按固定标识 pku-main/pku-ss 加载为 `CalendarConfig.periods`，只读取所选表；不回退至其他表。

YAML 拒绝重复键、未知字段、错误类型、自定义标签、锚点和别名。错误仅显示已知字段路径、数组下标或行列，不复述输入值。生成、检查和发布不会重新序列化 YAML；用户注释保持原样。导出自动引用易混淆的数字字符串。

## 导入与文件事务

普通拉取完全替换，不读取补丁或合并手工修改。目标存在且未给 `--overwrite` 时，在登录前失败。上游结构、身份、选课状态、分页或学期异常使整次拉取失败；单个无法识别的时间保留为 pending。拉取后仍校验可识别时段和课程身份。

以目标路径加 `.lock` 目录串行化本机拉取。读取旧文件字节，拉取完成后再次比较；显式覆盖先创建唯一备份，再写同目录临时文件，替换前重新检查原文件与日期窗口。首次创建使用原子且不覆盖的 link；已有文件使用 rename。备份失败或目标变化不会覆盖课表；正常失败清理临时文件和锁。外部编辑器不共享此锁，因此运行拉取时不要编辑文件。

所有私密文件使用 0600，新建私密目录使用 0700。`data/backups` 不自动清理，损坏旧 YAML 也按原字节备份。缺失课表始终报错，不隐式联网。

日期窗口仅限制向上游拉取。没有 `semesterBinding` 时必须取得上游明确匹配的学期；人工绑定不能覆盖矛盾学期证据。离线生成只要求 YAML 与公共校历学期一致，不依赖当前日期。

## 日历规则与事件身份

按 Asia/Shanghai 解释课程，每次上课对应一个 VEVENT。节次范围读取所有编号，按实际时刻排序，取最早开始和最晚结束，包含课间间隔。缺失节次或作息时刻实际重叠拒绝；编号不必按实际时间递增。

停课删除原日课程。补课映射“目标日期 → 原教学日期”从标准周课表取原日课程，替换目标日课表，原日不再保留。源和目标一一对应且不重叠，目标不能同时停课；不递归应用例外。

UID 继续使用 SHA-256(JSON 数组)：namespace、semester、courseId、classId、原教学日期、weekday、startPeriod、endPeriod，后缀 `@pku2cal`。名称、教师、地点、数组顺序及生成时间不参与。补课沿用原身份；更改星期或节次按移除旧事件、添加新事件处理。

ICS 使用 UTC DTSTART/DTEND、中文文本转义、CRLF 和每行最多 75 UTF-8 字节（包含续行空格）。相同文档、校历与生成时间应产生相同字节。校验失败不生成残缺快照。

## Pages 发布

本机 `pages:publish` 完整生成当前课表快照；不读取现存 ICS 作为输入。检查工作区、远端默认分支及标准 github.com origin，复用本地 Pages 状态中的令牌。令牌缺失但远端已有新旧 Secret 时，要求恢复状态或显式轮换。

单一 `PAGES_CALENDAR_SNAPSHOT` Secret 保存 gzip/Base64 编码的 `{version:1,token,ics,generatedAt}`。编码上限 45 KiB，解压 JSON 上限 2 MiB；上传前验证完整日历、令牌和大小。不自动分片，不把私密快照加入 Git。

workflow_dispatch 必须传入整个编码载荷的 SHA-256 `snapshot_id`；工作流检查摘要后解压、验证并遮蔽令牌。GitHub 在运行入队时读取仓库 Secret，摘要不一致则失败，避免并发更新错误发布。工作流无 schedule/push 发布触发，只有手动触发；保留 `PUBLISH_CALENDAR=true` 开关和远端部署串行组。

线上比较使用实际 Pages base URL、HTTPS、30 秒超时、禁止重定向。仅 404 表示首次发布；非 200/404、网络异常或损坏 ICS 都停止。语义比较只忽略 VEVENT DTSTAMP 及格式顺序差异，其他字段参与。无变化不打包、不部署；变化、首次发布或强制发布才准备专用 site 目录并上传一天保留期的 artifact。

初始化和日常发布共用入口，本机通过 `data/pages/publish.lock` 串行化；远端仅跟踪本次 dispatch 返回的运行 ID。默认等待 15 分钟，超时不取消远端任务。新工作流成功后才删除旧 PKU 与 Pages 令牌 Secrets；失败保留新发布并报告清理未完成。

## Worker 发布与响应

本机 `worker:deploy` 校验并生成快照，以 0600 临时文件将同一份快照传给 dry-run 和实际 Wrangler 构建，防止中途编辑使校验与部署使用不同输入。构建仅打包 Worker HTTP 逻辑和 ICS，不包含认证、课表解析或日历生成模块。

Worker runtime 使用 `CALENDAR_TOKEN`；配置标记 `PKU2CAL_MODE=snapshot-v1` 用于确认部署身份。无 KV、定时任务或请求触发刷新。GET 正确令牌返回内嵌快照，错误令牌 404，其他方法 405，缺失有效快照或令牌 503。响应设置 text/calendar、private/no-store、nosniff 及快照生成时间 Last-Modified，不再提供 fresh/stale 状态。

部署前先保存令牌，再发布代码与 Secret。验证线上 ICS 与候选语义一致、Last-Modified 有效及错误令牌 404；部署与验证失败分别报告。最多六次验证，每次请求限时 30 秒、间隔 5 秒。临时快照、Secrets、Wrangler 日志由 0700 `.run-*` 目录保存并在结束后清理，本机锁防止并发。

迁移保留原账号、Worker 名和令牌，备份旧状态、解绑 KV；不删除 namespace 和历史数据。仅验证成功后移除旧 namespace 状态字段并显式删除旧 PKU Secrets。新旧状态识别只为已有部署迁移，不引入运行时兼容路径。详细操作见[迁移指南](migration.md)。
