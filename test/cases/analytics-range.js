/**
 * 统计区间（预设近 N 天 / 自定义起止日期）用例
 * 覆盖：区间收敛规则（不晚于今天、不早于两年前、起止颠倒、跨度上限）、
 *       趋势分桶粒度（按天/周/月）、书籍统计在自定义区间下的计数口径
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
