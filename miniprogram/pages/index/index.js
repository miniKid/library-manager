const services = require('../../services/index');
const { hashColor } = require('../../utils/util');
const { normalizeList } = require('../../utils/cover');

Page({
  data: {
    keyword: '',
    locations: [],
    activeLocation: '',
    books: [],
    page: 1,
    // 分页策略：首次加载 10 本，触底（onReachBottom）再加载 10 本
    pageSize: 10,
    total: 0,
    loading: false,
    finished: false,
    logged: false
  },
  timer: null,

  onLoad() {
    const app = getApp();
    this.setData({ logged: !!app.globalData.userInfo });
    this.loadLocations();
  },

  async loadLocations() {
    try {
      const settings = await services.getSettings();
      const locations = (settings && settings.locations) || [];
      this.setData({ locations });
    } catch (e) {
      // 取不到地点时仅展示「全部」，不影响其余功能
    }
  },

  onShow() {
    const app = getApp();
    if (this.data.logged !== !!app.globalData.userInfo) {
      this.setData({ logged: !!app.globalData.userInfo });
    }
    // 每次回到页面都刷新，保证新增/编辑/删除/借还后书架数据同步
    this.loadBooks(true);
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loadBooks(true), 400);
  },

  onSearch() {
    if (this.timer) clearTimeout(this.timer);
    this.loadBooks(true);
  },

  onClearKeyword() {
    this.setData({ keyword: '' });
    this.loadBooks(true);
  },

  onFilter(e) {
    const loc = e.currentTarget.dataset.loc || '';
    if (loc === this.data.activeLocation) return;
    this.setData({ activeLocation: loc });
    this.loadBooks(true);
  },

  async loadBooks(reset) {
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page;
    this.setData({ loading: true });
    try {
      const { list, total } = await services.getBooks({
        keyword: this.data.keyword.trim(),
        location: this.data.activeLocation,
        page,
        pageSize: this.data.pageSize
      });
      // base64 封面先写入本地文件（<image> 不支持直接渲染 dataURL）
      const normalized = await normalizeList(list);
      const mapped = normalized.map((b) => ({
        ...b,
        coverBg: hashColor(b.title),
        coverChar: (b.title || '书').charAt(0),
        // 各馆藏地点可用数量，如 [{ loc: '广州', num: 3 }, { loc: '西安', num: 1 }]
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
      this.setData({ loading: false });
      wx.showToast({ title: '加载失败', icon: 'none' });
    }
  },

  onPullDownRefresh() {
    this.loadBooks(true).then(() => wx.stopPullDownRefresh());
  },

  onReachBottom() {
    if (!this.data.finished && !this.data.loading) {
      this.loadBooks(false);
    }
  },

  goDetail(e) {
    wx.navigateTo({
      url: '/pages/book-detail/index?id=' + e.currentTarget.dataset.id
    });
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  }
});
