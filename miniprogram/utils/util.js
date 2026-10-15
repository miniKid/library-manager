const { BORROW_STATUS, BORROW_DAYS } = require('./constants');

/** 补零 */
function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 格式化日期，withTime=true 时输出 2026-08-07 14:30。默认按中国时区（UTC+8）展示，与云库控制台一致 */
function formatDate(date, withTime) {
  if (!date) return '';
  const d = toChinaDate(date);
  if (isNaN(d.getTime())) return '';
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${base} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : base;
}

/** 默认按中国时区（UTC+8）展示与判定借阅相关日期；如需多时区可后续扩展 */
const CHINA_OFFSET_MS = 8 * 3600 * 1000;

/** 将时间戳按 UTC+8 平移为「中国墙钟时间」对应的 UTC 值，便于用 getUTC* 取年月日 */
function toChinaDate(date) {
  return new Date(new Date(date).getTime() + CHINA_OFFSET_MS);
}

/** 中国时区下的 YYYY-MM-DD（默认）或 YYYY-MM-DD HH:mm */
function formatCST(date, withTime) {
  if (!date) return '';
  const d = toChinaDate(date);
  if (isNaN(d.getTime())) return '';
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${base} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : base;
}

/** 中国时区下的日期字符串（YYYY-MM-DD），用于跨午夜一致的日期比较 */
function cstDateStr(date) {
  return formatCST(date, false);
}

/** 中国时区下的今天（YYYY-MM-DD） */
function cstTodayStr() {
  return formatCST(new Date(), false);
}

/** 当前时间字符串（YYYY-MM-DD HH:mm） */
function nowStr() {
  return formatDate(new Date(), true);
}

/** 日期加 N 天 */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

/** 判断借阅是否逾期（按中国时区判定：应还日早于今天即为逾期；应还当天仍可归还/续借） */
function isOverdue(borrow) {
  if (!borrow || borrow.status === BORROW_STATUS.RETURNED) return false;
  if (!borrow.dueDate) return false;
  return cstDateStr(borrow.dueDate) < cstTodayStr();
}

/** 归一化借阅记录：补全状态（逾期判断）、到期日、展示字段 */
function normalizeBorrow(record) {
  const r = Object.assign({}, record);
  r.borrowDateText = formatDate(r.borrowDate);
  r.dueDateText = formatCST(r.dueDate);
  if (r.status === BORROW_STATUS.BORROWING) {
    r.status = isOverdue(r) ? BORROW_STATUS.OVERDUE : BORROW_STATUS.BORROWING;
  }
  return r;
}

/** 生成简短 id */
function genId(prefix) {
  return (prefix || 'id') + '_' + Date.now() + '_' + Math.floor(Math.random() * 10000);
}

/** 根据字符串生成稳定的封面背景色 */
const COVER_COLORS = [
  '#5B7FA6', '#7A8CB8', '#8C6E9E', '#B0786E', '#6E9E8C',
  '#A68A5B', '#6E8CB8', '#9E7A6E', '#5BA68C', '#8C5B7A'
];
function hashColor(str) {
  if (!str) return COVER_COLORS[0];
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = (hash * 31 + str.charCodeAt(i)) % 997;
  }
  return COVER_COLORS[hash % COVER_COLORS.length];
}

/** 将 cloud:// 文件 ID 转为临时 HTTPS 链接；非云文件 ID 或转换失败时原样返回 */
async function cloudToTempUrl(fileID) {
  if (!fileID || fileID.indexOf('cloud://') !== 0) return fileID;
  if (!wx.cloud || !wx.cloud.getTempFileURL) return fileID;
  try {
    const res = await wx.cloud.getTempFileURL({ fileList: [fileID] });
    const f = (res.fileList || [])[0];
    return (f && f.tempFileURL) || fileID;
  } catch (e) {
    return fileID;
  }
}

module.exports = {
  formatDate,
  formatCST,
  cstDateStr,
  cstTodayStr,
  nowStr,
  addDays,
  isOverdue,
  normalizeBorrow,
  genId,
  hashColor,
  cloudToTempUrl,
  BORROW_DAYS
};
