/**
 * 云函数：notifyManager
 * 站内通知 + 待办。
 *
 * 设计要点：
 * 1. 通知「按人扇出」：群发时为每个接收者写一条独立文档，read 状态天然独立；
 *    接收者上限 500，超出截断并在返回值里告知，避免单次云函数超时。
 * 2. 待办分两类：
 *    - 系统待办：每次读取时按借阅/审批状态实时计算，不落库（避免与业务数据不一致）；
 *    - 自定义待办：todos 集合，可增删改、可勾选完成。
 * 3. 通知偏好存在 users.notifyPrefs；关闭某类型后不再为该类型「创建」新通知，历史保留。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const NOTICE = 'notifications';
const TODO = 'todos';
const LOG = 'noticeLogs';
const TYPE = ['borrow', 'due', 'overdue', 'card', 'system', 'review'];
const PRIORITY = ['high', 'normal', 'low'];
const FANOUT_LIMIT = 500;
const TODO_MAX_ACTIVE = 100;

const DEFAULT_PREFS = {
  borrow: true,
  due: true,
  overdue: true,
  card: true,
  system: true,
  review: true
};

/* ---------------------------------- 工具 ---------------------------------- */

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

function formatCST(date, withTime) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const t = new Date(d.getTime() + 8 * 3600 * 1000);
  const base = `${t.getUTCFullYear()}-${pad(t.getUTCMonth() + 1)}-${pad(t.getUTCDate())}`;
  return withTime ? `${base} ${pad(t.getUTCHours())}:${pad(t.getUTCMinutes())}` : base;
}

function cstToday() {
  return formatCST(new Date(), false);
}

/** 东八区今天 0 点对应的时间戳 */
function cstTodayStart() {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  const s = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - 8 * 3600 * 1000;
  return s;
}

/** 两个 yyyy-MM-dd 相差天数（b - a） */
function diffDays(a, b) {
  const pa = new Date(a + 'T00:00:00Z').getTime();
  const pb = new Date(b + 'T00:00:00Z').getTime();
  if (isNaN(pa) || isNaN(pb)) return 0;
  return Math.round((pb - pa) / 86400000);
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

function shapeNotice(row) {
  return {
    _id: row._id,
    type: row.type || 'system',
    title: row.title || '',
    content: row.content || '',
    link: row.link || '',
    level: row.level || 'info',
    read: !!row.read,
    senderName: row.senderName || '',
    createdAtText: formatCST(row.createdAt, true)
  };
}

/* --------------------------------- 通知 --------------------------------- */

async function doList(event, openid) {
  if (!openid) return { ok: false, msg: '请先登录' };
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));
  const where = { toOpenid: openid };
  if (event.onlyUnread) where.read = false;

  const [countRes, listRes] = await Promise.all([
    db.collection(NOTICE).where(where).count(),
    db
      .collection(NOTICE)
      .where(where)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()
  ]);
  return {
    ok: true,
    data: { list: listRes.data.map(shapeNotice), total: countRes.total, page, pageSize }
  };
}

async function doUnread(openid) {
  if (!openid) return { ok: true, data: { count: 0 } };
  const r = await db.collection(NOTICE).where({ toOpenid: openid, read: false }).count();
  return { ok: true, data: { count: r.total } };
}

async function doMarkRead(event, openid) {
  if (!openid) return { ok: false, msg: '请先登录' };
  if (!event.id) return { ok: false, msg: '缺少通知 ID' };
  const r = await db
    .collection(NOTICE)
    .where({ _id: event.id, toOpenid: openid })
    .update({ data: { read: true, readAt: db.serverDate() } });
  return { ok: true, data: { updated: r.stats.updated } };
}

async function doMarkAll(openid) {
  if (!openid) return { ok: false, msg: '请先登录' };
  const r = await db
    .collection(NOTICE)
    .where({ toOpenid: openid, read: false })
    .update({ data: { read: true, readAt: db.serverDate() } });
  return { ok: true, data: { updated: r.stats.updated } };
}

/* -------------------------------- 通知偏好 -------------------------------- */

async function doGetPrefs(openid) {
  const me = await getUser(openid);
  const prefs = Object.assign({}, DEFAULT_PREFS, (me && me.notifyPrefs) || {});
  return { ok: true, data: { prefs } };
}

async function doSavePrefs(event, openid) {
  const me = await getUser(openid);
  if (!me) return { ok: false, msg: '用户不存在，请重新登录' };
  const next = Object.assign({}, DEFAULT_PREFS, me.notifyPrefs || {});
  const input = event.prefs || {};
  Object.keys(DEFAULT_PREFS).forEach((k) => {
    // system 类公告不可关闭
    if (k === 'system') return;
    if (typeof input[k] === 'boolean') next[k] = input[k];
  });
  await db.collection('users').doc(me._id).update({ data: { notifyPrefs: next } });
  return { ok: true, data: { prefs: next } };
}

/* --------------------------------- 待办 --------------------------------- */

/** 读者侧系统待办：由借阅状态实时派生 */
async function userSystemTodos(openid) {
  const res = await db
    .collection('borrows')
    .where({ userId: openid, status: _.in(['pending', 'borrowing', 'return_requested']) })
    .orderBy('dueDate', 'asc')
    .limit(100)
    .get();
  const today = cstToday();
  const out = [];
  res.data.forEach((r) => {
    const title = r.bookTitle || '图书';
    if (r.status === 'borrowing' && r.dueDate) {
      const due = formatCST(r.dueDate, false);
      const left = diffDays(today, due);
      if (left < 0) {
        out.push({
          id: 'sys-overdue-' + r._id,
          type: 'system',
          title: `《${title}》已逾期 ${-left} 天`,
          desc: '请尽快提交还书申请，逾期会影响信用',
          level: 'danger',
          dueDateText: due,
          link: '/pages/my/borrows/index'
        });
      } else if (left <= 3) {
        out.push({
          id: 'sys-due-' + r._id,
          type: 'system',
          title: `《${title}》还有 ${left} 天到期`,
          desc: '可续借，或按时归还',
          level: 'warning',
          dueDateText: due,
          link: '/pages/my/borrows/index'
        });
      }
    }
    if (r.status === 'return_requested') {
      out.push({
        id: 'sys-ret-' + r._id,
        type: 'system',
        title: `《${title}》等待管理员确认归还`,
        desc: '已提交预约还书，请按时到馆交接',
        level: 'info',
        dueDateText: r.scheduledReturnDate || '',
        link: '/pages/my/borrows/index'
      });
    }
    if (r.status === 'pending') {
      const pickup = r.scheduledPickupDate || '';
      const gap = pickup ? diffDays(today, pickup) : 99;
      if (gap <= 1) {
        out.push({
          id: 'sys-pick-' + r._id,
          type: 'system',
          title: `《${title}》待取书`,
          desc: gap <= 0 ? '取书日期已到，请到馆领取' : '取书日期是明天，请安排时间',
          level: gap <= 0 ? 'warning' : 'info',
          dueDateText: pickup,
          link: '/pages/my/borrows/index'
        });
      }
    }
  });
  return out;
}

/** 管理员侧系统待办：待办数量聚合，数量为 0 的不返回 */
async function adminSystemTodos() {
  const [cardPending, borrowPending, returnPending, borrowingList] = await Promise.all([
    db.collection('users').where({ 'card.status': 'pending' }).count(),
    db.collection('borrows').where({ status: 'pending' }).count(),
    db.collection('borrows').where({ status: 'return_requested' }).count(),
    db
      .collection('borrows')
      .where({ status: 'borrowing' })
      .field({ dueDate: true })
      .limit(1000)
      .get()
  ]);
  const today = cstToday();
  let overdue = 0;
  borrowingList.data.forEach((r) => {
    if (r.dueDate && formatCST(r.dueDate, false) < today) overdue++;
  });

  const out = [];
  if (cardPending.total) {
    out.push({
      id: 'sys-admin-card',
      type: 'system',
      title: `有 ${cardPending.total} 条借书证申请待审批`,
      desc: '点击进入成员管理处理',
      level: 'warning',
      link: '/pages/admin/members/index?tab=pending'
    });
  }
  if (borrowPending.total) {
    out.push({
      id: 'sys-admin-borrow',
      type: 'system',
      title: `有 ${borrowPending.total} 笔借出待确认`,
      desc: '读者已提交申请，线下交收后线上确认',
      level: 'warning',
      link: '/pages/admin/borrows/index?status=pending'
    });
  }
  if (returnPending.total) {
    out.push({
      id: 'sys-admin-return',
      type: 'system',
      title: `有 ${returnPending.total} 笔归还待确认`,
      desc: '读者已预约还书，回收后线上确认',
      level: 'warning',
      link: '/pages/admin/borrows/index?status=return_requested'
    });
  }
  if (overdue) {
    out.push({
      id: 'sys-admin-overdue',
      type: 'system',
      title: `有 ${overdue} 本书已逾期未还`,
      desc: '可在借阅管理中发送逾期提醒',
      level: 'danger',
      link: '/pages/admin/borrows/index?status=overdue'
    });
  }
  return out;
}

async function doListTodos(openid) {
  if (!openid) return { ok: false, msg: '请先登录' };
  const admin = await isAdmin(openid);
  const [system, customRes] = await Promise.all([
    admin ? adminSystemTodos() : userSystemTodos(openid),
    db.collection(TODO).where({ ownerOpenid: openid }).orderBy('createdAt', 'desc').limit(200).get()
  ]);

  const today = cstToday();
  const active = [];
  const done = [];
  customRes.data.forEach((t) => {
    const dueDate = t.dueDate || '';
    const item = {
      id: t._id,
      type: 'custom',
      title: t.title,
      desc: t.note || '',
      priority: t.priority || 'normal',
      level: t.priority === 'high' ? 'danger' : t.priority === 'low' ? 'info' : 'warning',
      dueDateText: dueDate,
      done: !!t.done,
      overdue: !t.done && !!dueDate && dueDate < today,
      overdueDays: !t.done && dueDate && dueDate < today ? diffDays(dueDate, today) : 0,
      createdAtText: formatCST(t.createdAt, true)
    };
    (t.done ? done : active).push(item);
  });

  // 未完成按「有日期优先 + 日期升序」排序
  active.sort((a, b) => {
    if (a.dueDateText && b.dueDateText) return a.dueDateText < b.dueDateText ? -1 : 1;
    if (a.dueDateText) return -1;
    if (b.dueDateText) return 1;
    return 0;
  });

  return {
    ok: true,
    data: {
      isAdmin: admin,
      system,
      active,
      done: done.slice(0, 50),
      today
    }
  };
}

async function doAddTodo(event, openid) {
  if (!openid) return { ok: false, msg: '请先登录' };
  const title = String(event.title || '').trim();
  if (!title) return { ok: false, msg: '请填写待办标题' };
  if (title.length > 30) return { ok: false, msg: '标题最多 30 个字' };
  const note = String(event.note || '').trim();
  if (note.length > 200) return { ok: false, msg: '备注最多 200 个字' };

  const activeCount = await db.collection(TODO).where({ ownerOpenid: openid, done: false }).count();
  if (activeCount.total >= TODO_MAX_ACTIVE) {
    return { ok: false, msg: `未完成待办已达 ${TODO_MAX_ACTIVE} 条，请先清理` };
  }

  const dueDate = /^\d{4}-\d{2}-\d{2}$/.test(event.dueDate || '') ? event.dueDate : '';
  const priority = PRIORITY.indexOf(event.priority) >= 0 ? event.priority : 'normal';
  const add = await db.collection(TODO).add({
    data: {
      ownerOpenid: openid,
      title,
      note,
      dueDate,
      priority,
      done: false,
      doneAt: null,
      createdAt: db.serverDate()
    }
  });
  return { ok: true, data: { id: add._id } };
}

async function doToggleTodo(event, openid) {
  if (!openid) return { ok: false, msg: '请先登录' };
  const r = await db.collection(TODO).doc(event.id).get().catch(() => null);
  const doc = r && r.data;
  if (!doc) return { ok: false, msg: '待办不存在' };
  if (doc.ownerOpenid !== openid) return { ok: false, msg: '只能操作自己的待办' };
  const done = typeof event.done === 'boolean' ? event.done : !doc.done;
  await db.collection(TODO).doc(doc._id).update({ data: { done, doneAt: done ? db.serverDate() : null } });
  return { ok: true, data: { done } };
}

async function doRemoveTodo(event, openid) {
  if (!openid) return { ok: false, msg: '请先登录' };
  const r = await db.collection(TODO).doc(event.id).get().catch(() => null);
  const doc = r && r.data;
  if (!doc) return { ok: false, msg: '待办不存在' };
  if (doc.ownerOpenid !== openid) return { ok: false, msg: '只能删除自己的待办' };
  await db.collection(TODO).doc(doc._id).remove();
  return { ok: true };
}

/* ------------------------------- 管理员群发 ------------------------------- */

async function doSend(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const title = String(event.title || '').trim();
  const content = String(event.content || '').trim();
  if (!title) return { ok: false, msg: '请填写通知标题' };
  if (title.length > 30) return { ok: false, msg: '标题最多 30 个字' };
  if (content.length > 200) return { ok: false, msg: '正文最多 200 个字' };

  const type = TYPE.indexOf(event.type) >= 0 ? event.type : 'system';
  const link = String(event.link || '').trim();

  // 1) 取接收者
  let users = [];
  const scope = event.scope || 'all';
  if (scope === 'location' && event.location) {
    const r = await db
      .collection('users')
      .where({ 'card.location': event.location })
      .field({ openid: true, notifyPrefs: true, nickname: true })
      .limit(FANOUT_LIMIT + 1)
      .get();
    users = r.data;
  } else if (scope === 'openids' && Array.isArray(event.openids) && event.openids.length) {
    const r = await db
      .collection('users')
      .where({ openid: _.in(event.openids.slice(0, FANOUT_LIMIT + 1)) })
      .field({ openid: true, notifyPrefs: true, nickname: true })
      .limit(FANOUT_LIMIT + 1)
      .get();
    users = r.data;
  } else {
    const r = await db
      .collection('users')
      .field({ openid: true, notifyPrefs: true, nickname: true })
      .limit(FANOUT_LIMIT + 1)
      .get();
    users = r.data;
  }

  const truncated = users.length > FANOUT_LIMIT;
  if (truncated) users = users.slice(0, FANOUT_LIMIT);

  // 2) 过滤掉关闭了该类型通知的用户（system 不可关闭）
  const targets = users.filter((u) => {
    if (!u.openid) return false;
    if (type === 'system') return true;
    const prefs = u.notifyPrefs || {};
    return prefs[type] !== false;
  });

  const me = await getUser(openid);
  const senderName = (me && (me.nickname || me.nickName)) || '图书馆';

  // 3) 分批扇出（每批 20，避免并发写超限）
  let sent = 0;
  for (let i = 0; i < targets.length; i += 20) {
    const batch = targets.slice(i, i + 20);
    await Promise.all(
      batch.map((u) =>
        db
          .collection(NOTICE)
          .add({
            data: {
              toOpenid: u.openid,
              type,
              title,
              content,
              link,
              level: type === 'system' ? 'info' : 'warning',
              read: false,
              readAt: null,
              senderOpenid: openid,
              senderName,
              createdAt: db.serverDate()
            }
          })
          .then(() => {
            sent++;
          })
          .catch((e) => console.error('[notifyManager] 扇出失败', u.openid, e))
      )
    );
  }

  // 4) 发送记录留痕
  await db
    .collection(LOG)
    .add({
      data: {
        senderOpenid: openid,
        senderName,
        title,
        content,
        type,
        scope,
        location: event.location || '',
        targetCount: sent,
        truncated,
        createdAt: db.serverDate()
      }
    })
    .catch((e) => console.error('[notifyManager] 日志写入失败', e));

  return { ok: true, data: { sent, truncated } };
}

async function doSentList(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const page = Math.max(1, Number(event.page) || 1);
  const pageSize = Math.min(50, Math.max(1, Number(event.pageSize) || 20));
  const [countRes, listRes] = await Promise.all([
    db.collection(LOG).count(),
    db
      .collection(LOG)
      .orderBy('createdAt', 'desc')
      .skip((page - 1) * pageSize)
      .limit(pageSize)
      .get()
  ]);
  return {
    ok: true,
    data: {
      list: listRes.data.map((r) => ({
        _id: r._id,
        title: r.title,
        content: r.content,
        scope: r.scope,
        location: r.location,
        targetCount: r.targetCount,
        truncated: !!r.truncated,
        senderName: r.senderName,
        createdAtText: formatCST(r.createdAt, true)
      })),
      total: countRes.total,
      page,
      pageSize
    }
  };
}

/* ---------------------------------- 入口 ---------------------------------- */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'list':
        return await doList(event, OPENID);
      case 'unreadCount':
        return await doUnread(OPENID);
      case 'markRead':
        return await doMarkRead(event, OPENID);
      case 'markAllRead':
        return await doMarkAll(OPENID);
      case 'getPrefs':
        return await doGetPrefs(OPENID);
      case 'savePrefs':
        return await doSavePrefs(event, OPENID);
      case 'listTodos':
        return await doListTodos(OPENID);
      case 'addTodo':
        return await doAddTodo(event, OPENID);
      case 'toggleTodo':
        return await doToggleTodo(event, OPENID);
      case 'removeTodo':
        return await doRemoveTodo(event, OPENID);
      case 'send':
        return await doSend(event, OPENID);
      case 'sentList':
        return await doSentList(event, OPENID);
      default:
        return { ok: false, msg: '未知操作' };
    }
  } catch (e) {
    console.error('[notifyManager] ', e);
    return { ok: false, msg: (e && e.message) || '操作失败' };
  }
};
