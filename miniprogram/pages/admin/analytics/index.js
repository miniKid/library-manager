const services = require('../../../services/index');

const RANGES = [
  { days: 7, label: '近 7 天' },
  { days: 30, label: '近 30 天' },
  { days: 90, label: '近 90 天' }
];

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
    exporting: false
  },

  onLoad() {
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
    this.setData({ tab });
    this.load();
  },

  onRange(e) {
    const days = Number(e.currentTarget.dataset.days);
    if (days === this.data.days) return;
    this.setData({ days });
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
      const data = await services.getBookStats(this.data.days);
      if (data.error) {
        this.setData({ loading: false, error: data.error });
        return;
      }
      this.setData({
        book: data,
        bookBars: {
          category: this.percent(data.categoryChart, 'value'),
          location: this.percent(data.byLocation, 'value'),
          rating: this.percent(data.ratingChart, 'value'),
          trend: this.percent(data.trend, 'value')
        },
        loading: false
      });
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
