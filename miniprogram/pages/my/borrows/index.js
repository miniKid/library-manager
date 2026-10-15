const services = require('../../../services/index');
const { hashColor, formatDate } = require('../../../utils/util');
const { BORROW_STATUS } = require('../../../utils/constants');

const STATUS_MAP = {
  [BORROW_STATUS.PENDING]: { text: '待确认借出', cls: 'tag-orange' },
  [BORROW_STATUS.BORROWING]: { text: '借出中', cls: 'tag-blue' },
  [BORROW_STATUS.RETURN_REQUESTED]: { text: '待确认归还', cls: 'tag-orange' },
  [BORROW_STATUS.OVERDUE]: { text: '已逾期', cls: 'tag-red' },
  [BORROW_STATUS.RETURNED]: { text: '已归还', cls: 'tag-green' },
  [BORROW_STATUS.CANCELLED]: { text: '已取消', cls: 'tag-gray' }
};

Page({
  data: {
    borrows: [],
    loading: false
  },

  onShow() {
    this.loadBorrows();
  },

  async loadBorrows() {
    const app = getApp();
    if (!app.globalData.userInfo) {
      this.setData({ borrows: [] });
      return;
    }
    this.setData({ loading: true });
    const [list, settings] = await Promise.all([
      services.getMyBorrows(app.globalData.userInfo),
      services.getSettings()
    ]);
    const maxRenew = settings && settings.renewTimes !== undefined ? Number(settings.renewTimes) : 1;
    const mapped = list.map((r) => {
      const renewCount = Number(r.renewCount) || 0;
      const canRenew = r.status === BORROW_STATUS.BORROWING && renewCount < maxRenew;
      const renewTip = maxRenew > 0 ? `已续借 ${renewCount}/${maxRenew} 次` : '';
      return {
        ...r,
        coverBg: hashColor(r.bookTitle),
        statusInfo: STATUS_MAP[r.status] || STATUS_MAP[BORROW_STATUS.BORROWING],
        returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
        renewCount,
        canRenew,
        renewTip
      };
    });
    this.setData({ borrows: mapped, loading: false });
  }
});
