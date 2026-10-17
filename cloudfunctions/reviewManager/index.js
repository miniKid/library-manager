/**
 * 云函数：reviewManager
 * 书籍书评：一人一书一条（重复提交视为编辑）、点赞、管理员审核与回复。
 *
 * 设计要点：
 * 1. reviews 集合权限设为「所有用户不可读写」，客户端只能经本函数访问；
 * 2. 评论写入/编辑/隐藏后重算 books 的 ratingAvg / ratingCount / reviewCount，
 *    让书籍列表与详情页无需实时聚合（列表页 20 条 × 聚合 = 20 次查询，成本高）；
 * 3. 身份一律取 getWXContext().OPENID，不信任客户端传入。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const COLL = 'reviews';
const STATUS = { APPROVED: 'approved', HIDDEN: 'hidden' };
const MIN_LEN = 5;
const MAX_LEN = 500;
const PAGE_SIZE = 10;
// 本地敏感词预检（上线建议同时接 cloud.openapi.security.msgSecCheck）
const BANNED = ['加微信', '代写', '刷单', '博彩', '色情', '贷款', '兼职日结'];

/* ---------------------------------- 工具 ---------------------------------- */

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 东八区格式化（与 borrowManager 口径一致） */
function formatCST(date, withTime) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const base = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  return withTime ? `${base} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` : base;
}

/** 转义正则元字符，避免用户输入 "(" 导致查询报错 */
function escapeReg(s) {
  return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

async function isAdmin(openid) {
  if (!openid) return false;
  const r = await db.collection('users').where({ openid, role: 'admin' }).count();
  return r.total > 0;
}

async function getUser(openid) {
  if (!openid) return null;
  const r = await db.collection('users').where({ openid }).limit(1).get();
  return r.data[0] || null;
}

/** 昵称脱敏：保留首字 + **，用于匿名展示 */
function maskName(name) {
  const s = String(name || '读者');
  return s.charAt(0) + '**';
}

/** 重算某书的评分聚合，写回 books（失败不影响主流程） */
async function refreshBookRating(bookId) {
  if (!bookId) return;
  try {
    const res = await db
      .collection(COLL)
      .aggregate()
      .match({ bookId, status: STATUS.APPROVED })
      .group({ _id: null, count: $.sum(1), avg: $.avg('$rating') })
      .end();
    const row = (res.list && res.list[0]) || { count: 0, avg: 0 };
    await db
      .collection('books')
      .doc(bookId)
      .update({
        data: {
          ratingCount: row.count || 0,
          ratingAvg: row.count ? Math.round((row.avg || 0) * 10) / 10 : 0,
          reviewCount: row.count || 0
        }
      });
  } catch (e) {
    console.error('[reviewManager] 重算评分失败', bookId, e);
  }
}

/** 输出结构：补展示字段 + 当前用户是否点过赞 */
function shape(row, openid) {
  const anonymous = !!row.anonymous;
  return {
    _id: row._id,
    bookId: row.bookId,
    bookTitle: row.bookTitle || '',
    userName: anonymous ? '匿名读者' : row.userName || '读者',
    avatar: anonymous ? '' : row.avatar || '',
    anonymous,
    rating: Number(row.rating) || 0,
    content: row.content || '',
    likeCount: Number(row.likeCount) || 0,
    liked: !!(openid && (row.likedBy || []).indexOf(openid) >= 0),
    mine: !!(openid && row.openid === openid),
    status: row.status || STATUS.APPROVED,
    reply: row.reply || null,
    replyText: row.reply ? formatCST(row.reply.createdAt, true) : '',
    createdAtText: formatCST(row.createdAt, true),
    edited: !!(row.updatedAt && row.createdAt && new Date(row.updatedAt) - new Date(row.createdAt) > 1000)
  };
}

/* ---------------------------------- 业务 ---------------------------------- */

/** 新增或编辑评论（同一用户同一本书只有一条） */
async function doAdd(event, openid) {
  const bookId = event.bookId;
  if (!bookId) return { ok: false, msg: '缺少图书信息' };

  const rating = Math.round(Number(event.rating) || 0);
  if (rating < 1 || rating > 5) return { ok: false, msg: '请先选择 1-5 星评分' };

  const content = String(event.content || '').trim();
  if (content.length < MIN_LEN) return { ok: false, msg: `评论至少 ${MIN_LEN} 个字` };
  if (content.length > MAX_LEN) return { ok: false, msg: `评论最多 ${MAX_LEN} 个字` };
  const hit = BANNED.find((w) => content.indexOf(w) >= 0);
  if (hit) return { ok: false, msg: '内容包含不适合发布的词汇，请修改后再提交' };

  const bookRes = await db.collection('books').doc(bookId).get().catch(() => null);
  if (!bookRes || !bookRes.data) return { ok: false, msg: '图书不存在' };

  const me = await getUser(openid);
  if (!me) return { ok: false, msg: '请先登录' };

  const exist = await db.collection(COLL).where({ bookId, openid }).limit(1).get();
  const now = db.serverDate();

  if (exist.data.length) {
    const old = exist.data[0];
    await db
      .collection(COLL)
      .doc(old._id)
      .update({
        data: {
          rating,
          content,
          anonymous: !!event.anonymous,
          updatedAt: now,
          // 被隐藏的评论经作者修改后重新进入可见状态（给一次改正机会）
          status: old.status === STATUS.HIDDEN ? STATUS.APPROVED : old.status
        }
      });
    await refreshBookRating(bookId);
    return { ok: true, data: { id: old._id, updated: true } };
  }

  const add = await db.collection(COLL).add({
    data: {
      bookId,
      bookTitle: bookRes.data.title || '',
      openid,
      userName: me.nickname || me.nickName || '读者',
      avatar: me.avatarUrl || '',
      anonymous: !!event.anonymous,
      rating,
      content,
      likeCount: 0,
      likedBy: [],
      status: STATUS.APPROVED,
      reply: null,
      createdAt: now,
      updatedAt: now
    }
  });
  await refreshBookRating(bookId);
  return { ok: true, data: { id: add._id, created: true } };
}

/** 删除评论：本人或管理员 */
async function doRemove(event, openid) {
  const admin = await isAdmin(openid);
  let doc = null;
  if (event.reviewId) {
    const r = await db.collection(COLL).doc(event.reviewId).get().catch(() => null);
    doc = r && r.data;
  } else if (event.bookId) {
    const r = await db.collection(COLL).where({ bookId: event.bookId, openid }).limit(1).get();
    doc = r.data[0];
  }
  if (!doc) return { ok: false, msg: '评论不存在' };
  if (!admin && doc.openid !== openid) return { ok: false, msg: '只能删除自己的评论' };

  await db.collection(COLL).doc(doc._id).remove();
  await refreshBookRating(doc.bookId);
  return { ok: true };
}

/** 某本书的评论列表（公开，分页） */
async function doList(event, openid) {
  const bookId = event.bookId;
  if (!bookId) return { ok: false, msg: '缺少图书信息' };
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || PAGE_SIZE));
  const sort = event.sort === 'helpful' ? 'helpful' : 'latest';

  const where = { bookId, status: STATUS.APPROVED };
  const order = sort === 'helpful' ? ['likeCount', 'desc'] : ['createdAt', 'desc'];

  const [countRes, listRes, sumRes] = await Promise.all([
    db.collection(COLL).where(where).count(),
    db
      .collection(COLL)
      .where(where)
      .orderBy(order[0], order[1])
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get(),
    db
      .collection(COLL)
      .aggregate()
      .match(where)
      .group({ _id: null, count: $.sum(1), avg: $.avg('$rating') })
      .end()
  ]);

  const agg = (sumRes.list && sumRes.list[0]) || { count: 0, avg: 0 };
  const dist = [0, 0, 0, 0, 0];
  // 评分分布用于详情页星级条；只统计本页会失真，故单独聚合
  const distRes = await db
    .collection(COLL)
    .aggregate()
    .match(where)
    .group({ _id: '$rating', n: $.sum(1) })
    .end();
  distRes.list.forEach((r) => {
    const idx = Math.round(Number(r._id)) - 1;
    if (idx >= 0 && idx < 5) dist[idx] = r.n;
  });

  return {
    ok: true,
    data: {
      list: listRes.data.map((r) => shape(r, openid)),
      total: countRes.total,
      page,
      pageSize,
      summary: {
        count: agg.count || 0,
        avg: agg.count ? Math.round((agg.avg || 0) * 10) / 10 : 0,
        dist
      }
    }
  };
}

/** 我在某本书下的评论（用于「写评论」回填） */
async function doMyReview(event, openid) {
  if (!event.bookId) return { ok: false, msg: '缺少图书信息' };
  const r = await db.collection(COLL).where({ bookId: event.bookId, openid }).limit(1).get();
  if (!r.data.length) return { ok: true, data: null };
  const row = r.data[0];
  return {
    ok: true,
    data: {
      _id: row._id,
      rating: Number(row.rating) || 0,
      content: row.content || '',
      anonymous: !!row.anonymous,
      status: row.status
    }
  };
}

/** 点赞 / 取消点赞（幂等切换） */
async function doLike(event, openid) {
  const reviewId = event.reviewId;
  if (!reviewId) return { ok: false, msg: '缺少评论 ID' };
  const r = await db.collection(COLL).doc(reviewId).get().catch(() => null);
  const doc = r && r.data;
  if (!doc) return { ok: false, msg: '评论不存在' };
  if (doc.openid === openid) return { ok: false, msg: '不能给自己的评论点赞' };

  const liked = (doc.likedBy || []).indexOf(openid) >= 0;
  await db
    .collection(COLL)
    .doc(reviewId)
    .update({
      data: liked
        ? { likedBy: _.pull(openid), likeCount: _.inc(-1) }
        : { likedBy: _.addToSet(openid), likeCount: _.inc(1) }
    });
  return { ok: true, data: { liked: !liked, likeCount: Math.max(0, (doc.likeCount || 0) + (liked ? -1 : 1)) } };
}

/** 管理员：评论列表（可按状态/关键词筛选） */
async function doAdminList(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));
  const where = {};
  if (event.status && event.status !== 'all') where.status = event.status;
  if (event.keyword) {
    const reg = db.RegExp({ regexp: escapeReg(event.keyword), options: 'i' });
    where.content = reg;
  }
  const [countRes, listRes] = await Promise.all([
    db.collection(COLL).where(where).count(),
    db
      .collection(COLL)
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()
  ]);
  return {
    ok: true,
    data: {
      list: listRes.data.map((r) => Object.assign(shape(r, openid), { openid: r.openid })),
      total: countRes.total,
      page,
      pageSize
    }
  };
}

/** 管理员：隐藏 / 恢复 */
async function doSetStatus(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const status = event.status === STATUS.HIDDEN ? STATUS.HIDDEN : STATUS.APPROVED;
  const r = await db.collection(COLL).doc(event.reviewId).get().catch(() => null);
  const doc = r && r.data;
  if (!doc) return { ok: false, msg: '评论不存在' };
  await db.collection(COLL).doc(doc._id).update({ data: { status, updatedAt: db.serverDate() } });
  await refreshBookRating(doc.bookId);
  return { ok: true };
}

/** 管理员：官方回复（每条评论 1 条，可覆盖），并通知作者 */
async function doReply(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const content = String(event.content || '').trim();
  if (!content) return { ok: false, msg: '请填写回复内容' };
  if (content.length > 200) return { ok: false, msg: '回复最多 200 字' };

  const r = await db.collection(COLL).doc(event.reviewId).get().catch(() => null);
  const doc = r && r.data;
  if (!doc) return { ok: false, msg: '评论不存在' };

  const reply = { content, openid, createdAt: new Date() };
  await db.collection(COLL).doc(doc._id).update({ data: { reply, updatedAt: db.serverDate() } });

  // 站内通知作者（失败不影响回复本身）
  try {
    const me = await getUser(openid);
    await db.collection('notifications').add({
      data: {
        toOpenid: doc.openid,
        type: 'review',
        title: '馆员回复了你的书评',
        content: `《${doc.bookTitle || '图书'}》：${content.slice(0, 40)}`,
        link: `/pages/book-reviews/index?bookId=${doc.bookId}`,
        level: 'info',
        read: false,
        readAt: null,
        senderOpenid: openid,
        senderName: (me && (me.nickname || me.nickName)) || '馆员',
        createdAt: db.serverDate()
      }
    });
  } catch (e) {
    console.error('[reviewManager] 回复通知写入失败', e);
  }
  return { ok: true };
}

/* ---------------------------------- 入口 ---------------------------------- */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'addReview':
        if (!OPENID) return { ok: false, msg: '请先登录' };
        return await doAdd(event, OPENID);
      case 'removeReview':
        if (!OPENID) return { ok: false, msg: '请先登录' };
        return await doRemove(event, OPENID);
      case 'listReviews':
        return await doList(event, OPENID);
      case 'myReview':
        if (!OPENID) return { ok: false, msg: '请先登录' };
        return await doMyReview(event, OPENID);
      case 'likeReview':
        if (!OPENID) return { ok: false, msg: '请先登录' };
        return await doLike(event, OPENID);
      case 'adminReviews':
        return await doAdminList(event, OPENID);
      case 'setReviewStatus':
        return await doSetStatus(event, OPENID);
      case 'replyReview':
        return await doReply(event, OPENID);
      default:
        return { ok: false, msg: '未知操作' };
    }
  } catch (e) {
    console.error('[reviewManager] ', e);
    return { ok: false, msg: (e && e.message) || '操作失败' };
  }
};
