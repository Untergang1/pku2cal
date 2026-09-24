# pku2cal

将北京大学个人课表转换为 ICS 日历订阅，方便同步到 Apple Calendar 等支持 iCalendar 的日历应用。

## 项目状态

已实现共用核心、本地生成、GitHub Actions／Pages 和 Cloudflare Worker 入口，支持按官方校历初始化学期、带有效期的学期绑定及人工确认的无固定时间课程。2026–2027 秋季学期已完成 Node.js 与本地 Worker 的真实日历生成及事件一致性验证。验证边界见 [验证记录](docs/verification.md)。

开发使用 Node.js 22（至少 22.12）和 npm，执行 `npm ci`、`npm run check` 完成安装、类型检查、构建和离线测试。Worker 本地运行时使用与 Wrangler 匹配的 Miniflare。

跨平台目标：同一套代码和工具流程支持 macOS 与 Linux 的本地开发、测试、ICS 生成和部署，并通过两种系统的 CI 检查持续验证。

## 本地使用

在未跟踪的 `.env` 中填写凭据后，运行：

```sh
npm run setup
npm run status
npm run generate
```

`setup` 根据北京时间选择已收录的北大校本部官方校历，将学期和生成有效期写入 `config/calendar.json`；已有不同配置会保留。`status` 查看日期状态，`generate` 生成私密文件 `data/calendar.ics`。无固定时间课程需先人工确认；配置方式见 [使用说明](docs/usage.md)。

## 工作流程

北大账号认证 → 获取个人课表 → 解析课程时间与地点 → 生成 ICS → 日历应用订阅。

## 部署方式

两种方式共用课表处理与 ICS 生成逻辑，提供稳定的订阅地址：

| 方式 | 课表更新与服务 | 部署方式 |
| --- | --- | --- |
| 静态 ICS | GitHub Actions 定时获取课表并重新生成 ICS，GitHub Pages 托管产物 | 通过 GitHub Actions 发布到 Pages |
| 动态 ICS | Cloudflare Worker 动态提供 ICS 订阅响应 | 通过 Wrangler CLI 部署 |

服务端更新后，日历应用仍按自身的订阅刷新机制获取变化。配置、命令和部署步骤见 [使用说明](docs/usage.md)。

## 隐私与安全

个人课表、登录凭据、会话信息及包含个人信息的日历文件不应提交到仓库或输出到日志。凭据通过 GitHub Actions Secrets、Worker Secrets 或本地未跟踪的环境配置提供。

发布到 GitHub Pages 的 ICS 应按公开可访问资源处理；启用静态发布前，应确认可以接受课表内容被访问。

## 开发资料

- [AGENTS.md](AGENTS.md)：开发边界、数据处理与维护约定。
- [系统设计](docs/design.md)：首版技术路线、模块边界、日历规则与验收要求。
- [参考资料](docs/reference.md)：北大认证、课表获取、课程时间解析及 ICS 导出的外部实现线索。
