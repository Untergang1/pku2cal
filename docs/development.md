# 开发与维护

日常使用见 [README](../README.md)，配置和发布参数见[进阶使用](advanced.md)。本文面向修改代码、调试 Worker 或维护本地工作目录的使用者。

## 开发环境与验证

macOS 与 Linux 使用相同的 Node.js 22（至少 22.12）和 npm 流程。在项目根目录运行 `npm ci` 安装依赖。

按变更范围选择验证命令，例如：

```sh
npm run typecheck
npm run build
npm test -- tests/unit/document.test.ts tests/integration/entrypoints.test.ts
npm run worker:check
```

上述测试覆盖课表文档与生成入口；修改其他部分时选择对应测试。小范围、低风险变更优先审阅 diff，文档变更检查内容与链接即可。需要测试时只运行直接相关的最小范围，通过后无需扩大验证。

CI 在 macOS 和 Linux 上使用相同的 `npm ci`、`npm run check` 和 `npm run worker:check` 命令。`check` 包含类型检查、构建与完整测试；`worker:check` 使用合成数据检查两种 Worker 构建配置，运行 Wrangler dry-run，不发布服务。自动测试和这些 dry-run 不依赖真实北大凭据。

实现与验收情况见[验证边界](verification.md)。自动测试通过不等于真实发布或日历客户端显示已经验收。

## Worker 本地调试

准备本地课表 YAML，在被 Git 忽略的 `.dev.vars` 中设置 `CALENDAR_TOKEN`，然后运行：

```sh
npm run worker:dev
```

Worker 使用构建时生成的日历快照，不会因为收到订阅请求而拉取课表。自定义构建输入可通过 `PKU_CONFIG_PATH`、`PKU_SCHEDULE_PATH` 指定；日常部署优先使用 `worker:deploy` 的 `--config`、`--schedule` 参数。

使用个人课表构建的产物包含个人 ICS，不要提交或公开分享。`.dev.vars`、本地数据和部署状态同样需要保密。

## 异常中断与文件清理

正常完成或报错时，命令会自动清理临时文件和锁。如果进程被强制终止，先确认没有相关命令仍在运行，再清理对应 `.lock` 目录或 Worker `.run-*` 私密临时目录。后者可能包含临时快照、Secrets 和 Wrangler 日志，不要公开上传排障。

`data/backups/` 中的课表备份不会自动删除，可在确认不再需要后自行清理。保留正在使用的课表、ICS、部署配置及 `data/pages/`、`data/worker/` 中的令牌状态；恢复方式见[进阶使用](advanced.md)。

`npm run build` 会先清理 `dist` 子目录中已无对应源码的编译产物，保留有效输出和根目录 Worker bundle。在没有运行中任务时，可以删除 `.cache/` 与依赖中的测试缓存。

## 实现资料

- [系统设计](design.md)：模块职责、数据契约、文件保护、事件身份和发布流程。
- [验证边界](verification.md)：自动覆盖、实测情况及尚未验证的部分。
- [参考资料](reference.md)：上游页面、认证、时间表依据和许可证边界；修改课表获取功能前先阅读。
