/**
 * 值班管理公共工具
 * 值班安排数据结构：{ location, weekly: [7 项, 0=周一...6=周日], overrides: { 'yyyy-MM-dd': true/false } }
 * 某日是否可选：优先看 overrides，其次看 weekly；未配置任何值班的地点为不可选。
 */

const WEEKDAYS = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

function pad(n) {
  return n < 10 ? '0' + n : '' + n;
}

/** 日期转 yyyy-MM-dd */
function formatDate(d) {
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
}

/** yyyy-MM-dd 转周索引（0=周一 ... 6=周日） */
function weekdayIndex(dateStr) {
  const d = new Date(dateStr + 'T00:00:00');
  const wd = d.getDay();
  return wd === 0 ? 6 : wd - 1;
}

/** 判断某地点某日是否值班可选 */
function isScheduledOn(schedule, dateStr) {
  if (!schedule) return false;
  if (schedule.overrides && schedule.overrides[dateStr] !== undefined) {
    return !!schedule.overrides[dateStr];
  }
  // weekly 约定为长度 7 的数组（0=周一...6=周日），非法配置一律视为不可选
  if (!Array.isArray(schedule.weekly) || schedule.weekly.length !== 7) return false;
  return !!schedule.weekly[weekdayIndex(dateStr)];
}

/** 将值班列表转为 { location: schedule } 映射 */
function buildScheduleMap(schedules) {
  const map = {};
  (schedules || []).forEach((s) => {
    if (s && s.location) map[s.location] = s;
  });
  return map;
}

/**
 * 生成用户端日期选择月历（取书/还书日期选择）
 * 以自然月为单位，带星期对齐；只允许选择 [minDate, maxDate] 范围内的值班日期。
 * @param {number} year 年份
 * @param {number} month 月份 1-12
 * @param {object} schedule 值班配置
 * @param {string} minDate 最小可选日期 yyyy-MM-dd（含）
 * @param {string} maxDate 最大可选日期 yyyy-MM-dd（含）
 * 返回 { year, month, weeks: [[cell, ...], ...] }，cell = { date, day, week, available, inRange, today } | null
 */
function buildDateMonthCalendar(year, month, schedule, minDate, maxDate) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 0=周一
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = year + '-' + pad(month) + '-' + pad(day);
    const inRange = dateStr >= minDate && dateStr <= maxDate;
    cells.push({
      date: dateStr,
      day,
      week: WEEKDAYS[weekdayIndex(dateStr)],
      available: inRange && isScheduledOn(schedule, dateStr),
      inRange,
      today: dateStr === minDate
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { year, month, weeks };
}

/**
 * 生成管理端月历
 * @param {number} year 年份
 * @param {number} month 月份 1-12
 * @param {object} schedule 值班配置
 * 返回 { year, month, weeks: [[cell, ...], ...]，cell = { date, day, weeklyDefault, override, available } | null }
 */
function buildMonthCalendar(year, month, schedule) {
  const daysInMonth = new Date(year, month, 0).getDate();
  const lead = (new Date(year, month - 1, 1).getDay() + 6) % 7; // 0=周一
  const cells = [];
  for (let i = 0; i < lead; i++) cells.push(null);
  for (let day = 1; day <= daysInMonth; day++) {
    const dateStr = year + '-' + pad(month) + '-' + pad(day);
    const weeklyDefault = schedule && Array.isArray(schedule.weekly) ? !!schedule.weekly[weekdayIndex(dateStr)] : false;
    const hasOverride = !!(schedule && schedule.overrides && schedule.overrides[dateStr] !== undefined);
    const available = hasOverride ? !!schedule.overrides[dateStr] : weeklyDefault;
    cells.push({
      date: dateStr,
      day,
      weeklyDefault,
      override: hasOverride,
      available
    });
  }
  while (cells.length % 7 !== 0) cells.push(null);
  const weeks = [];
  for (let i = 0; i < cells.length; i += 7) weeks.push(cells.slice(i, i + 7));
  return { year, month, weeks };
}

module.exports = {
  WEEKDAYS,
  formatDate,
  weekdayIndex,
  isScheduledOn,
  buildScheduleMap,
  buildDateMonthCalendar,
  buildMonthCalendar
};
