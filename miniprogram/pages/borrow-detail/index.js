const services = require('../../services/index');
const { BORROW_STATUS } = require('../../utils/constants');
const { formatDate, addDays } = require('../../utils/util');
const { buildScheduleMap, isScheduledOn } = require('../../utils/schedule');

const RETURN_DAYS = 30;

const STATUS_MAP = {
  [BORROW_STATUS.PENDING]: {
    text: '待确认借出', cls: 'tag-orange',
    tip: '等待管理员确认借出，确认后到馆藏地点线下领取'
  },
  [BORROW_STATUS.BORROWING]: { text: '借出中', cls: 'tag-blue', tip: '' },
  [BORROW_STATUS.RETURN_REQUESTED]: {
    text: '待确认归还', cls: 'tag-orange',
    tip: '已提交归还申请，等待管理员线下回收确认'
  },
  [BORROW_STATUS.OVERDUE]: {
    text: '已逾期', cls: 'tag-red',
    tip: '已超过应还日期，逾期后不能续借，请尽快预约还书'
  },
  [BORROW_STATUS.RETURNED]: { text: '已归还', cls: 'tag-green', tip: '' },
  [BORROW_STATUS.CANCELLED]: { text: '已取消', cls: 'tag-gray', tip: '' }
};

/** 与「我的借阅」一致的确认弹窗 */
function confirmAction(title, content) {
  return new Promise((resolve) => {
    wx.showModal({
      title,
      content,
      success: (r) => resolve(!!r.confirm),
      fail: () => resolve(false)
    });
  });
}

Page({
  data: {
    loading: true,
    notFound: false,
    item: null,
    statusInfo: {},
    statusTip: '',
    canRenew: false,
    renewTip: '',
    timeline: [],
    returnPanel: { show: false, date: '', min: '', max: '' }
  },

  onLoad(options) {
    this.borrowId = (options && options.id) || '';
  },

  onShow() {
    if (!this.borrowId) {
      this.setData({ loading: false, notFound: true });
      return;
    }
    this.loadBorrow();
  },

  /** 从「我的借阅」列表里按 id 取单条；列表由云函数按当前 openid 过滤，天然越权隔离 */
  async loadBorrow() {
    this.setData({ loading: true });
    const app = getApp();
    const [list, settings] = await Promise.all([
      services.getMyBorrows(app.globalData.userInfo),
      services.getSettings()
    ]);
    const raw = (list || []).find((r) => String(r._id) === String(this.borrowId));
    if (!raw) {
      this.setData({ loading: false, notFound: true, item: null });
      return;
    }

    const maxRenew = settings && settings.renewTimes !== undefined ? Number(settings.renewTimes) : 1;
    const renewCount = Number(raw.renewCount) || 0;
    const canRenew = raw.status === BORROW_STATUS.BORROWING && maxRenew > 0 && renewCount < maxRenew;
    const info = STATUS_MAP[raw.status] || STATUS_MAP[BORROW_STATUS.BORROWING];

    const timeline = [
      { label: '申请日期', value: raw.borrowDateText },
      { label: '预约取书', value: raw.scheduledPickupDateText },
      { label: '借出日期', value: raw.deliverDateText },
      { label: '应还日期', value: raw.dueDateText }
    ].filter((row) => row.value);

    if (raw.status === BORROW_STATUS.OVERDUE && raw.dueDateText) {
      const today = formatDate(new Date());
      const days = Math.max(
        0,
        Math.round((new Date(today + 'T00:00:00Z') - new Date(raw.dueDateText + 'T00:00:00Z')) / 86400000)
      );
      timeline.push({ label: '逾期天数', value: days + ' 天' });
    }
    if (raw.scheduledReturnDateText) timeline.push({ label: '预约还书', value: raw.scheduledReturnDateText });
    if (raw.returnDateText) timeline.push({ label: '归还日期', value: raw.returnDateText });
    if (maxRenew > 0) timeline.push({ label: '续借次数', value: `已续借 ${renewCount}/${maxRenew} 次` });

    this.setData({
      loading: false,
      notFound: false,
      item: raw,
      statusInfo: info,
      statusTip: info.tip,
      canRenew,
      renewTip: maxRenew > 0 ? `已续借 ${renewCount}/${maxRenew} 次` : '',
      timeline
    });
  },

  async onRenew() {
    const item = this.data.item;
    if (!item) return;
    wx.showLoading({ title: '续借中' });
    const res = await services.renewBorrow(item._id);
    wx.hideLoading();
    if (res && res.ok) {
      wx.showToast({ title: '续借成功，已延长到期时间', icon: 'success' });
      this.loadBorrow();
    } else {
      wx.showToast({ title: (res && res.msg) || '续借失败', icon: 'none' });
    }
  },

  async onCancelBorrow() {
    const item = this.data.item;
    if (!item) return;
    const ok = await confirmAction('取消借出申请', `确认取消《${item.bookTitle}》的借出申请？`);
    if (!ok) return;
    const res = await services.cancelBorrow(item._id);
    if (res && res.ok) {
      wx.showToast({ title: '已取消申请', icon: 'success' });
      this.loadBorrow();
    } else {
      wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
    }
  },

  async onCancelReturn() {
    const item = this.data.item;
    if (!item) return;
    const ok = await confirmAction('取消还书申请', `确认取消《${item.bookTitle}》的还书申请？`);
    if (!ok) return;
    const res = await services.cancelReturn(item._id);
    if (res && res.ok) {
      wx.showToast({ title: '已取消还书申请', icon: 'success' });
      this.loadBorrow();
    } else {
      wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
    }
  },

  /** 预约还书：加载值班表后弹出日期选择；提交前按值班规则预校验，服务端仍会二次校验 */
  async onRequestReturn() {
    if (!this.data.item) return;
    wx.showLoading({ title: '加载中' });
    const schedules = await services.getSchedules().catch(() => []);
    wx.hideLoading();
    this.scheduleMap = buildScheduleMap(schedules);
    this.setData({
      returnPanel: {
        show: true,
        date: '',
        min: formatDate(new Date()),
        max: formatDate(addDays(new Date(), RETURN_DAYS))
      }
    });
  },

  onPickReturnDate(e) {
    this.setData({ 'returnPanel.date': e.detail.value });
  },

  closeReturnPanel() {
    this.setData({ 'returnPanel.show': false });
  },

  async onSubmitReturn() {
    const p = this.data.returnPanel;
    const item = this.data.item;
    if (!item || !p.date) return wx.showToast({ title: '请选择还书日期', icon: 'none' });
    const schedule = this.scheduleMap && this.scheduleMap[item.location];
    if (!isScheduledOn(schedule, p.date)) {
      return wx.showToast({ title: '该日期馆藏无人值班，请换一天', icon: 'none' });
    }
    wx.showLoading({ title: '提交中' });
    const res = await services.requestReturn(item._id, p.date);
    wx.hideLoading();
    this.setData({ 'returnPanel.show': false });
    if (res && res.ok) {
      wx.showToast({ title: '已提交归还申请', icon: 'success' });
      this.loadBorrow();
    } else {
      wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
    }
  }
});
