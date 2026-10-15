const services = require('../../../services/index');
const { hashColor } = require('../../../utils/util');
const { normalizeList } = require('../../../utils/cover');

Page({
  data: {
    books: [],
    keyword: '',
    loading: false
  },
  timer: null,

  onShow() {
    this.loadBooks();
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loadBooks(), 400);
  },

  onSearch() {
    if (this.timer) clearTimeout(this.timer);
    this.loadBooks();
  },

  onClearKeyword() {
    this.setData({ keyword: '' });
    this.loadBooks();
  },

  async loadBooks() {
    this.setData({ loading: true });
    try {
      const { list } = await services.getBooks({
        keyword: this.data.keyword.trim(),
        page: 1,
        pageSize: 100
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
      this.setData({ books: mapped, loading: false });
    } catch (e) {
      console.error('[admin/books] loadBooks error:', e);
      this.setData({ loading: false, loadError: true });
    }
  },

  onRetry() {
    this.setData({ loadError: false });
    this.loadBooks();
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
          this.loadBooks();
        } else {
          wx.showToast({ title: (result && result.msg) || '删除失败', icon: 'none' });
        }
      }
    });
  }
});
