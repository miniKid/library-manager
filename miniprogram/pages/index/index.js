const services = require('../../services/index');
const { hashColor, resolveCloudImage } = require('../../utils/util');
const { normalizeList, toLocalFile } = require('../../utils/cover');
const { normalizeNoticeLink } = require('../../utils/notice-links');

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
    logged: false,
    recommends: [],
    homePopup: null
  },
  timer: null,

  onLoad() {
    const app = getApp();
    this.setData({ logged: !!app.globalData.userInfo });
    this.loadLocations();
    this.loadRecommends();
  },

  /** 首页「为你推荐」：未登录也会返回冷启动结果（热门 + 高分 + 新书） */
  async loadRecommends() {
    try {
      const res = await services.getRecommendations({ limit: 6, offset: 0 });
      const list = (res.list || []).map((b) => ({
        _id: b._id,
        title: b.title,
        reason: b.reason,
        cover: b.cover || '',
        coverBg: hashColor(b.title),
        initial: String(b.title || '书').charAt(0)
      }));
      this.setData({ recommends: list });
    } catch (e) {
      this.setData({ recommends: [] });
    }
  },

  goRecommend() {
    wx.navigateTo({ url: '/pages/recommend/index' });
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
    // 仅登录用户弹出首页公告（全局配置，但按需求只对登录态展示）
    if (this.data.logged) this.loadPopup();
  },

  /** 读取 settings.popup，命中（启用且版本未被本地关闭过）则弹窗 */
  async loadPopup() {
    if (this.data.homePopup) return;
    try {
      const settings = await services.getSettings();
      const p = settings && settings.popup;
      if (!p || !p.enabled) return;
      // 富文本类型已下线：存量 html 配置不再弹出，避免出现空白弹窗
      if (p.type !== 'text' && p.type !== 'image') return;
      const seen = wx.getStorageSync('homePopupSeenVersion') || 0;
      if (Number(p.version) === Number(seen)) return;
      const link = normalizeNoticeLink(p.link);
      let image = '';
      if (p.type === 'image') {
        console.log('[homePopup] 读取配置', { version: p.version, hasBase64: !!p.imageBase64, image: (p.image || '').slice(0, 60) });
        // 优先用随配置入库的 base64，不依赖云存储权限（与 books.cover 同策略）
        if (p.imageBase64) image = await toLocalFile(p.imageBase64, 'home_popup_' + (p.version || 0));
        if (!image) image = await resolveCloudImage(p.image);
        console.log('[homePopup] 最终图片地址', image);
      }
      this.setData({ homePopup: Object.assign({}, p, { link, image }) });
    } catch (e) {
      console.error('[homePopup] 加载失败', e);
    }
  },

  /** 图片真正加载失败时给出可定位日志 */
  onPopupImageError(e) {
    const p = this.data.homePopup;
    console.error('[homePopup] 图片加载失败', p && p.image, e && e.detail);
  },

  /** 关闭弹窗：记录已关闭版本，避免再次弹出 */
  onPopupKnow() {
    const p = this.data.homePopup;
    if (p) wx.setStorageSync('homePopupSeenVersion', Number(p.version) || 0);
    this.setData({ homePopup: null });
  },

  /** 执行跳转：tabBar 页必须走 switchTab，失败时输出可定位日志 */
  goPopupLink(link) {
    const isTab = /^\/pages\/(index|admin|my)\/index$/.test(link);
    if (isTab) {
      wx.switchTab({ url: link, fail: (err) => console.error('[homePopup] switchTab 失败', link, err) });
    } else {
      wx.navigateTo({ url: link, fail: (err) => console.error('[homePopup] navigateTo 失败', link, err) });
    }
  },

  /** 点击卡片 / 跳转键：无跳转目标时保持弹窗，不误关闭 */
  onPopupDetail() {
    const p = this.data.homePopup;
    const link = p && p.link;
    if (!link) return;
    wx.setStorageSync('homePopupSeenVersion', Number(p.version) || 0);
    this.setData({ homePopup: null });
    this.goPopupLink(link);
  },

  /** 图片海报：配置了跳转则点击直接跳转，否则放大预览 */
  onPopupImageTap() {
    const p = this.data.homePopup;
    if (!p) return;
    if (p.link) return this.onPopupDetail();
    if (p.image) {
      wx.previewImage({
        urls: [p.image],
        current: p.image,
        fail: (err) => console.error('[homePopup] previewImage 失败', p.image, err)
      });
    }
  },

  /** 阻止弹窗卡片点击穿透到遮罩层（关闭） */
  noop() {},

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
