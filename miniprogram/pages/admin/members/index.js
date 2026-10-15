const services = require('../../../services/index');
const { ROLE, CARD_STATUS } = require('../../../utils/constants');
const { formatDate } = require('../../../utils/util');

Page({
  data: {
    users: [],
    filtered: [],
    loading: false,
    loadingMore: false,
    hasMore: false,
    total: 0,
    page: 1,
    pageSize: 20,
    selfOpenid: '',
    keyword: '',
    activeFilter: '',
    filters: [
      { key: '', label: '全部' },
      { key: 'reader', label: '读者' },
      { key: 'admin', label: '管理员' },
      { key: 'pending', label: '借书证申请' }
    ]
  },

  onShow() {
    const app = getApp();
    const self = app.globalData.userInfo || {};
    this.setData({ selfOpenid: self.openid || '', keyword: '' });
    this.loadUsers(true);
  },

  fmtTs(v) {
    if (!v) return '';
    const d = new Date(v);
    if (isNaN(d.getTime())) return '';
    return formatDate(d);
  },

  async loadUsers(reset = true) {
    const page = reset ? 1 : this.data.page + 1;
    const base = reset ? [] : this.data.users;
    this.setData({ loading: reset, loadingMore: !reset, page });
    const role = this.data.activeFilter === 'admin' ? ROLE.ADMIN
      : this.data.activeFilter === 'reader' ? ROLE.USER : '';
    const cardStatus = this.data.activeFilter === 'pending' ? CARD_STATUS.PENDING : '';
    const res = await services.getUsers({
      keyword: this.data.keyword.trim(),
      role,
      cardStatus,
      page,
      pageSize: this.data.pageSize
    });
    const list = (res && res.list) || [];
    const total = (res && res.total) || 0;
    const users = base.concat(list.map((u) => this.mapUser(u)));
    this.setData({
      users,
      filtered: users,
      loading: false,
      loadingMore: false,
      hasMore: users.length < total,
      total
    });
  },

  mapUser(u) {
    const isAdmin = u.role === ROLE.ADMIN;
    const card = u.card || {};
    // 借书证按其真实状态展示：管理员身份只是叠加的管理权限，不豁免借书证规则
    const status = card.status || CARD_STATUS.NONE;
    let cardText = '';
    let cardDesc = '';
    if (status === CARD_STATUS.PENDING) {
      cardText = '待审批';
      cardDesc = '申请借书证：手机号 ' + (card.phone || '') + ' · ' + (card.location || '') + ' · 申请于 ' + this.fmtTs(card.applyDate);
    } else if (status === CARD_STATUS.ACTIVE) {
      cardText = '已开通';
      const idText = card.phone ? '手机号 ' + card.phone + ' · ' : '';
      cardDesc = idText + '仅可借「' + (card.location || '') + '」馆藏';
    } else if (status === CARD_STATUS.REJECTED) {
      cardText = '已驳回';
      cardDesc = (card.rejectReason || '资料不符合要求') + '（可重新申请）';
    } else {
      cardText = '未开通';
      cardDesc = '尚未申请借书证，仅可浏览';
    }
    return {
      _id: u._id,
      openid: u.openid,
      nickname: u.nickname || '微信用户',
      avatarUrl: u.avatarUrl || '',
      isAdmin,
      isSelf: u.openid === this.data.selfOpenid,
      cardStatus: status,
      cardText,
      cardDesc,
      coverChar: (u.nickname || '微').charAt(0)
    };
  },

  onReachBottom() {
    if (this.data.hasMore && !this.data.loading && !this.data.loadingMore) {
      this.loadUsers(false);
    }
  },

  onFilter(e) {
    const key = e.currentTarget.dataset.key || '';
    this.setData({ activeFilter: key }, () => this.loadUsers(true));
  },

  onKeywordInput(e) {
    this.setData({ keyword: e.detail.value });
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => this.loadUsers(true), 400);
  },

  onSearch() {
    if (this.timer) clearTimeout(this.timer);
    this.loadUsers(true);
  },

  onClearKeyword() {
    this.setData({ keyword: '' }, () => this.loadUsers(true));
  },

  confirmAction(content, handler) {
    wx.showModal({
      title: '操作确认',
      content,
      success: async (res) => {
        if (!res.confirm) return;
        wx.showLoading({ title: '处理中' });
        const result = await handler();
        wx.hideLoading();
        if (result && result.ok) {
          wx.showToast({ title: '已更新', icon: 'success' });
          this.loadUsers();
        } else {
          wx.showToast({ title: (result && result.msg) || '操作失败', icon: 'none' });
        }
      }
    });
  },

  // 通过借书证申请
  onApprove(e) {
    const { id, nickname } = e.currentTarget.dataset;
    this.confirmAction('确定通过「' + nickname + '」的借书证申请吗？', () =>
      services.approveCard(id)
    );
  },

  // 驳回借书证申请
  onReject(e) {
    const { id, nickname } = e.currentTarget.dataset;
    this.confirmAction('确定驳回「' + nickname + '」的借书证申请吗？（用户可重新申请）', () =>
      services.rejectCard(id)
    );
  },

  // 剔除借书证（清理僵尸用户）：删除其全部关联借阅数据
  onRemoveCard(e) {
    const { id, nickname } = e.currentTarget.dataset;
    this.confirmAction('确定移除「' + nickname + '」的借书证吗？将删除该用户全部关联借阅数据，且须其无未归还借阅。', () =>
      services.removeCard(id)
    );
  },

  // 升格为管理员
  onPromote(e) {
    const { id, nickname } = e.currentTarget.dataset;
    this.confirmAction('确定将「' + nickname + '」升格为管理员吗？升格后可管理后台。', () =>
      services.promoteAdmin(id)
    );
  },

  // 降级为普通读者
  onDemote(e) {
    const { id, nickname } = e.currentTarget.dataset;
    this.confirmAction('确定将管理员「' + nickname + '」降级为普通用户吗？', () =>
      services.demoteAdmin(id)
    );
  }
});
