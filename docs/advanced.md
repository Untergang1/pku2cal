# 进阶使用

首次获取课表、生成日历和发布订阅，请先阅读 [README](../README.md)。本文用于查阅课表格式、自定义配置和发布故障处理；所有命令均在项目根目录运行。

## 编辑课表

`data/schedule.yaml` 是生成与发布使用的课程数据源。

示例见 [schedule.example.yaml](../config/schedule.example.yaml)：

```yaml
version: 1
semester: "2026-2027-1"
courses:
  - courseId: "00123456"
    classId: "01"
    name: 示例课程
    teacher: 示例教师
    slots:
      - status: scheduled
        weekday: 1
        startPeriod: 1
        endPeriod: 2
        weeks: "1-8,10-16"
        parity: all
        location: 示例教室
```

- `courseId`、`classId` 必须是字符串；数字形式用引号，保留前导零。课程号和班号组合唯一。手动加课可使用 `manual-` 前缀的课程号。
- `weekday` 为 1–7（周一至周日）；节次按公共校历所选作息表解释，不直接填写钟点。
- `weeks` 是字符串，使用数字、闭区间和英文逗号，如 `"1-8,10-16"`。`parity` 为 `all`、`odd` 或 `even`，按教学周编号筛选。
- 每个时段单独填写 `location`，可以为空字符串。同一课程多个时段放在 `slots` 中。教师没有信息时填写空字符串。
- 改课程名、教师、教室或调整排列不改变事件 UID；改星期、节次或课程身份时，订阅快照移除旧事件并添加新事件。
- 删除课程即可取消；`courses: []` 是合法空课表，发布后可清除订阅中的全部课程。
- 允许注释；不支持未知字段、标签、锚点、别名或重复字段。检查报告提供字段路径或 YAML 行列，不打印课表内容。

### 处理待确认时段

拉取无法识别的时段会保留原文：

```yaml
slots:
  - status: pending
    sourceText: 原始时间说明
```

确认有固定上课时间后，用前面示例中的完整 `scheduled` 时段替换这一项，并移除 `sourceText`。如果确认无需生成事件，则改为 `ignored` 并填写原因：

```yaml
slots:
  - status: ignored
    sourceText: 原始时间说明
    reason: 已确认无固定上课时间
```

同一课程可以有已解析和待处理时段。有任意 `pending` 时，检查、生成及发布都会失败；不会静默漏掉课程。`ignored` 必须填写原因。

检查、生成和发布只读课表，保留注释；重新拉取会完整替换课表。`importedAt` 是可选的导入时间，不参与 UID。

处理完后运行 `npm run schedule:check`，通过检查后再生成或发布。

## 重新拉取与文件保护

```sh
npm run schedule:pull -- --overwrite
```

此命令完整替换课表，**会覆盖手工修改，不合并旧文件**。不带 `--overwrite` 时，已有文件会在登录前拒绝覆盖。

获取、解析成功后，旧文件原样备份到 `data/backups/`，然后原子替换。备份、登录、页面完整性、学期检查失败或发现拉取期间文件被编辑时，不替换当前课表。备份不自动删除；文件权限为 `0600`。不要在拉取运行期间编辑文件。

## 自定义文件路径

以下以默认校历和自定义课表、输出路径为例：

```sh
npm run schedule:pull -- --config config/calendar.json --output data/custom.yaml
npm run schedule:check -- --config config/calendar.json --schedule data/custom.yaml
npm run generate -- --config config/calendar.json --schedule data/custom.yaml --output data/custom.ics
```

两个发布命令同样接受 `--config`、`--schedule`。缺少 YAML 会提示先拉取，绝不隐式联网获取课表。

自定义个人课表和状态文件仍应放在 Git 忽略的目录中。只有 `schedule:pull` 读取北大凭据，系统环境变量优先于 `.env`。

## 校历配置

个人 YAML 保存课程，校历配置保存学期、首周周一、教学周数、作息表、停课日期和补课映射。两份文件的学期必须一致。校历结构示例见 [calendar.example.json](../config/calendar.example.json)。

离线预设只收录校本部 2026–2027 第一学期校历；`setup` 按北京时间选择已收录的学期预设，默认使用软微作息（`pku-ss`），输出 `config/calendar.json`。仓库附带的该文件也使用软微作息。日常使用可直接编辑现有配置，再运行 `npm run status`。

若要明确选择已收录学期并另外创建一份配置：

```sh
npm run setup -- --semester 2026-2027-1 --output data/calendar.json
npm run status -- --config data/calendar.json
```

后续拉取、检查、生成和发布也需通过 `--config data/calendar.json` 使用这份配置。`setup` 不会覆盖已有的不同配置，也不能创建离线预设未收录的学期。官网已公布的新学期可使用下面的手动拉取命令；也可以按官方资料手工编辑配置。

### 手动拉取官方校历

```sh
# 预览当前配置对应学期的字段变化，不写校历或备份
npm run calendar:pull -- --dry-run
# 备份后更新默认配置
npm run calendar:pull -- --overwrite
# 明确切换到官网已公布的学期
npm run calendar:pull -- --semester 2026-2027-2 --overwrite
# 另存为独立配置
npm run calendar:pull -- --semester 2026-2027-2 --output data/calendar.json
```

`--output` 默认为 `config/calendar.json`。学期选择依次使用 `--semester`、目标文件中的学期、北京时间当前日期；只有目标不存在时才按日期选择。当前日期必须落在官网某学期上课日至考试结束日内，否则需要显式指定学期。不猜测尚未公布的学年，不回退到离线预设。

命令只获取[北大官方校历网页](https://www.pku.edu.cn/detail/3377.html)中的校本部春秋学期，不需要登录，也不读取 `.env`。教学周按上课日至考试开始前的完整周计算；日期无法明确对应完整教学周、停补课表述无法解析或出现矛盾时停止保存。“公休，课程照常进行”不记为停课或补课；补课必须明确实际日期和原教学日期，例如“10月11日补10月1日课”，不能仅凭“补周一的课”推断。

官方写明“另行通知”时，保存已公布内容并在终端列出待核对事项；这些提醒不写入配置，需自行记下并在安排公布后重新拉取或手工补充。校历不包含学院临时通知，也不自动应用社会调休安排。

已有配置必须用 `--overwrite` 才会替换；只保留 `namespace` 和 `timetable`，其余校历字段整体重建，包括拉取有效期。**手工停补课修订不会合并，需要重新补充**。新文件默认使用 `pku-main-calendar` 命名空间和 `pku-ss` 作息；可以保存后自行编辑。仍需在选课系统中确认当前学期，网页学期和日期窗口不能代替此检查。

覆盖前将原文件按字节备份到 `data/backups/`；配置损坏、抓取或校验失败、备份失败、拉取期间文件发生变化时保留原文件。不要在拉取期间编辑目标配置。`--dry-run` 不需要 `--overwrite`，不创建配置、备份、目录或锁，仅显示差异和提醒。校历更新不会修改课程 YAML，切换学期后须使用同学期课表；本地修改需重新生成、发布才会影响订阅。

### 作息与停补课规则

`timetable` 可选 `pku-main`（校本部）或 `pku-ss`（软件与微电子学院）。一份课表统一使用一套作息，切换只改变节次对应的时间，不改变学期日期、停补课安排。

两套内置时间表如下，均按北京时间（`Asia/Shanghai`）解释：

| 节次 | 校本部 | 软件与微电子学院 |
| --- | --- | --- |
| 1 | 08:00–08:50 | 08:30–09:20 |
| 2 | 09:00–09:50 | 09:30–10:20 |
| 3 | 10:10–11:00 | 10:30–11:20 |
| 4 | 11:10–12:00 | 11:30–12:20 |
| 5 | 13:00–13:50 | 14:00–14:50 |
| 6 | 14:00–14:50 | 15:00–15:50 |
| 7 | 15:10–16:00 | 16:00–16:50 |
| 8 | 16:10–17:00 | **13:00–13:50** |
| 9 | 17:10–18:00 | 18:00–18:50 |
| 10 | 18:40–19:30 | 19:00–19:50 |
| 11 | 19:40–20:30 | 20:00–20:50 |
| 12 | 20:40–21:30 | 21:00–21:50 |

**软微第 8 节的特殊处理**

软微时间表将选课系统中的第 8 节映射为 **13:00–13:50**，第 5–7 节仍为 **14:00–16:50**。这是根据实际观察对选课系统课时所做的手动映射，尚未经官方资料独立核实，请结合自己的课程安排确认。

连续节次会读取范围内每一节的实际时间，取最早开始和最晚结束，包含中间的课间间隔。因此，在当前映射下，5–8 节、7–8 节都会生成 **13:00–16:50** 的事件。时间表来源和调整依据见[参考资料](reference.md#时间语义与校历)。

`semesterBinding` 中的日期窗口只限制向选课系统拉取数据。没有绑定时，拉取要求上游明确给出匹配的学期；上游明确给出矛盾学期时始终拒绝，人工绑定不能覆盖该检查。已有本地课表在学期结束后仍可生成、发布和订阅。

停课配置会移除指定日期的课程。补课映射方向为“目标日期 → 原教学日期”：将原教学日的课程移到目标日，替换目标日原有课表，原日不再保留，事件身份不变。源和目标必须一一对应且不重叠，目标不能同时停课，也不会递归应用例外。节次范围包含其中全部编号，按实际时间取最早开始和最晚结束，保留课间间隔。详细规则见[系统设计](design.md#日历规则与事件身份)。

## GitHub Pages 进阶操作

基本发布步骤见 [README](../README.md#github-pages)。`pages:publish` 应在本机运行，它会：

1. 校验 YAML 和校历，在本机生成完整 ICS，不使用可能过时的本地 ICS 文件。
2. 检查工作区干净、`origin` 读写目标一致、本地 HEAD 等于远端默认分支；不自动提交或推送。
3. 初始化或复用 Pages 及 `data/pages/<owner>/<repo>.json` 中的订阅令牌。
4. 将令牌、ICS 和生成时间作为单个 gzip/Base64 快照上传到 `PAGES_CALENDAR_SNAPSHOT` Secret，设置 `PUBLISH_CALENDAR=true`，触发并跟踪本次手动 Actions 运行。
5. 工作流检查快照摘要、比较线上日历；有效内容相同则跳过部署，有变化才发布。完成后，本机命令输出订阅 URL。

个人 YAML 不上传至 Git，云端不登录北大。gzip/Base64 编码不是对公开产物的访问保护。快照编码上限为 45 KiB，解压后上限为 2 MiB；超限会停止，不自动拆分或转存仓库。手动工作流需要 `snapshot_id`，推荐始终通过本机命令触发；GitHub 界面无法获取你尚未发布的本地编辑。

支持实际 Pages 路径和自定义域名。初始化只用于本机，默认最多等待 15 分钟；超时不取消远端任务。线上比较的网络异常、非 200/404 响应或损坏日历都会停止发布，旧站点保留。

### Pages 隐私风险

**请把 Pages 上的课表视为公开可访问的数据。** 它包含上课时间、地点等个人安排；任何持有完整订阅地址的人，无需登录即可读取。

风险也不只来自链接泄露：Pages 部署会上传一份包含课表和令牌路径的 Actions 发布产物（artifact）。对于公开仓库，登录 GitHub 的用户可以在保留期内下载这份产物，从中取得课表及订阅地址中的令牌。访问条件见 [GitHub 官方说明](https://docs.github.com/en/actions/how-tos/manage-workflow-runs/download-workflow-artifacts)。

项目目前采取了以下措施来减少风险：

- 使用随机生成的长令牌作为地址的一部分，降低地址被猜中的可能。
- 凭据、个人课表文件、ICS 和本地令牌状态默认不加入 Git；发布内容与令牌通过 GitHub Secret 传递，北大凭据留在本机。
- 在 Actions 日志中遮蔽令牌，将发布产物的保留期设为一天。
- 仅手动发布；课表内容未变化时，跳过新的产物上传与部署。
- 支持轮换令牌，新部署会移除旧地址对应的文件。

这些措施**不能让 Pages 成为私有存储**。一天保留期只针对发布产物，不表示线上日历一天后下线；轮换令牌也无法收回已被下载的课表，旧地址的 CDN 缓存可能延迟失效。

### 强制发布与轮换令牌

```sh
npm run pages:publish -- --force-publish
npm run pages:publish -- --rotate-token
```

强制发布跳过线上比较。轮换复用原站点但更换地址并强制发布，旧路径随新部署移除；CDN 缓存可能延迟失效。轮换成功后需在日历应用中换成新地址；已经下载的课表无法收回。

### 备份与恢复

请私密备份 `data/pages/`，换电脑后恢复到相同位置。本地令牌丢失而远端已有 Secret 时，恢复文件或显式轮换，不能从 GitHub 读回 Secret。

## Cloudflare Worker 进阶操作

基本操作见 [README](../README.md#cloudflare-worker)。

部署命令从本地 YAML 生成 ICS，完成不发布构建检查，再通过 Wrangler 将快照随代码部署。Worker 仅返回这份快照，不访问选课系统、不创建或使用 KV；唯一必需 Secret 为 `CALENDAR_TOKEN`。修改 YAML 后再次部署即可更新。

首次初始化会保存 `data/worker/<账号 ID>/<Worker 名称>.json`，复用已有令牌；成功验证线上快照内容及错误令牌 404 后，输出 `https://<worker>.workers.dev/calendar/<令牌>.ics`。持有完整地址即可读取课表，请保密。

```sh
npm run worker:deploy -- --account <账号ID> --name pku2cal
npm run worker:deploy -- --rotate-token
```

多个账号时明确选择 `--account`，也支持 shell 中的 `CLOUDFLARE_ACCOUNT_ID`；认证使用 Wrangler OAuth 或 shell 中的 `CLOUDFLARE_API_TOKEN`。当前入口面向默认 `workers.dev`，不支持自定义域名、环境或额外绑定。

请私密备份 `data/worker/`。令牌丢失和损坏不会被自动覆盖；轮换失败后普通重跑复用已保存的新令牌。部署成功但验证失败会明确报错，不自动回滚。

云端已有部署但本地令牌文件缺失时，可恢复备份，或在接受更换地址的前提下显式使用 `--rotate-token`。

轮换成功后需在日历应用中换成新地址。损坏或与目标不符的状态文件需按报错修复或从备份恢复；换电脑后应将备份恢复到相同位置。使用自定义账号、名称或文件路径时，重跑和轮换也应指定相同参数。部署验证报错时，不应假定线上仍是旧课表。

本地 Worker 调试和异常中断后的文件清理见[开发与维护](development.md)。
