module.exports = {
  // 图书状态
  BOOK_STATUS: {
    AVAILABLE: 'available', // 可借
    BORROWED: 'borrowed'    // 借出
  },

  // 借阅状态（借阅需管理员确认的中间状态）
  BORROW_STATUS: {
    PENDING: 'pending',             // 预约借出，等待管理员确认借出
    BORROWING: 'borrowing',         // 借出中
    RETURN_REQUESTED: 'return_requested', // 预约还书，等待管理员确认归还
    RETURNED: 'returned',           // 已归还
    CANCELLED: 'cancelled',         // 已取消（预约借出申请取消后的终态）
    OVERDUE: 'overdue'              // 已逾期（派生状态，借出中且过期）
  },

  // 角色
  ROLE: {
    USER: 'user',
    ADMIN: 'admin'
  },

  // 借书证状态（role=user 的用户须开通借书证后才能借阅对应馆藏的图书）
  CARD_STATUS: {
    NONE: 'none',           // 未申请（初始身份，仅可浏览）
    PENDING: 'pending',     // 申请中，等待管理员审批
    ACTIVE: 'active',       // 已开通，可借阅其归属馆藏的图书
    REJECTED: 'rejected'    // 申请被驳回，可重新申请
  },

  // 单次借阅时长（天）
  BORROW_DAYS: 30,

  // 默认馆藏地点与借阅限制（settings 集合未初始化时兜底）
  DEFAULT_LOCATIONS: ['广州', '西安'],
  DEFAULT_MAX_BORROW: 3,

  // 续借默认配置（settings 集合未初始化时兜底；与 borrowDays / maxBorrow 同机制）
  DEFAULT_RENEW_TIMES: 1, // 默认可续借次数（0 表示关闭续借）
  DEFAULT_RENEW_DAYS: 15, // 默认一次续借延长天数

  // 图书分类
  CATEGORIES: [
    '文学', '小说', '历史', '科技', '计算机', '经济管理',
    '教育', '艺术', '哲学', '心理学', '生活', '少儿', '其他'
  ],

  // 订阅消息模板 ID（公众平台「订阅消息 → 我的模板」中创建，均为一次性订阅）
  // 注意：data 字段名（thing1/date2…）必须与模板关键词完全一致，否则发送报 47003
  TEMPLATE_ID: {
    BORROW_OK: 'gZphulGBNq3xfluQHwHT52nAyhZcU8G5J_QvJlbzQE4',     // 借阅成功通知
    RETURN_REMIND: 'opgxSjtbN8zWIerXYN8fphLzfHmGwhXY13swG9tdBTM',  // 图书到期提醒（定时）
    OVERDUE_REMIND: 'FAPXsyLsQ-cpHvgphgx8eNH-3YJQT2JHM7NwLYRtQmo'  // 逾期提醒（管理员手动触发）
  }
};
