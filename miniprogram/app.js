const services = require('./services/index');

App({
  globalData: {
    userInfo: null,
    role: 'user',
    isAdmin: false
  },

  onLaunch() {
    // 初始化数据服务（云开发初始化 / 本地模拟数据种子）
    if (typeof services.init === 'function') {
      services.init();
    }

    // 恢复登录状态
    const userInfo = wx.getStorageSync('userInfo');
    if (userInfo && userInfo._id) {
      this.setLoginUser(userInfo);
    }
  },

  setLoginUser(user) {
    this.globalData.userInfo = user;
    this.globalData.role = user.role || 'user';
    this.globalData.isAdmin = user.role === 'admin';
    wx.setStorageSync('userInfo', user);
  },

  logout() {
    this.globalData.userInfo = null;
    this.globalData.role = 'user';
    this.globalData.isAdmin = false;
    wx.removeStorageSync('userInfo');
  }
});
