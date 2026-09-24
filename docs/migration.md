# 从自动获取与补丁迁移

新版本以本地 YAML 为准。代码更新不会自动改变已部署的 Worker；旧 Pages cron 也要等远端默认分支更新后才停止。迁移操作均需手动运行，下面命令不会由安装或生成过程自动执行。

## 1. 备份并迁移个人课表

先私密备份 `.env`、旧课程确认与补丁文件，以及 `data/pages/`、`data/worker/`。不要把备份提交到 Git。

保留旧 `.env` 中的凭据、`PKU_UNSCHEDULED_COURSES[_FILE]` 和 `PKU_COURSE_SUPPLEMENTS[_FILE]`，选择正确校历，然后运行：

```sh
npm ci
npm run schedule:migrate
npm run schedule:check
npm run generate
```

`migrate` 是显式的首次导入：登录并拉取当前课表，按原规则核对确认列表及补丁，将确认课程写为 ignored 时段，将教室覆盖和新增课程直接写入 YAML。相同课程身份和时段继续使用原 UID。确认原文改变、学期矛盾、身份冲突或不可解析时间会停止，旧文件保留，不猜测。

目标 `data/schedule.yaml` 已存在时，迁移会拒绝覆盖。不要用迁移命令进行日常刷新。若已先执行普通拉取，请先将该 YAML 私密备份到其他路径，再选择迁移输出路径；检查后自行决定使用哪一份。

旧确认项可以来自旧校历或私密环境来源，互相冲突时拒绝；旧补丁仍通过环境变量或文件来源读取。仅云端存在的 Secret 无法读回，须恢复本地备份，不能自动恢复。未匹配现有课程的旧确认项和地点覆盖按旧规则忽略，退选课程不会重新加入。

迁移不会删除旧文件或编辑 `.env`。检查 YAML 后可从 `.env` 移除旧确认和补丁变量；正常拉取、生成和发布均不再读取它们。如果旧校历内嵌 `unscheduledCourses`，迁移成功后还需从公共校历移除该字段，再执行新版本检查。当前公共校历不允许个人字段。

以后直接编辑 YAML，或显式完整刷新：

```sh
npm run schedule:pull -- --overwrite
```

刷新会备份旧 YAML 并覆盖手工修改，不会再次套用旧补丁。

## 2. 迁移 Pages，保持订阅地址

提交并手动推送新代码与工作流到远端默认分支，使旧 cron 消失；不要提交 YAML、ICS 或凭据。确认旧工作流没有正在运行的任务后发布：

```sh
npm run pages:publish
```

它复用 `data/pages/<owner>/<repo>.json` 中的令牌和现有站点，把本地生成的快照上传为一个 Secret，手动部署。已有 URL 不变。首次迁移成功（包括明确无变化）后，清理该仓库中旧的 PKU_USERNAME、PKU_PASSWORD、PKU_UNSCHEDULED_COURSES、PKU_COURSE_SUPPLEMENTS 及 PAGES_CALENDAR_TOKEN Secrets。

清理失败会报告“发布成功、清理未完成”；重新运行同一命令即可重试。本地令牌缺失时停止，请恢复状态文件；只有接受更换订阅地址时才使用 `--rotate-token`。

原 `pages:setup -- --publish` 改为 `pages:publish`。GitHub 界面手动工作流只能发布已经上传的快照，不能读取电脑上的修改。

## 3. 迁移 Worker，保持订阅地址

```sh
npm run worker:deploy
```

命令复用现有账号、名称、令牌；识别旧 CALENDAR_KV 与 PKU Secrets 绑定，核对本地旧 namespace 是否一致。新部署使用内嵌快照，不再访问北大或 KV。

旧状态保存为同目录 `.pre-snapshot.bak`。新版本验证成功后才从当前状态移除 namespace 字段、删除旧 PKU Secrets；namespace、历史 KV 内容和 Cloudflare 历史部署仍保留，不自动销毁。需要彻底清理历史个人数据时，在核对备份与回滚需求后自行清理这些资源。

失败后重跑同一命令。已经保存新令牌的轮换失败后不要再次附加 `--rotate-token`，以免重复轮换。丢失状态时恢复备份；对无法识别的同名 Worker 不自动接管。

原 `worker:setup -- --deploy` 和 npm 中直接调用 Wrangler 的入口统一为 `worker:deploy`。低层 Wrangler CLI 仍可自行使用，但不会自动执行本项目的状态迁移和线上验证。

## 4. 完成核对

- YAML 包含所需课程，所有 pending 都已处理；本地 ICS 的名称、教室、日期和时间正确。
- 两个平台仍使用原有订阅地址，线上内容与本次本地生成结果一致。
- Pages 默认分支不再有定时发布；Worker 已更新为 snapshot-v1，不再绑定 KV。
- 新发布成功后旧 PKU Secrets 已清理；电脑中凭据仍仅供手动拉取。
- 日历客户端最终显示需要实测；离线测试和平台发布成功不能代替客户端验收。
