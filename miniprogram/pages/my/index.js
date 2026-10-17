const services = require('../../services/index');
const { hashColor, formatDate } = require('../../utils/util');
const { BORROW_STATUS } = require('../../utils/constants');
const { buildScheduleMap, buildDateMonthCalendar, WEEKDAYS } = require('../../utils/schedule');

const RETURN_DAYS = 30; // 可预约未来 30 天

const STATUS_MAP = {
  [BORROW_STATUS.PENDING]: { text: '待确认借出', cls: 'tag-orange' },
  [BORROW_STATUS.BORROWING]: { text: '借出中', cls: 'tag-blue' },
  [BORROW_STATUS.RETURN_REQUESTED]: { text: '待确认归还', cls: 'tag-orange' },
  [BORROW_STATUS.OVERDUE]: { text: '已逾期', cls: 'tag-red' },
  [BORROW_STATUS.RETURNED]: { text: '已归还', cls: 'tag-green' },
  [BORROW_STATUS.CANCELLED]: { text: '已取消', cls: 'tag-gray' }
};

// 未完结状态：仍在流程中、需要在「我的借阅」置顶展示的借阅
const UNFINISHED = [
  BORROW_STATUS.PENDING,
  BORROW_STATUS.BORROWING,
  BORROW_STATUS.RETURN_REQUESTED,
  BORROW_STATUS.OVERDUE
];

Page({
  data: {
    userInfo: null,
    isAdmin: false,
    cardInfo: null, // 借书证状态展示 { status, text, desc, canApply, active }
    applyPanel: { show: false },
    applyLocations: [],
    locationIndex: 0,
    phone: '',
    borrows: [],
    unfinishedBorrows: [],
    unreadCount: 0,
    loading: false,
    returnPanel: {
      show: false,
      borrowId: '',
      bookTitle: '',
      location: '',
      selected: '',
      selectedText: ''
    },
    editPanel: { show: false, avatarUrl: '', nickname: '' },
    locationPanel: { show: false, locations: [], index: 0 },
    returnCalendar: {
      monthLabel: '',
      canPrev: false,
      canNext: false,
      weeks: []
    },
    WEEKDAYS
  },

  onShow() {
    // 值班安排（周规则/单日覆盖）可能被管理员调整，进入页面时清除缓存，确保下次预约还书拉取到最新配置
    this.scheduleMap = null;
    this.loadPage();
  },

  async loadPage() {
    const app = getApp();
    let userInfo = app.globalData.userInfo;
    // 借书证状态（审批/驳回）由管理员在另一端口操作，本端缓存可能滞后；
    // 进入页面时从后端重新拉取最新用户信息，确保卡状态展示与实际一致
    if (userInfo && userInfo.openid) {
      try {
        const refreshed = await services.login({
          openid: userInfo.openid,
          nickname: userInfo.nickname,
          avatarUrl: userInfo.avatarUrl
        });
        if (refreshed && refreshed._id) {
          app.setLoginUser(refreshed);
          userInfo = refreshed;
        }
      } catch (e) {
        // 拉取失败则继续使用本地缓存兜底
      }
    }
    this.setData({
      userInfo: userInfo
        ? { ...userInfo, coverChar: (userInfo.nickname || '微').charAt(0) }
        : null,
      isAdmin: app.globalData.isAdmin,
      cardInfo: userInfo ? this.buildCardInfo(userInfo) : null
    });
    if (userInfo) {
      this.loadBorrows();
      this.loadUnread();
    } else {
      this.setData({ borrows: [], unfinishedBorrows: [], unreadCount: 0 });
    }
  },

  /** 未读通知数（消息入口红点） */
  async loadUnread() {
    try {
      const count = await services.getUnreadNotifCount();
      this.setData({ unreadCount: count });
    } catch (e) {
      this.setData({ unreadCount: 0 });
    }
  },

  goMessage() {
    wx.navigateTo({ url: '/pages/message/index?tab=notice' });
  },

  goTodos() {
    wx.navigateTo({ url: '/pages/message/index?tab=todo' });
  },

  goRecommend() {
    wx.navigateTo({ url: '/pages/recommend/index' });
  },

  /** 借书证状态展示：管理员身份只是叠加的管理权限，不豁免借阅规则，借书证按其真实状态展示 */
  buildCardInfo(u) {
    const card = u.card || { status: 'none' };
    const canChangeLocation = card.status === 'active' || card.status === 'pending';
    if (!card.status || card.status === 'none') {
      return { status: 'none', text: '未开通借书证', desc: '开通后可借阅图书：填写手机号并选择归属馆藏提交申请，由管理员审批', canApply: true, canChangeLocation: false };
    }
    if (card.status === 'pending') {
      return { status: 'pending', text: '借书证审批中', desc: '手机号 ' + (card.phone || '') + ' · 归属馆藏：' + (card.location || '') + '，等待管理员审批', canApply: false, canChangeLocation: true };
    }
    if (card.status === 'rejected') {
      return { status: 'rejected', text: '借书证申请被驳回', desc: (card.rejectReason || '资料不符合要求') + '，可重新提交申请', canApply: true, canChangeLocation: false };
    }
    const idText = card.phone ? '手机号 ' + card.phone + ' · ' : '';
    return { status: 'active', text: '借书证已开通', desc: idText + '仅可借阅「' + (card.location || '') + '」馆藏的图书', canApply: false, canChangeLocation: true };
  },

  async loadBorrows() {
    const app = getApp();
    this.setData({ loading: true });
    const [list, settings] = await Promise.all([
      services.getMyBorrows(app.globalData.userInfo),
      services.getSettings()
    ]);
    // 续借上限：settings.renewTimes 显式给出时取其值（显式 0 表示禁用续借）；缺失时回退默认 1，避免云端未部署默认 / 旧 settings 文档导致按钮不显示
    const maxRenew = settings && settings.renewTimes !== undefined ? Number(settings.renewTimes) : 1;
    const mapped = list.map((r) => {
      const renewCount = Number(r.renewCount) || 0;
      // 续借仅限「借出中且未逾期」且未达最大续借次数（逾期记录在 getMyBorrows 中已派生成 overdue）
      const canRenew = r.status === BORROW_STATUS.BORROWING && renewCount < maxRenew;
      const renewTip = maxRenew > 0 ? `已续借 ${renewCount}/${maxRenew} 次` : '';
      return {
        ...r,
        coverBg: hashColor(r.bookTitle),
        statusInfo: STATUS_MAP[r.status] || STATUS_MAP[BORROW_STATUS.BORROWING],
        returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
        renewCount,
        canRenew,
        renewTip
      };
    });
    this.setData({
      borrows: mapped,
      unfinishedBorrows: mapped.filter((r) => UNFINISHED.includes(r.status)),
      loading: false
    });
  },

  /** 申请续借：逾期前自主延长到期时间 */
  async onRenew(e) {
    const { id } = e.currentTarget.dataset;
    wx.showLoading({ title: '续借中' });
    const result = await services.renewBorrow(id);
    wx.hideLoading();
    if (result && result.ok) {
      wx.showToast({ title: '续借成功，已延长到期时间', icon: 'success' });
      this.loadBorrows();
    } else {
      wx.showToast({ title: (result && result.msg) || '续借失败', icon: 'none' });
    }
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  },

  goFullBorrows() {
    wx.navigateTo({ url: '/pages/my/borrows/index' });
  },

  // 已登录时点击头像/昵称：选择「修改资料」或「退出登录」；未登录则去登录
  onUserTap() {
    if (!this.data.userInfo) {
      this.goLogin();
      return;
    }
    wx.showActionSheet({
      itemList: ['修改资料', '退出登录'],
      success: (res) => {
        if (res.tapIndex === 0) this.openEditProfile();
        else if (res.tapIndex === 1) this.onLogout();
      }
    });
  },

  openEditProfile() {
    const u = this.data.userInfo || {};
    this.setData({ editPanel: { show: true, avatarUrl: u.avatarUrl || '', nickname: u.nickname || '' } });
  },

  closeEditPanel() {
    this.setData({ 'editPanel.show': false });
  },

  onEditAvatarChoose(e) {
    this.setData({ 'editPanel.avatarUrl': e.detail.avatarUrl });
  },

  onEditNicknameInput(e) {
    this.setData({ 'editPanel.nickname': e.detail.value });
  },

  async onSaveProfile() {
    const nickname = (this.data.editPanel.nickname || '').trim();
    if (!nickname) {
      wx.showToast({ title: '请输入昵称', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '保存中...' });
    try {
      const avatarUrl = await services.uploadAvatar(this.data.editPanel.avatarUrl || '');
      const user = await services.updateProfile({
        nickname,
        avatarUrl
      });
      if (user && user._id) {
        getApp().setLoginUser(user);
        this.setData({ userInfo: user });
      }
      wx.hideLoading();
      this.closeEditPanel();
      wx.showToast({ title: '已保存', icon: 'success' });
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  // ---------- 借书证申请 ----------
  async openApplyCard() {
    const settings = await services.getSettings();
    const locations = (settings && settings.locations) || [];
    this.setData({
      applyPanel: { show: true },
      applyLocations: locations,
      locationIndex: 0,
      phone: ''
    });
  },

  closeApplyPanel() {
    this.setData({ 'applyPanel.show': false });
  },

  onApplyPhoneInput(e) {
    this.setData({ phone: e.detail.value });
  },

  onApplyLocationChange(e) {
    this.setData({ locationIndex: Number(e.detail.value) || 0 });
  },

  // ---------- 修改借书证归属馆藏 ----------
  async openChangeLocation() {
    const settings = await services.getSettings();
    const locations = (settings && settings.locations) || [];
    const card = (this.data.userInfo && this.data.userInfo.card) || {};
    const cur = card.location || '';
    let index = locations.indexOf(cur);
    if (index < 0) index = 0;
    // 切换前须先归还/取消原馆藏的全部借阅（本地预检，服务端仍会二次校验）
    const outstanding = (this.data.borrows || []).filter(
      (r) => r.location === cur && r.status !== 'returned' && r.status !== 'cancelled'
    ).length;
    const warn = outstanding > 0
      ? '当前尚有 ' + outstanding + ' 条原馆藏（' + cur + '）的借阅未归还/取消，请先处理后再修改地址'
      : '';
    this.setData({ locationPanel: { show: true, locations, index, warn } });
  },

  closeLocationPanel() {
    this.setData({ 'locationPanel.show': false });
  },

  onLocationChange(e) {
    this.setData({ 'locationPanel.index': Number(e.detail.value) || 0 });
  },

  async onSubmitLocation() {
    const location = this.data.locationPanel.locations[this.data.locationPanel.index];
    if (!location) {
      wx.showToast({ title: '请选择馆藏地点', icon: 'none' });
      return;
    }
    if (this.data.locationPanel.warn) {
      wx.showToast({ title: '请先处理原馆藏借阅', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '保存中' });
    try {
      const res = await services.updateCardLocation(location);
      wx.hideLoading();
      if (res && res.ok) {
        const app = getApp();
        const u = Object.assign({}, app.globalData.userInfo);
        u.card = Object.assign({}, u.card, { location });
        app.setLoginUser(u);
        this.setData({ 'locationPanel.show': false, userInfo: u, cardInfo: this.buildCardInfo(u) });
        wx.showToast({ title: '已更新借阅地址', icon: 'success' });
      } else {
        wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      wx.showToast({ title: '保存失败，请重试', icon: 'none' });
    }
  },

  async onSubmitCardApply() {
    const app = getApp();
    const phone = (this.data.phone || '').trim();
    const location = this.data.applyLocations[this.data.locationIndex];
    if (!phone) {
      wx.showToast({ title: '请填写手机号', icon: 'none' });
      return;
    }
    if (!/^1\d{10}$/.test(phone)) {
      wx.showToast({ title: '请输入正确的手机号', icon: 'none' });
      return;
    }
    if (!location) {
      wx.showToast({ title: '请选择馆藏地点', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '提交中' });
    const result = await services.applyCard({ phone, location });
    wx.hideLoading();
    if (result && result.ok) {
      this.setData({ 'applyPanel.show': false });
      wx.showToast({ title: '已提交申请，等待管理员审批', icon: 'none' });
      // 刷新本地用户信息（卡状态已变更）
      const cur = app.globalData.userInfo;
      const user = await services.login({ openid: cur.openid, nickname: cur.nickname, avatarUrl: cur.avatarUrl });
      app.setLoginUser(user);
      this.loadPage();
    } else {
      wx.showToast({ title: (result && result.msg) || '提交失败', icon: 'none' });
    }
  },

  // ---------- 测试后门：双击身份标签切换模拟身份 ----------
  onIdentityTap() {
    const now = Date.now();
    if (this._lastIdentityTap && now - this._lastIdentityTap < 350) {
      this._lastIdentityTap = 0;
      this.openSimulate();
    } else {
      this._lastIdentityTap = now;
    }
  },

  async openSimulate() {
    const accounts = await services.getTestAccounts();
    if (!accounts || !accounts.length) {
      wx.showToast({ title: '仅本地模拟模式支持切换模拟身份', icon: 'none' });
      return;
    }
    const currentOpenid = this.data.userInfo && this.data.userInfo.openid;
    const items = accounts.map((a) => a.nickname + '（' + a.desc + '）');
    const self = this;
    wx.showActionSheet({
      itemList: items,
      success: async (res) => {
        const acc = accounts[res.tapIndex];
        if (!acc) return;
        if (acc.openid === currentOpenid) {
          wx.showToast({ title: '已是该身份', icon: 'none' });
          return;
        }
        wx.showLoading({ title: '切换中' });
        const user = await services.login({ openid: acc.openid, nickname: acc.nickname });
        wx.hideLoading();
        getApp().setLoginUser(user);
        self.loadPage();
      }
    });
  },

  goBook(e) {
    wx.navigateTo({ url: '/pages/book-detail/index?id=' + e.currentTarget.dataset.id });
  },

  onRequestReturn(e) {
    const { id, bookTitle, location } = e.currentTarget.dataset;
    this.returnTarget = { id, bookTitle, location };
    if (this.scheduleMap) {
      this.openReturnPanel();
      return;
    }
    wx.showLoading({ title: '加载中' });
    services.getSchedules().then((schedules) => {
      wx.hideLoading();
      this.scheduleMap = buildScheduleMap(schedules);
      this.openReturnPanel();
    });
  },

  /** 打开还书日期选择弹窗（月历式） */
  openReturnPanel() {
    const t = this.returnTarget;
    if (!t) return;
    const schedule = this.scheduleMap[t.location];
    const today = new Date();
    const max = new Date(today);
    max.setDate(max.getDate() + RETURN_DAYS - 1);
    this.returnSchedule = schedule;
    this.returnMin = formatDate(today);
    this.returnMax = formatDate(max);
    this.returnCursor = new Date(today.getFullYear(), today.getMonth(), 1);
    this.renderReturnCalendar();
    this.setData({
      returnPanel: {
        show: true,
        borrowId: t.id,
        bookTitle: t.bookTitle,
        location: t.location,
        selected: '',
        selectedText: ''
      }
    });
  },

  closeReturnPanel() {
    this.setData({ 'returnPanel.show': false });
  },

  /** 渲染当前月份还书日历 */
  renderReturnCalendar() {
    const y = this.returnCursor.getFullYear();
    const m = this.returnCursor.getMonth() + 1;
    const calendar = buildDateMonthCalendar(y, m, this.returnSchedule, this.returnMin, this.returnMax);
    const now = new Date();
    const max = new Date(this.returnMax + 'T00:00:00');
    const canPrev = y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1);
    const canNext = y < max.getFullYear() || (y === max.getFullYear() && m < max.getMonth() + 1);
    this.setData({
      returnCalendar: Object.assign({}, calendar, {
        monthLabel: y + '年' + m + '月',
        canPrev,
        canNext
      })
    });
  },

  prevMonth() {
    if (!this.data.returnCalendar.canPrev) return;
    this.returnCursor.setDate(1);
    this.returnCursor.setMonth(this.returnCursor.getMonth() - 1);
    this.renderReturnCalendar();
  },

  nextMonth() {
    if (!this.data.returnCalendar.canNext) return;
    this.returnCursor.setDate(1);
    this.returnCursor.setMonth(this.returnCursor.getMonth() + 1);
    this.renderReturnCalendar();
  },

  onPickReturnDate(e) {
    const { date, available } = e.currentTarget.dataset;
    if (!date || !available) return;
    let week = '';
    const weeks = this.data.returnCalendar.weeks;
    for (let i = 0; i < weeks.length; i++) {
      const row = weeks[i];
      for (let j = 0; j < row.length; j++) {
        if (row[j] && row[j].date === date) {
          week = row[j].week;
          break;
        }
      }
      if (week) break;
    }
    this.setData({
      'returnPanel.selected': date,
      'returnPanel.selectedText': date + '（' + (week || WEEKDAYS[0]) + '）'
    });
  },

  async onSubmitReturn() {
    const p = this.data.returnPanel;
    if (!p.selected) {
      wx.showToast({ title: '请选择还书日期', icon: 'none' });
      return;
    }
    wx.showLoading({ title: '提交中' });
    const result = await services.requestReturn(p.borrowId, p.selected);
    wx.hideLoading();
    this.setData({ 'returnPanel.show': false });
    if (result && result.ok) {
      wx.showToast({ title: '已提交归还申请', icon: 'success' });
      this.loadBorrows();
    } else {
      wx.showToast({ title: (result && result.msg) || '操作失败', icon: 'none' });
    }
  },

  onCancelBorrow(e) {
    const { id, bookTitle } = e.currentTarget.dataset;
    wx.showModal({
      title: '取消借出申请',
      content: '确认取消《' + bookTitle + '》的借出申请？',
      success: async (res) => {
        if (!res.confirm) return;
        const result = await services.cancelBorrow(id);
        if (result && result.ok) {
          wx.showToast({ title: '已取消申请', icon: 'success' });
          this.loadBorrows();
        } else {
          wx.showToast({ title: (result && result.msg) || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onCancelReturn(e) {
    const { id, bookTitle } = e.currentTarget.dataset;
    wx.showModal({
      title: '取消还书申请',
      content: '确认取消《' + bookTitle + '》的还书申请？',
      success: async (res) => {
        if (!res.confirm) return;
        const result = await services.cancelReturn(id);
        if (result && result.ok) {
          wx.showToast({ title: '已取消还书申请', icon: 'success' });
          this.loadBorrows();
        } else {
          wx.showToast({ title: (result && result.msg) || '操作失败', icon: 'none' });
        }
      }
    });
  },

  goAdmin() {
    wx.switchTab({ url: '/pages/admin/index' });
  },

  onLogout() {
    wx.showModal({
      title: '退出登录',
      content: '确定要退出当前账号吗？',
      success: (res) => {
        if (res.confirm) {
          getApp().logout();
          this.loadPage();
        }
      }
    });
  }
});
