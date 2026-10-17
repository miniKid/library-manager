# 云图图书馆（微信小程序）

一款基于**微信小程序 + 云开发**的图书馆管理软件，分为**用户端**（查书、借书、写书评）和**管理端**（图书管理、借阅确认、借书证审批、数据统计、通知群发、书评审核）。

## 功能特性

| 模块 | 功能 |
|---|---|
| 用户端 · 借阅 | 图书浏览（关键词搜索 / 分类筛选 / 多馆藏地点库存）、图书详情、在线借阅申请与取消、还书申请、续借、我的借阅记录（含逾期天数与到期提醒） |
| 用户端 · 书评 | 1–5 星评分 + 文字评论（5–500 字）、一人一书仅一条（再次提交即编辑）、点赞、匿名发表、馆员回复、全部书评列表（按最新/最热排序） |
| 用户端 · 消息 | 消息中心：站内通知（借阅/到期/逾期/借书证/系统公告/书评回复）+ 待办（系统自动待办 + 自定义待办，可设优先级与截止日）、未读红点、通知分类开关 |
| 用户端 · 推荐 | 「为你推荐」栏目：按分类偏好 / 作者偏好 / 热度 / 评分 / 新书加权打分，过滤已借过与已评论的书，同作者最多 2 本，冷启动走热门+高分+新书 |
| 管理端 · 馆务 | 图书增删改（ISBN 查询、封面处理）、借阅管理（确认借出 / 确认归还 / 逾期提醒）、用户与借书证审批、馆藏地点与借期设置、按地点值班表 |
| 管理端 · 数据 | 用户统计与书籍统计（近 7 / 30 / 90 天）、馆藏分布、借阅排行、滞销书、评分分布、CSV 导出（带 BOM，Excel 直接打开不乱码） |
| 管理端 · 运营 | 发送通知（全部用户 / 按馆藏地点）、发送记录、书评审核（隐藏 / 恢复 / 回复 / 删除） |
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
4. 云开发控制台建 4 个集合：`reviews`、`notifications`、`todos`、`noticeLogs`，权限均选「所有用户不可读写」。
5. 建索引（字段顺序不能乱）：

   | 集合 | 索引 |
   |---|---|
   | `reviews` | `bookId`↑ + `status`↑ + `createdAt`↓；`openid`↑ + `bookId`↑ |
   | `notifications` | `toOpenid`↑ + `read`↑ + `createdAt`↓ |
   | `todos` | `ownerOpenid`↑ + `done`↑ + `dueDate`↑ |
   | `noticeLogs` | `createdAt`↓ |

6. 左侧文件树右键 `cloudfunctions` → 「当前环境」选中你的环境，然后逐个右键「上传并部署：云端安装依赖」：
   `login`、`initDB`、`lookupBook`、`borrowManager`、`notify`、`notifyManager`、`reviewManager`、`insightManager`
7. 云开发控制台 → 云函数 → `initDB` → 测试，参数 `{}` 运行一次，写入种子图书与全局设置。

> 每一步的点按路径、验收清单、常见报错对照，见 **[docs/本地验证指南.md](docs/本地验证指南.md)**。

## 项目结构

```
├── project.config.json          # 项目配置（AppID、目录）
├── cloudbaserc.json             # 云开发环境配置
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
        ├── my/borrows/          # 我的借阅
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
            ├── notify/          # 发送通知与发送记录
            └── reviews/         # 书评管理
```

## 数据库结构

| 集合 | 主要字段 | 读写权限 |
|---|---|---|
| `books` | title, author, isbn, category, publisher, year, description, cover, stocks（按地点库存）, stock, status, borrowCount, ratingAvg, ratingCount, reviewCount, createdAt | 所有用户可读 |
| `borrows` | bookId, bookTitle, userId, userName, location, borrowDate, deliverDate, dueDate, returnDate, status(pending/borrowing/return_requested/returned/cancelled/overdue), renewed | 客户端需读自己的记录（见下方「安全须知」） |
| `users` | openid, nickname, avatarUrl, role(user/admin), card{status,location,phone,...}, notifyPrefs, createdAt | 仅云函数读写 |
| `settings` | 单文档 `_id: 'global'`：locations, borrowDays, maxBorrow, adminOpenid, schedules（按地点的值班表） | 所有用户可读 |
| `reviews` | bookId, bookTitle, openid, userName, rating, content, anonymous, likeCount, likedBy[], status(approved/hidden), reply{}, createdAt | 所有用户不可读写 |
| `notifications` | toOpenid, type, title, content, link, level, bizId, read, readAt, senderName, createdAt | 所有用户不可读写 |
| `todos` | ownerOpenid, title, note, dueDate, priority, done, createdAt | 所有用户不可读写 |
| `noticeLogs` | senderOpenid, senderName, title, content, scope, location, targetCount, createdAt | 所有用户不可读写 |

> **安全须知**：`borrows` 目前为了支持「我的借阅」在客户端直查，需放开「所有用户可读」，这会让任何用户能读到全馆借阅记录（openid + 昵称 + 书名）。后续应改为全部走云函数查询并收紧权限。新增的 4 个集合已强制「所有用户不可读写」，只经云函数访问。

## 云函数一览

| 函数 | 职责 | 触发器 / 权限 |
|---|---|---|
| `login` | openid 换取用户；`settings.adminOpenid` 为空时首个用户为管理员 | — |
| `initDB` | 建集合、写全局设置与种子图书（幂等） | 手动执行一次 |
| `borrowManager` | 借阅全流程、逾期提醒、借书证审批、图书增删改 | `subscribeMessage.send` |
| `notify` | 每天 9:00 扫描到期/逾期，发订阅消息 + 写站内通知，清理 90 天前通知 | timer `0 0 9 * * *`、`subscribeMessage.send` |
| `notifyManager` | 通知列表/已读/偏好、待办 CRUD、管理员群发与发送记录 | — |
| `reviewManager` | 书评列表/提交/编辑/删除、点赞、审核、回复（回复会通知作者） | — |
| `insightManager` | 用户统计、书籍统计、CSV 导出、推荐打分 | — |
| `lookupBook` | ISBN/书名查书 | 30s 超时 |

## 测试

```bash
node test/run-tests.js     # 无需安装依赖
```

- 覆盖：业务规则（借阅/续借/还书/借书证）、第二期功能（书评聚合与审核、通知未读、待办 CRUD、统计与 CSV、推荐）、静态检查（页面与云函数约定）。
- 当前基线：**50 / 56 通过**。剩余 6 条为仓库既有失败（4 条借书证业务用例 + 2 条静态检查误报），改动前后一致，可对照 `/tmp` 原始副本确认。

## 文档

| 文档 | 内容 |
|---|---|
| [docs/需求规格说明-第二期.md](docs/需求规格说明-第二期.md) | 通知/待办、用户与书籍统计导出、书评、推荐的需求规则、口径、数据模型、接口、权限、验收标准 |
| [docs/本地验证指南.md](docs/本地验证指南.md) | 模拟模式零部署验证步骤、云开发部署点按路径、逐项验收清单、常见报错对照 |

## 常见问题

- **本地模式登录后不是管理员？** 首个登录用户自动成为管理员；否则清缓存重新登录，或在 `env.js` 里用 `mockAdminOpenid` 指定。
- **云模式登录后不是管理员？** 检查 `settings` 集合里 `_id: global` 的 `adminOpenid`，必须是空字符串（填了别人的 openid 就只认那个人）。
- **如何重置本地数据？** 开发者工具「清除缓存 → 清除数据缓存」恢复种子数据。
- **云模式借阅失败？** 确认已部署 `login` / `borrowManager`，且 `books`/`borrows` 集合已创建。
- **消息中心一直空的？** 通知只由业务动作产生（借阅通过、审批结果、逾期提醒、群发、书评回复）。先去管理端「发送通知」发一条看红点是否出现。
- **导出的 CSV 在哪？** 手机端会弹「发送给朋友」，发到文件传输助手即可在电脑打开；开发者工具模拟器不支持转发文件，会降级为复制到剪贴板。
- **书评提交提示包含敏感词？** 本地词库预检拦截，词库在 `cloudfunctions/reviewManager/index.js`。

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
