const services = require('../../../services/index');
const { hashColor, formatDate, formatCST } = require('../../../utils/util');
const { BORROW_STATUS } = require('../../../utils/constants');

const STATUS_MAP = {
  [BORROW_STATUS.PENDING]: { text: '待确认借出', cls: 'tag-orange' },
  [BORROW_STATUS.BORROWING]: { text: '借出中', cls: 'tag-blue' },
  [BORROW_STATUS.RETURN_REQUESTED]: { text: '待确认归还', cls: 'tag-orange' },
  [BORROW_STATUS.OVERDUE]: { text: '已逾期', cls: 'tag-red' },
  [BORROW_STATUS.RETURNED]: { text: '已归还', cls: 'tag-green' },
  [BORROW_STATUS.CANCELLED]: { text: '已取消', cls: 'tag-gray' }
};

const FILTERS = [
  { key: '', label: '全部' },
  { key: BORROW_STATUS.PENDING, label: '待确认借出' },
  { key: BORROW_STATUS.BORROWING, label: '借出中' },
  { key: BORROW_STATUS.RETURN_REQUESTED, label: '待确认归还' },
  { key: BORROW_STATUS.OVERDUE, label: '已逾期' },
  { key: BORROW_STATUS.RETURNED, label: '已归还' },
  { key: BORROW_STATUS.CANCELLED, label: '已取消' }
];

Page({
  data: {
    filters: FILTERS,
    activeFilter: '',
    borrows: [],
    loading: false
  },

  onLoad(options) {
    // 支持从管理首页统计卡片带 status 深链进入具体 tab（如 ?status=overdue）
    const validKeys = FILTERS.map((f) => f.key);
    const status = options && options.status;
    if (status && validKeys.indexOf(status) !== -1) {
      this.setData({ activeFilter: status });
    }
  },

  onShow() {
    this.loadBorrows();
  },

  onFilter(e) {
    this.setData({ activeFilter: e.currentTarget.dataset.key });
    this.loadBorrows();
  },

  async loadBorrows() {
    this.setData({ loading: true });
    const list = await services.getBorrows({ status: this.data.activeFilter });
    const mapped = list.map((r) => ({
      ...r,
      coverBg: hashColor(r.bookTitle),
      statusInfo: STATUS_MAP[r.status] || STATUS_MAP[BORROW_STATUS.BORROWING],
      borrowDateText: formatDate(r.borrowDate, true),
      deliverDateText: r.deliverDate ? formatDate(r.deliverDate, true) : '',
      dueDateText: formatCST(r.dueDate),
      returnDateText: r.returnDate ? formatDate(r.returnDate, true) : ''
    }));
    this.setData({ borrows: mapped, loading: false });
  },

  onConfirmBorrow(e) {
    const { id, bookTitle } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认借出',
      content: '确认已线下交付《' + bookTitle + '》给借阅人？',
      success: async (res) => {
        if (!res.confirm) return;
        const result = await services.confirmBorrow(id);
        if (result && result.ok) {
          wx.showToast({ title: '已确认借出', icon: 'success' });
          this.loadBorrows();
        } else {
          wx.showToast({ title: (result && result.msg) || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onReturn(e) {
    const { id, bookTitle } = e.currentTarget.dataset;
    wx.showModal({
      title: '确认归还',
      content: '确认《' + bookTitle + '》已由用户线下归还？',
      success: async (res) => {
        if (!res.confirm) return;
        const result = await services.returnBook(id);
        if (result && result.ok) {
          wx.showToast({ title: '已确认归还', icon: 'success' });
          this.loadBorrows();
        } else {
          wx.showToast({ title: (result && result.msg) || '操作失败', icon: 'none' });
        }
      }
    });
  },

  onCancelBorrow(e) {
    const { id, bookTitle } = e.currentTarget.dataset;
    wx.showModal({
      title: '取消借出申请',
      content: '确认取消《' + bookTitle + '》的借出申请？取消后需重新申请',
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
  }
});
