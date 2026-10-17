const services = require('../../services/index');
const { normalizeCover } = require('../../utils/cover');
const { hashColor } = require('../../utils/util');

const BATCH = 20;

Page({
  data: {
    list: [],
    loading: false,
    offset: 0,
    total: 0,
    hasMore: true,
    done: false
  },

  onLoad() {
    this.loadBatch(true);
  },

  onPullDownRefresh() {
    this.loadBatch(true).then(() => wx.stopPullDownRefresh());
  },

  async loadBatch(reset) {
    if (this.data.loading) return;
    const offset = reset ? 0 : this.data.offset;
    this.setData({ loading: true });
    const res = await services.getRecommendations({ limit: BATCH, offset });
    const list = await Promise.all(
      (res.list || []).map(async (b) => {
        const cover = await normalizeCover(b.cover, b._id).catch(() => '');
        return Object.assign({}, b, {
          cover,
          coverBg: hashColor(b.title),
          initial: String(b.title || '书').charAt(0)
        });
      })
    );
    this.setData({
      list: reset ? list : this.data.list.concat(list),
      offset: offset + list.length,
      total: res.total || 0,
      hasMore: !!res.hasMore,
      done: !res.hasMore,
      loading: false
    });
  },

  onMore() {
    if (!this.data.hasMore) return;
    this.loadBatch(false);
  },

  onRestart() {
    this.loadBatch(true);
  },

  onTapBook(e) {
    const { id } = e.currentTarget.dataset;
    wx.navigateTo({ url: '/pages/book-detail/index?id=' + id });
  }
});
