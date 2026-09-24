# pku2cal

将北京大学个人课表手动导入为可编辑 YAML，再生成 ICS，导入或订阅到 Apple Calendar 等日历应用。

**`data/schedule.yaml` 是唯一课程数据源。** 生成与发布以你编辑后的文件为准，不登录北大、不覆盖课表。只有显式拉取会获取选课系统的数据；没有定时获取或订阅请求触发的刷新。

支持教学周、单双周、同一课程多个时段、独立教室和校历停补课。时间按 `Asia/Shanghai` 解释。提供 GitHub Pages 和 Cloudflare Worker 两种固定地址订阅，内容仅在手动发布后更新；客户端按自身刷新机制获取。

## 安装与首次使用

macOS、Linux 使用 Node.js 22（至少 22.12）与 npm：

```sh
npm ci
npm run setup
npm run status
```

`setup` 选择已收录的官方校历，写入 `config/calendar.json`；已有不同配置不会覆盖。`status` 显示所选学期、作息时间表及当前是否允许拉取。请先在选课系统确认账号的当前学期；系统日期不能代替这一步。

复制 `.env.example` 为 `.env`，填写 `PKU_USERNAME` 和 `PKU_PASSWORD`。凭据仅用于手动导入，系统环境变量优先于 `.env`。扫码或交互验证暂不支持。`.env`、`data/`、ICS、构建产物均由 Git 忽略，不要提交个人数据。

```sh
npm run schedule:pull
# 编辑 data/schedule.yaml
npm run schedule:check
npm run generate
```

生成结果为 `data/calendar.ics`。可以直接导入日历应用；直接导入的文件不会自动更新。

## 编辑课表

示例见 [config/schedule.example.yaml](config/schedule.example.yaml)：

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

拉取无法识别的时段会保留原文：

```yaml
slots:
  - status: pending
    sourceText: 原始时间说明
```

把它改为完整的 `scheduled` 时段，或人工确认无需生成事件后改为：

```yaml
slots:
  - status: ignored
    sourceText: 原始时间说明
    reason: 已确认无固定上课时间
```

同一课程可以有已解析和待处理时段。有任意 `pending` 时，检查、生成及发布都会失败；不会静默漏掉课程。`ignored` 必须填写原因。

所有正常命令只读课表，保留注释。`importedAt` 是可选的导入时间，不参与 UID。

## 重新拉取与文件保护

```sh
npm run schedule:pull -- --overwrite
```

此命令完整替换课表，**会覆盖手工修改，不合并旧文件**。不带 `--overwrite` 时，已有文件会在登录前拒绝覆盖。

获取、解析成功后，旧文件原样备份到 `data/backups/`，然后原子替换。备份、登录、页面完整性、学期检查失败或发现拉取期间文件被编辑时，不替换当前课表。备份不自动删除；文件权限为 `0600`。不要在拉取运行期间编辑文件。

自定义路径：

```sh
npm run schedule:pull -- --config config/calendar.json --output data/custom.yaml
npm run schedule:check -- --config config/calendar.json --schedule data/custom.yaml
npm run generate -- --config config/calendar.json --schedule data/custom.yaml --output data/custom.ics
```

两个发布命令同样接受 `--config`、`--schedule`。缺少 YAML 会提示先拉取，绝不隐式联网获取课表。

## 校历与作息时间

个人 YAML 只保存课程；学期、首周周一、教学周数、作息表、停课日期、补课映射继续放在公共校历中。YAML 和校历的学期必须一致。

仓库提供校本部 2026–2027 第一学期校历及 `pku-main`、`pku-ss` 两套节次表。其他学期和校区需核对官方校历；选择软微作息不会改变学期日期或假期。

```sh
npm run setup -- --semester 2026-2027-1 --output data/calendar.json
```

`semesterBinding` 的日期窗口仅限制向选课系统拉取数据，本地课表在学期结束后仍可生成、发布和订阅。没有绑定时，拉取要求上游明确给出匹配学期；上游学期矛盾始终拒绝。

一份课表统一使用一套作息。节次范围包含其中全部编号，按实际时间取最早开始和最晚结束，保留课间间隔；软微第 8 节早于 5–7 节的情况也适用。停课移除当日课程；补课映射为“目标日期 → 原教学日期”，替换目标日课表，原事件身份保持不变。详细规则见[系统设计](docs/design.md)。

## GitHub Pages 手动发布

**Pages 的完整链接持有者可以访问课表。** 公开仓库的登录用户还可能下载保留期内的 Actions artifact；artifact 保留一天。令牌路径降低被猜到的风险，不改变这些访问边界。

安装并登录 [GitHub CLI](https://cli.github.com/)，将代码提交并手动推送到自己的 GitHub 仓库默认分支：

```sh
gh auth login
git push origin main
npm run pages:publish
```

运行命令即表示公开发布当前本地课表。命令会：

1. 校验 YAML 和校历，在本机生成完整 ICS，不使用可能过时的本地 ICS 文件。
2. 检查工作区干净、`origin` 读写目标一致、本地 HEAD 等于远端默认分支；不自动提交或推送。
3. 初始化或复用 Pages 及 `data/pages/<owner>/<repo>.json` 中的订阅令牌。
4. 将令牌、ICS 和生成时间作为单个 gzip/Base64 快照上传到 `PAGES_CALENDAR_SNAPSHOT` Secret，手动触发并跟踪本次 Actions 运行。
5. 工作流检查快照摘要、比较线上日历；有效内容相同则跳过部署，有变化才发布并输出订阅 URL。

个人 YAML 不上传至 Git，云端不登录北大。快照编码上限为 45 KiB，解压后上限为 2 MiB；超限会停止，不自动拆分或转存仓库。手动工作流需要 `snapshot_id`，推荐始终通过本机命令触发；GitHub 界面无法获取你尚未发布的本地编辑。

支持实际 Pages 路径和自定义域名。初始化只用于本机，默认最多等待 15 分钟；超时不取消远端任务。线上比较的网络异常、非 200/404 响应或损坏日历都会停止发布，旧站点保留。

```sh
npm run pages:publish -- --force-publish
npm run pages:publish -- --rotate-token
```

强制发布跳过线上比较。轮换复用原站点但更换地址并强制发布，旧路径随新部署移除；CDN 缓存可能延迟失效。备份 `data/pages/`；本地令牌丢失而远端已有 Secret 时，恢复文件或显式轮换，不能从 GitHub 读回 Secret。

## Cloudflare Worker 手动部署

先在 Cloudflare 设置 `workers.dev` 子域名，并登录：

```sh
npx wrangler login
npm run worker:deploy
```

命令从本地 YAML 生成 ICS，完成不发布构建检查，再通过 Wrangler 将快照随代码部署。Worker 仅返回这份快照，不访问选课系统、不创建或使用 KV；唯一必需 Secret 为 `CALENDAR_TOKEN`。修改 YAML 后再次部署即可更新。

首次初始化会保存 `data/worker/<账号 ID>/<Worker 名称>.json`，复用已有令牌；成功验证线上快照内容及错误令牌 404 后，输出 `https://<worker>.workers.dev/calendar/<令牌>.ics`。持有完整地址即可读取课表，请保密。

```sh
npm run worker:deploy -- --account <账号ID> --name pku2cal
npm run worker:deploy -- --rotate-token
```

多个账号时明确选择 `--account`，也支持 shell 中的 `CLOUDFLARE_ACCOUNT_ID`；认证使用 Wrangler OAuth 或 shell 中的 `CLOUDFLARE_API_TOKEN`。当前入口面向默认 `workers.dev`，不支持自定义域名、环境或额外绑定。

请私密备份 `data/worker/`。令牌丢失和损坏不会被自动覆盖；轮换失败后普通重跑复用已保存的新令牌。部署成功但验证失败会明确报错，不自动回滚。

本地开发：在忽略的 `.dev.vars` 设置 `CALENDAR_TOKEN`，准备本地 YAML 后运行 `npm run worker:dev`。自定义构建输入可通过 `PKU_CONFIG_PATH`、`PKU_SCHEDULE_PATH` 指定；日常发布优先使用 CLI 参数。构建产物包含个人 ICS，不要提交或公开分享。

## 验证与维护

```sh
npm run typecheck
npm run build
npm test -- tests/unit/document.test.ts tests/integration/entrypoints.test.ts
npm run worker:check
```

CI 在 macOS、Linux 上使用相同安装、构建、测试与 Worker dry-run 命令；所有测试和 dry-run 使用合成数据，不依赖真实凭据。按变更运行相关测试即可，无需为小改动运行完整套件。

如果进程被强制终止，先确认没有运行中的命令，再清理对应 `.lock` 目录或 Worker `.run-*` 私密临时目录；正常完成或报错会自动清理。课表备份不会自动删除。

`npm run build` 会先清理 `dist` 子目录中已无对应源码的编译产物，保留有效输出和根目录 Worker bundle。缓存 `.cache/` 与依赖中的测试缓存可在没有运行中任务时删除；保留正在使用的 ICS、部署配置和私密状态。

实现和验收边界见[系统设计](docs/design.md)及[验证边界](docs/verification.md)，上游资料与时间表依据见[参考资料](docs/reference.md)。
