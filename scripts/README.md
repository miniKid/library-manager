# scripts · 一次性运维脚本

这里放**不该常驻生产**的一次性任务。它们需要云环境（管理员权限、云数据库、云存储），
但不能一直挂在 `cloudfunctions/` 里——那会多一个可被调用的入口，也占部署位。

## dbMaintenance

清理历史数据 + 封面迁移，三个 action 都要求调用者是管理员（`settings.adminOpenid` 或 `users.role=admin`）。

| action | 作用 | 是否改数据 |
|---|---|---|
| `stats` | 体检：多少本书是 base64 封面、总体积、多少条借阅记录还留着 `bookCover` | 否 |
| `cleanBorrowCover` | 分批删除 `borrows.bookCover` 字段（单次最多 5000 条，可反复跑） | 是（只删该字段） |
| `migrateBookCover` | 把 `books.cover` 的 base64 上传到云存储、改成 `fileID`；默认 dryRun | 需 `commit:true` |

### 怎么跑

```bash
# 1) 临时拷进函数目录
cp -r scripts/oneoff/dbMaintenance cloudfunctions/

# 2) 开发者工具里右键 cloudfunctions/dbMaintenance → 上传并部署（云端安装依赖）

# 3) 调用：控制台「云函数 → 测试」传 JSON，或用 tcb CLI
tcb fn invoke dbMaintenance --params '{"action":"stats"}'
tcb fn invoke dbMaintenance --params '{"action":"cleanBorrowCover"}'
tcb fn invoke dbMaintenance --params '{"action":"migrateBookCover"}'                        # dryRun
tcb fn invoke dbMaintenance --params '{"action":"migrateBookCover","commit":true}'          # 真跑

# 4) 跑完删掉，别留在生产函数列表里
rm -rf cloudfunctions/dbMaintenance
```

在小程序调试 Console 里也能调：

```js
wx.cloud.callFunction({ name: 'dbMaintenance', data: { action: 'stats' } }).then(console.log)
```

### 封面迁移的前置条件（重要）

`migrateBookCover` 会把封面从 base64 改成 `cloud://` fileID，**前提是云存储权限为「所有用户可读」**。
若存储仍为「仅管理端可读写」，客户端的 `<image>` 读不到 fileID，真机会显示空白封面。

所以：

- 存储权限能改（推荐）：先改权限，再 `migrateBookCover`，列表响应体可从数百 KB 降到几 KB。
- 存储权限改不了（免费套餐限制）：**只跑 `cleanBorrowCover`**，保留 base64 封面，
  同时靠 `services.getBooks` 的字段投影控制单次返回体积。

代码侧已经做到「两种封面都能渲染」：`utils/cover.js` 对 base64 写本地文件、对 `cloud://` / `https://` 原样透传，
迁移与否都不用改前端。
