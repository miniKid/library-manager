# 云图图书馆（微信小程序）

一款基于**微信小程序 + 云开发**的图书馆管理软件，分为**用户端**（查书、借书、写书评）和**管理端**（图书管理、借阅确认、借书证审批、数据统计、首页弹窗公告、书评审核）。

## 功能特性

| 模块 | 功能 |
|---|---|
| 用户端 · 借阅 | 图书浏览（关键词搜索 / 分类筛选 / 多馆藏地点库存）、图书详情、在线借阅申请与取消、还书申请、续借、我的借阅记录（含逾期天数与到期提醒） |
| 用户端 · 书评 | 1–5 星评分 + 文字评论（5–500 字）、一人一书仅一条（再次提交即编辑）、点赞、匿名发表、馆员回复、全部书评列表（按最新/最热排序） |
| 用户端 · 消息 | 消息中心：站内通知（借阅/到期/逾期/借书证/书评回复）+ 待办（系统自动待办 + 自定义待办，可设优先级与截止日）、未读红点、通知分类开关 |
| 用户端 · 推荐 | 「为你推荐」栏目：按分类偏好 / 作者偏好 / 热度 / 评分 / 新书加权打分，过滤已借过与已评论的书，同作者最多 2 本，冷启动走热门+高分+新书 |
| 管理端 · 馆务 | 图书增删改（ISBN 查询、封面处理）、借阅管理（确认借出 / 确认归还 / 逾期提醒）、用户与借书证审批、馆藏地点与借期设置、按地点值班表 |
| 管理端 · 数据 | 用户统计与书籍统计（近 7 / 30 / 90 天，或**自定义起止日期**，两个 Tab 共用同一区间；最长两年，趋势自动按天/周/月降精度）、馆藏分布、借阅排行、滞销书、评分分布、CSV 导出（带 BOM，Excel 直接打开不乱码） |
| 管理端 · 运营 | 首页弹窗公告（纯文字 / 图片海报、点击跳转、已关闭用户随版本重新弹出）、书评审核（隐藏 / 恢复 / 回复 / 删除） |
| 系统 | 双模式数据层（本地模拟 / 云开发一键切换）、借期 30 天、每人最多同时借 3 本、多馆藏库存按地点扣减、值班日校验、每天 9:00 定时到期提醒、管理操作全部在云函数内做身份校验 |

## 双模式说明

内置两套数据实现，通过 `miniprogram/config/env.js` 的 `useCloud` 字段切换，**页面代码无需改动**：

| 模式 | 配置 | 说明 |
|---|---|---|
| 本地模拟 | `useCloud: false` | 数据存于小程序本地缓存，不需要 AppID 和云环境，改完直接编译就能点完整流程 |
| 云开发 | `useCloud: true` | 云数据库 + 云函数，真实上线用；`cloudEnv` 需填自己的环境 ID |

> 仓库提交的默认值是 `useCloud: true`（面向线上）。本地验证时临时改成 `false`，**这是个人本地改动，不要提交**——和 `project.config.json` 的 appid 一样，提交会让别人的环境跑不起来。

> **注意**：`services/mock.js` 与 `services/cloud.js` 是两套**独立实现**，不是同一份代码的包装。`npm test` 里的静态检查会强制两者导出同名方法，但业务行为仍需人工保持一致。改业务规则时两边都要改。

## 快速开始

### 方式 A：本地模拟模式（推荐先跑这个，无需部署）

1. 微信开发者工具「导入项目」→ 选择**仓库根目录**（不是 `miniprogram/`），AppID 可选测试号。
2. 打开 `miniprogram/config/env.js`，把 `useCloud` 改成 `false`（本地改动，别提交）。
3. 工具菜单「工具 → 清缓存 → 清除数据缓存」。
4. 点「编译」→ 底部「我的」→ 登录。**第一个登录的用户自动成为管理员**，底部出现「管理」tab。

借书流程：首页/详情页「借阅」→ 管理端「借阅管理」确认借出 → 用户提交还书 → 管理端确认归还。

### 方式 B：云开发模式

1. 在[微信公众平台](https://mp.weixin.qq.com)注册小程序，拿到 AppID 并开通云开发环境。
2. 把 `project.config.json` 的 `appid` 换成自己的（**只改本地，不要提交**）。
3. `miniprogram/config/env.js`：`useCloud: true` + `cloudEnv` 填云环境 ID。
4. 云开发控制台建 **3 个集合**：`reviews`、`todos`、`noticeLogs`，权限均选「所有用户不可读写」。
   - 站内通知用的 `notifications` 由第 9 步运行 `initDB` 自动创建，无需手动建；运行后同样把它的权限设为「所有用户不可读写」（云函数不受权限规则限制，但保持基线一致）。
   - 若暂时不想跑 `initDB`，也可以在这一步手动建 `notifications`，效果相同。
5. **按 [`database.rules.json`](database.rules.json) 配置每个集合的权限**（客户端只直连 `books`，其余集合一律只经云函数访问）。逐集合「权限设置 → 自定义安全规则」粘贴对应对象即可。
6. 建索引（字段顺序不能乱）：

   | 集合 | 索引 |
   |---|---|
   | `reviews` | `bookId`↑ + `status`↑ + `createdAt`↓；`openid`↑ + `bookId`↑ |
   | `notifications` | `toOpenid`↑ + `read`↑ + `createdAt`↓ |
   | `todos` | `ownerOpenid`↑ + `done`↑ + `dueDate`↑ |
   | `noticeLogs` | `createdAt`↓ |

7. 左侧文件树右键 `cloudfunctions` → 「当前环境」选中你的环境，然后逐个右键「上传并部署：云端安装依赖」：
   `login`、`initDB`、`lookupBook`、`borrowManager`、`notify`、`notifyManager`、`reviewManager`、`insightManager`
8. （可选）配置订阅消息模板与少量环境变量：

   | 配置项 | 作用 | 默认 |
   |---|---|---|
   | `settings.global.templates` | 三个订阅消息模板的 **ID + 字段映射**（结构见下）；放在数据库里，可在云开发控制台或管理端「设置」页直接改，换模板/换小程序不必改代码、不必重新部署 | 本项目在微信公众平台申请的真实模板 ID（开箱即用）；若 fork 到自己的小程序，需改成你自己的模板 |
   | `MP_STATE`（云函数环境变量） | 订阅消息点击后跳转的版本：`formal` 正式 / `trial` 体验 / `developer` 开发 | `formal` |
   | `ADMIN_OPENID`（云函数环境变量） | 指定初始管理员（也可在管理端「设置」页改 `settings.global.adminOpenid`，集合值优先） | 空 = 首个登录用户当管理员 |

   `MP_STATE` 是真正的「环境切换」，仍用云函数环境变量；模板 ID 与字段映射已数据化到 `settings.global.templates`。该字段结构（`settings` 集合 `_id: global` 文档内）：

   ```json
   "templates": {
     "borrowOk":      { "templateId": "...", "fields": { "thing1": "bookTitle", "time5": "deliverDate", "time3": "dueDateFull" } },
     "returnRemind":  { "templateId": "...", "fields": { "date1": "dueDate", "thing3": "bookTitle", "number2": "dueCount", "thing4": "dueTip" } },
     "overdueRemind": { "templateId": "...", "fields": { "thing1": "bookTitle", "short_thing4": "overdueDays", "thing5": "overdueTip" } }
   }
   ```

   - `fields` 的 **key** 是模板关键词（随你在公众平台选的模板而定，配错会报 `47003`），**value** 是取值器名：`bookTitle` / `deliverDate` / `dueDate` / `dueDateFull` / `dueCount` / `dueTip` / `overdueDays` / `overdueTip`。其中 `number2` 是**数字类型**，只能填数值（`dueCount` 默认 `1`），不能填 `bookId` 这类字符串，否则报 `47003`；`thing` 类型关键词（如 `thing3`/`thing4`）上限 20 字，`dueTip` 已按此截断。
   - 不同小程序、或你的模板关键词与示例不一致时，**只改 `settings` 里的 `templates` 即可**，无需改 `borrowManager` / `notify` 代码；首次运行 `initDB` 会自动写入这份默认配置。

9. 云开发控制台 → 云函数 → `initDB` → 测试，参数 `{}` 运行一次：幂等建齐 `books` / `borrows` / `users` / `settings` / `notifications` 集合，并写入种子图书、全局设置与默认模板。其余 3 个第二期集合（`todos` / `noticeLogs` / `reviews`）仍按第 4 步手动创建。

> 每一步的点按路径、验收清单、常见报错对照，见 **[docs/本地验证指南.md](docs/本地验证指南.md)**。

## 项目结构

```
├── project.config.json          # 项目配置（AppID、目录）
├── cloudbaserc.json             # 云开发环境配置
├── database.rules.json          # 数据库安全规则（客户端可直连哪些集合的唯一依据）
├── cloudfunctions/              # 云函数
│   ├── login/                   # 登录：openid 换取用户，首个用户自动管理员
│   ├── initDB/                  # 初始化集合、全局设置与种子图书
│   ├── borrowManager/           # 借阅主逻辑：申请/确认/还书/续借/逾期提醒/借书证审批/图书增删改
│   ├── notify/                  # 定时器（每天 9:00）：到期提醒，写订阅消息 + 站内通知
│   ├── notifyManager/           # 站内通知列表/已读/偏好、待办增删改、管理员群发
│   ├── reviewManager/           # 书评增删改、点赞、审核、馆员回复
│   ├── insightManager/          # 用户/书籍统计、CSV 导出、推荐打分
│   ├── lookupBook/              # ISBN / 书名查询图书信息
│   ├── fixBookCover/            # 一次性脚本：修复历史封面
│   └── migrateStocks/           # 一次性脚本：库存字段迁移到多馆藏结构
├── scripts/                     # 一次性运维脚本（不随生产部署，见 scripts/README.md）
│   └── oneoff/dbMaintenance/    # 清理 borrows.bookCover、封面迁云存储（临时部署后删除）
└── miniprogram/
    ├── app.js / app.json / app.wxss
    ├── config/env.js            # 双模式开关 + 云环境 ID
    ├── services/                # 数据服务层
    │   ├── index.js             # 门面：按开关选 cloud 或 mock，并合入导出/头像上传
    │   ├── cloud.js             # 云开发实现（调云函数）
    │   ├── mock.js              # 本地模拟实现（读写本地缓存）
    │   ├── data.js              # 种子数据（馆藏、图书、用户）
    │   └── export.js            # CSV 落盘 + 转发，云/模拟共用
    ├── utils/                   # constants（状态/文案映射）、util、schedule（值班计算）、cover（封面）
    └── pages/
        ├── index/               # 首页（图书列表、搜索、分类、为你推荐）
        ├── book-detail/         # 图书详情（借阅、书评概览）
        ├── book-reviews/        # 全部书评（写/改/删、点赞）
        ├── recommend/           # 为你推荐
        ├── message/             # 消息中心（通知 / 待办 / 通知设置）
        ├── my/                  # 我的（借书证、快捷入口、未读红点）
        ├── my/borrows/          # 我的借阅（完整记录）
        ├── borrow-detail/       # 单条借阅详情（借阅类通知点击落地页：时间线、续借/还书）
        ├── login/               # 登录
        └── admin/               # 管理端
            ├── index/           # 管理首页
            ├── books/           # 图书管理
            ├── book-edit/       # 图书编辑/新增
            ├── book-borrows/    # 单本图书的借阅记录
            ├── borrows/         # 借阅管理（确认借出/归还、逾期提醒）
            ├── members/         # 用户与借书证管理
            ├── settings/        # 馆藏地点、借期、限借数量
            ├── schedule/        # 值班管理
            ├── analytics/       # 数据统计与导出
            ├── notify/          # 首页弹窗公告配置
            └── reviews/         # 书评管理
```

## 数据库结构

| 集合 | 主要字段 | 客户端权限 |
|---|---|---|
| `books` | title, author, isbn, category, publisher, year, description, cover, stocks（按地点库存）, stock, status, borrowCount, ratingAvg, ratingCount, reviewCount, createdAt | **可读**、不可写（唯一允许客户端直连的集合） |
| `borrows` | bookId, bookTitle, userId, userName, location, borrowDate, deliverDate, dueDate, returnDate, status(pending/borrowing/return_requested/returned/cancelled) | 不可读写（`myBorrows` / `adminBorrows` / `bookBorrows` 三个云函数 action 提供数据） |
| `users` | openid, nickname, avatarUrl, role(user/admin), card{status,location,phone,...}, notifyPrefs, createdAt | 不可读写 |
| `settings` | 单文档 `_id: 'global'`：locations, borrowDays, maxBorrow, adminOpenid, schedules（按地点的值班表） | 不可读写（经 `getSettings` 云函数读取） |
| `reviews` | bookId, bookTitle, openid, userName, rating, content, anonymous, likeCount, likedBy[], status(approved/hidden), reply{}, createdAt | 不可读写 |
| `notifications` | toOpenid, type, title, content, link, level, bizId, read, readAt, senderName, createdAt | 不可读写 |
| `todos` | ownerOpenid, title, note, dueDate, priority, done, createdAt | 不可读写 |
| `noticeLogs` | senderOpenid, senderName, title, content, scope, location, targetCount, createdAt | 不可读写 |

> **安全基线**：客户端只直连 `books`，其余集合**一律「所有用户不可读写」**，只能经云函数访问（云函数用 `wx-server-sdk`，不受客户端规则限制）。`borrows` 里有 openid、昵称、书名、馆藏地点，开放读权限等于把全馆借阅流水公开给任何打开控制台的人。
>
> 权限的唯一事实来源是 [`database.rules.json`](database.rules.json)，改权限时请同步改它，不要在控制台手点完就完事。
>
> 借阅记录**不再存 `bookCover`**：早期每条记录都会复制一份 ≤40KB 的 base64 封面（UI 从未使用），现在写入端已去掉；存量字段由 `scripts/oneoff/dbMaintenance` 清，`initDB` 每次运行也会幂等顺带删除（见 [scripts/README.md](scripts/README.md)）。读取端（`borrowManager` / `mock`）不再做任何剔除。

## 云函数一览

| 函数 | 职责 | 触发器 / 权限 |
|---|---|---|
| `login` | openid 换取用户；`settings.adminOpenid` / `ADMIN_OPENID` 为空时首个用户为管理员 | — |
| `initDB` | 建集合（`books` / `borrows` / `users` / `settings` / `notifications`）、写全局设置与种子图书（幂等） | 手动执行一次 |
| `borrowManager` | 借阅全流程、逾期提醒、借书证审批、图书增删改、管理端借阅查询（`adminBorrows` / `bookBorrows`） | `subscribeMessage.send`；模板见 `settings.global.templates`；环境变量 `MP_STATE`、`ADMIN_OPENID` |
| `notify` | 每天 9:00 扫描到期/逾期，发订阅消息 + 写站内通知，清理 90 天前通知 | timer `0 0 9 * * *`、`subscribeMessage.send`；模板见 `settings.global.templates`；环境变量 `MP_STATE` |
| `notifyManager` | 通知列表/已读/偏好、待办 CRUD、管理员群发与发送记录（**前端入口已下线，能力保留**） | — |
| `reviewManager` | 书评列表/提交/编辑/删除、点赞、审核、回复（回复会通知作者） | — |
| `insightManager` | 用户统计、书籍统计、CSV 导出、推荐打分 | — |
| `lookupBook` | ISBN/书名查书 | 30s 超时 |

> ⚠️ **部署 `notify` 后必须确认定时器触发器已挂载。** `notify` 依赖 `cloudfunctions/notify/config.json` 里的 `dailyReturnRemind`（`0 0 9 * * *`，每天 09:00）定时触发；但 IDE「上传并部署」常常不会自动建触发器，导致函数在控制台显示为「普通云函数」、`main()` 从不执行——表现为：收不到任何订阅消息/站内通知、`borrows` 里也从无 `reminded` 字段。部署后在云函数控制台「触发器」页确认 `dailyReturnRemind` 存在且启用；若缺失则手动新建定时触发器（周期 `0 0 9 * * *`）。建完可点「测试」手动触发一次 `main()` 立即验证（会被处理的记录写入 `reminded`、并向 `notifications` 写入提醒通知）。

## 图片资源与云存储权限（`cloud://` 限制）

> **结论先行**：`cloud://` 文件 ID **不能直接给 `<image src>` 用**；且本项目使用的云开发**免费套餐下无法修改云存储文件权限**（控制台会提示不可修改）。因此所有用户可见图片都**不依赖云存储读权限**，而是把图片转成 base64 存入数据库、渲染前写成本地临时文件。若日后升级到可改权限的套餐，可按下文「优化项」迁回云存储。

### 1. `cloud://` 为什么不能直接显示

微信小程序 `<image>` 的 `src` 接受「网络路径 / 本地路径 / 本地临时路径」，不识别云文件 ID。直接填 `cloud://...` 会被当成相对路径拼到当前页面目录下，报：

```
[渲染层网络层错误] Failed to load image http://127.0.0.1:xxxx/__pageframe__/pages/index/cloud://...
```

必须先经 `wx.cloud.downloadFile()`（下载为本地临时路径）或 `wx.cloud.getTempFileURL()`（换临时 https 链接）转换。本项目封装在 `miniprogram/utils/util.js` 的 `resolveCloudImage()`：优先 `downloadFile`（走云开发 SDK，不受 `downloadFile` 合法域名限制），失败再退化到 `getTempFileURL`。

> 早期 `utils/cover.js` 注释曾写「`<image>` 支持云文件ID」，实为误解，已更正；不要再照着旧注释直接填 `cloud://`。

### 2. 免费套餐的权限限制（本次踩坑点）

控制台尝试把云存储文件改成「所有用户可读」时，**免费套餐提示不允许修改权限**。文件默认私有读，于是：

- `wx.cloud.downloadFile({ fileID })` → `errCode: -403003 internal server error: empty download url`
- `wx.cloud.getTempFileURL()` 同样拿不到有效下载地址
- 结果：模拟器与真机图片都空白，且**无法通过改权限绕过**，`resolveCloudImage()` 的两条路径都会失败

这与 `docs/本地验证指南.md` 里对 `books.cover` 的既有决策一致：权限能设才迁云存储，不能设就维持 base64。（套餐策略如后续调整，以云开发控制台实际可操作性为准。）

### 3. 当前实现（不依赖云存储权限）

| 场景 | 做法 | 相关代码 |
|---|---|---|
| 图书封面 | 离屏 canvas 压缩 ≤40KB → base64 存 `books.cover` → `toLocalFile()` 写本地文件后给 `<image>` | `pages/admin/book-edit/index.js`、`utils/cover.js` |
| 首页弹窗海报 | 后台「选择图片」压缩到 620×780 / JPEG 0.72 / base64 ≤26 万字符 → 存 `settings.global.popup.imageBase64` → 首页 `toLocalFile()` 渲染 | `utils/cover.js#imageToDataUrl`、`pages/admin/notify/index.js`、`pages/index/index.js#loadPopup` |

要点：

- `<image>` **不支持直接渲染 base64 dataURL**（真机空白），所以必须经 `toLocalFile()` 写到 `wx.env.USER_DATA_PATH` 再用本地路径渲染，详见 `utils/cover.js` 文件头。
- 弹窗图片优先级：`popup.imageBase64` > `popup.image`（https 外链 / 包内路径 / `cloud://`）；在地址框手工输入会自动清掉已选的本地图片。
- 纯文字/图片之外的富文本（HTML）类型已下线，存量 `type='html'` 配置在后台回退为纯文字、首页不再弹出。
- 代价：`settings.global` 单文档会带最多约 26 万字符（≈260KB）的 base64 文本，而 `getSettings` 在首页等多个页面被调用，会略增请求体积。图书封面因列表多条累加，压得更小（≤40KB）。

### 4. 优化项：升级到可改权限的套餐后

前端两种方案**本来就兼容**，`loadPopup` 是「有 base64 就用 base64，否则解析 `popup.image`」，所以可以先小规模试点，不必一次性改渲染层。建议顺序：

1. 云存储把对应文件/目录设为「所有用户可读」（或改由云函数以管理员身份下发）。
2. 上传端改用 `wx.cloud.uploadFile()` 拿 fileID，配置里只存 `cloud://...`（可复用 `services/index.js#uploadAvatar` 的上传封装）。
3. 保留 `resolveCloudImage()` 做转换：仍优先 `downloadFile` → 本地临时路径；此时不会再报 `-403003`。
4. 图书封面的存量迁移可参考 `scripts/oneoff/dbMaintenance` 的 `migrateBookCover` 思路；弹窗海报则需增加一个「清除 `imageBase64`、改用 fileID」的迁移动作。
5. 全量迁移并验证后，再考虑移除 base64 分支与体积上限校验，让 `settings.global` 回到几 KB。

> 迁移收益：数据库体积与 `getSettings` 响应显著下降；代价是多一次云存储读取，以及重新依赖文件读权限。免费套餐阶段**不要**提前做这一步。

### 相关报错速查

| 现象 | 原因 / 处理 |
|---|---|
| `Failed to load image http://127.0.0.1:.../cloud://...` | 把 `cloud://` 直接填进了 `<image>`；改用后台「选择图片」，或确认 `resolveCloudImage()` 被调用 |
| `errCode: -403003 ... empty download url` | 免费套餐文件私有读且权限不可改；改走 base64 存库方案 |
| `[cover] base64->local ok` 但图片仍空白 | 检查是否把未转换的 dataURL 直接给了 `src`；看图片 `binderror` 日志 |
| https 外链不显示 | 需在小程序后台配 `downloadFile` 合法域名；开发者工具可勾「不校验合法域名」临时绕过 |
| 图片尺寸不合适导致弹窗内部可滑动 | 图片类型已脱离 `scroll-view`，用 `mode="aspectFit"` 在固定 `58vh` 主体内等比压缩完整显示，不裁剪、不滚动 |

## 测试

```bash
node test/run-tests.js     # 无需安装依赖
```

- 覆盖：业务规则（借阅/续借/还书/借书证）、第二期功能（书评聚合与审核、通知未读、待办 CRUD、统计与 CSV、推荐）、静态检查（页面与云函数约定）。
- 当前基线：**61 / 67 通过**。剩余 6 条为仓库既有失败（4 条借书证业务用例 + 2 条静态检查误报），改动前后一致，可对照 `/tmp` 原始副本确认。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/需求规格说明-第二期.md](docs/需求规格说明-第二期.md) | 通知/待办、用户与书籍统计导出、书评、推荐的需求规则、口径、数据模型、接口、权限、验收标准 |
| [docs/本地验证指南.md](docs/本地验证指南.md) | 模拟模式零部署验证步骤、云开发部署点按路径、逐项验收清单、常见报错对照 |

## 常见问题

- **本地模式登录后不是管理员？** 首个登录用户自动成为管理员；否则清缓存重新登录，或在 `env.js` 里用 `mockAdminOpenid` 指定。
- **云模式登录后不是管理员？** 检查 `settings` 集合里 `_id: global` 的 `adminOpenid`，必须是空字符串（填了别人的 openid 就只认那个人）；或删掉该字段，让 `ADMIN_OPENID` 环境变量 / 首个登录用户生效。
- **点订阅消息提示「小程序不存在」？** `MP_STATE` 还是 `developer`。代码默认 `formal`，开发阶段在云函数环境变量里配 `MP_STATE=trial` 或 `developer`。
- **借阅列表 / 借阅记录页空白？** 检查是否重新部署了 `borrowManager`（`adminBorrows`、`bookBorrows` 是新增 action），以及 `borrows` 集合权限是否已设为「所有用户不可读写」。
- **换了集合权限后「我的借阅」打不开？** 该功能走 `myBorrows` 云函数，不受客户端规则影响；若报错请确认 `borrowManager` 已部署。
- **如何重置本地数据？** 开发者工具「清除缓存 → 清除数据缓存」恢复种子数据。
- **云模式借阅失败？** 确认已部署 `login` / `borrowManager`，且 `books`/`borrows` 集合已创建。
- **消息中心一直空的？** 先确认 `notifications` 集合已存在（跑一次 `initDB`，或按第 4 步手动建），权限为「所有用户不可读写」。集合不存在时云函数报错会被转成空列表，页面表现为**空白而不是报错**，很容易误判成业务没触发。站内通知只由业务动作产生（借阅通过、审批结果、逾期提醒、书评回复），完成一次借书流程（申请 → 管理端确认借出）即可看到红点。
- **管理端「发送通知」/广播公告去哪了？** 该功能前端入口已下线（暂无业务场景）。服务端 `notifyManager` 的 `send` / `sentList`、`noticeLogs` 集合与 `services` 层实现**保留**，便于以后恢复；当前管理端该入口为「首页弹窗公告」。
- **收不到订阅消息/站内通知，且 `borrows` 里没有任何 `reminded` 字段？** `notify` 多半是「普通云函数」、定时器触发器没挂上（`main()` 从没跑过）。去云函数控制台 `notify` 的「触发器」页确认 `dailyReturnRemind`（`0 0 9 * * *`）存在且启用；缺失就手动新建。可点「测试」手动触发一次验证：被处理的记录会写入 `reminded`，并向 `notifications` 写入提醒通知。注意：即使跑起来了，订阅消息也只是「距到期 ≤3 天」时推一次（一次性订阅），不会在逾期后单独再推。
- **导出的 CSV 在哪？** 手机端会弹「发送给朋友」，发到文件传输助手即可在电脑打开；开发者工具模拟器不支持转发文件，会降级为复制到剪贴板。
- **书评提交提示包含敏感词？** 本地词库预检拦截，词库在 `cloudfunctions/reviewManager/index.js`。
- **图片/弹窗海报空白，报 `Failed to load image .../cloud://...`？** `cloud://` 不能直接当 `<image src>`，见上文「图片资源与云存储权限」。
- **云存储下载报 `errCode: -403003 ... empty download url`？** 免费套餐下文件权限不可改，改用 base64 存库方案，见上文「图片资源与云存储权限」。

## 协作开发（Git 工作流）

代码托管在 GitHub：`git@github.com:miniKid/library-manager.git`

### 分支模型
- `main`：稳定分支，对应线上版本，**已开启分支保护**——禁止直接 push，必须通过 Pull Request 合并。
- `develop`：日常开发集成分支。
- `feature/xxx`：每人按功能开分支（如 `feature/login`），开发完成后提 PR 合入 `develop`。

### 新成员接入
1. 克隆仓库：`git clone git@github.com:miniKid/library-manager.git`
2. 用微信开发者工具「导入项目」，选择**仓库根目录**（不是 `miniprogram/` 子目录），因为 `project.config.json` 在项目根。
3. 工具会为每人自动生成各自的 `project.private.config.json`（含代码上传私钥）。该文件已被 `.gitignore` 忽略，**切勿手动提交**，否则会泄露上传权限。
4. 在[微信公众平台](https://mp.weixin.qq.com)后台「成员管理」被添加为**开发者**，否则无法上传代码。
5. `project.config.json` 里的 `appid` 是本地配置，换环境时会被工具自动改写——**改完不要提交**，避免把个人 AppID 带进提交历史：
   ```bash
   git update-index --skip-worktree project.config.json
   ```

### 日常开发流程
```bash
git checkout develop
git pull
git checkout -b feature/xxx      # 按功能开分支
# ... 开发 ...
git push origin feature/xxx
# 到 GitHub 提 Pull Request 到 develop，管理员 review 后合并
```
发布上线时：将 `develop` 合并到 `main` → 用开发者工具「上传」生成体验版 → 提交审核发布。
