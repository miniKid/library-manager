const services = require('../../services/index');

const PAGE_SIZE = 10;

Page({
  data: {
    bookId: '',
    bookTitle: '',
    list: [],
    total: 0,
    summary: { count: 0, avg: 0, dist: [0, 0, 0, 0, 0] },
    sort: 'latest',
    page: 1,
    hasMore: false,
    loading: false,
    logged: false,
    myReview: null,
    stars: [1, 2, 3, 4, 5],
    sheet: { show: false, rating: 0, content: '', anonymous: false, saving: false },
    distRows: []
  },

  onLoad(options) {
    this.setData({
      bookId: options.bookId || '',
      bookTitle: options.title ? decodeURIComponent(options.title) : ''
    });
    if (this.data.bookTitle) {
      wx.setNavigationBarTitle({ title: '《' + this.data.bookTitle + '》书评' });
    }
    this.loadReviews(true);
  },

  onShow() {
    const app = getApp();
    this.setData({ logged: !!(app && app.globalData && app.globalData.userInfo) });
  },

  onPullDownRefresh() {
    this.loadReviews(true).then(() => wx.stopPullDownRefresh());
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  },

  async loadReviews(reset) {
    if (!this.data.bookId || this.data.loading) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    const res = await services.getReviews({
      bookId: this.data.bookId,
      page,
      pageSize: PAGE_SIZE,
      sort: this.data.sort
    });
    const shaped = (res.list || []).map((r) =>
      Object.assign({}, r, { initial: String(r.userName || '读').charAt(0) })
    );
    const list = reset ? shaped : this.data.list.concat(shaped);
    const summary = res.summary || { count: 0, avg: 0, dist: [0, 0, 0, 0, 0] };
    const max = Math.max.apply(null, summary.dist.concat([1]));
    const distRows = [5, 4, 3, 2, 1].map((star) => ({
      star,
      count: summary.dist[star - 1] || 0,
      percent: Math.round(((summary.dist[star - 1] || 0) / max) * 100)
    }));
    this.setData({
      list,
      total: res.total || 0,
      summary,
      distRows,
      page,
      hasMore: list.length < (res.total || 0),
      loading: false
    });
  },

  loadMore() {
    this.loadReviews(false);
  },

  onSort(e) {
    const sort = e.currentTarget.dataset.sort;
    if (sort === this.data.sort) return;
    this.setData({ sort }, () => this.loadReviews(true));
  },

  /* ---------------- 写评论 ---------------- */

  async openSheet() {
    if (!this.data.logged) {
      wx.showModal({
        title: '提示',
        content: '登录后才能发表书评',
        confirmText: '去登录',
        success: (r) => {
          if (r.confirm) this.goLogin();
        }
      });
      return;
    }
    const mine = await services.getMyReview(this.data.bookId);
    this.setData({
      myReview: mine,
      sheet: {
        show: true,
        rating: (mine && mine.rating) || 0,
        content: (mine && mine.content) || '',
        anonymous: !!(mine && mine.anonymous),
        saving: false
      }
    });
  },

  closeSheet() {
    this.setData({ 'sheet.show': false });
  },

  onPickStar(e) {
    this.setData({ 'sheet.rating': Number(e.currentTarget.dataset.star) });
  },

  onContentInput(e) {
    this.setData({ 'sheet.content': e.detail.value });
  },

  onAnonymous(e) {
    this.setData({ 'sheet.anonymous': e.detail.value });
  },

  async onSubmit() {
    const s = this.data.sheet;
    if (s.saving) return;
    if (!s.rating) {
      wx.showToast({ title: '请先选择星级', icon: 'none' });
      return;
    }
    if ((s.content || '').trim().length < 5) {
      wx.showToast({ title: '至少写 5 个字', icon: 'none' });
      return;
    }
    this.setData({ 'sheet.saving': true });
    const res = await services.submitReview({
      bookId: this.data.bookId,
      rating: s.rating,
      content: s.content,
      anonymous: s.anonymous
    });
    this.setData({ 'sheet.saving': false });
    if (res && res.ok) {
      this.setData({ 'sheet.show': false });
      wx.showToast({ title: res.data && res.data.updated ? '已更新' : '发布成功', icon: 'success' });
      this.loadReviews(true);
    } else {
      wx.showToast({ title: (res && res.msg) || '发布失败', icon: 'none' });
    }
  },

  async onDeleteMine() {
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除书评',
        content: '确定删除自己的这条书评吗？',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirm) return;
    const res = await services.removeMyReview(this.data.bookId);
    if (res && res.ok) {
      wx.showToast({ title: '已删除', icon: 'success' });
      this.setData({ myReview: null });
      this.loadReviews(true);
    } else {
      wx.showToast({ title: (res && res.msg) || '删除失败', icon: 'none' });
    }
  },

  async onLike(e) {
    if (!this.data.logged) {
      this.goLogin();
      return;
    }
    const { id } = e.currentTarget.dataset;
    const res = await services.likeReview(id);
    if (!res || !res.ok) {
      wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
      return;
    }
    const liked = res.data.liked;
    const count = res.data.likeCount;
    this.setData({
      list: this.data.list.map((r) =>
        r._id === id ? Object.assign({}, r, { liked, likeCount: count }) : r
      )
    });
  },

  stopBubble() {}
});
