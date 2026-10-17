const services = require('../../services/index');
const { TEMPLATE_ID } = require('../../utils/constants');
const { hashColor } = require('../../utils/util');
const { normalizeCover } = require('../../utils/cover');
const { buildScheduleMap, buildDateMonthCalendar, formatDate, WEEKDAYS } = require('../../utils/schedule');

const PICKUP_DAYS = 30; // 可预约未来 30 天

Page({
  data: {
    book: null,
    coverBg: '#5B7FA6',
    logged: false,
    isAdmin: false,
    settings: {
      locations: [],
      borrowDays: 30,
      maxBorrow: 3
    },
    datePanel: {
      show: false,
      location: '',
      selected: '',
      selectedText: ''
    },
    dateCalendar: {
      monthLabel: '',
      canPrev: false,
      canNext: false,
      weeks: []
    },
    WEEKDAYS,
    reviewSummary: { count: 0, avg: 0, dist: [0, 0, 0, 0, 0] },
    reviewPreview: []
  },

  onLoad(options) {
    this.id = options.id;
    this.scheduleMap = {};
    this.loadSettings();
    this.loadBook();
    this.loadSchedules();
    this.loadReviews();
  },

  /** 书评概览 + 前 3 条（完整列表在 book-reviews 页） */
  async loadReviews() {
    if (!this.id) return;
    try {
      const res = await services.getReviews({ bookId: this.id, page: 1, pageSize: 3 });
      const list = (res.list || []).map((r) => Object.assign({}, r, { initial: String(r.userName || '读').charAt(0) }));
      this.setData({
        reviewSummary: res.summary || { count: 0, avg: 0, dist: [0, 0, 0, 0, 0] },
        reviewPreview: list
      });
    } catch (e) {
      // 评论加载失败不影响详情页主流程
    }
  },

  goReviews() {
    const title = encodeURIComponent((this.data.book && this.data.book.title) || '');
    wx.navigateTo({ url: `/pages/book-reviews/index?bookId=${this.id}&title=${title}` });
  },

  onShow() {
    const app = getApp();
    this.setData({
      logged: !!app.globalData.userInfo,
      isAdmin: !!app.globalData.isAdmin
    });
  },

  async loadSettings() {
    const settings = await services.getSettings();
    if (settings && settings.locations && settings.locations.length) {
      this.setData({
        settings: {
          locations: settings.locations,
          borrowDays: Number(settings.borrowDays) || 30,
          maxBorrow: Number(settings.maxBorrow) || 3
        }
      });
    }
  },

  /** 加载各地点值班安排，用于预约时选择可操作日期 */
  async loadSchedules() {
    const schedules = await services.getSchedules();
    this.scheduleMap = buildScheduleMap(schedules);
  },

  async loadBook() {
    const book = await services.getBook(this.id);
    if (!book) {
      wx.showToast({ title: '图书不存在', icon: 'none' });
      return;
    }
    const cover = await normalizeCover(book.cover, book._id);
    const stocks = book.stocks || {};
    // 各馆藏地点可用数量：配置库存 - 未归还占用（含待确认的申请），实现库存锁定
    const occupied = await services.getBookOccupied(this.id).catch(() => ({}));
    const stockChips = Object.keys(stocks).map((loc) => {
      const total = Number(stocks[loc]) || 0;
      const used = Number(occupied[loc]) || 0;
      return {
        loc,
        num: Math.max(total - used, 0),
        total,
        used,
        available: total - used > 0
      };
    });
    this.setData({
      book: Object.assign({}, book, { cover, stockChips }),
      coverBg: hashColor(book.title),
      coverChar: (book.title || '书').charAt(0)
    });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  },

  onBorrow() {
    const app = getApp();
    if (!app.globalData.userInfo) {
      wx.showModal({
        title: '提示',
        content: '请先登录后再借阅',
        confirmText: '去登录',
        success: (res) => {
          if (res.confirm) this.goLogin();
        }
      });
      return;
    }
    const available = (this.data.book.stockChips || []).filter((s) => s.available);
    if (available.length === 0) {
      wx.showToast({ title: '该书所有馆藏地点均无库存', icon: 'none' });
      return;
    }
    // 选择馆藏地点后选择可操作（有人值班）的取书日期
    if (available.length === 1) {
      this.openDatePanel(available[0].loc);
      return;
    }
    wx.showActionSheet({
      itemList: available.map((s) => s.loc + '（可借 ' + s.num + ' 本）'),
      success: (res) => {
        this.openDatePanel(available[res.tapIndex].loc);
      }
    });
  },

  /** 打开取书日期选择弹窗（月历式） */
  openDatePanel(location) {
    const schedule = this.scheduleMap[location];
    const today = new Date();
    const max = new Date(today);
    max.setDate(max.getDate() + PICKUP_DAYS - 1);
    this.pickupSchedule = schedule;
    this.pickupMin = formatDate(today);
    this.pickupMax = formatDate(max);
    this.pickupCursor = new Date(today.getFullYear(), today.getMonth(), 1);
    this.renderDateCalendar();
    this.setData({
      datePanel: {
        show: true,
        location,
        selected: '',
        selectedText: ''
      }
    });
  },

  closeDatePanel() {
    this.setData({ 'datePanel.show': false });
  },

  /** 渲染当前月份取书日历 */
  renderDateCalendar() {
    const y = this.pickupCursor.getFullYear();
    const m = this.pickupCursor.getMonth() + 1;
    const calendar = buildDateMonthCalendar(y, m, this.pickupSchedule, this.pickupMin, this.pickupMax);
    const now = new Date();
    const max = new Date(this.pickupMax + 'T00:00:00');
    const canPrev = y > now.getFullYear() || (y === now.getFullYear() && m > now.getMonth() + 1);
    const canNext = y < max.getFullYear() || (y === max.getFullYear() && m < max.getMonth() + 1);
    this.setData({
      dateCalendar: Object.assign({}, calendar, {
        monthLabel: y + '年' + m + '月',
        canPrev,
        canNext
      })
    });
  },

  prevMonth() {
    if (!this.data.dateCalendar.canPrev) return;
    this.pickupCursor.setDate(1);
    this.pickupCursor.setMonth(this.pickupCursor.getMonth() - 1);
    this.renderDateCalendar();
  },

  nextMonth() {
    if (!this.data.dateCalendar.canNext) return;
    this.pickupCursor.setDate(1);
    this.pickupCursor.setMonth(this.pickupCursor.getMonth() + 1);
    this.renderDateCalendar();
  },

  onPickDate(e) {
    const { date, available } = e.currentTarget.dataset;
    if (!date || !available) return;
    // 在月历中查找该日期的周几文本
    let week = '';
    const weeks = this.data.dateCalendar.weeks;
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
      'datePanel.selected': date,
      'datePanel.selectedText': date + '（' + (week || WEEKDAYS[0]) + '）'
    });
  },

  async onSubmitBorrow() {
    const p = this.data.datePanel;
    if (!p.selected) {
      wx.showToast({ title: '请选择取书日期', icon: 'none' });
      return;
    }
    const app = getApp();
    const me = app.globalData.userInfo;
    // —— 客户端前置校验：明显不可借阅的情况在弹订阅前先拦截，避免「先弹订阅后失败」——
    if (!me) {
      wx.showModal({
        title: '提示', content: '请先登录后再借阅',
        confirmText: '去登录', success: (r) => { if (r.confirm) this.goLogin(); }
      });
      return;
    }
    const card = me.card || {};
    if (card.status !== 'active') {
      wx.showToast({ title: card.status === 'pending' ? '借书证审批中，通过后方可借阅' : '请先在我的页面开通借书证', icon: 'none' });
      return;
    }
    if (card.location !== p.location) {
      wx.showToast({ title: `您仅可借阅「${card.location}」馆藏的图书`, icon: 'none' });
      return;
    }
    const chip = (this.data.book.stockChips || []).find((s) => s.loc === p.location);
    if (!chip || !chip.available) {
      wx.showToast({ title: '该馆藏地点无可用库存', icon: 'none' });
      return;
    }
    // 必须在用户点击的同步执行链内发起订阅（任何 await 之后调用都会报 can only be invoked by user TAP gesture）。
    // 一次传入三个模板，真机上会合并成一个弹窗让用户逐个勾选（与多数小程序一致）。
    // 注意：微信开发者工具「模拟器」对 requestSubscribeMessage 仅支持第一个模板（官方已知限制，
    // 见社区帖 mac开发者工具模拟器使用 requestSubscribeMessage 不支持多个模板），因此在模拟器里只会看到第一个；
    // 要验证三个模板都出现，请用「真机调试」。
    // 第三个模板 OVERDUE_REMIND 为「逾期提醒」，由管理员在借阅管理页手动触发；用户在此处一并授权，
    // 可随每次借阅累加一次额度（也可后续在小程序内增加订阅按钮继续累加）。
    const subPromise = wx.requestSubscribeMessage({
      tmplIds: [TEMPLATE_ID.BORROW_OK, TEMPLATE_ID.RETURN_REMIND, TEMPLATE_ID.OVERDUE_REMIND]
    }).catch((e) => { console.error('[订阅授权异常]', e); return null; });

    wx.showLoading({ title: '提交中' });
    // 提交借阅申请并校验（云端仍会二次校验卡状态/库存/限借等）
    const result = await services.borrowBook(this.id, p.location, p.selected, me, false);
    wx.hideLoading();
    this.setData({ 'datePanel.show': false });
    if (result && result.ok) {
      // 借阅申请校验通过后，才取订阅授权结果并回写（授权本身已在手势内发起）
      const subRes = await subPromise;
      console.log('[订阅授权结果]', JSON.stringify(subRes));
      const subscribedReturn = subRes && subRes[TEMPLATE_ID.RETURN_REMIND] === 'accept';
      // 仅当授权到期提醒时，把标记回写到借阅记录（供确认借出/定时提醒使用）
      if (subscribedReturn && result.borrowId) {
        await services.setSubscribedReturn(result.borrowId, true).catch(() => {});
      }
      wx.showModal({
        title: '申请已提交',
        content: '已提交借阅申请，请在规定日期到线下领取图书。',
        showCancel: false
      });
      this.loadBook();
    } else {
      wx.showToast({ title: (result && result.msg) || '借阅失败', icon: 'none' });
    }
  },

  /** 管理员点击「被借次数」：跳转该书借阅记录完整页面（含未归还） */
  onTapBorrowCount() {
    if (!this.data.isAdmin) return;
    const title = (this.data.book && this.data.book.title) || '';
    wx.navigateTo({
      url: '/pages/admin/book-borrows/index?bookId=' + this.id + '&title=' + encodeURIComponent(title)
    });
  }
});
