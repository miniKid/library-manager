const services = require('../../../services/index');
const rangeUtil = require('../../../utils/analytics-range');
const { formatCST } = require('../../../utils/util');

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' }
];

/** 默认自定义区间：近 30 天 */
function defaultCustom() {
  const today = rangeUtil.todayStartMs();
  return {
    startDate: formatCST(today - 29 * rangeUtil.DAY_MS),
    endDate: formatCST(today)
  };
}

Page({
  data: {
    tab: 'user',
    days: 30,
    ranges: RANGES,
    loading: false,
    user: null,
    book: null,
    error: '',
    // 图表宽度百分比在 JS 里算好，WXML 只做展示
    userBars: { location: [], role: [], buckets: [], trend: [] },
    bookBars: { category: [], location: [], rating: [], trend: [] },
    exporting: false,
    // 书籍统计的时间口径：预设近 N 天 / 自定义起止日期
    rangeMode: 'preset',
    today: '',
    minDate: '',
    startDate: '',
    endDate: '',
    bookRangeText: '',
    bookNewLabel: '',
    bookUnitLabel: '按天'
  },

  onLoad() {
    const def = defaultCustom();
    this.setData({
      today: rangeUtil.formatToday(),
      minDate: rangeUtil.formatMinStart(),
      startDate: def.startDate,
      endDate: def.endDate
    });
    this.load();
  },

  onShow() {
    const app = getApp();
    if (app && app.globalData && !app.globalData.isAdmin) {
      wx.showToast({ title: '仅管理员可查看', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }
    if (this.data.user || this.data.book) return;
    this.load();
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    // 自定义区间只对书籍统计生效，切回用户统计时回到预设口径
    this.setData({ tab, rangeMode: tab === 'user' ? 'preset' : this.data.rangeMode });
    this.load();
  },

  onRange(e) {
    const days = Number(e.currentTarget.dataset.days);
    if (days === this.data.days && this.data.rangeMode === 'preset') return;
    this.setData({ days, rangeMode: 'preset' });
    this.load();
  },

  /* ---------------- 自定义区间 ---------------- */

  onCustomRange() {
    if (this.data.rangeMode === 'custom') return;
    const def = defaultCustom();
    const start = this.data.startDate || def.startDate;
    const end = this.data.endDate || def.endDate;
    this.setData({ rangeMode: 'custom', startDate: start, endDate: end });
    this.load();
  },

  onStartDate(e) {
    let start = e.detail.value;
    let end = this.data.endDate;
    if (start > end) end = start; // 开始晚于结束时把结束拉到同一天，避免出现空区间
    this.setData({ startDate: start, endDate: end });
    this.load();
  },

  onEndDate(e) {
    let end = e.detail.value;
    let start = this.data.startDate;
    if (end < start) start = end;
    this.setData({ endDate: end, startDate: start });
    this.load();
  },

  onResetRange() {
    const def = defaultCustom();
    this.setData({ startDate: def.startDate, endDate: def.endDate });
    this.load();
  },

  percent(list, key) {
    const arr = (list || []).map((x) => Number(x[key]) || 0);
    const max = Math.max.apply(null, arr.concat([1]));
    return (list || []).map((x) => ({
      label: x.label,
      value: Number(x[key]) || 0,
      percent: Math.round(((Number(x[key]) || 0) / max) * 100)
    }));
  },

  /** 书籍统计的入参：自定义区间优先，否则用预设天数 */
  bookParams() {
    if (this.data.rangeMode === 'custom') {
      return { startDate: this.data.startDate, endDate: this.data.endDate };
    }
    return this.data.days;
  },

  async load() {
    if (this.data.loading) return;
    this.setData({ loading: true, error: '' });
    if (this.data.tab === 'user') {
      const data = await services.getUserStats(this.data.days);
      if (data.error) {
        this.setData({ loading: false, error: data.error });
        return;
      }
      this.setData({
        user: data,
        userBars: {
          location: this.percent(data.byLocation, 'value'),
          role: this.percent(data.roleChart, 'value'),
          buckets: this.percent(data.buckets, 'value'),
          trend: this.percent(data.trend, 'value')
        },
        loading: false
      });
    } else {
      const data = await services.getBookStats(this.bookParams());
      if (data.error) {
        this.setData({ loading: false, error: data.error });
        return;
      }
      const range = data.range || {};
      const patch = {
        book: data,
        bookBars: {
          category: this.percent(data.categoryChart, 'value'),
          location: this.percent(data.byLocation, 'value'),
          rating: this.percent(data.ratingChart, 'value'),
          trend: this.percent(data.trend, 'value')
        },
        bookRangeText: range.label || `近 ${data.days || this.data.days} 天`,
        bookNewLabel: range.mode === 'custom' ? '区间新增' : `近 ${range.days || data.days} 天新增`,
        bookUnitLabel: range.unitLabel || '按天',
        loading: false
      };
      // 服务端可能把越界日期收敛过，回写以保持选择器与实际口径一致
      if (range.mode === 'custom' && range.startDate && range.endDate) {
        patch.startDate = range.startDate;
        patch.endDate = range.endDate;
      }
      this.setData(patch);
      const notices = (range.notices || []).filter(Boolean);
      if (notices.length) wx.showToast({ title: notices[0], icon: 'none', duration: 2500 });
    }
  },

  async onExport() {
    if (this.data.exporting) return;
    this.setData({ exporting: true });
    const isUser = this.data.tab === 'user';
    const res = isUser ? await services.exportUsersCsv(this.data.days) : await services.exportBooksCsv(this.data.days);
    if (!res || res.error) {
      this.setData({ exporting: false });
      wx.showToast({ title: (res && res.error) || '导出失败', icon: 'none' });
      return;
    }
    const saved = await services.exportCsv({ filename: res.filename, content: res.content });
    this.setData({ exporting: false });
    if (!saved.ok) {
      wx.showToast({ title: saved.msg || '导出失败', icon: 'none' });
      return;
    }
    if (saved.method === 'clipboard') {
      wx.showModal({
        title: '已复制到剪贴板',
        content: `共 ${res.rows} 行。当前基础库不支持直接转发文件，已把 CSV 内容复制到剪贴板，可粘贴到 Excel。`,
        showCancel: false
      });
    } else if (saved.method === 'share') {
      wx.showToast({ title: `已导出 ${res.rows} 行`, icon: 'success' });
    }
    if (res.truncated) {
      wx.showToast({ title: '数据超过上限，仅导出前 3000 行', icon: 'none' });
    }
  }
});
