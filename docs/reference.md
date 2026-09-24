# 参考资料与实现依据

本文保留上游定位、已有核查依据和本项目与参考实现的差异。当前架构见[系统设计](design.md)，运行方法见 [README](../README.md)，验证范围见[验证边界](verification.md)。

## 上游来源与许可证

| 来源 | 用途与已有核查 | 复用边界 |
| --- | --- | --- |
| [pkucli](https://github.com/pkuinfo/pkucli/tree/0ad6dea1802abc98825dc57b07b75da4dee1c9f4) | 认证、会话及选课结果页面；已核查版本 `0ad6dea1802abc98825dc57b07b75da4dee1c9f4` | [MIT](https://github.com/pkuinfo/pkucli/blob/0ad6dea1802abc98825dc57b07b75da4dee1c9f4/LICENSE)，版权归 pkuinfo team；本项目独立实现，未复制源码 |
| [PekingParser](https://github.com/dIT8Zv/WakeupSchedule_BUPT/blob/master/app/src/main/java/com/suda/yzune/wakeupschedule/schedule_import/parser/PekingParser.kt) | 北大时间字符串、多时段与单双周语义 | 既有记录已核对根目录 Apache-2.0；不复用固定列号及默认时间 |
| [Sleepy](https://github.com/lingion/sleepy) 的 `ScheduleExporter.kt` | ICS 导出行为参考 | GPL-3.0；不复制实现 |
| [RFC 5545](https://www.rfc-editor.org/rfc/rfc5545) | ICS 格式、文本转义和折行 | 日历格式依据 |

修改上游集成或复用代码前，应重新核对所用版本、页面假设和许可证。

## 认证与页面获取

pkucli 的定位文件：

- `crates/common/src/iaaa.rs`：`IaaaConfig`、`login_password()`、`encrypt_password()`；扫码登录不是本项目支持的能力。
- `crates/elective/src/client.rs`、`login.rs`：SSO 地址、Cookie 与重定向，以及主修／辅双学位选择。
- `crates/elective/src/api.rs`：`SHOW_RESULTS`、`get_results()`、`follow_and_read()`、`parse_datagrid_table()`。

密码登录先 GET `https://iaaa.pku.edu.cn/iaaa/getPublicKey.do`，使用 RSA PKCS#1 v1.5 与 Base64 编码密码，再 POST `https://iaaa.pku.edu.cn/iaaa/oauthlogin.do`。选课应用使用 `app_id=syllabus`，认证字段的 `redirect_url` 为 `http://elective.pku.edu.cn:80/elective2008/ssoLogin.do`；实际选课请求升级为 HTTPS。

携带 IAAA token 请求 `https://elective.pku.edu.cn/elective2008/ssoLogin.do` 后获取选课会话。只允许 IAAA 与选课系统两个 origin，手动处理 Cookie 和重定向，会话仅存在于一次导入的内存中。主修标识为 `bzx`，辅修／双学位为 `bfx`；本项目读取主修课表。

选课结果地址为 `https://elective.pku.edu.cn/elective2008/edu/pku/stu/elective/controller/electiveWork/showResults.do`，核心表格为 `table.datagrid`。既有真实页面核查发现：

- 表头包含课程号、课程名、课程类别、学分、周学时、教师、班号、开课单位、教室信息、选课结果、IP地址和操作时间；选课状态为“已选上”“未选上”。
- 表尾存在空行与跨列分页行。解析需验证表头、身份、状态及分页；pkucli 的结果结构未保留课程号且未校验预期表头，不能直接作为本项目数据契约。
- caption 可能只有“学期课程表”，没有可验证的学期编号。这种情况下必须由用户确认选课系统学期并设置日期窗口；系统日期不能替代确认。

这些观察来自既有联调，不保证上游页面今后保持不变；原始认证页面和会话不应作为公开测试 fixture。

## 时间语义与校历

PekingParser 用于理解 `1~16周 周一1~2节 教101`、单双周及 `<br>` 分隔的同一课程多个时段。页面结构优先参考 pkucli 并核对真实页面；不要照搬旧解析器的固定 `<td>` 下标。

公共学期目录和 `calendar:pull` 的本部校历来源为[北大官方校历与作息](https://www.pku.edu.cn/detail/3377.html)。个人课表按 `Asia/Shanghai` 解释；校历与课表是独立输入。

校历解析以 `.school_calendar` 内的学年标题、`.txt` 段落中的上下学期标题和校区前缀为依据，只导入校本部。当前页面公开提供可解析文本，包含“上课”“停课复习考试”“全校停课”和“课程照常进行”等条目；部分节假日明确标为另行通知。抓取不读取页面作息表，不改变本地 `pku-main` / `pku-ss` 时间映射。页面结构或表述改变需重新核查，自动测试使用独立编写的合成页面，不复制外部实现。

`pku-ss` 节次表由用户按实际观察提供，尚未经官方资料独立核实。第 8 节 `13:00–13:50` 是针对选课系统课时的手动映射，第 5–7 节维持 `14:00–16:50`。因此 5–8 节、7–8 节均覆盖 `13:00–16:50`；展开时需检查范围内所有节次，按实际时间取最早开始与最晚结束。用户核实上游恢复正常后，应修改该时间表中的对应节次。

Sleepy 的周重复规则仅作导出行为参考。本项目按实际教学日期展开为独立 VEVENT，以处理停补课和不连续教学周；UID 与 ICS 规则统一见[系统设计](design.md#日历规则与事件身份)。
