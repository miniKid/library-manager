/**
 * 微信云开发实现
 * 使用云数据库（books / borrows / users）+ 云函数（login / initDB）
 */
const env = require('../config/env');
const { BORROW_STATUS } = require('../utils/constants');
const { formatDate, formatCST, cstDateStr, cstTodayStr } = require('../utils/util');

function db() {
  return wx.cloud.database();
}

function init() {
  if (!wx.cloud) {
    console.error('当前基础库不支持云开发，请确认已使用真实 AppID 并开通云环境');
    return;
  }
  wx.cloud.init({
    env: env.cloudEnv || undefined,
    traceUser: true
  });
}

function handleError(e) {
  console.error('[cloud] ', e);
  return { ok: false, msg: (e && e.errMsg) || e.message || '操作失败' };
}

/** 登录：云函数根据 openid 获取/创建用户，第一个注册用户自动为管理员 */
async function login(profile) {
  const res = await wx.cloud.callFunction({
    name: 'login',
    data: { profile: profile || {} }
  });
  return res.result.user;
}

/** 更新当前用户资料（昵称/头像）：复用 login 云函数，openid 由服务端从 WX 上下文派生，按当前用户更新，不新建账号 */
async function updateProfile(profile) {
  const res = await wx.cloud.callFunction({
    name: 'login',
    data: { profile: profile || {} }
  });
  return res.result.user;
}

/** 修改借书证归属馆藏（本人）：仅更新 location，不重置审批状态 */
async function updateCardLocation(location) {
  const res = await wx.cloud.callFunction({
    name: 'borrowManager',
    data: { action: 'updateCardLocation', location }
  });
  return res.result || { ok: false, msg: '操作失败' };
}

/** 读取全局设置（馆藏地点 / 借期 / 每人限借数）——由云函数读取，客户端权限无限制 */
async function getSettings() {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'getSettings' }
    });
    return (res.result && res.result.data) || {};
  } catch (e) {
    return {};
  }
}

/** 保存全局设置（云函数内校验管理员身份与移除地点的冲突） */
async function saveSettings(data) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'saveSettings', ...data }
    });
    return res.result || { ok: false, msg: '保存失败' };
  } catch (e) {
    return handleError(e);
  }
}

async function getBooks({ keyword = '', category = '', location = '', page = 1, pageSize = 20 } = {}) {
  const d = db();
  const conds = [];
  if (keyword) {
    const reg = d.RegExp({ regexp: keyword, options: 'i' });
    // 搜索书名 / 作者 / ISBN
    conds.push(d.command.or([{ title: reg }, { author: reg }, { isbn: reg }]));
  }
  if (category) conds.push({ category });
  // 按馆藏地点筛选可借：该地点 stocks 大于 0 表示有可借副本
  if (location) conds.push({ ['stocks.' + location]: d.command.gt(0) });
  const where = conds.length === 0 ? {} : conds.length === 1 ? conds[0] : d.command.and(conds);
  const countRes = await d.collection('books').where(where).count();
  const res = await d
    .collection('books')
    .where(where)
    .orderBy('createdAt', 'desc')
    .skip((page - 1) * pageSize)
    .limit(pageSize)
    // 字段投影：列表页不需要大段简介，减小返回体积（封面可能为 base64 大字段）
    .field({
      _id: true,
      title: true,
      author: true,
      isbn: true,
      category: true,
      publisher: true,
      year: true,
      stock: true,
      stocks: true,
      cover: true,
      status: true,
      borrowCount: true,
      createdAt: true
    })
    .get();
  return { list: res.data, total: countRes.total };
}

async function getBook(id) {
  const res = await db().collection('books').doc(id).get();
  return res.data;
}

function getCategories() {
  return require('../utils/constants').CATEGORIES;
}

/** 新增图书（云函数执行，规避客户端写权限限制） */
async function addBook(data) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'addBook', data }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 编辑图书（云函数执行，含馆藏下限校验） */
async function updateBook(id, data) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'updateBook', id, data }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 删除图书（云函数执行，含馆藏与借阅校验） */
async function deleteBook(id) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'deleteBook', id }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 用户发起借阅申请（预约借出，需选择可操作日期；云函数执行） */
async function borrowBook(bookId, location, pickupDate, profile, subscribedReturn) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'borrow', bookId, location, pickupDate, profile: profile || {}, subscribedReturn: !!subscribedReturn }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 借阅申请成功后再回写「是否授权到期提醒」标记 */
async function setSubscribedReturn(borrowId, value) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'setSubscribedReturn', borrowId, value: !!value }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员确认借出（线下交收后线上确认，扣减馆藏库存） */
async function confirmBorrow(borrowId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'confirmBorrow', borrowId }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 用户预约还书（需选择可操作日期，等待管理员线下回收确认） */
async function requestReturn(borrowId, returnDate) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'requestReturn', borrowId, returnDate }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 值班安排列表（按馆藏地点返回周规则与日期覆盖） */
async function getSchedules() {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'getSchedules' }
    });
    return (res.result && res.result.data) || [];
  } catch (e) {
    return [];
  }
}

/** 保存某地点值班安排（管理员；周规则 + 日期覆盖） */
async function saveSchedule(data) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'saveSchedule', ...data }
    });
    return res.result || { ok: false, msg: '保存失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员确认归还（线下回收后线上确认，归还到借出时的馆藏地点） */
async function returnBook(borrowId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'confirmReturn', borrowId }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 取消预约借出申请：本人或管理员可取消；仅 pending 状态可取消，取消后为终态 cancelled */
async function cancelBorrow(borrowId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'cancelBorrow', borrowId }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 取消预约还书申请：本人或管理员可取消；回到借出中状态，可再次预约还书 */
async function cancelReturn(borrowId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'cancelReturn', borrowId }
    });
    return res.result;
  } catch (e) {
    return handleError(e);
  }
}

/** 借阅人续借：逾期前自主申请，延长应还日期（按馆藏设置续借次数与天数） */
async function renewBorrow(borrowId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'renewBorrow', borrowId }
    });
    return res.result || { ok: false, msg: '续借失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员手动发送「逾期提醒」给借阅人（云函数执行，需用户此前已授权） */
async function sendOverdueRemind(borrowId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'sendOverdueRemind', borrowId }
    });
    return res.result || { ok: false, msg: '发送失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 我的借阅：由云函数按当前 openid 查询（客户端无 openid 权限） */
async function getMyBorrows() {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'myBorrows' }
    });
    return Array.isArray(res.result) ? res.result : [];
  } catch (e) {
    return [];
  }
}

async function getBorrows({ status = '' } = {}) {
  const where = {};
  if (status) {
    // 逾期是派生状态：借出中且已超过应还日期，DB 中 status 仍为 borrowing，故按其查询后再过滤
    where.status = status === BORROW_STATUS.OVERDUE ? BORROW_STATUS.BORROWING : status;
  }
  const res = await db()
    .collection('borrows')
    .where(where)
    .orderBy('borrowDate', 'desc')
    .limit(100)
    .get();
  return res.data
    .filter((r) => {
      if (status !== BORROW_STATUS.OVERDUE) return true;
      return r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr();
    })
    .map((r) => {
      const overdue = r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr();
      return {
        ...r,
        status: overdue ? BORROW_STATUS.OVERDUE : r.status,
        borrowDateText: formatDate(r.borrowDate),
        deliverDateText: r.deliverDate ? formatDate(r.deliverDate) : '',
        dueDateText: formatDate(r.dueDate),
        returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
        scheduledPickupDateText: r.scheduledPickupDate ? formatDate(r.scheduledPickupDate) : '',
        scheduledReturnDateText: r.scheduledReturnDate ? formatDate(r.scheduledReturnDate) : ''
      };
    });
}

/** 某本书的全部借阅记录（含未归还），供管理员在详情页查看 */
async function getBorrowsByBook(bookId) {
  if (!bookId) return [];
  const res = await db()
    .collection('borrows')
    .where({ bookId })
    .orderBy('borrowDate', 'desc')
    .limit(100)
    .get();
  return res.data.map((r) => {
    const overdue = r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr();
    return {
      ...r,
      status: overdue ? BORROW_STATUS.OVERDUE : r.status,
      borrowDateText: formatDate(r.borrowDate),
      deliverDateText: r.deliverDate ? formatDate(r.deliverDate) : '',
      dueDateText: formatDate(r.dueDate),
      returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
      scheduledPickupDateText: r.scheduledPickupDate || '',
      scheduledReturnDateText: r.scheduledReturnDate || ''
    };
  });
}

/** 各馆藏地点该书的未归还占用数（含待确认申请），用于展示锁定后的可借数量 */
async function getBookOccupied(bookId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'bookOccupied', bookId }
    });
    return (res.result && res.result.data && res.result.data.occupied) || {};
  } catch (e) {
    return {};
  }
}

/** 用户列表（管理端）：云函数校验管理员后返回，支持关键词/角色/借书证状态过滤与分页 */
async function getUsers({ keyword = '', role = '', cardStatus = '', page = 1, pageSize = 20 } = {}) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'users', keyword, role, cardStatus, page, pageSize }
    });
    const data = (res.result && res.result.data) || {};
    return { list: data.list || [], total: data.total || 0 };
  } catch (e) {
    return { list: [], total: 0 };
  }
}

/** 借书证申请（本人提交手机号与归属馆藏） */
async function applyCard({ phone, location } = {}) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'applyCard', phone, location }
    });
    return res.result || { ok: false, msg: '申请失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员：通过借书证申请 */
async function approveCard(userId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'approveCard', userId }
    });
    return res.result || { ok: false, msg: '操作失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员：驳回借书证申请 */
async function rejectCard(userId, reason) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'rejectCard', userId, reason }
    });
    return res.result || { ok: false, msg: '操作失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员：剔除借书证（删除该用户全部关联借阅数据） */
async function removeCard(userId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'removeCard', userId }
    });
    return res.result || { ok: false, msg: '操作失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员：升格某注册用户为管理员 */
async function promoteAdmin(userId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'promoteAdmin', userId }
    });
    return res.result || { ok: false, msg: '操作失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 管理员：将某管理员降级为普通用户 */
async function demoteAdmin(userId) {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'demoteAdmin', userId }
    });
    return res.result || { ok: false, msg: '操作失败' };
  } catch (e) {
    return handleError(e);
  }
}

/** 测试后门：云模式无本地模拟身份，返回空列表 */
async function getTestAccounts() {
  return [];
}

/** 统计概览（管理端）：走云函数 stats，避免客户端查询条数上限与取数错误 */
async function getStats() {
  try {
    const res = await wx.cloud.callFunction({
      name: 'borrowManager',
      data: { action: 'stats' }
    });
    const data = (res.result && res.result.data) || {};
    return {
      bookTotal: data.bookTotal || 0,
      availableTotal: data.availableTotal || 0,
      borrowedTotal: data.borrowedTotal || 0,
      overdueTotal: data.overdueTotal || 0,
      pendingTotal: data.pendingTotal || 0,
      memberTotal: data.memberTotal || 0,
      borrowTotal: data.borrowTotal || 0
    };
  } catch (e) {
    return {
      bookTotal: 0,
      availableTotal: 0,
      borrowedTotal: 0,
      overdueTotal: 0,
      pendingTotal: 0,
      memberTotal: 0,
      borrowTotal: 0
    };
  }
}

/** ISBN 在线查询图书信息（云函数，封面已转存云存储） */
async function lookupBook(isbn) {
  const res = await wx.cloud.callFunction({
    name: 'lookupBook',
    data: { isbn }
  });
  return res.result;
}

module.exports = {
  init,
  login,
  updateProfile,
  updateCardLocation,
  getBooks,
  getBook,
  getCategories,
  addBook,
  updateBook,
  deleteBook,
  borrowBook,
  setSubscribedReturn,
  confirmBorrow,
  requestReturn,
  cancelBorrow,
  cancelReturn,
  renewBorrow,
  sendOverdueRemind,
  returnBook,
  getMyBorrows,
  getBorrows,
  getBorrowsByBook,
  getBookOccupied,
  getUsers,
  applyCard,
  approveCard,
  rejectCard,
  removeCard,
  promoteAdmin,
  demoteAdmin,
  getTestAccounts,
  getStats,
  lookupBook,
  getSettings,
  saveSettings,
  getSchedules,
  saveSchedule
};
