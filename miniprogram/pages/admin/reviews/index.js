const services = require('../../../services/index');

const FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'approved', label: '展示中' },
  { key: 'hidden', label: '已隐藏' }
];

Page({
  data: {
    filters: FILTERS,
    status: 'all',
    keyword: '',
    list: [],
    total: 0,
    page: 1,
    pageSize: 20,
    loading: false,
    stars: [1, 2, 3, 4, 5],
    replySheet: { show: false, reviewId: '', content: '', saving: false }
  },

  onLoad() {
    const app = getApp();
    if (app && app.globalData && !app.globalData.isAdmin) {
      wx.showToast({ title: '仅管理员可用', icon: 'none' });
      setTimeout(() => wx.navigateBack(), 1200);
      return;
    }
    this.load(true);
  },

  onFilter(e) {
    const status = e.currentTarget.dataset.status;
    if (status === this.data.status) return;
    this.setData({ status }, () => this.load(true));
  },

  onKeyword(e) {
    this.setData({ keyword: e.detail.value });
  },

  onSearch() {
    this.load(true);
  },

  onReachBottom() {
    if (this.data.list.length < this.data.total) this.load(false);
  },

  async load(reset) {
    if (this.data.loading) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loading: true });
    const res = await services.adminGetReviews({
      status: this.data.status,
      keyword: this.data.keyword,
      page,
      pageSize: this.data.pageSize
    });
    const shaped = (res.list || []).map((r) => Object.assign({}, r, { initial: String(r.userName || '读').charAt(0) }));
    this.setData({
      list: reset ? shaped : this.data.list.concat(shaped),
      total: res.total || 0,
      page,
      loading: false
    });
  },

  async onToggleStatus(e) {
    const { id, status } = e.currentTarget.dataset;
    const next = status === 'hidden' ? 'approved' : 'hidden';
    const res = await services.adminSetReviewStatus(id, next);
    if (res && res.ok) {
      wx.showToast({ title: next === 'hidden' ? '已隐藏' : '已恢复', icon: 'success' });
      this.load(true);
    } else {
      wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
    }
  },

  async onDelete(e) {
    const { id } = e.currentTarget.dataset;
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除评论',
        content: '删除后不可恢复，确定吗？',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirm) return;
    const res = await services.adminRemoveReview(id);
    if (res && res.ok) {
      wx.showToast({ title: '已删除', icon: 'success' });
      this.load(true);
    } else {
      wx.showToast({ title: (res && res.msg) || '删除失败', icon: 'none' });
    }
  },

  openReply(e) {
    const { id, content } = e.currentTarget.dataset;
    this.setData({ replySheet: { show: true, reviewId: id, content: content || '', saving: false } });
  },

  closeReply() {
    this.setData({ 'replySheet.show': false });
  },

  onReplyInput(e) {
    this.setData({ 'replySheet.content': e.detail.value });
  },

  async onSaveReply() {
    const s = this.data.replySheet;
    if (s.saving) return;
    if (!s.content.trim()) {
      wx.showToast({ title: '请填写回复', icon: 'none' });
      return;
    }
    this.setData({ 'replySheet.saving': true });
    const res = await services.adminReplyReview(s.reviewId, s.content);
    this.setData({ 'replySheet.saving': false });
    if (res && res.ok) {
      this.setData({ 'replySheet.show': false });
      wx.showToast({ title: '已回复', icon: 'success' });
      this.load(true);
    } else {
      wx.showToast({ title: (res && res.msg) || '回复失败', icon: 'none' });
    }
  },

  stopBubble() {}
});
