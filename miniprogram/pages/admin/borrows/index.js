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

// 页签文案压到 2-3 字，保证单行不折行；countKey 对应 getBorrowStatusCounts 的字段
// danger=true 表示「有活要干」的队列，数量标红
const FILTERS = [
  { key: '', label: '全部', countKey: 'all' },
  { key: BORROW_STATUS.PENDING, label: '待借出', countKey: 'pending', danger: true },
  { key: BORROW_STATUS.BORROWING, label: '借出中', countKey: 'borrowing' },
  { key: BORROW_STATUS.RETURN_REQUESTED, label: '待归还', countKey: 'return_requested', danger: true },
  { key: BORROW_STATUS.OVERDUE, label: '逾期', countKey: 'overdue', danger: true },
  { key: BORROW_STATUS.RETURNED, label: '已归还', countKey: 'returned' },
  { key: BORROW_STATUS.CANCELLED, label: '已取消', countKey: 'cancelled' }
];

Page({
  data: {
    filters: FILTERS,
    activeFilter: '',
    borrows: [],
    loading: false,
    scrollInto: '',
    emptyText: '暂无借阅记录'
  },

  onLoad(options) {
    // 支持从管理首页统计卡片带 status 深链进入具体 tab（如 ?status=overdue）
    const validKeys = FILTERS.map((f) => f.key);
    const status = options && options.status;
    if (status && validKeys.indexOf(status) !== -1) {
      this.setData({ activeFilter: status, scrollInto: 'chip-' + status });
    }
  },

  onShow() {
    this.loadBorrows();
  },

  onFilter(e) {
    const key = e.currentTarget.dataset.key;
    if (key === this.data.activeFilter) return;
    this.setData({ activeFilter: key, scrollInto: 'chip-' + (key || 'all') });
    this.loadBorrows();
  },

  /** 页签数组：把数量合并进去，数量为 0 时页面不渲染徽标 */
  buildFilters(counts) {
    const c = counts || {};
    const filters = FILTERS.map((f) => Object.assign({}, f, { count: Number(c[f.countKey]) || 0 }));
    const hit = filters.filter((f) => f.key === this.data.activeFilter)[0];
    return {
      filters,
      emptyText: hit && hit.key ? '暂无「' + hit.label + '」的记录' : '暂无借阅记录'
    };
  },

  async loadBorrows() {
    this.setData({ loading: true });
    const [list, counts] = await Promise.all([
      services.getBorrows({ status: this.data.activeFilter }),
      services.getBorrowStatusCounts()
    ]);
    const mapped = list.map((r) => ({
      ...r,
      coverBg: hashColor(r.bookTitle),
      statusInfo: STATUS_MAP[r.status] || STATUS_MAP[BORROW_STATUS.BORROWING],
      borrowDateText: formatDate(r.borrowDate, true),
      deliverDateText: r.deliverDate ? formatDate(r.deliverDate, true) : '',
      dueDateText: formatCST(r.dueDate),
      returnDateText: r.returnDate ? formatDate(r.returnDate, true) : ''
    }));
    this.setData(Object.assign({ borrows: mapped, loading: false }, this.buildFilters(counts)));
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
  },

  /** 管理员手动发送逾期提醒订阅消息给借阅人 */
  onSendOverdueRemind(e) {
    const { id, bookTitle } = e.currentTarget.dataset;
    wx.showModal({
      title: '逾期提醒',
      content: '向《' + bookTitle + '》借阅人发送逾期提醒订阅消息？',
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '发送中' });
        const result = await services.sendOverdueRemind(id);
        wx.hideLoading();
        if (result && result.ok) {
          wx.showToast({ title: '已发送逾期提醒', icon: 'success' });
        } else if (result && result.code === 'NO_GRANT') {
          wx.showModal({ title: '无法发送', content: (result.msg || '该用户未订阅逾期提醒'), showCancel: false });
        } else {
          wx.showToast({ title: (result && result.msg) || '发送失败', icon: 'none' });
        }
      }
    });
  }
});
