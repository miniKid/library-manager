/**
 * 统计区间（预设近 N 天 / 自定义起止日期）用例
 * 覆盖：区间收敛规则（不晚于今天、不早于两年前、起止颠倒、跨度上限）、
 *       趋势分桶粒度（按天/周/月）、用户/书籍统计在自定义区间下的计数与导出口径
 */
'use strict';

const { test, mock, assert, resetDb, rawDb } = require('../helpers');
const rangeUtil = require('../../miniprogram/utils/analytics-range');
const { formatCST } = require('../../miniprogram/utils/util');

const DAY = 86400000;

function d(offsetDays) {
  return formatCST(Date.now() + offsetDays * DAY);
}

/* ----------------------------- 区间归一化 ----------------------------- */

test('区间：自定义起止日期按含首含尾折算天数', async () => {
  const r = rangeUtil.normalizeRange({ startDate: d(-6), endDate: d(0) });
  assert.strictEqual(r.mode, 'custom');
  assert.strictEqual(r.days, 7, '含首含尾：6 天前到今天应为 7 天');
  assert.strictEqual(r.startDate, d(-6));
  assert.strictEqual(r.endDate, d(0));
  assert.strictEqual(r.notices.length, 0, '合法区间不应产生修正提示');
});

test('区间：结束日期晚于今天时收敛到今天', async () => {
  const r = rangeUtil.normalizeRange({ startDate: d(-3), endDate: d(5) });
  assert.strictEqual(r.endDate, d(0), '结束日期应被收敛到今天');
  assert.ok(r.notices.some((n) => n.indexOf('结束日期') >= 0), '应提示已调整结束日期');
  assert.strictEqual(r.days, 4);
});

test('区间：开始日期早于两年前时收敛到两年前', async () => {
  const r = rangeUtil.normalizeRange({ startDate: d(-900), endDate: d(0) });
  assert.strictEqual(r.startDate, rangeUtil.formatMinStart(), '开始日期应被收敛到两年前');
  assert.ok(r.days <= rangeUtil.MAX_SPAN_DAYS, '跨度不应超过上限');
  assert.ok(r.notices.some((n) => n.indexOf('两年前') >= 0), '应提示已调整开始日期');
});

test('区间：开始晚于结束时自动调换', async () => {
  const r = rangeUtil.normalizeRange({ startDate: d(-2), endDate: d(-10) });
  assert.strictEqual(r.startDate, d(-10), '应调换为较早的开始日期');
  assert.strictEqual(r.endDate, d(-2));
  assert.strictEqual(r.days, 9);
});

test('区间：预设天数与自定义区间都能给出正确的趋势粒度', async () => {
  assert.strictEqual(rangeUtil.normalizeRange(30).unit, 'day');
  assert.strictEqual(rangeUtil.normalizeRange({ startDate: d(-59), endDate: d(0) }).unit, 'week');
  assert.strictEqual(rangeUtil.normalizeRange({ startDate: d(-199), endDate: d(0) }).unit, 'month');

  // 桶数：按周=ceil(days/7)，按月不超过 13 个
  const week = rangeUtil.normalizeRange({ startDate: d(-59), endDate: d(0) });
  assert.strictEqual(rangeUtil.buildBuckets(week).length, 9, '60 天按周应为 9 个桶');
  const month = rangeUtil.normalizeRange({ startDate: d(-199), endDate: d(0) });
  const monthBuckets = rangeUtil.buildBuckets(month);
  assert.ok(monthBuckets.length <= 13, '按月桶数不应超过 13');
  assert.ok(/^\d{4}-\d{2}$/.test(monthBuckets[0].label), '按月标签应为 YYYY-MM');
});

/* --------------------------- 书籍统计口径 --------------------------- */

test('书籍统计：自定义区间下新增书籍与趋势只统计区间内数据', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const db = rawDb();
  // 造两条边界数据：3 天前在区间内、60 天前在区间外
  db.books[0].createdAt = Date.now() - 3 * DAY;
  db.books[1].createdAt = Date.now() - 60 * DAY;

  const startDate = d(-6);
  const endDate = d(0);
  const stats = await mock.getBookStats({ startDate, endDate });

  assert.ok(!stats.error, '统计不应报错');
  assert.strictEqual(stats.range.mode, 'custom');
  assert.strictEqual(stats.range.days, 7);
  assert.strictEqual(stats.range.unit, 'day');
  assert.strictEqual(stats.trend.length, 7, '7 天区间趋势应有 7 个点');

  const range = rangeUtil.normalizeRange({ startDate, endDate });
  const expected = rawDb().books.filter((b) => {
    const ms = new Date(b.createdAt).getTime();
    return ms >= range.startMs && ms < range.endExclusiveMs;
  }).length;
  assert.strictEqual(stats.cards.newBooks, expected, '新增书籍数应与区间内实际条数一致');
  assert.ok(expected >= 1, '3 天前那条应被计入');

  const trendSum = stats.trend.reduce((s, x) => s + x.value, 0);
  assert.strictEqual(trendSum, expected, '趋势各桶之和应等于区间内新增数');
});

test('书籍统计：跨半年区间自动按月汇总，口径仍完整', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const db = rawDb();
  db.books[0].createdAt = Date.now() - 100 * DAY;

  const stats = await mock.getBookStats({ startDate: d(-199), endDate: d(0) });
  assert.strictEqual(stats.range.unit, 'month');
  assert.ok(stats.range.unitLabel === '按月');
  assert.ok(stats.trend.length <= 13, '按月分桶不应超过 13 个');
  const trendSum = stats.trend.reduce((s, x) => s + x.value, 0);
  assert.strictEqual(trendSum, stats.cards.newBooks, '趋势合计应等于新增数');
});

/* --------------------------- 用户统计口径 --------------------------- */

test('用户统计：自定义区间只统计区间内的新增用户与借阅', async () => {
  resetDb();
  const me = await mock.login({ nickname: '管理员' });
  const db = rawDb();
  // 老用户：60 天前注册，借过 1 次（60 天前）
  db.users.push({
    _id: 'u_old',
    openid: 'openid_old',
    nickname: '老用户',
    role: 'user',
    card: { status: 'active', location: (db.settings.locations || [])[0] || '' },
    createdAt: Date.now() - 60 * DAY
  });
  db.borrows.push({
    _id: 'b_old',
    userId: 'openid_old',
    bookId: db.books[0]._id,
    bookTitle: db.books[0].title,
    status: 'returned',
    borrowDate: Date.now() - 60 * DAY,
    dueDate: Date.now() - 45 * DAY
  });
  // 新借阅：3 天前，属于管理员
  db.borrows.push({
    _id: 'b_new',
    userId: me.openid,
    bookId: db.books[0]._id,
    bookTitle: db.books[0].title,
    status: 'returned',
    borrowDate: Date.now() - 3 * DAY,
    dueDate: Date.now() + 10 * DAY
  });

  const short = await mock.getUserStats({ startDate: d(-6), endDate: d(0) });
  assert.ok(!short.error, '统计不应报错');
  assert.strictEqual(short.range.mode, 'custom');
  assert.strictEqual(short.range.days, 7);
  assert.strictEqual(short.range.unit, 'day');
  assert.strictEqual(short.trend.length, 7, '7 天区间趋势应有 7 个点');
  assert.strictEqual(short.cards.newUsers, 1, '只有管理员是区间内注册');
  assert.strictEqual(short.cards.borrowTotal, 1, '只有 3 天前那笔借阅在区间内');
  assert.strictEqual(short.cards.activeBorrowers, 1);

  const long = await mock.getUserStats({ startDate: d(-89), endDate: d(0) });
  assert.strictEqual(long.range.unit, 'week', '90 天区间趋势应降到按周');
  assert.strictEqual(long.cards.newUsers, 2, '60 天前注册的老用户应被计入');
  assert.strictEqual(long.cards.borrowTotal, 2, '两笔借阅都在 90 天区间内');
  assert.strictEqual(
    long.trend.reduce((s, x) => s + x.value, 0),
    long.cards.newUsers,
    '趋势合计应等于区间新增用户数'
  );
});

test('用户统计：预设天数与自定义区间结果同口径，CSV 表头标注区间', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const db = rawDb();
  db.users.push({
    _id: 'u_old',
    openid: 'openid_old',
    nickname: '老用户',
    role: 'user',
    card: {},
    createdAt: Date.now() - 20 * DAY
  });

  const preset = await mock.getUserStats(30);
  const custom = await mock.getUserStats({ startDate: d(-29), endDate: d(0) });
  assert.strictEqual(preset.range.mode, 'preset');
  assert.strictEqual(custom.range.days, preset.range.days, '近 30 天与 29 天前至今应为同一跨度');
  assert.strictEqual(custom.cards.newUsers, preset.cards.newUsers, '两种入口的口径必须一致');

  const csv = await mock.exportUsersCsv({ startDate: d(-29), endDate: d(0) });
  assert.ok(csv.content.indexOf('区间借阅（') >= 0, 'CSV 表头应标注统计区间');
  assert.ok(csv.content.indexOf('昵称') >= 0, 'CSV 应保留原有表头');
  assert.ok(
    csv.filename.indexOf(d(-29).replace(/-/g, '')) >= 0,
    '导出文件名应包含区间开始日期，便于区分多次导出'
  );
});
