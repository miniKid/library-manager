const services = require('../../services/index');

Page({
  data: {
    ready: false,
    needProfile: false, // true=首次需填头像昵称；false=老用户直接登录
    preview: null, // 老用户预览 { nickname, avatarUrl }
    avatarUrl: '',
    nickname: '',
    submitting: false
  },

  async onLoad() {
    // 按 openid 取/建用户：若后端已存在昵称资料，则视为老用户，无需再填头像昵称
    try {
      const user = await services.login();
      if (user && user._id && user.nickname && user.nickname !== '微信用户') {
        const avatarUrl = user.avatarUrl || '';
        this.setData({
          ready: true,
          needProfile: false,
          preview: { nickname: user.nickname, avatarUrl }
        });
        return;
      }
    } catch (e) {
      // 拉取失败则退化到首次填写流程
    }
    this.setData({ ready: true, needProfile: true });
  },

  onChooseAvatar(e) {
    this.setData({ avatarUrl: e.detail.avatarUrl });
  },

  onNicknameInput(e) {
    this.setData({ nickname: e.detail.value });
  },

  async onSubmit() {
    if (this.data.submitting) return;
    let profile = {};
    if (this.data.needProfile) {
      const nickname = this.data.nickname.trim();
      if (!nickname) {
        wx.showToast({ title: '请输入昵称', icon: 'none' });
        return;
      }
      const avatarUrl = this.data.avatarUrl ? await services.uploadAvatar(this.data.avatarUrl) : '';
      profile = { nickname, avatarUrl };
    }
    this.setData({ submitting: true });
    wx.showLoading({ title: '登录中...' });
    try {
      const user = await services.login(profile);
      getApp().setLoginUser(user);
      wx.hideLoading();
      wx.showToast({ title: '登录成功', icon: 'success' });
      setTimeout(() => {
        const pages = getCurrentPages();
        if (pages.length > 1) wx.navigateBack();
        else wx.reLaunch({ url: '/pages/my/index' });
      }, 600);
    } catch (e) {
      wx.hideLoading();
      this.setData({ submitting: false });
      wx.showToast({ title: '登录失败，请重试', icon: 'none' });
    }
  }
});
