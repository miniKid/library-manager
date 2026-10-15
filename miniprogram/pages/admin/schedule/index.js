const services = require('../../../services/index');
const { buildMonthCalendar, WEEKDAYS } = require('../../../utils/schedule');

Page({
  data: {
    locations: [],
    activeLocation: '',
    weekly: [false, false, false, false, false, false, false],
    calendar: { year: 0, month: 0, weeks: [] },
    monthLabel: '',
    saving: false,
    dirty: false
  },

  onLoad() {
    this.monthCursor = new Date();
    this.overrides = {};
  },

  /** 每次进入页面重新拉取云端数据，确保看到最新已保存的值班内容 */
  onShow() {
    this.loadData();
  },

  async loadData() {
    wx.showLoading({ title: '加载中' });
    const [settings, schedules] = await Promise.all([services.getSettings(), services.getSchedules()]);
    wx.hideLoading();
    const locations = (settings && settings.locations) || [];
    this.schedules = schedules || [];
    this.setData({ locations });
    if (locations.length) {
      this.switchLocation(locations[0]);
    }
  },

  /** 切换馆藏地点 */
  switchLocation(e) {
    const location = typeof e === 'string' ? e : e.currentTarget.dataset.location;
    const s = this.schedules.find((x) => x.location === location);
    this.weekly = s && Array.isArray(s.weekly) ? s.weekly.slice() : [false, false, false, false, false, false, false];
    this.overrides = s && s.overrides ? Object.assign({}, s.overrides) : {};
    this.setData({
      activeLocation: location,
      weekly: this.weekly,
      dirty: false
    });
    this.renderCalendar();
  },

  /** 渲染当前月份日历 */
  renderCalendar() {
    const y = this.monthCursor.getFullYear();
    const m = this.monthCursor.getMonth() + 1;
    const schedule = { weekly: this.weekly, overrides: this.overrides };
    const calendar = buildMonthCalendar(y, m, schedule);
    this.setData({
      calendar,
      monthLabel: y + '年' + m + '月'
    });
  },

  /** 切换每周值班规则（周一~周日） */
  onToggleWeekly(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.weekly[idx] = !this.weekly[idx];
    this.setData({ weekly: this.weekly, dirty: true });
    this.renderCalendar();
  },

  /** 上一月 */
  prevMonth() {
    this.monthCursor.setDate(1);
    this.monthCursor.setMonth(this.monthCursor.getMonth() - 1);
    this.renderCalendar();
  },

  /** 下一月 */
  nextMonth() {
    this.monthCursor.setDate(1);
    this.monthCursor.setMonth(this.monthCursor.getMonth() + 1);
    this.renderCalendar();
  },

  /**
   * 点击日历日期，在「可选 / 不可选」间切换（写入日期覆盖）。
   * 若切换后的值与每周规则一致，则视为恢复默认并清除覆盖。
   */
  onToggleDay(e) {
    const { date } = e.currentTarget.dataset;
    const day = this.findDay(date);
    if (!day) return;
    const cur = this.overrides[date] !== undefined ? this.overrides[date] : day.weeklyDefault;
    const next = !cur;
    if (next === day.weeklyDefault) {
      delete this.overrides[date];
    } else {
      this.overrides[date] = next;
    }
    this.setData({ dirty: true });
    this.renderCalendar();
  },

  findDay(date) {
    const weeks = this.data.calendar.weeks;
    for (let i = 0; i < weeks.length; i++) {
      const row = weeks[i];
      for (let j = 0; j < row.length; j++) {
        if (row[j] && row[j].date === date) return row[j];
      }
    }
    return null;
  },

  /** 保存当前地点的值班安排 */
  async onSave() {
    if (!this.data.activeLocation) return;
    if (this.data.saving) return;
    this.setData({ saving: true });
    const result = await services.saveSchedule({
      location: this.data.activeLocation,
      weekly: this.weekly,
      overrides: this.overrides
    });
    this.setData({ saving: false });
    if (result && result.ok) {
      // 更新本地缓存
      let s = this.schedules.find((x) => x.location === this.data.activeLocation);
      if (!s) {
        s = { location: this.data.activeLocation };
        this.schedules.push(s);
      }
      s.weekly = this.weekly.slice();
      s.overrides = Object.assign({}, this.overrides);
      this.setData({ dirty: false });
      wx.showToast({ title: '已保存', icon: 'success' });
    } else {
      wx.showToast({ title: (result && result.msg) || '保存失败', icon: 'none' });
    }
  }
});
