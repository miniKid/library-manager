# 云图图书馆（微信小程序）

一款基于**微信小程序 + 云开发**的图书馆管理软件，分为**用户端**（在线借书、查询借阅）和**管理端**（图书管理、借阅确认、用户管理）。

## 功能特性

| 模块 | 功能 |
|---|---|
| 用户端 | 图书浏览（搜索 / 分类筛选）、图书详情、在线借阅申请、我的借阅记录（含逾期提示）、微信头像昵称登录 |
| 管理端 | 数据统计看板、图书增删改、借阅记录管理（状态筛选、线下交付后确认归还）、用户角色管理 |
| 系统 | 双模式数据层（本地模拟 / 云开发一键切换）、借阅 30 天期限、每人最多同时借 3 本、自动逾期判断 |

## 双模式说明

本项目内置两套数据实现，通过 `miniprogram/config/env.js` 的 `useCloud` 字段切换，**页面代码无需改动**：

- **`useCloud: false`（默认）**：本地模拟模式。数据存于小程序本地缓存，无需真实 AppID 和云环境，适合当前阶段在开发者工具中完整体验所有功能。
- **`useCloud: true`**：微信云开发模式。使用云数据库 + 云函数，用于后期真实上线。

## 快速开始（本地预览）

1. 用微信开发者工具「导入项目」，选择本目录，AppID 选择「测试号」即可（无需注册小程序）。
2. 编译运行，首页即可浏览种子图书数据。
3. 点击底部「我的」→ 登录（填写昵称）。**第一个登录的用户自动成为管理员**，底部出现「管理」tab，可进入管理后台体验完整流程。
4. 借书流程：首页/详情页点击「借阅」→ 在管理端「借阅管理」中确认归还。

## 切换为云开发模式（上线前）

1. 在[微信公众平台](https://mp.weixin.qq.com)注册小程序账号，获取真实 AppID，并开通云开发环境。
2. 修改 `project.config.json` 中的 `appid` 为你的 AppID。
3. 开发者工具中右键 `cloudfunctions` 下的 `login`、`initDB`、`lookupBook` 目录，选择「上传并部署：云端安装依赖」。
4. 首次部署后在云开发控制台或调用一次 `initDB` 云函数，完成数据库集合与种子数据初始化。
5. 将 `miniprogram/config/env.js` 中 `useCloud` 改为 `true`，并填入你的云环境 ID（`cloudEnv`）。

> 云开发模式首次登录前，需保证 `users` 集合已创建（执行过 `login` 云函数会自动创建）。

## 项目结构

```
├── project.config.json        # 项目配置（AppID、目录）
├── cloudfunctions/            # 云函数
│   ├── login/                 # 登录（openid 获取/创建用户，首个用户自动管理员）
│   ├── initDB/                # 初始化数据库集合与种子图书
│   └── lookupBook/            # ISBN 查询图书信息（豆瓣等数据源，封面转存云存储）
└── miniprogram/
    ├── app.js / app.json / app.wxss
    ├── config/env.js          # 环境配置（双模式开关）
    ├── services/              # 数据服务层（mock 本地模拟 / cloud 云开发）
    ├── utils/                 # 常量、工具函数
    └── pages/
        ├── index/             # 首页（图书列表、搜索、分类）
        ├── book-detail/       # 图书详情（借阅）
        ├── my/                # 我的（信息、借阅记录）
        ├── login/             # 登录
        └── admin/             # 管理端
            ├── index/         # 管理首页（统计、入口）
            ├── books/         # 图书管理
            ├── book-edit/     # 图书编辑/新增
            ├── borrows/       # 借阅管理（确认归还）
            └── members/       # 用户管理（角色设置）
```

## 数据库结构

| 集合 | 字段 |
|---|---|
| `books` | title, author, isbn, category, publisher, year, stock, cover, description, status(available/borrowed), borrowCount, createdAt |
| `borrows` | bookId, bookTitle, userId, userName, borrowDate, dueDate, returnDate, status(borrowing/returned/overdue) |
| `users` | openid, nickname, avatarUrl, role(user/admin), createdAt |

## 常见问题

- **本地模式登录后不是管理员？** 第一个登录的用户自动成为管理员；也可以重置缓存（开发者工具清除缓存）后重新登录，或在 `env.js` 中指定 `mockAdminOpenid`。
- **如何重置本地数据？** 开发者工具「清除缓存 → 清除数据缓存」即可恢复种子数据。
- **云开发模式借阅失败？** 检查是否已部署 `login` 云函数、`books`/`borrows` 集合是否已创建。

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
5. 全组共用 `project.config.json` 中的正式 AppID（`wx3a48ac37f5681280`），不要改成各自的测试号或别的 AppID。

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
