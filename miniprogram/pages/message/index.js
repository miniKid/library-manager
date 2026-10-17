const services = require('../../services/index');
const { NOTICE_META } = require('../../utils/constants');

const PAGE_SIZE = 20;

Page({
  data: {
    tab: 'notice',
    logged: false,
    // 通知
    notices: [],
    unread: 0,
    onlyUnread: false,
    page: 1,
    total: 0,
    hasMore: false,
    loadingNotice: false,
    // 待办
    todos: { system: [], active: [], done: [], isAdmin: false },
    loadingTodo: false,
    // 新建待办
    todoSheet: { show: false, title: '', note: '', dueDate: '', priority: 'normal', saving: false },
    priorities: [
      { key: 'high', label: '高' },
      { key: 'normal', label: '普通' },
      { key: 'low', label: '低' }
    ],
    // 通知设置
    prefsSheet: { show: false, list: [], saving: false }
  },

  onLoad(options) {
    this.setData({ tab: options.tab === 'todo' ? 'todo' : 'notice' });
  },

  onShow() {
    const app = getApp();
    const logged = !!(app && app.globalData && app.globalData.userInfo);
    this.setData({ logged });
    if (logged) {
      this.loadUnread();
      if (this.data.tab === 'notice') this.loadNotices(true);
      else this.loadTodos();
    }
  },

  onPullDownRefresh() {
    const done = () => wx.stopPullDownRefresh();
    const p = this.data.tab === 'notice' ? this.loadNotices(true) : this.loadTodos();
    Promise.resolve(p).then(done, done);
  },

  goLogin() {
    wx.navigateTo({ url: '/pages/login/index' });
  },

  onTab(e) {
    const tab = e.currentTarget.dataset.tab;
    if (tab === this.data.tab) return;
    this.setData({ tab });
    if (tab === 'notice') this.loadNotices(true);
    else this.loadTodos();
  },

  /* ---------------- 通知 ---------------- */

  async loadUnread() {
    const count = await services.getUnreadNotifCount();
    this.setData({ unread: count });
  },

  async loadNotices(reset) {
    if (this.data.loadingNotice) return;
    const page = reset ? 1 : this.data.page + 1;
    this.setData({ loadingNotice: true });
    const res = await services.getNotifications({
      page,
      pageSize: PAGE_SIZE,
      onlyUnread: this.data.onlyUnread
    });
    const shaped = (res.list || []).map((n) => {
      const meta = NOTICE_META[n.type] || NOTICE_META.system;
      return Object.assign({}, n, { typeLabel: meta.label, typeColor: meta.color });
    });
    const list = reset ? shaped : this.data.notices.concat(shaped);
    this.setData({
      notices: list,
      page,
      total: res.total || 0,
      hasMore: list.length < (res.total || 0),
      loadingNotice: false
    });
  },

  loadMore() {
    this.loadNotices(false);
  },

  onToggleUnread() {
    this.setData({ onlyUnread: !this.data.onlyUnread }, () => this.loadNotices(true));
  },

  async onMarkAll() {
    const res = await services.markAllNotifRead();
    if (res && res.ok) {
      wx.showToast({ title: '已全部标记为已读', icon: 'none' });
      this.loadNotices(true);
      this.loadUnread();
    } else {
      wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
    }
  },

  async onTapNotice(e) {
    const { id, link } = e.currentTarget.dataset;
    const item = this.data.notices.find((n) => n._id === id);
    if (item && !item.read) {
      await services.markNotifRead(id).catch(() => {});
      this.setData({
        notices: this.data.notices.map((n) => (n._id === id ? Object.assign({}, n, { read: true }) : n)),
        unread: Math.max(0, this.data.unread - 1)
      });
    }
    if (link) {
      const isTab = /^\/pages\/(index|admin|my)\/index$/.test(link);
      if (isTab) wx.switchTab({ url: link });
      else wx.navigateTo({ url: link });
    }
  },

  /* ---------------- 待办 ---------------- */

  async loadTodos() {
    this.setData({ loadingTodo: true });
    const todos = await services.getTodos();
    this.setData({ todos, loadingTodo: false });
  },

  openTodoSheet() {
    this.setData({
      todoSheet: { show: true, title: '', note: '', dueDate: '', priority: 'normal', saving: false }
    });
  },

  closeTodoSheet() {
    this.setData({ 'todoSheet.show': false });
  },

  onTodoInput(e) {
    this.setData({ ['todoSheet.' + e.currentTarget.dataset.field]: e.detail.value });
  },

  onTodoDate(e) {
    this.setData({ 'todoSheet.dueDate': e.detail.value });
  },

  onTodoPriority(e) {
    const key = e.currentTarget.dataset.key;
    this.setData({ 'todoSheet.priority': key });
  },

  async onSaveTodo() {
    const s = this.data.todoSheet;
    if (s.saving) return;
    if (!s.title.trim()) {
      wx.showToast({ title: '请填写标题', icon: 'none' });
      return;
    }
    this.setData({ 'todoSheet.saving': true });
    const res = await services.addTodo({
      title: s.title,
      note: s.note,
      dueDate: s.dueDate,
      priority: s.priority
    });
    this.setData({ 'todoSheet.saving': false });
    if (res && res.ok) {
      this.setData({ 'todoSheet.show': false });
      wx.showToast({ title: '已添加', icon: 'success' });
      this.loadTodos();
    } else {
      wx.showToast({ title: (res && res.msg) || '添加失败', icon: 'none' });
    }
  },

  async onToggleTodo(e) {
    const { id, done } = e.currentTarget.dataset;
    const res = await services.toggleTodo(id, !done);
    if (res && res.ok) this.loadTodos();
    else wx.showToast({ title: (res && res.msg) || '操作失败', icon: 'none' });
  },

  async onRemoveTodo(e) {
    const { id } = e.currentTarget.dataset;
    const confirm = await new Promise((resolve) => {
      wx.showModal({
        title: '删除待办',
        content: '确定删除这条待办吗？',
        success: (r) => resolve(r.confirm),
        fail: () => resolve(false)
      });
    });
    if (!confirm) return;
    const res = await services.removeTodo(id);
    if (res && res.ok) this.loadTodos();
    else wx.showToast({ title: (res && res.msg) || '删除失败', icon: 'none' });
  },

  onTapSystemTodo(e) {
    const { link } = e.currentTarget.dataset;
    if (!link) return;
    if (/^\/pages\/(index|admin|my)\/index$/.test(link)) wx.switchTab({ url: link });
    else wx.navigateTo({ url: link });
  },

  /* ---------------- 通知设置 ---------------- */

  async onOpenPrefs() {
    const prefs = await services.getNotifyPrefs();
    const list = Object.keys(NOTICE_META)
      .filter((k) => k !== 'system')
      .map((k) => ({ key: k, label: NOTICE_META[k].label, on: prefs[k] !== false }));
    this.setData({ prefsSheet: { show: true, list, saving: false } });
  },

  closePrefs() {
    this.setData({ 'prefsSheet.show': false });
  },

  onPrefChange(e) {
    const key = e.currentTarget.dataset.key;
    const value = e.detail.value;
    const list = this.data.prefsSheet.list.map((x) => (x.key === key ? Object.assign({}, x, { on: value }) : x));
    this.setData({ 'prefsSheet.list': list });
  },

  async onSavePrefs() {
    const prefs = {};
    this.data.prefsSheet.list.forEach((x) => {
      prefs[x.key] = x.on;
    });
    const res = await services.saveNotifyPrefs(prefs);
    if (res && res.ok) {
      this.setData({ 'prefsSheet.show': false });
      wx.showToast({ title: '已保存', icon: 'success' });
    } else {
      wx.showToast({ title: (res && res.msg) || '保存失败', icon: 'none' });
    }
  },

  stopBubble() {}
});
