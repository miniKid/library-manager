const services = require('../../../services/index');
const { BORROW_STATUS } = require('../../../utils/constants');

// 借阅状态文案
const STATUS_LABEL = {
  [BORROW_STATUS.PENDING]: '待确认借出',
  [BORROW_STATUS.BORROWING]: '借出中',
  [BORROW_STATUS.RETURN_REQUESTED]: '待确认归还',
  [BORROW_STATUS.RETURNED]: '已归还',
  [BORROW_STATUS.OVERDUE]: '已逾期',
  [BORROW_STATUS.CANCELLED]: '已取消'
};

// 顶部筛选：精简为 全部 / 借出中（含正常借出与逾期）/ 已归还；待确认借出与已取消仅归入「全部」
const FILTERS = [
  { key: '', label: '全部' },
  { key: BORROW_STATUS.BORROWING, label: '借出中' },
  { key: BORROW_STATUS.RETURNED, label: '已归还' }
];

Page({
  data: {
    bookId: '',
    bookTitle: '',
    list: [],
    filtered: [],
    loading: false,
    activeFilter: '',
    filters: FILTERS
  },

  onLoad(options) {
    const bookId = options.bookId || '';
    const bookTitle = options.title ? decodeURIComponent(options.title) : '';
    this.setData({ bookId, bookTitle });
    if (bookTitle) wx.setNavigationBarTitle({ title: bookTitle + ' · 借阅记录' });
    this.loadList();
  },

  async loadList() {
    if (!this.data.bookId) return;
    this.setData({ loading: true });
    try {
      const list = await services.getBorrowsByBook(this.data.bookId);
      const decorated = (list || []).map((r) => Object.assign({}, r, {
        statusText: STATUS_LABEL[r.status] || r.status
      }));
      this.setData({ list: decorated, loading: false }, () => this.applyFilter());
    } catch (e) {
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onFilter(e) {
    const key = e.currentTarget.dataset.key || '';
    this.setData({ activeFilter: key }, () => this.applyFilter());
  },

  applyFilter() {
    const key = this.data.activeFilter;
    let filtered;
    if (!key) {
      filtered = this.data.list;
    } else if (key === BORROW_STATUS.BORROWING) {
      // 借出中：包含正常借出与逾期
      filtered = this.data.list.filter((r) => r.status === BORROW_STATUS.BORROWING || r.status === BORROW_STATUS.OVERDUE);
    } else {
      filtered = this.data.list.filter((r) => r.status === key);
    }
    this.setData({ filtered });
  },

  onPullDownRefresh() {
    this.loadList().then(() => wx.stopPullDownRefresh());
  }
});
