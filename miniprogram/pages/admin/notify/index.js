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
    loading: false,
    popup: { enabled: false, version: 1, type: 'text', title: '', text: '', image: '', html: '', link: '', linkText: '' },
    popupTypes: [
      { label: '纯文字', value: 'text' },
      { label: '图片海报', value: 'image' },
      { label: '富文本(HTML)', value: 'html' }
    ],
    popupTypeIndex: 0,
    popupLinks: LINKS,
    popupLinkIndex: 0,
    savingPopup: false
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
    const p = (settings && settings.popup) || {};
    const types = ['text', 'image', 'html'];
    this.setData({
      popup: Object.assign({ enabled: false, version: 1, type: 'text', title: '', text: '', image: '', html: '', link: '', linkText: '' }, p),
      popupTypeIndex: Math.max(0, types.indexOf(p.type)),
      popupLinkIndex: Math.max(0, LINKS.findIndex((l) => l.value === (p.link || '')))
    });
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
  },

  onPopupToggle(e) {
    this.setData({ 'popup.enabled': e.detail.value });
  },

  onPopupType(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ popupTypeIndex: idx, 'popup.type': this.data.popupTypes[idx].value });
  },

  onPopupInput(e) {
    this.setData({ ['popup.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  onPopupLink(e) {
    const idx = Number(e.detail.value);
    this.setData({ popupLinkIndex: idx, 'popup.link': this.data.popupLinks[idx].value });
  },

  async onSavePopup() {
    if (this.data.savingPopup) return;
    const p = this.data.popup;
    if (p.enabled) {
      if (p.type === 'text' && !p.text.trim()) return wx.showToast({ title: '请填写文字内容', icon: 'none' });
      if (p.type === 'image' && !p.image.trim()) return wx.showToast({ title: '请填写图片地址', icon: 'none' });
      if (p.type === 'html' && !p.html.trim()) return wx.showToast({ title: '请填写 HTML 内容', icon: 'none' });
    }
    this.setData({ savingPopup: true });
    const payload = Object.assign({}, p, { version: (Number(p.version) || 0) + 1 });
    const res = await services.saveSettings({ popup: payload });
    this.setData({ savingPopup: false });
    if (res && res.ok) {
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ 'popup.version': payload.version });
    } else {
      wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' });
    }
  }
});
