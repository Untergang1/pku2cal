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
- 当前结果页的 caption 仅写“学期课程表”，没有可验证的学期编号；学期匹配策略待明确，不能猜测。
- 合成认证用例在 Node.js 和 workerd 中通过，包含 RSA 填充、多个 Set-Cookie、相对跳转、Cookie 隔离、非法跳转和交互验证拒绝。
- macOS 与 GitHub 托管 Linux CI 已配置，尚未在远端执行。Cloudflare 云端尚未部署或验证。

## 核心验证

离线用例覆盖成功与失败选课状态、异常表格、分页拒绝、多时段、单双周、停补课、重复事件身份、配置冲突、中文与 emoji 折行、转义和独立 ICS 解析器回读。

完整生成流程在 Node 文件入口和 Worker 入口产生相同字节，并在 workerd 与本地 KV 绑定中通过。覆盖六小时缓存边界、失败回退、无副本 `503`、配置隔离、令牌轮换、并发刷新、损坏快照和原子文件替换。Linux 上 Wrangler dry-run 已通过，未向 Cloudflare 发布。

真实页面已通过结构解析。存在已选上课程的时间单元格仅有无法识别的括号文本；依设计整次生成失败，不自动忽略课程或编造时间。当前尚未产出真实账号的可验收日历。

## 交付检查（2026-09-24）

- 本地 Linux / Node.js 22.23.2：从锁文件 `npm ci` 安装成功，审计报告无已知漏洞；`npm run check` 通过类型检查、构建和 54 项测试；`npm run worker:check` 通过 Wrangler dry-run。
- Markdown 相对链接及 Git diff 空白检查通过；Git 未跟踪 `.env`、`data/`、ICS 或运行时缓存。
- 已整理 `config/pku-main-2026-2027-1.json`，来源为 [北大官方校历与作息](https://www.pku.edu.cn/detail/3377.html)。该文件没有自动启用，不能替代用户确认账号当前学期。
- 仍待：学期确认策略、无明确时间课程的处理决定、真实日历日期与课程核对、macOS／托管 Linux CI 执行。公开 Pages 与云端 Worker 未发布。
