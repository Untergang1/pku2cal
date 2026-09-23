# pku2cal

将北京大学个人课表转换为 ICS 日历订阅，方便同步到 Apple Calendar 等支持 iCalendar 的日历应用。

## 项目状态

仓库已初始化，功能尚未实现。

跨平台目标：同一套代码和工具流程支持 macOS 与 Linux 的本地开发、测试、ICS 生成和部署，并通过两种系统的 CI 检查持续验证。

## 计划工作流程

北大账号认证 → 获取个人课表 → 解析课程时间与地点 → 生成 ICS → 日历应用订阅。

## 计划部署方式

两种方式共用课表处理与 ICS 生成逻辑，提供稳定的订阅地址：

| 方式 | 课表更新与服务 | 部署方式 |
| --- | --- | --- |
| 静态 ICS | GitHub Actions 定时获取课表并重新生成 ICS，GitHub Pages 托管产物 | 通过 GitHub Actions 发布到 Pages |
| 动态 ICS | Cloudflare Worker 动态提供 ICS 订阅响应 | 通过 Wrangler CLI 部署 |

服务端更新后，日历应用仍按自身的订阅刷新机制获取变化。具体配置和部署步骤将在功能实现后补充。

## 隐私与安全

个人课表、登录凭据、会话信息及包含个人信息的日历文件不应提交到仓库或输出到日志。凭据通过 GitHub Actions Secrets、Worker Secrets 或本地未跟踪的环境配置提供。

发布到 GitHub Pages 的 ICS 应按公开可访问资源处理；启用静态发布前，应确认可以接受课表内容被访问。

## 开发资料

- [AGENTS.md](AGENTS.md)：开发边界、数据处理与维护约定。
- [参考资料](docs/reference.md)：北大认证、课表获取、课程时间解析及 ICS 导出的外部实现线索。
