const services = require('../../../services/index');
const { BORROW_DAYS, DEFAULT_MAX_BORROW, DEFAULT_RENEW_TIMES, DEFAULT_RENEW_DAYS } = require('../../../utils/constants');

Page({
  data: {
    locations: [],
    newLocation: '',
    borrowDays: BORROW_DAYS,
    maxBorrow: DEFAULT_MAX_BORROW,
    renewTimes: DEFAULT_RENEW_TIMES,
    renewDays: DEFAULT_RENEW_DAYS,
    saving: false
  },

  async onLoad() {
    await this.loadSettings();
  },

  async loadSettings() {
    const settings = await services.getSettings();
    if (!settings) return;
    this.setData({
      locations: (settings.locations || []).slice(),
      borrowDays: settings.borrowDays !== undefined ? Number(settings.borrowDays) : BORROW_DAYS,
      maxBorrow: settings.maxBorrow !== undefined ? Number(settings.maxBorrow) : DEFAULT_MAX_BORROW,
      renewTimes: settings.renewTimes !== undefined ? Number(settings.renewTimes) : DEFAULT_RENEW_TIMES,
      renewDays: settings.renewDays !== undefined ? Number(settings.renewDays) : DEFAULT_RENEW_DAYS
    });
  },

  onLocationInput(e) {
    this.setData({ newLocation: e.detail.value });
  },

  onBorrowDaysInput(e) {
    this.setData({ borrowDays: e.detail.value });
  },

  onMaxBorrowInput(e) {
    this.setData({ maxBorrow: e.detail.value });
  },

  onRenewTimesInput(e) {
    this.setData({ renewTimes: e.detail.value });
  },

  onRenewDaysInput(e) {
    this.setData({ renewDays: e.detail.value });
  },

  /** 将当前 settings（含馆藏地点与借阅参数）提交到云端/本地，统一保存入口 */
  async commit() {
    if (this.data.saving) return { ok: false, msg: '正在保存' };
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...' });
    try {
      const result = await services.saveSettings({
        locations: this.data.locations,
        borrowDays: Number(this.data.borrowDays),
        maxBorrow: Number(this.data.maxBorrow),
        renewTimes: Number(this.data.renewTimes),
        renewDays: Number(this.data.renewDays)
      });
      return result || { ok: false, msg: '保存失败' };
    } catch (e) {
      return { ok: false, msg: '保存失败' };
    } finally {
      wx.hideLoading();
      this.setData({ saving: false });
    }
  },

  async onAddLocation() {
    const name = this.data.newLocation.trim();
    if (!name) {
      wx.showToast({ title: '请输入馆藏地点名称', icon: 'none' });
      return;
    }
    if (this.data.locations.indexOf(name) !== -1) {
      wx.showToast({ title: '该地点已存在', icon: 'none' });
      return;
    }
    this.setData({
      locations: this.data.locations.concat(name),
      newLocation: ''
    });
    const result = await this.commit();
    if (result && result.ok) {
      wx.showToast({ title: '已添加并同步', icon: 'success' });
    } else {
      this.setData({
        locations: this.data.locations.filter((l) => l !== name),
        newLocation: name
      });
      wx.showToast({ title: (result && result.msg) || '添加失败', icon: 'none' });
    }
  },

  onRemoveLocation(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const name = this.data.locations[idx];
    wx.showModal({
      title: '删除馆藏地点',
      content: '确定删除「' + name + '」吗？已有图书在该地点的库存将保留在数据中。',
      confirmColor: '#E54D42',
      success: async (res) => {
        if (!res.confirm) return;
        const locations = this.data.locations.slice();
        locations.splice(idx, 1);
        this.setData({ locations });
        const result = await this.commit();
        if (result && result.ok) {
          wx.showToast({ title: '已删除并同步', icon: 'success' });
        } else {
          // 保存被拦截（如该地点仍有库存/未归还）时回滚本地删除
          const restored = this.data.locations.slice();
          restored.splice(idx, 0, name);
          this.setData({ locations: restored });
          wx.showToast({ title: (result && result.msg) || '删除失败', icon: 'none' });
        }
      }
    });
  },

  async onSave() {
    const borrowDays = Number(this.data.borrowDays);
    const maxBorrow = Number(this.data.maxBorrow);
    if (!this.data.locations.length) {
      wx.showToast({ title: '至少保留一个馆藏地点', icon: 'none' });
      return;
    }
    if (!borrowDays || borrowDays <= 0) {
      wx.showToast({ title: '借期天数需大于 0', icon: 'none' });
      return;
    }
    if (!maxBorrow || maxBorrow <= 0) {
      wx.showToast({ title: '限借数量需大于 0', icon: 'none' });
      return;
    }
    const renewTimes = Number(this.data.renewTimes);
    const renewDays = Number(this.data.renewDays);
    if (renewTimes < 0) {
      wx.showToast({ title: '续借次数不能为负', icon: 'none' });
      return;
    }
    if (renewTimes > 0 && (!renewDays || renewDays <= 0)) {
      wx.showToast({ title: '续借天数需大于 0', icon: 'none' });
      return;
    }
    const result = await this.commit();
    if (result && result.ok) {
      wx.showToast({ title: '设置已保存', icon: 'success' });
    } else {
      wx.showToast({ title: (result && result.msg) || '保存失败', icon: 'none' });
    }
  }
});
