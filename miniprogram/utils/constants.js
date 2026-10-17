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
  },

  // ===== 第二期：通知 / 待办 / 评论 / 推荐 =====

  // 站内通知类型（与云函数 notifyManager / notify 保持一致）
  NOTICE_TYPE: {
    BORROW: 'borrow',   // 借阅成功 / 借出确认
    DUE: 'due',         // 即将到期
    OVERDUE: 'overdue', // 已逾期
    CARD: 'card',       // 借书证审批结果
    SYSTEM: 'system',   // 管理员群发公告
    REVIEW: 'review'    // 书评被回复
  },

  // 通知类型展示配置：label 用于列表标签，switch 表示用户是否可关闭该类站内通知
  NOTICE_META: {
    borrow: { label: '借阅', color: 'tag-blue', switch: true },
    due: { label: '到期', color: 'tag-orange', switch: true },
    overdue: { label: '逾期', color: 'tag-red', switch: true },
    card: { label: '借书证', color: 'tag-green', switch: true },
    system: { label: '公告', color: 'tag-gray', switch: false },
    review: { label: '书评', color: 'tag-blue', switch: true }
  },

  // 评论状态（先发后审：默认 approved，管理员可置为 hidden）
  REVIEW_STATUS: {
    APPROVED: 'approved',
    HIDDEN: 'hidden'
  },

  REVIEW_MIN_LEN: 5,
  REVIEW_MAX_LEN: 500,
  REVIEW_PAGE_SIZE: 10,

  // 待办优先级
  TODO_PRIORITY: {
    HIGH: 'high',
    NORMAL: 'normal',
    LOW: 'low'
  },

  // 单个用户未完成自定义待办上限
  TODO_MAX_ACTIVE: 100,

  // 通知保留天数 & 群发单次接收者上限
  NOTICE_KEEP_DAYS: 90,
  NOTICE_FANOUT_LIMIT: 500,

  // 统计与导出：默认区间与单次导出行数上限
  STATS_DEFAULT_DAYS: 30,
  EXPORT_MAX_ROWS: 3000,

  // 推荐：候选池上限、作者去重上限
  RECOMMEND_POOL_SIZE: 200,
  RECOMMEND_MAX_PER_AUTHOR: 2
};
