const services = require('../../services/index');

Page({
  data: {
    isAdmin: false,
    stats: null
  },

  onShow() {
    const app = getApp();
    if (app.globalData.isAdmin) {
      this.setData({ isAdmin: true });
      this.loadStats();
    } else {
      this.setData({ isAdmin: false });
    }
  },

  async loadStats() {
    const stats = await services.getStats();
    this.setData({ stats });
  },

  goBooks() {
    wx.navigateTo({ url: '/pages/admin/books/index' });
  },

  goBorrows(e) {
    const ds = e && e.currentTarget ? e.currentTarget.dataset : {};
    const status = ds.status || '';
    const url = status ? '/pages/admin/borrows/index?status=' + status : '/pages/admin/borrows/index';
    wx.navigateTo({ url });
  },

  goMembers() {
    wx.navigateTo({ url: '/pages/admin/members/index' });
  },

  goSettings() {
    wx.navigateTo({ url: '/pages/admin/settings/index' });
  },

  goSchedule() {
    wx.navigateTo({ url: '/pages/admin/schedule/index' });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  }
});
