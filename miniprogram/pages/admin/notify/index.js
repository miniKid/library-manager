const services = require('../../../services/index');

const LINKS = [
  { label: '不跳转', value: '' },
  { label: '首页', value: '/pages/index/index' },
  { label: '我的借阅', value: '/pages/my/borrows/index' },
  { label: '推荐栏目', value: '/pages/recommend/index' }
];

Page({
  data: {
    scope: 'all',
    locations: [],
    locationIndex: 0,
    form: { title: '', content: '' },
    linkIndex: 0,
    links: LINKS,
    sending: false,
    history: [],
    total: 0,
    loading: false
  },

  onLoad() {
    this.init();
  },

  async init() {
    const app = getApp();
    if (app && app.globalData && !app.globalData.isAdmin) {
      wx.showToast({ title: '仅管理员可用', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }
    const settings = await services.getSettings();
    this.setData({ locations: (settings && settings.locations) || [] });
    this.loadHistory();
  },

  onScope(e) {
    this.setData({ scope: e.currentTarget.dataset.scope });
  },

  onLocation(e) {
    this.setData({ locationIndex: Number(e.detail.value) });
  },

  onLink(e) {
    this.setData({ linkIndex: Number(e.detail.value) });
  },

  onInput(e) {
    this.setData({ ['form.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  async loadHistory() {
    this.setData({ loading: true });
    const res = await services.getSentNotifications({ page: 1, pageSize: 10 });
    this.setData({ history: res.list || [], total: res.total || 0, loading: false });
  },

  async onSend() {
    const f = this.data.form;
    if (this.data.sending) return;
    if (!f.title.trim()) {
      wx.showToast({ title: '请填写标题', icon: 'none' });
      return;
    }
    if (!f.content.trim()) {
      wx.showToast({ title: '请填写正文', icon: 'none' });
      return;
    }
    const scopeText = this.data.scope === 'all' ? '全部用户' : `「${this.data.locations[this.data.locationIndex]}」馆藏用户`;
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '确认发送',
        content: `将向${scopeText}发送通知，确定吗？`,
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirm) return;

    this.setData({ sending: true });
    const res = await services.sendNotification({
      scope: this.data.scope,
      location: this.data.scope === 'location' ? this.data.locations[this.data.locationIndex] : '',
      title: f.title,
      content: f.content,
      type: 'system',
      link: this.data.links[this.data.linkIndex].value
    });
    this.setData({ sending: false });

    if (res && res.ok) {
      wx.showModal({
        title: '发送成功',
        content: `已送达 ${res.data.sent} 位用户${res.data.truncated ? '（超过 500 人上限，已截断）' : ''}`,
        showCancel: false
      });
      this.setData({ form: { title: '', content: '' } });
      this.loadHistory();
    } else {
      wx.showToast({ title: (res && res.msg) || '发送失败', icon: 'none' });
    }
  }
});
