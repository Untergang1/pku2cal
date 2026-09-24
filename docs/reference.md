# PKU Calendar — Reference Implementation Notes

目标：实现一个轻量的 **北京大学个人课表 → ICS 订阅** 服务。

预期主流程：

```text
PKU IAAA
  ↓
elective.pku.edu.cn
  ↓
个人已选课程
  ↓
课程时间解析
  ↓
ICS
  ↓
HTTP subscription endpoint
```

## 1. PKU IAAA authentication

Repository:

https://github.com/pkuinfo/pkucli

Primary reference:

```text
crates/common/src/iaaa.rs
```

Relevant implementation:

- `IaaaConfig`
- `login_password()`
- `login_qrcode()`
- `encrypt_password()`

Current password login flow:

```text
GET https://iaaa.pku.edu.cn/iaaa/getPublicKey.do
↓
RSA encrypt password
↓
POST https://iaaa.pku.edu.cn/iaaa/oauthlogin.do
↓
IAAA token
```

For the elective system:

```text
app_id = syllabus
redirect_url =
http://elective.pku.edu.cn:80/elective2008/ssoLogin.do
```

Use this as the main reference for implementing `pku/auth`.

---

## 2. IAAA token → elective session

Repository:

https://github.com/pkuinfo/pkucli

References:

```text
crates/elective/src/client.rs
crates/elective/src/login.rs
```

Important URLs from `client.rs`:

```text
ELECTIVE_BASE
https://elective.pku.edu.cn/elective2008

SSO_LOGIN
https://elective.pku.edu.cn/elective2008/ssoLogin.do

OAUTH_REDIR
http://elective.pku.edu.cn:80/elective2008/ssoLogin.do
```

`login.rs` implements:

```text
IAAA token
↓
GET ssoLogin.do?...&token=<token>
↓
follow redirects
↓
persist elective cookies
```

Also contains special handling for dual-degree accounts:

```text
bzx = major
bfx = minor / dual-degree
```

For an MVP, this can be isolated behind the authentication layer rather than spread through the parser.

---

## 3. Fetch current selected courses

Repository:

https://github.com/pkuinfo/pkucli

Primary reference:

```text
crates/elective/src/api.rs
```

Relevant pieces:

```text
SHOW_RESULTS
ElectiveApi::get_results()
ElectiveApi::follow_and_read()
parse_datagrid_table()
```

Current endpoint:

```text
https://elective.pku.edu.cn/elective2008/
edu/pku/stu/elective/controller/electiveWork/showResults.do
```

Current implementation parses:

```text
table.datagrid
→ tr
→ td
→ CourseData
```

Useful fields include:

```text
name
category
credit
hours
teacher
class_id
department
classroom
status
```

Prefer this repository for current URLs, authentication flow, redirect behavior, cookies, and page structure.

---

## 4. PKU course-time parsing

Primary upstream reference:

https://github.com/dIT8Zv/WakeupSchedule_BUPT

File:

```text
app/src/main/java/com/suda/yzune/wakeupschedule/
schedule_import/parser/PekingParser.kt
```

Parser handles PKU-specific strings such as:

```text
1~16周 周一1~2节 教101
1~16周 周三3~4节 教202
2~16周 周五5~6节(单) 教303
```

Extract:

```text
start_week
end_week
weekday
start_node
end_node
odd/even week
room
teacher
course name
```

Important behavior:

```text
"<br>" → multiple schedule slots for one course

contains("单") → odd weeks
contains("双") → even weeks
```

Do not blindly copy fixed `<td>` indices from this parser. Its page assumptions are older.

Use `pkucli/crates/elective/src/api.rs` as the primary source for the current HTML structure and use `PekingParser.kt` mainly for PKU time-string semantics.

License: Apache-2.0.

---

## 5. ICS generation

Reference repository:

https://github.com/lingion/sleepy

File:

```text
app/src/main/java/com/lingion/sleepy/data/parser/
ScheduleExporter.kt
```

Relevant functions:

```text
exportIcs()
escapeIcs()
```

Useful recurrence model:

```text
normal course:
RRULE:FREQ=WEEKLY

odd/even course:
RRULE:FREQ=WEEKLY;INTERVAL=2
```

Also inspect its handling of:

```text
DTSTART
DTEND
UNTIL
BYDAY
UID
SUMMARY
LOCATION
DESCRIPTION
ICS escaping
```

Use this as a behavioral reference only if possible. Sleepy is GPL-3.0; avoid copying GPL implementation into a project intended to use a more permissive license.

---

## 本项目的实现边界

目录和数据契约以 [系统设计](design.md) 为准。`pku` 负责内存会话、页面获取和结构解析，`schedule` 处理时间和校历，`calendar` 序列化 ICS，`application` 编排，两个 `entrypoints` 处理平台行为。本项目不持久化上游会话，Worker KV 仅存成功日历快照。

已核查的上游版本、许可证、真实页面差异及联调限制见 [验证记录](verification.md)，运行与部署见 [README 使用说明](../README.md)。参考代码中的持久化会话、宽松错误处理和重复规则不是本项目的行为。
