/**
 * 云函数：insightManager
 * 1. 用户统计 / 书籍统计（管理端）
 * 2. CSV 导出（返回文本，客户端落盘后转发/保存）
 * 3. 个性化推荐（规则打分，冷启动友好）
 *
 * 口径说明（必须与页面文案一致）：
 * - 借出中 = borrowing + return_requested（书在读者手上）
 * - 逾期 = borrowing 且 dueDate < 今天
 * - 可借册数 = Σ stocks − 未归还占用（与详情页「可借 N 本」同口径）
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;
const $ = db.command.aggregate;

const EXPORT_MAX = 3000;
const POOL = 200;
const MAX_PER_AUTHOR = 2;

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

/** N 天前的东八区 0 点（Date） */
function daysAgoStart(days) {
  const t = new Date(Date.now() + 8 * 3600 * 1000);
  const todayStart = Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - 8 * 3600 * 1000;
  return new Date(todayStart - (days - 1) * 86400000);
}

/** 生成近 days 天的日期数组（升序） */
function dayList(days) {
  const out = [];
  const start = daysAgoStart(days).getTime();
  for (let i = 0; i < days; i++) out.push(formatCST(start + i * 86400000, false));
  return out;
}

/* ------------------------- 统计区间（预设 / 自定义） ------------------------- */
// 与 miniprogram/utils/analytics-range.js 保持同一口径，改动需同步两边

const DAY_MS = 86400000;
const CHINA_OFFSET_MS = 8 * 3600 * 1000;
const MAX_SPAN_DAYS = 731; // 两年（含闰年）

/** 'YYYY-MM-DD' → 东八区当天 00:00 的时间戳；非法返回 null */
function dayStartMs(dateStr) {
  const s = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(s + 'T00:00:00+08:00');
  return isNaN(ms) ? null : ms;
}

/** 今天（东八区）00:00 */
function todayStartMs() {
  const t = new Date(Date.now() + CHINA_OFFSET_MS);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - CHINA_OFFSET_MS;
}

/** 两年前的今天 00:00 */
function minStartMs() {
  const t = new Date(todayStartMs() + CHINA_OFFSET_MS);
  t.setUTCFullYear(t.getUTCFullYear() - 2);
  return t.getTime() - CHINA_OFFSET_MS;
}

function unitForDays(days) {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

/**
 * 解析统计区间：优先自定义 startDate/endDate，否则回退 days。
 * 越界一律收敛（不报错）：结束日 ≤ 今天、开始日 ≥ 两年前、跨度 ≤ 731 天。
 */
function resolveRange(event = {}) {
  const notices = [];
  const today = todayStartMs();
  const minStart = minStartMs();
  const rawStart = dayStartMs(event.startDate);
  const rawEnd = dayStartMs(event.endDate);
  const isCustom = rawStart !== null && rawEnd !== null;

  let startMs;
  let endMs;

  if (isCustom) {
    startMs = rawStart;
    endMs = rawEnd;
    if (endMs > today) {
      endMs = today;
      notices.push('结束日期不能晚于今天，已自动改为今天');
    }
    if (startMs < minStart) {
      startMs = minStart;
      notices.push('开始日期不能早于两年前，已自动调整');
    }
    if (startMs > endMs) {
      const tmp = startMs;
      startMs = endMs;
      endMs = tmp;
      notices.push('开始日期晚于结束日期，已自动调换');
    }
    if (Math.round((endMs - startMs) / DAY_MS) + 1 > MAX_SPAN_DAYS) {
      startMs = endMs - (MAX_SPAN_DAYS - 1) * DAY_MS;
      notices.push(`区间最长 ${MAX_SPAN_DAYS} 天，已自动截断`);
    }
  } else {
    const days = Math.min(365, Math.max(1, Number(event.days) || 30));
    endMs = today;
    startMs = today - (days - 1) * DAY_MS;
  }

  if (startMs < minStart) startMs = minStart;
  if (endMs > today) endMs = today;

  const days = Math.round((endMs - startMs) / DAY_MS) + 1;
  const unit = unitForDays(days);
  const startDate = formatCST(startMs, false);
  const endDate = formatCST(endMs, false);

  return {
    mode: isCustom ? 'custom' : 'preset',
    start: new Date(startMs),
    endExclusive: new Date(endMs + DAY_MS),
    startMs,
    endExclusiveMs: endMs + DAY_MS,
    startDate,
    endDate,
    days,
    unit,
    unitLabel: unit === 'month' ? '按月' : unit === 'week' ? '按周' : '按天',
    label: isCustom ? `${startDate} 至 ${endDate}` : `近 ${days} 天`,
    notices
  };
}

/** 趋势分桶：按天 / 按周（7 天一格）/ 按月（自然月） */
function buildBuckets(range) {
  const out = [];
  const end = range.endExclusiveMs;

  if (range.unit === 'month') {
    let cursor = range.startMs;
    while (cursor < end) {
      const t = new Date(cursor + CHINA_OFFSET_MS);
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth();
      const to = Math.min(Date.UTC(y, m + 1, 1) - CHINA_OFFSET_MS, end);
      out.push({ label: `${y}-${m + 1 < 10 ? '0' : ''}${m + 1}`, from: cursor, to });
      cursor = to;
    }
    return out;
  }

  const step = (range.unit === 'week' ? 7 : 1) * DAY_MS;
  for (let s = range.startMs; s < end; s += step) {
    out.push({ label: formatCST(s, false).slice(5), from: s, to: Math.min(s + step, end) });
  }
  return out;
}

function bucketIndexOf(ms, range, buckets) {
  if (range.unit === 'month') {
    const label = formatCST(ms, false).slice(0, 7);
    for (let i = 0; i < buckets.length; i++) if (buckets[i].label === label) return i;
    return -1;
  }
  const step = (range.unit === 'week' ? 7 : 1) * DAY_MS;
  const idx = Math.floor((ms - range.startMs) / step);
  return idx >= 0 && idx < buckets.length ? idx : -1;
}

/** 按区间分桶统计趋势 */
function trendOf(items, range, pick) {
  const buckets = buildBuckets(range);
  const counts = new Array(buckets.length).fill(0);
  (items || []).forEach((it) => {
    const v = pick(it);
    if (!v) return;
    const ms = new Date(v).getTime();
    if (isNaN(ms) || ms < range.startMs || ms >= range.endExclusiveMs) return;
    const idx = bucketIndexOf(ms, range, buckets);
    if (idx >= 0) counts[idx] += 1;
  });
  return buckets.map((b, i) => ({ label: b.label, value: counts[i] }));
}

function sumStocks(stocks) {
  if (!stocks) return 0;
  return Object.keys(stocks).reduce((s, k) => s + (Number(stocks[k]) || 0), 0);
}

/** 手机号脱敏：138****8000 */
function maskPhone(phone) {
  const s = String(phone || '');
  if (s.length < 7) return s;
  return s.slice(0, 3) + '****' + s.slice(-4);
}

async function isAdmin(openid) {
  if (!openid) return false;
  const r = await db.collection('users').where({ openid, role: 'admin' }).count();
  return r.total > 0;
}

/** CSV 单元格转义：含逗号/引号/换行时用双引号包裹 */
function cell(v) {
  const s = v === null || v === undefined ? '' : String(v);
  if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
  return s;
}

/** 拼 CSV（带 UTF-8 BOM，Excel 打开不乱码） */
function toCsv(headers, rows) {
  const lines = [headers.map(cell).join(',')];
  rows.forEach((r) => lines.push(r.map(cell).join(',')));
  return '\ufeff' + lines.join('\r\n');
}

/* -------------------------------- 用户统计 -------------------------------- */

async function doUserStats(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const days = Math.min(365, Math.max(1, Number(event.days) || 30));
  const start = daysAgoStart(days);

  const [total, admins, activeCards, pendingCards, newUsers, settingsRes] = await Promise.all([
    db.collection('users').count(),
    db.collection('users').where({ role: 'admin' }).count(),
    db.collection('users').where({ 'card.status': 'active' }).count(),
    db.collection('users').where({ 'card.status': 'pending' }).count(),
    db.collection('users').where({ createdAt: _.gte(start) }).count(),
    db.collection('settings').doc('global').get().catch(() => ({ data: {} }))
  ]);
  const locations = ((settingsRes.data || {}).locations || []).slice();

  // 按馆藏地点分布
  const byLocation = [];
  for (const loc of locations) {
    const r = await db.collection('users').where({ 'card.location': loc }).count();
    byLocation.push({ label: loc, value: r.total });
  }
  byLocation.sort((a, b) => b.value - a.value);

  // 新增趋势（近 N 天每天一条 count，并发执行）
  const daysArr = dayList(days);
  const trendCounts = await Promise.all(
    daysArr.map((d) => {
      const s = new Date(d + 'T00:00:00+08:00').getTime();
      return db
        .collection('users')
        .where({ createdAt: _.gte(new Date(s)).and(_.lt(new Date(s + 86400000))) })
        .count()
        .then((r) => r.total)
        .catch(() => 0);
    })
  );
  const trend = daysArr.map((d, i) => ({ label: d.slice(5), value: trendCounts[i] }));

  // 区间借阅总量 & 活跃借阅人
  const [borrowTotal, borrowerGroups] = await Promise.all([
    db
      .collection('borrows')
      .where({ borrowDate: _.gte(start), status: _.neq('cancelled') })
      .count(),
    db
      .collection('borrows')
      .aggregate()
      .match({ borrowDate: _.gte(start), status: _.neq('cancelled') })
      .group({ _id: '$userId', n: $.sum(1) })
      .sort({ n: -1 })
      .limit(1000)
      .end()
  ]);
  const groups = (borrowerGroups.list || []).filter((g) => g._id);
  const activeBorrowers = groups.length;

  // TOP 20 借阅人
  const top = groups.slice(0, 20);
  const topOpenids = top.map((g) => g._id);
  let topUsers = [];
  if (topOpenids.length) {
    const r = await db
      .collection('users')
      .where({ openid: _.in(topOpenids) })
      .field({ openid: true, nickname: true, card: true })
      .get();
    topUsers = r.data;
  }
  const topBorrowers = top.map((g) => {
    const u = topUsers.find((x) => x.openid === g._id) || {};
    return {
      openid: g._id,
      nickname: u.nickname || '已注销用户',
      cardStatus: (u.card && u.card.status) || 'none',
      location: (u.card && u.card.location) || '',
      count: g.n
    };
  });

  // 借阅次数分档
  const buckets = [
    { label: '0 次', value: Math.max(0, total.total - activeBorrowers) },
    { label: '1-2 次', value: 0 },
    { label: '3-5 次', value: 0 },
    { label: '6 次以上', value: 0 }
  ];
  groups.forEach((g) => {
    if (g.n >= 6) buckets[3].value++;
    else if (g.n >= 3) buckets[2].value++;
    else buckets[1].value++;
  });

  return {
    ok: true,
    data: {
      days,
      cards: {
        total: total.total,
        admins: admins.total,
        activeCards: activeCards.total,
        pendingCards: pendingCards.total,
        newUsers: newUsers.total,
        borrowTotal: borrowTotal.total,
        activeBorrowers,
        perCapita: activeBorrowers ? Math.round((borrowTotal.total / activeBorrowers) * 10) / 10 : 0
      },
      byLocation,
      roleChart: [
        { label: '普通用户', value: Math.max(0, total.total - admins.total) },
        { label: '管理员', value: admins.total }
      ],
      buckets,
      trend,
      topBorrowers
    }
  };
}

/* -------------------------------- 书籍统计 -------------------------------- */

async function doBookStats(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  // 支持两种口径：{ days } 预设近 N 天；{ startDate, endDate } 自定义区间（含首含尾）
  const range = resolveRange(event);
  const start = range.start;
  const endEx = range.endExclusive;
  const days = range.days;

  const [kinds, newBooks, bookRes, occupiedRes, reviewRes, settingsRes] = await Promise.all([
    db.collection('books').count(),
    db
      .collection('books')
      .where({ createdAt: _.gte(start).and(_.lt(endEx)) })
      .count(),
    db
      .collection('books')
      .field({
        title: true,
        author: true,
        category: true,
        stocks: true,
        borrowCount: true,
        createdAt: true,
        ratingAvg: true,
        ratingCount: true
      })
      .limit(1000)
      .get(),
    db
      .collection('borrows')
      .where({ status: _.in(['pending', 'borrowing', 'return_requested']) })
      .field({ bookId: true, location: true })
      .limit(1000)
      .get(),
    db
      .collection('reviews')
      .aggregate()
      .match({ status: 'approved' })
      .group({ _id: '$rating', n: $.sum(1) })
      .end()
      .catch(() => ({ list: [] })),
    db.collection('settings').doc('global').get().catch(() => ({ data: {} }))
  ]);

  const books = bookRes.data;
  const locations = ((settingsRes.data || {}).locations || []).slice();

  // 各地点馆藏册数（口径：该地点在架册数，不含已借出副本）
  const byLocation = locations.map((loc) => ({ label: loc, value: 0 }));
  const byCategory = {};
  let copies = 0;
  let available = 0;
  let zeroStock = 0;

  const occupied = {};
  occupiedRes.data.forEach((r) => {
    occupied[r.bookId] = (occupied[r.bookId] || 0) + 1;
  });

  books.forEach((b) => {
    const total = sumStocks(b.stocks);
    copies += total;
    const used = occupied[b._id] || 0;
    available += Math.max(0, total - used);
    if (total <= 0) zeroStock++;
    byCategory[b.category || '未分类'] = (byCategory[b.category || '未分类'] || 0) + 1;
    Object.keys(b.stocks || {}).forEach((loc) => {
      const row = byLocation.find((x) => x.label === loc);
      if (row) row.value += Number(b.stocks[loc]) || 0;
    });
  });

  const categoryChart = Object.keys(byCategory)
    .map((k) => ({ label: k, value: byCategory[k] }))
    .sort((a, b) => b.value - a.value);

  // 借阅热度 TOP 20（区间聚合，回退 borrowCount）
  const hotAgg = await db
    .collection('borrows')
    .aggregate()
    .match({ borrowDate: _.gte(start).and(_.lt(endEx)), status: _.neq('cancelled') })
    .group({ _id: '$bookId', n: $.sum(1) })
    .sort({ n: -1 })
    .limit(20)
    .end()
    .catch(() => ({ list: [] }));
  let topBooks = (hotAgg.list || [])
    .filter((g) => g._id)
    .map((g) => {
      const b = books.find((x) => x._id === g._id) || {};
      return { bookId: g._id, title: b.title || '未知图书', author: b.author || '', count: g.n };
    });
  if (!topBooks.length) {
    topBooks = books
      .slice()
      .sort((a, b) => (Number(b.borrowCount) || 0) - (Number(a.borrowCount) || 0))
      .slice(0, 20)
      .map((b) => ({ bookId: b._id, title: b.title, author: b.author, count: Number(b.borrowCount) || 0 }));
  }

  // 滞销书：从未被借且上架超 30 天
  const cold = books
    .filter((b) => !Number(b.borrowCount) && b.createdAt && new Date(b.createdAt) < new Date(Date.now() - 30 * 86400000))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, 20)
    .map((b) => ({ bookId: b._id, title: b.title, author: b.author, createdAtText: formatCST(b.createdAt) }));

  // 评分分布
  const dist = [0, 0, 0, 0, 0];
  (reviewRes.list || []).forEach((r) => {
    const i = Math.round(Number(r._id)) - 1;
    if (i >= 0 && i < 5) dist[i] = r.n;
  });
  const ratingChart = dist.map((n, i) => ({ label: i + 1 + ' 星', value: n }));

  // 新增书籍趋势（区间内按天/周/月分桶，超过 31 天自动降精度）
  const trend = trendOf(books, range, (b) => b.createdAt);

  return {
    ok: true,
    data: {
      days,
      range: {
        mode: range.mode,
        days: range.days,
        startDate: range.startDate,
        endDate: range.endDate,
        unit: range.unit,
        unitLabel: range.unitLabel,
        label: range.label,
        notices: range.notices
      },
      cards: {
        kinds: kinds.total,
        copies,
        available,
        zeroStock,
        newBooks: newBooks.total,
        coldCount: cold.length
      },
      byLocation,
      categoryChart,
      hotBooks: topBooks,
      coldBooks: cold,
      ratingChart,
      trend
    }
  };
}

/* --------------------------------- 导出 --------------------------------- */

async function doExportUsers(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const days = Math.min(365, Math.max(1, Number(event.days) || 30));
  const start = daysAgoStart(days);

  const userRes = await db
    .collection('users')
    .field({
      openid: true,
      nickname: true,
      role: true,
      card: true,
      createdAt: true
    })
    .limit(EXPORT_MAX)
    .get();
  const users = userRes.data;

  // 每人借阅次数与最近借阅（区间内）
  const agg = await db
    .collection('borrows')
    .aggregate()
    .match({ status: _.neq('cancelled') })
    .group({ _id: '$userId', n: $.sum(1), last: $.max('$borrowDate') })
    .limit(EXPORT_MAX)
    .end()
    .catch(() => ({ list: [] }));
  const stat = {};
  (agg.list || []).forEach((g) => {
    stat[g._id] = { n: g.n, last: g.last };
  });

  // 区间内借阅次数（用于排序展示，导出仍全量）
  const inRange = await db
    .collection('borrows')
    .aggregate()
    .match({ borrowDate: _.gte(start), status: _.neq('cancelled') })
    .group({ _id: '$userId', n: $.sum(1) })
    .limit(EXPORT_MAX)
    .end()
    .catch(() => ({ list: [] }));
  const rangeMap = {};
  (inRange.list || []).forEach((g) => {
    rangeMap[g._id] = g.n;
  });

  const rows = users.map((u) => {
    const card = u.card || {};
    const s = stat[u.openid] || {};
    return [
      u.nickname || '',
      u.role === 'admin' ? '管理员' : '普通用户',
      card.status === 'active' ? '已开通' : card.status === 'pending' ? '审批中' : card.status === 'rejected' ? '已驳回' : '未申请',
      card.location || '',
      maskPhone(card.phone),
      formatCST(u.createdAt),
      s.n || 0,
      rangeMap[u.openid] || 0,
      s.last ? formatCST(s.last) : ''
    ];
  });

  const csv = toCsv(
    ['昵称', '角色', '借书证状态', '归属馆藏', '手机号', '注册时间', '累计借阅', '近' + days + '天借阅', '最近借阅'],
    rows
  );
  return {
    ok: true,
    data: {
      filename: `用户统计_${cstToday().replace(/-/g, '')}.csv`,
      content: csv,
      rows: rows.length,
      truncated: users.length >= EXPORT_MAX
    }
  };
}

async function doExportBooks(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const res = await db
    .collection('books')
    .field({
      title: true,
      author: true,
      isbn: true,
      category: true,
      publisher: true,
      year: true,
      stocks: true,
      borrowCount: true,
      ratingAvg: true,
      ratingCount: true,
      createdAt: true
    })
    .limit(EXPORT_MAX)
    .get();
  const books = res.data;

  const rows = books.map((b) => [
    b.title || '',
    b.author || '',
    b.isbn || '',
    b.category || '',
    b.publisher || '',
    b.year || '',
    sumStocks(b.stocks),
    Math.max(0, sumStocks(b.stocks) - 0),
    Number(b.borrowCount) || 0,
    Number(b.ratingAvg) || 0,
    Number(b.ratingCount) || 0,
    formatCST(b.createdAt)
  ]);

  const csv = toCsv(
    ['书名', '作者', 'ISBN', '分类', '出版社', '出版年', '馆藏总册', '在架册数', '累计借阅', '平均评分', '评论数', '上架时间'],
    rows
  );
  return {
    ok: true,
    data: {
      filename: `书籍统计_${cstToday().replace(/-/g, '')}.csv`,
      content: csv,
      rows: rows.length,
      truncated: books.length >= EXPORT_MAX
    }
  };
}

/* --------------------------------- 推荐 --------------------------------- */

/** 规则打分推荐：分类偏好 35 / 作者偏好 15 / 热度 20 / 口碑 20 / 新书 10 */
async function doRecommend(event, openid) {
  const limit = Math.min(50, Math.max(1, Number(event.limit) || 6));
  const offset = Math.max(0, Number(event.offset) || 0);

  const [settingsRes, hotRes, newRes] = await Promise.all([
    db.collection('settings').doc('global').get().catch(() => ({ data: {} })),
    db
      .collection('books')
      .where({ status: 'available' })
      .orderBy('borrowCount', 'desc')
      .field({ title: true, author: true, category: true, cover: true, stocks: true, borrowCount: true, ratingAvg: true, ratingCount: true, createdAt: true, status: true, isbn: true })
      .limit(POOL)
      .get()
      .catch(() => ({ data: [] })),
    db
      .collection('books')
      .where({ status: 'available' })
      .orderBy('createdAt', 'desc')
      .field({ title: true, author: true, category: true, cover: true, stocks: true, borrowCount: true, ratingAvg: true, ratingCount: true, createdAt: true, status: true, isbn: true })
      .limit(POOL)
      .get()
      .catch(() => ({ data: [] }))
  ]);

  // 候选池：热门 + 新书去重，且需有可借库存
  const map = {};
  hotRes.data.concat(newRes.data).forEach((b) => {
    if (!map[b._id] && sumStocks(b.stocks) > 0) map[b._id] = b;
  });
  let pool = Object.keys(map).map((k) => map[k]);
  // 池子不足时放开「仅有库存」限制再取一次
  if (pool.length < limit) {
    const more = await db
      .collection('books')
      .field({ title: true, author: true, category: true, cover: true, stocks: true, borrowCount: true, ratingAvg: true, ratingCount: true, createdAt: true, status: true, isbn: true })
      .limit(POOL)
      .get()
      .catch(() => ({ data: [] }));
    more.data.forEach((b) => {
      if (!map[b._id] && sumStocks(b.stocks) > 0) {
        map[b._id] = b;
        pool.push(b);
      }
    });
  }

  // 用户画像
  const profile = { categories: {}, authors: {}, borrowed: {}, reviewed: {} };
  if (openid) {
    const [borrowsRes, reviewsRes] = await Promise.all([
      db
        .collection('borrows')
        .where({ userId: openid })
        .field({ bookId: true, bookTitle: true })
        .orderBy('borrowDate', 'desc')
        .limit(200)
        .get()
        .catch(() => ({ data: [] })),
      db
        .collection('reviews')
        .where({ openid })
        .field({ bookId: true })
        .limit(200)
        .get()
        .catch(() => ({ data: [] }))
    ]);
    const borrowedIds = borrowsRes.data.map((r) => r.bookId).filter(Boolean);
    borrowedIds.forEach((id) => {
      profile.borrowed[id] = true;
    });
    reviewsRes.data.forEach((r) => {
      profile.reviewed[r.bookId] = true;
    });
    // 借过的书的分类/作者需要回查 books（借阅记录只存 bookId/bookTitle）
    if (borrowedIds.length) {
      const bRes = await db
        .collection('books')
        .where({ _id: _.in(borrowedIds.slice(0, 100)) })
        .field({ category: true, author: true })
        .get()
        .catch(() => ({ data: [] }));
      bRes.data.forEach((b) => {
        if (b.category) profile.categories[b.category] = (profile.categories[b.category] || 0) + 1;
        if (b.author) profile.authors[b.author] = (profile.authors[b.author] || 0) + 1;
      });
    }
  }

  const totalBorrow = Object.keys(profile.categories).reduce((s, k) => s + profile.categories[k], 0) || 1;
  const maxHot = pool.reduce((m, b) => Math.max(m, Number(b.borrowCount) || 0), 0) || 1;
  const now = Date.now();

  const scored = pool
    .filter((b) => !profile.borrowed[b._id] && !profile.reviewed[b._id])
    .map((b) => {
      const catScore = ((profile.categories[b.category] || 0) / totalBorrow) * 35;
      const authorScore = profile.authors[b.author] ? 15 : 0;
      const hotScore = ((Number(b.borrowCount) || 0) / maxHot) * 20;
      const rating = Number(b.ratingAvg) || 3; // 无评分按 3 星折算，避免压制新书
      const rateScore = (rating / 5) * 20;
      const ageDays = b.createdAt ? (now - new Date(b.createdAt).getTime()) / 86400000 : 999;
      const newScore = ageDays <= 30 ? 10 : Math.max(0, 10 - (ageDays - 30) / 30);
      const total = catScore + authorScore + hotScore + rateScore + newScore;

      let reason = '';
      if (catScore >= authorScore && catScore >= hotScore && catScore > 0) reason = `因为你在读「${b.category}」类`;
      else if (authorScore > 0) reason = `你借过 ${b.author} 的书`;
      else if (hotScore >= rateScore) reason = '本馆热门';
      else if (b.ratingCount) reason = `读者好评 ${rating} 分`;
      else reason = '新书上架';

      return { book: b, score: total, reason };
    })
    .sort((a, b) => b.score - a.score);

  // 同作者最多 2 本 + 运营精选置顶
  const picks = ((settingsRes.data || {}).recommendPicks || []).slice(0, 6);
  const authorCount = {};
  const picked = [];
  const rest = [];
  scored.forEach((item) => {
    const author = item.book.author || '';
    authorCount[author] = authorCount[author] || 0;
    if (authorCount[author] >= MAX_PER_AUTHOR) return;
    authorCount[author]++;
    if (picks.indexOf(item.book._id) >= 0) picked.push(Object.assign({ reason: '馆员推荐' }, item));
    else rest.push(item);
  });
  const ordered = picked.concat(rest);
  const slice = ordered.slice(offset, offset + limit);

  return {
    ok: true,
    data: {
      list: slice.map((it) => ({
        _id: it.book._id,
        title: it.book.title,
        author: it.book.author,
        category: it.book.category,
        cover: it.book.cover || '',
        borrowCount: Number(it.book.borrowCount) || 0,
        ratingAvg: Number(it.book.ratingAvg) || 0,
        ratingCount: Number(it.book.ratingCount) || 0,
        reason: it.reason,
        score: Math.round(it.score)
      })),
      total: ordered.length,
      hasMore: offset + limit < ordered.length
    }
  };
}

/* ---------------------------------- 入口 ---------------------------------- */

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'userStats':
        return await doUserStats(event, OPENID);
      case 'bookStats':
        return await doBookStats(event, OPENID);
      case 'exportUsers':
        return await doExportUsers(event, OPENID);
      case 'exportBooks':
        return await doExportBooks(event, OPENID);
      case 'recommend':
        return await doRecommend(event, OPENID);
      default:
        return { ok: false, msg: '未知操作' };
    }
  } catch (e) {
    console.error('[insightManager] ', e);
    return { ok: false, msg: (e && e.message) || '操作失败' };
  }
};
