const services = require('../../../services/index');
const { hashColor } = require('../../../utils/util');
const { normalizeList } = require('../../../utils/cover');

Page({
  data: {
    books: [],
    keyword: '',
    // 分页策略：首次加载 pageSize 本，触底（onReachBottom）再加载下一页，避免图书量大时一次性加载过慢
    page: 1,
    pageSize: 10,
    total: 0,
    loading: false,
    finished: false,
    loadError: false
  },
  timer: null,

  onShow() {
    this.loadBooks(true);
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loadBooks(), 400);
  },

  onSearch() {
    if (this.timer) clearTimeout(this.timer);
    this.loadBooks(true);
  },

  onClearKeyword() {
    this.setData({ keyword: '' });
    this.loadBooks(true);
  },

  async loadBooks(reset) {
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true, loadError: false });
    try {
      const { list, total } = await services.getBooks({
        keyword: this.data.keyword.trim(),
        page,
        pageSize: this.data.pageSize
      });
      const normalized = await normalizeList(list);
      const mapped = normalized.map((b) => ({
        ...b,
        coverBg: hashColor(b.title),
        coverChar: (b.title || '书').charAt(0),
        // 各馆藏地点可用数量
        stockChips: Object.keys(b.stocks || {}).map((loc) => ({
          loc,
          num: Number(b.stocks[loc]) || 0
        }))
      }));
      this.setData({
        books: reset ? mapped : this.data.books.concat(mapped),
        page: page + 1,
        total,
        finished: page * this.data.pageSize >= total,
        loading: false
      });
    } catch (e) {
      console.error('[admin/books] loadBooks error:', e);
      if (reset) {
        this.setData({ loading: false, loadError: true });
      } else {
        this.setData({ loading: false });
        wx.showToast({ title: '加载失败', icon: 'none' });
      }
    }
  },

  onReachBottom() {
    if (!this.data.finished && !this.data.loading) {
      this.loadBooks(false);
    }
  },

  onRetry() {
    this.setData({ loadError: false });
    this.loadBooks(true);
  },

  goEdit(e) {
    wx.navigateTo({
      url: '/pages/admin/book-edit/index?id=' + e.currentTarget.dataset.id
    });
  },

  goAdd() {
    wx.navigateTo({ url: '/pages/admin/book-edit/index' });
  },

  onDelete(e) {
    const { id, title } = e.currentTarget.dataset;
    wx.showModal({
      title: '删除图书',
      content: '确定删除《' + title + '》吗？',
      confirmColor: '#E54D42',
      success: async (res) => {
        if (!res.confirm) return;
        const result = await services.deleteBook(id);
        if (result && result.ok) {
          wx.showToast({ title: '已删除', icon: 'success' });
          this.loadBooks(true);
        } else {
          wx.showToast({ title: (result && result.msg) || '删除失败', icon: 'none' });
        }
      }
    });
  }
});
