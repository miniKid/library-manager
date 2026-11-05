const services = require('../../../services/index');
const { NOTICE_LINKS, normalizeNoticeLink } = require('../../../utils/notice-links');
const { imageToDataUrl, toLocalFile } = require('../../../utils/cover');

Page({
  data: {
    popup: { enabled: false, version: 1, type: 'text', title: '', text: '', image: '', link: '', linkText: '', imageBase64: '' },
    popupTypes: [
      { label: '纯文字', value: 'text' },
      { label: '图片海报', value: 'image' }
    ],
    popupTypeIndex: 0,
    popupLinks: NOTICE_LINKS,
    popupLinkIndex: 0,
    savingPopup: false,
    popupImagePreview: ''
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
    const p = (settings && settings.popup) || {};
    const types = ['text', 'image'];
    // 富文本类型已下线：存量 html 配置回退为纯文字，避免类型选中项与内容不匹配
    const type = types.indexOf(p.type) >= 0 ? p.type : 'text';
    const link = normalizeNoticeLink(p.link);
    const saved = Object.assign({ enabled: false, version: 1, type: 'text', title: '', text: '', image: '', link: '', linkText: '', imageBase64: '' }, p, { type, link });
    delete saved.html;
    const preview = p.imageBase64 ? await toLocalFile(p.imageBase64, 'notify_popup_preview') : '';
    this.setData({
      popup: saved,
      popupTypeIndex: types.indexOf(type),
      popupLinkIndex: Math.max(0, NOTICE_LINKS.findIndex((l) => l.value === link)),
      popupImagePreview: preview
    });
  },

  onPopupToggle(e) {
    this.setData({ 'popup.enabled': e.detail.value });
  },

  onPopupType(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    this.setData({ popupTypeIndex: idx, 'popup.type': this.data.popupTypes[idx].value });
  },

  onPopupInput(e) {
    const field = e.currentTarget.dataset.field;
    const patch = { ['popup.' + field]: e.detail.value };
    // 手填图片地址时清掉已选的本地图片，避免 base64 优先级架空地址框
    if (field === 'image' && e.detail.value.trim() && this.data.popup.imageBase64) {
      patch['popup.imageBase64'] = '';
      patch.popupImagePreview = '';
    }
    this.setData(patch);
  },

  onPopupLink(e) {
    const idx = Number(e.detail.value);
    this.setData({ popupLinkIndex: idx, 'popup.link': this.data.popupLinks[idx].value });
  },

  /** 从相册选图：压缩为 base64 随配置入库，绕开云存储读权限（与 books.cover 同策略） */
  async onChoosePopupImage() {
    const path = await new Promise((resolve) => {
      wx.chooseMedia({
        count: 1,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        sizeType: ['compressed'],
        success: (r) => resolve((r.tempFiles && r.tempFiles[0] && r.tempFiles[0].tempFilePath) || ''),
        fail: () => resolve('')
      });
    });
    if (!path) return;
    wx.showLoading({ title: '处理中...' });
    let ok = false;
    let msg = '图片处理失败';
    try {
      const dataUrl = await imageToDataUrl(path, 620, 780, 0.72);
      if (dataUrl.length > 260000) {
        msg = '图片过大，请换一张';
      } else {
        const preview = await toLocalFile(dataUrl, 'notify_popup_preview');
        this.setData({ 'popup.imageBase64': dataUrl, popupImagePreview: preview });
        ok = true;
        msg = '已设置，请点保存配置';
      }
    } catch (e) {
      console.error('[notify] 弹窗图片处理失败', e);
    }
    wx.hideLoading();
    wx.showToast({ title: msg, icon: ok ? 'success' : 'none' });
  },

  onClearPopupImage() {
    this.setData({ 'popup.imageBase64': '', popupImagePreview: '' });
  },

  onPopupPreviewError(e) {
    console.error('[notify] 预览图加载失败', this.data.popupImagePreview, e && e.detail);
  },

  async onSavePopup() {
    if (this.data.savingPopup) return;
    const p = this.data.popup;
    if (p.enabled) {
      if (p.type === 'text' && !p.text.trim()) return wx.showToast({ title: '请填写文字内容', icon: 'none' });
      if (p.type === 'image' && !String(p.image || '').trim() && !p.imageBase64) {
        return wx.showToast({ title: '请选择图片或填写图片地址', icon: 'none' });
      }
    }
    this.setData({ savingPopup: true });
    const payload = Object.assign({}, p, { version: (Number(p.version) || 0) + 1 });
    console.log('[notify] 保存弹窗配置', { version: payload.version, type: payload.type, hasBase64: !!payload.imageBase64, image: (payload.image || '').slice(0, 60) });
    const res = await services.saveSettings({ popup: payload });
    this.setData({ savingPopup: false });
    console.log('[notify] 保存结果', res && res.ok, res && res.msg);
    if (res && res.ok) {
      wx.showToast({ title: '已保存', icon: 'success' });
      this.setData({ 'popup.version': payload.version });
    } else {
      wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' });
    }
  }
});
