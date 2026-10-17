/**
 * 统计区间工具
 * -------------------------------
 * 统一「近 N 天」与「自定义起止日期」两种时间口径，供统计页、mock 实现与单元测试共用。
 * 口径约定：
 *   - 日期字符串一律为东八区 YYYY-MM-DD，区间**含首含尾**（startDate 当天 00:00 起，endDate 次日 00:00 止）
 *   - 结束日期不晚于今天，开始日期不早于「两年前的今天」，跨度最多 MAX_SPAN_DAYS 天
 *   - 越界一律**收敛**（clamp）而不是报错，并回传 notice 供页面提示
 *   - 趋势图分桶：≤31 天按天、≤120 天按周、更长按月，避免 700 多根柱子画不下
 */

const { formatCST } = require('./util');

const DAY_MS = 86400000;
const CHINA_OFFSET_MS = 8 * 3600 * 1000;
const MAX_SPAN_DAYS = 731; // 两年（含闰年）

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 'YYYY-MM-DD' → 中国时区当天 00:00 的时间戳；非法返回 null */
function dayStartMs(dateStr) {
  const s = String(dateStr || '').trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const ms = Date.parse(s + 'T00:00:00+08:00');
  return isNaN(ms) ? null : ms;
}

/** 今天（中国时区）00:00 的时间戳 */
function todayStartMs() {
  const t = new Date(Date.now() + CHINA_OFFSET_MS);
  return Date.UTC(t.getUTCFullYear(), t.getUTCMonth(), t.getUTCDate()) - CHINA_OFFSET_MS;
}

/** 两年前的今天 00:00（开始日期下界） */
function minStartMs() {
  const t = new Date(todayStartMs() + CHINA_OFFSET_MS);
  t.setUTCFullYear(t.getUTCFullYear() - 2);
  return t.getTime() - CHINA_OFFSET_MS;
}

/** 今天（YYYY-MM-DD），供日期选择器的 end 上界 */
function formatToday() {
  return formatCST(todayStartMs());
}

/** 两年前的今天（YYYY-MM-DD），供日期选择器的 start 下界 */
function formatMinStart() {
  return formatCST(minStartMs());
}

function daysBetween(startMs, endMs) {
  return Math.round((endMs - startMs) / DAY_MS) + 1;
}

/** 趋势粒度：按天 / 按周 / 按月 */
function unitForDays(days) {
  if (days <= 31) return 'day';
  if (days <= 120) return 'week';
  return 'month';
}

function unitLabel(unit) {
  return unit === 'month' ? '按月' : unit === 'week' ? '按周' : '按天';
}

/**
 * 归一化区间
 * @param {number|{days?:number,startDate?:string,endDate?:string}} input
 * @returns {{mode:'preset'|'custom',startDate:string,endDate:string,days:number,
 *            unit:string,unitLabel:string,startMs:number,endExclusiveMs:number,
 *            label:string,notices:string[]}}
 */
function normalizeRange(input) {
  const notices = [];
  const today = todayStartMs();
  const minStart = minStartMs();
  const opt = typeof input === 'number' ? { days: input } : input || {};

  const rawStart = dayStartMs(opt.startDate);
  const rawEnd = dayStartMs(opt.endDate);
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
    if (daysBetween(startMs, endMs) > MAX_SPAN_DAYS) {
      startMs = endMs - (MAX_SPAN_DAYS - 1) * DAY_MS;
      notices.push(`区间最长 ${MAX_SPAN_DAYS} 天，已自动截断`);
    }
  } else {
    const days = Math.min(365, Math.max(1, Number(opt.days) || 30));
    endMs = today;
    startMs = today - (days - 1) * DAY_MS;
  }

  // 下界兜底（自定义分支已处理，预设分支理论上不会触发）
  if (startMs < minStart) startMs = minStart;
  if (endMs > today) endMs = today;

  const days = daysBetween(startMs, endMs);
  const unit = unitForDays(days);
  const startDate = formatCST(startMs);
  const endDate = formatCST(endMs);

  return {
    mode: isCustom ? 'custom' : 'preset',
    startDate,
    endDate,
    days,
    unit,
    unitLabel: unitLabel(unit),
    startMs,
    endExclusiveMs: endMs + DAY_MS,
    label: isCustom ? `${startDate} 至 ${endDate}` : `近 ${days} 天`,
    notices
  };
}

/** 生成趋势分桶（含首不含尾，标签按粒度取 MM-DD / YYYY-MM） */
function buildBuckets(range) {
  const out = [];
  const end = range.endExclusiveMs;

  if (range.unit === 'month') {
    let cursor = range.startMs;
    while (cursor < end) {
      const t = new Date(cursor + CHINA_OFFSET_MS);
      const y = t.getUTCFullYear();
      const m = t.getUTCMonth();
      const nextMs = Date.UTC(y, m + 1, 1) - CHINA_OFFSET_MS;
      const to = Math.min(nextMs, end);
      out.push({ label: `${y}-${pad(m + 1)}`, from: cursor, to });
      cursor = to;
    }
    return out;
  }

  const step = (range.unit === 'week' ? 7 : 1) * DAY_MS;
  for (let s = range.startMs; s < end; s += step) {
    out.push({ label: formatCST(s).slice(5), from: s, to: Math.min(s + step, end) });
  }
  return out;
}

function indexOfMs(ms, range, buckets) {
  if (range.unit === 'month') {
    const label = formatCST(ms).slice(0, 7);
    for (let i = 0; i < buckets.length; i++) if (buckets[i].label === label) return i;
    return -1;
  }
  const step = (range.unit === 'week' ? 7 : 1) * DAY_MS;
  const idx = Math.floor((ms - range.startMs) / step);
  return idx >= 0 && idx < buckets.length ? idx : -1;
}

/**
 * 按区间分桶统计趋势
 * @param {Array} items 数据源
 * @param {object} range normalizeRange 的返回值
 * @param {Function} pick 取时间字段，返回可被 new Date() 解析的值
 */
function trendOf(items, range, pick) {
  const buckets = buildBuckets(range);
  const counts = new Array(buckets.length).fill(0);
  (items || []).forEach((it) => {
    const v = pick(it);
    if (!v) return;
    const ms = new Date(v).getTime();
    if (isNaN(ms) || ms < range.startMs || ms >= range.endExclusiveMs) return;
    const idx = indexOfMs(ms, range, buckets);
    if (idx >= 0) counts[idx] += 1;
  });
  return buckets.map((b, i) => ({ label: b.label, value: counts[i] }));
}

module.exports = {
  MAX_SPAN_DAYS,
  DAY_MS,
  dayStartMs,
  todayStartMs,
  minStartMs,
  formatToday,
  formatMinStart,
  unitForDays,
  normalizeRange,
  buildBuckets,
  trendOf
};
