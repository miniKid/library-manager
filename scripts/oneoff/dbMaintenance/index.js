/**
 * 一次性运维脚本：数据清理 / 封面迁移（不是常驻云函数）
 *
 * 为什么放在 scripts/ 而不是 cloudfunctions/：
 *   一次性任务不该长期挂在生产函数列表里——既占部署位，也多一个可被调用的入口。
 *   但清理历史数据必须在云环境里跑，所以保留成「可临时部署」的函数源码。
 *
 * 用法：
 *   1) cp -r scripts/oneoff/dbMaintenance cloudfunctions/
 *   2) 开发者工具右键 cloudfunctions/dbMaintenance → 上传并部署（云端安装依赖）
 *   3) 调用（三选一）：
 *      · 开发者工具「云开发 → 云函数 → dbMaintenance → 测试」传入 {"action":"stats"}
 *      · tcb fn invoke dbMaintenance --params '{"action":"stats"}'
 *      · 小程序调试 Console：wx.cloud.callFunction({ name:'dbMaintenance', data:{ action:'stats' } })
 *   4) 跑完 rm -rf cloudfunctions/dbMaintenance，并在控制台删除该函数
 *
 * action 一览：
 *   stats             只读体检：多少本书是 base64 封面、占多少体积、多少条借阅记录还留着 bookCover
 *   cleanBorrowCover  分批删除 borrows.bookCover 字段（幂等，可反复跑直到 remaining=0）
 *   migrateBookCover  把 books.cover 的 base64 写入云存储并改成 fileID（默认 dryRun，需显式 commit）
 *
 * 安全：所有 action 都要求调用者是管理员（settings.adminOpenid 或首个用户），
 *       且上线前请自行确认只在自家环境调用，跑完删除函数。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const BATCH = 20; // 云函数单次请求体/内存都有限，单批不宜过大
const MAX_ROUNDS = 200; // 保险丝：单次调用最多处理 200 批

/** 判断是否管理员：调用者 openid 命中 settings.adminOpenid，或 users 中 role=admin */
async function isAdmin(openid) {
  if (!openid) return false;
  try {
    const s = await db.collection('settings').doc('global').get();
    const adminOpenid = (s.data && s.data.adminOpenid) || process.env.ADMIN_OPENID || '';
    if (adminOpenid) return adminOpenid === openid;
    const u = await db.collection('users').where({ openid, role: 'admin' }).count();
    return u.total > 0;
  } catch (e) {
    // settings 不存在时退化为按 users.role 判断
    try {
      const u = await db.collection('users').where({ openid, role: 'admin' }).count();
      return u.total > 0;
    } catch (e2) {
      return false;
    }
  }
}

function isDataUrl(cover) {
  return typeof cover === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(cover);
}

function parseDataUrl(dataUrl) {
  const m = String(dataUrl).match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,(.*)$/i);
  if (!m) return null;
  const type = m[1].toLowerCase();
  return { ext: type === 'jpeg' ? 'jpg' : type, buffer: Buffer.from(m[2], 'base64') };
}

function kb(n) {
  return Math.round((Number(n) || 0) / 1024) + 'KB';
}

/* --------------------------------- 体检 --------------------------------- */

async function doStats() {
  const [booksTotal, borrowsTotal] = await Promise.all([
    db.collection('books').count(),
    db.collection('borrows').count()
  ]);

  // 逐批扫描 books 的封面，统计 base64 数量与总体积
  let withCover = 0;
  let base64Count = 0;
  let base64Bytes = 0;
  let fileIdCount = 0;
  let httpCount = 0;
  let skip = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await db
      .collection('books')
      .field({ cover: true })
      .skip(skip)
      .limit(100)
      .get();
    if (!res.data.length) break;
    res.data.forEach((b) => {
      const cover = b.cover || '';
      if (!cover) return;
      withCover++;
      if (isDataUrl(cover)) {
        base64Count++;
        base64Bytes += cover.length;
      } else if (cover.indexOf('cloud://') === 0) {
        fileIdCount++;
      } else if (/^https?:\/\//.test(cover)) {
        httpCount++;
      }
    });
    skip += res.data.length;
    if (res.data.length < 100) break;
  }

  // 借阅记录里残留的 bookCover
  let borrowCoverCount = 0;
  let skipB = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    const res = await db
      .collection('borrows')
      .where({ bookCover: _.exists(true) })
      .field({ bookCover: true })
      .skip(skipB)
      .limit(100)
      .get();
    if (!res.data.length) break;
    borrowCoverCount += res.data.length;
    skipB += res.data.length;
    if (res.data.length < 100) break;
  }

  return {
    ok: true,
    action: 'stats',
    books: { total: booksTotal.total, withCover, base64Count, base64Size: kb(base64Bytes), fileIdCount, httpCount },
    borrows: { total: borrowsTotal.total, withBookCover: borrowCoverCount }
  };
}

/* ------------------------- 删除 borrows.bookCover ------------------------- */

async function doCleanBorrowCover(event) {
  const limit = Math.min(Math.max(parseInt(event.limit, 10) || 500, 1), 5000);
  let removed = 0;
  let rounds = 0;

  while (removed < limit && rounds < MAX_ROUNDS) {
    const res = await db
      .collection('borrows')
      .where({ bookCover: _.exists(true) })
      .field({ bookCover: true })
      .limit(100)
      .get();
    if (!res.data.length) break;
    // 逐条 update 删字段；remove() 只删字段不动其余数据
    await Promise.all(
      res.data.map((r) =>
        db
          .collection('borrows')
          .doc(r._id)
          .update({ data: { bookCover: _.remove() } })
          .catch((e) => {
            console.error('[cleanBorrowCover] 更新失败', r._id, e);
            return null;
          })
      )
    );
    removed += res.data.length;
    rounds++;
  }

  const left = await db.collection('borrows').where({ bookCover: _.exists(true) }).count();
  return {
    ok: true,
    action: 'cleanBorrowCover',
    removed,
    remaining: left.total,
    hint: left.total > 0 ? '还有剩余，再调用一次即可（每次最多清 5000 条）' : '清理完成'
  };
}

/* --------------------- books.cover: base64 → 云存储 --------------------- */

/**
 * 前置条件：云存储权限必须是「所有用户可读」。
 * 若仍是「仅管理端可读写」，迁移后真机封面会显示空白——
 * 这种情况请只跑 cleanBorrowCover，不要跑本 action。
 */
async function doMigrateBookCover(event) {
  const commit = event.commit === true; // 默认 dryRun，只报告不改数据
  const limit = Math.min(Math.max(parseInt(event.limit, 10) || 20, 1), 100);

  const res = await db
    .collection('books')
    .where({ cover: db.RegExp({ regexp: '^data:image/', options: 'i' }) })
    .field({ cover: true, title: true })
    .limit(limit)
    .get();

  const report = [];
  let migrated = 0;
  let bytesBefore = 0;
  let bytesAfter = 0;

  for (const book of res.data) {
    const parsed = parseDataUrl(book.cover);
    if (!parsed) {
      report.push({ _id: book._id, skipped: '无法解析的 dataURL' });
      continue;
    }
    bytesBefore += book.cover.length;
    if (!commit) {
      report.push({ _id: book._id, title: book.title, wouldUpload: kb(parsed.buffer.length) });
      continue;
    }
    try {
      const uploaded = await cloud.uploadFile({
        cloudPath: `covers/${book._id}.${parsed.ext}`,
        fileContent: parsed.buffer
      });
      const fileID = uploaded.fileID;
      await db.collection('books').doc(book._id).update({ data: { cover: fileID, coverType: 'fileID' } });
      bytesAfter += fileID.length;
      migrated++;
      report.push({ _id: book._id, title: book.title, fileID });
    } catch (e) {
      console.error('[migrateBookCover] 上传失败', book._id, e);
      report.push({ _id: book._id, title: book.title, error: (e && e.message) || '上传失败' });
    }
  }

  const left = await db
    .collection('books')
    .where({ cover: db.RegExp({ regexp: '^data:image/', options: 'i' }) })
    .count();

  return {
    ok: true,
    action: 'migrateBookCover',
    dryRun: !commit,
    scanned: res.data.length,
    migrated,
    remainingBase64: left.total,
    sizeBefore: kb(bytesBefore),
    sizeAfter: kb(bytesAfter),
    detail: report,
    hint: commit
      ? '封面已换成 fileID；请确认云存储权限为「所有用户可读」，再逐批调用直到 remainingBase64=0'
      : '这是 dryRun，确认无误后传 {"action":"migrateBookCover","commit":true} 真正执行'
  };
}

/* --------------------------------- 入口 --------------------------------- */

exports.main = async (event = {}) => {
  const { OPENID } = cloud.getWXContext();
  if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };

  switch (event.action) {
    case 'stats':
      return await doStats();
    case 'cleanBorrowCover':
      return await doCleanBorrowCover(event);
    case 'migrateBookCover':
      return await doMigrateBookCover(event);
    default:
      return {
        ok: false,
        msg: '未知动作，可用：stats / cleanBorrowCover / migrateBookCover'
      };
  }
};
