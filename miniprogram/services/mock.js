/**
 * 本地模拟模式实现
 * 数据持久化在小程序本地缓存，无需 AppID / 云环境即可完整体验
 * 所有方法与云开发实现保持相同的异步签名
 */
const env = require('../config/env');
const { buildSeed } = require('./data');
const {
  BORROW_STATUS,
  ROLE,
  CARD_STATUS,
  BORROW_DAYS,
  DEFAULT_LOCATIONS,
  DEFAULT_MAX_BORROW,
  DEFAULT_RENEW_TIMES,
  DEFAULT_RENEW_DAYS
} = require('../utils/constants');
const { formatDate, addDays, genId, formatCST, cstDateStr, cstTodayStr } = require('../utils/util');

const DB_KEY = '__mock_db';
const MOCK_OPENID = 'mock_openid_001';

/**
 * 测试用模拟身份（本地模式「我的」页双击身份区域可模拟切换，用于权限测试）。
 * test1：新注册用户（未开通借书证，验证申请与浏览权限）；
 * test2：新注册用户（初始预置一张已开通借书证，验证馆藏借阅范围限制）。
 */
const TEST_ACCOUNTS = [
  { openid: 'mock_test_001', nickname: 'test1', phone: '13800000001', card: null },
  { openid: 'mock_test_002', nickname: 'test2', phone: '13800000002', card: { status: CARD_STATUS.ACTIVE } }
];

function getDb() {
  const db = wx.getStorageSync(DB_KEY);
  if (db && db.books && db.borrows && db.users) return db;
  const seed = buildSeed();
  wx.setStorageSync(DB_KEY, seed);
  return seed;
}

function getSettingsDb(db) {
  if (!db.settings) db.settings = {
    _id: 'global',
    locations: DEFAULT_LOCATIONS,
    borrowDays: BORROW_DAYS,
    maxBorrow: DEFAULT_MAX_BORROW,
    renewTimes: DEFAULT_RENEW_TIMES,
    renewDays: DEFAULT_RENEW_DAYS
  };
  // 兼容本功能上线前的旧本地数据：即使 settings 已存在，也补齐缺失的续借字段
  const s = db.settings;
  if (s.renewTimes === undefined) s.renewTimes = DEFAULT_RENEW_TIMES;
  if (s.renewDays === undefined) s.renewDays = DEFAULT_RENEW_DAYS;
  return s;
}

/** 汇总各地点馆藏总数 */
function sumStocks(stocks) {
  if (!stocks) return 0;
  return Object.keys(stocks).reduce((s, k) => s + (Number(stocks[k]) || 0), 0);
}

/** 是否占用库存 / 限借名额的活跃状态（排除已归还与已取消） */
function isActiveStatus(status) {
  return status !== BORROW_STATUS.RETURNED && status !== BORROW_STATUS.CANCELLED;
}

/** 值班安排存储：存于 settings 管理参数表的 schedules 对象，键为地点名；未配置时默认周一至周五可选 */
function getSchedulesDb(db) {
  const settings = getSettingsDb(db);
  if (!settings.schedules) {
    settings.schedules = {};
    (settings.locations || []).forEach((loc) => {
      settings.schedules[loc] = { weekly: [true, true, true, true, true, false, false], overrides: {} };
    });
    saveDb(db);
  }
  return settings.schedules;
}

/** 地点变更时同步值班配置：新地点补默认规则，已删除地点清理配置 */
function syncSchedules(db) {
  const settings = getSettingsDb(db);
  const locs = settings.locations || [];
  const scheds = getSchedulesDb(db);
  locs.forEach((loc) => {
    if (!scheds[loc]) {
      scheds[loc] = { weekly: [true, true, true, true, true, false, false], overrides: {} };
    }
  });
  Object.keys(scheds).forEach((loc) => {
    if (!locs.includes(loc)) delete scheds[loc];
  });
  saveDb(db);
}

/** 某日期该地点是否有人值班（可选）：优先看 overrides，其次 weekly */
function isScheduledOn(schedule, dateStr) {
  if (!schedule) return false;
  if (schedule.overrides && schedule.overrides[dateStr] !== undefined) {
    return !!schedule.overrides[dateStr];
  }
  const d = new Date(dateStr + 'T00:00:00');
  const idx = d.getDay() === 0 ? 6 : d.getDay() - 1; // 0=周一
  return !!(schedule.weekly && schedule.weekly[idx]);
}

async function getSettings() {
  const db = getDb();
  return Object.assign({}, getSettingsDb(db));
}

async function saveSettings(data) {
  const db = getDb();
  const settings = getSettingsDb(db);
  // 馆藏地点变更：移除前校验库存与未归还借阅，并级联清理书籍库存
  if (Array.isArray(data.locations)) {
    const list = data.locations.map((s) => String(s).trim()).filter(Boolean);
    if (list.length === 0) return { ok: false, msg: '至少保留一个馆藏地点' };
    const removed = (settings.locations || []).filter((l) => list.indexOf(l) === -1);
    for (const loc of removed) {
      const stocked = (db.books || []).filter((b) => b.stocks && Number(b.stocks[loc]) > 0).length;
      if (stocked > 0) {
        return { ok: false, msg: `地点「${loc}」仍有 ${stocked} 本书配置库存，请先调整这些书的馆藏` };
      }
      const lending = (db.borrows || []).filter(
        (r) => r.location === loc && r.status !== BORROW_STATUS.RETURNED && r.status !== BORROW_STATUS.CANCELLED
      ).length;
      if (lending > 0) {
        return { ok: false, msg: `地点「${loc}」仍有 ${lending} 本未归还，暂不能移除` };
      }
    }
    settings.locations = list;
    // 清理被移除地点的书籍库存字段（同步重算总馆藏与状态）
    removed.forEach((loc) => {
      (db.books || []).forEach((b) => {
        if (b.stocks && b.stocks[loc] !== undefined) {
          const rest = Object.assign({}, b.stocks);
          delete rest[loc];
          b.stocks = rest;
          b.stock = sumStocks(rest);
          b.status = (b.stock || 0) > 0 ? 'available' : 'unstocked';
        }
      });
    });
    // 将被移除地点归属的借书证重置为未开通
    removed.forEach((loc) => {
      (db.users || []).forEach((u) => {
        if (u.card && u.card.location === loc) {
          u.card = { status: 'none' };
        }
      });
    });
    // 被移除地点的值班配置由 syncSchedules 在末尾统一清理
  }
  if (data.borrowDays !== undefined) settings.borrowDays = Number(data.borrowDays) || 30;
  if (data.maxBorrow !== undefined) settings.maxBorrow = Number(data.maxBorrow) || 3;
  if (data.renewTimes !== undefined) settings.renewTimes = Math.max(0, Number(data.renewTimes) || 0);
  if (data.renewDays !== undefined) settings.renewDays = Math.max(1, Number(data.renewDays) || 1);
  syncSchedules(db);
  saveDb(db);
  return { ok: true };
}

function saveDb(db) {
  wx.setStorageSync(DB_KEY, db);
}

function safeBook(b) {
  return Object.assign({}, b);
}

function init() {
  getDb(); // 确保种子数据已生成
}

/** 页面无显式身份时的当前会话 openid：跟随 app 全局当前登录用户（本地模拟）；测试环境无 app 则主账号 */
function currentSessionOpenid() {
  try {
    const app = getApp();
    const u = app && app.globalData && app.globalData.userInfo;
    if (u && u.openid) return u.openid;
  } catch (e) {
    // 测试环境无 getApp，回退主账号
  }
  return MOCK_OPENID;
}

/**
 * 登录（本地模拟）：
 * - profile.openid 存在：按该身份登录（测试后门模拟其他身份 / 内部按用户操作）
 * - profile 只带 nickname：登录页流程，回到主账号 MOCK_OPENID
 * - 无参数：跟随当前会话身份（app.globalData 当前用户，页面常规操作）
 * - 主账号：未配置 mockAdminOpenid 且库里还没有管理员时自动成为管理员；
 *   首个管理员创建时默认开通一张归属第一馆藏地点的借书证（管理员不豁免借阅规则，借阅仍限归属馆藏）
 * - 测试身份（test1/test2）：初始 role=user 且无管理权限
 */
async function login(profile) {
  const db = getDb();
  let openid;
  if (profile && profile.openid) {
    openid = profile.openid; // 显式指定身份
  } else if (profile && profile.nickname) {
    openid = currentSessionOpenid(); // 未显式指定身份时跟随当前会话
  } else {
    openid = currentSessionOpenid(); // 跟随会话
  }
  const tpl = TEST_ACCOUNTS.find((t) => t.openid === openid);
  let user = db.users.find((u) => u.openid === openid);
  if (!user) {
    let role = ROLE.USER;
    if (env.mockAdminOpenid && openid === env.mockAdminOpenid) {
      role = ROLE.ADMIN;
    } else if (!env.mockAdminOpenid && openid === MOCK_OPENID && !db.users.some((u) => u.role === ROLE.ADMIN)) {
      role = ROLE.ADMIN;
    }
    user = {
      _id: genId('u'),
      openid,
      nickname: (profile && profile.nickname) || (tpl && tpl.nickname) || '微信用户',
      avatarUrl: (profile && profile.avatarUrl) || '',
      role,
      card: { status: CARD_STATUS.NONE },
      createdAt: Date.now()
    };
    const settings = getSettingsDb(db);
    // 测试身份预置借书证：test2 直接持有一张已开通卡（馆藏归属第一个地点），便于验证借阅范围限制
    if (tpl && tpl.card) {
      user.card = Object.assign(
        { status: CARD_STATUS.ACTIVE, phone: tpl.phone, location: (settings.locations || [])[0] || '' },
        tpl.card
      );
    } else if (role === ROLE.ADMIN) {
      // 首个管理员（系统初始管理员）：管理员身份只是叠加的管理权限，借阅仍须持有效借书证并遵守馆藏范围，
      // 因此创建时默认开通一张归属第一馆藏地点的借书证
      const locs = settings.locations || [];
      user.card = { status: CARD_STATUS.ACTIVE, location: locs[0] || '' };
    }
    db.users.push(user);
    saveDb(db);
  } else {
    if (profile && profile.nickname) {
      user.nickname = profile.nickname;
      if (profile.avatarUrl) user.avatarUrl = profile.avatarUrl;
    }
    // 兼容旧缓存：老用户（含管理员）无借书证字段时补未开通，借阅一律按读者身份走借书证流程
    if (!user.card) {
      user.card = { status: CARD_STATUS.NONE };
    }
    saveDb(db);
  }
  return Object.assign({}, user);
}

/** 更新当前会话用户资料（昵称/头像）：本地模拟按 currentSessionOpenid 找到对应用户并写回，不新建账号 */
async function updateProfile(profile) {
  const db = getDb();
  const openid = currentSessionOpenid();
  const user = db.users.find((u) => u.openid === openid);
  if (!user) return null;
  if (profile && profile.nickname) user.nickname = profile.nickname;
  if (profile && profile.avatarUrl) user.avatarUrl = profile.avatarUrl;
  saveDb(db);
  return Object.assign({}, user);
}

/** 修改借书证归属馆藏（本人）：仅更新 location，不重置审批状态；仅 active/pending 可改 */
async function updateCardLocation(location) {
  const db = getDb();
  const openid = currentSessionOpenid();
  const user = db.users.find((u) => u.openid === openid);
  if (!user) return { ok: false, msg: '用户不存在，请重新登录' };
  const card = user.card || { status: CARD_STATUS.NONE };
  if (card.status !== CARD_STATUS.ACTIVE && card.status !== CARD_STATUS.PENDING) {
    return { ok: false, msg: '当前借书证状态不可修改归属馆藏' };
  }
  const locs = getSettingsDb(db).locations || [];
  if (!location || !locs.includes(location)) return { ok: false, msg: '请选择有效的馆藏地点' };
  if (location === card.location) return { ok: false, msg: '所选馆藏与当前一致' };
  // 切换前须先归还/取消原馆藏的全部借阅（含待确认借出、借出中/已逾期、待确认归还）
  const outstanding = db.borrows.filter((r) =>
    r.userId === openid &&
    r.location === card.location &&
    [BORROW_STATUS.PENDING, BORROW_STATUS.BORROWING, BORROW_STATUS.RETURN_REQUESTED].includes(r.status)
  ).length;
  if (outstanding > 0) {
    return { ok: false, msg: '请先归还/取消原馆藏（' + card.location + '）的全部借阅后再修改地址' };
  }
  user.card.location = location;
  saveDb(db);
  return { ok: true, card: Object.assign({}, user.card) };
}

/** 借书证申请：本人提交（手机号 + 归属馆藏地点）；已提交的申请会被新申请覆盖 */
async function applyCard({ phone, location } = {}, profile) {
  const db = getDb();
  const me = await login(profile);
  // login 返回的是副本，必须写回 db.users 中的原对象
  const user = db.users.find((u) => u.openid === me.openid);
  if (!user) return { ok: false, msg: '用户不存在' };
  // 管理员身份只是叠加的管理权限，借阅仍需持卡：无有效卡时同样可申请开通借书证
  const card = user.card || {};
  if (card.status === CARD_STATUS.ACTIVE) return { ok: false, msg: '您已开通借书证，无需重复申请' };
  if (!phone || !String(phone).trim()) return { ok: false, msg: '请填写手机号' };
  if (!/^1\d{10}$/.test(String(phone).trim())) return { ok: false, msg: '请输入正确的手机号' };
  const locs = getSettingsDb(db).locations || [];
  if (!location || !locs.includes(location)) return { ok: false, msg: '请选择有效的馆藏地点' };
  user.card = {
    status: CARD_STATUS.PENDING,
    phone: String(phone).trim(),
    location,
    applyDate: Date.now()
  };
  saveDb(db);
  return { ok: true, card: Object.assign({}, user.card) };
}

/** 管理员：通过某用户的借书证申请 */
async function approveCard(userId) {
  const db = getDb();
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  // 管理员亦须遵循借书证规则，其申请同样可被审批
  if (!user.card || user.card.status !== CARD_STATUS.PENDING) {
    return { ok: false, msg: '该用户当前没有待审批的借书证申请' };
  }
  user.card.status = CARD_STATUS.ACTIVE;
  user.card.auditDate = Date.now();
  user.card.rejectReason = '';
  saveDb(db);
  return { ok: true };
}

/** 管理员：驳回某用户的借书证申请 */
async function rejectCard(userId, reason) {
  const db = getDb();
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  if (!user.card || user.card.status !== CARD_STATUS.PENDING) {
    return { ok: false, msg: '该用户当前没有待审批的借书证申请' };
  }
  user.card.status = CARD_STATUS.REJECTED;
  user.card.auditDate = Date.now();
  user.card.rejectReason = (reason && String(reason).trim()) || '资料不符合要求';
  saveDb(db);
  return { ok: true };
}

/** 管理员：剔除某用户借书证（清理僵尸用户）——同时删除其全部借阅数据；存在未归还借阅时拒绝 */
async function removeCard(userId) {
  const db = getDb();
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  // 剔除只影响借书证（借阅身份），管理员的 role 不受影响；管理员须持卡方可借阅，同样适用
  const active = db.borrows.find((r) => r.userId === user.openid && isActiveStatus(r.status));
  if (active) return { ok: false, msg: '该用户存在未归还的借阅，请先处理后再剔除' };
  db.borrows = db.borrows.filter((r) => r.userId !== user.openid); // 删除其全部关联借阅数据
  user.card = { status: CARD_STATUS.NONE }; // 可重新申请
  saveDb(db);
  return { ok: true };
}

/** 管理员：将某注册用户升格为管理员（管理员身份叠加在原读者身份上，借书证与馆藏范围保持不变） */
async function promoteAdmin(userId) {
  const db = getDb();
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  if (user.role === ROLE.ADMIN) return { ok: false, msg: '该用户已是管理员' };
  user.role = ROLE.ADMIN; // 仅叠加管理权限，不清卡：有卡保留、无卡则仍为未开通，借阅须先办卡
  saveDb(db);
  return { ok: true };
}

/** 管理员：将某管理员降级为普通用户（保留其原有借书证，若无则未开通，可重新申请） */
async function demoteAdmin(userId) {
  const db = getDb();
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  if (user.role !== ROLE.ADMIN) return { ok: false, msg: '该用户不是管理员' };
  user.role = ROLE.USER;
  if (!user.card) {
    user.card = { status: CARD_STATUS.NONE };
  } else if (user.card.status === CARD_STATUS.NONE) {
    // 保持未开通
  }
  saveDb(db);
  return { ok: true };
}

/** 测试后门：返回本地模式可模拟的身份列表（云模式为空）；含主账号与 test1/test2 */
async function getTestAccounts() {
  const db = getDb();
  const settings = getSettingsDb(db);
  const firstLoc = (settings.locations || [])[0] || '';
  return [
    {
      openid: MOCK_OPENID,
      nickname: '主账号',
      desc: '管理员' + (firstLoc ? '（初始已开通「' + firstLoc + '」馆藏借书证，借阅限该馆藏）' : '')
    },
    { openid: 'mock_test_001', nickname: 'test1', desc: '新注册用户（未开通借书证）' },
    {
      openid: 'mock_test_002',
      nickname: 'test2',
      desc: '已开通借书证' + (firstLoc ? '（仅可借「' + firstLoc + '」馆藏）' : '')
    }
  ];
}

/** 图书列表：支持关键字与分类筛选、分页 */
async function getBooks({ keyword = '', category = '', location = '', page = 1, pageSize = 20 } = {}) {
  const db = getDb();
  let list = db.books.slice();
  if (keyword) {
    const kw = keyword.toLowerCase();
    list = list.filter(
      (b) =>
        b.title.toLowerCase().includes(kw) ||
        b.author.toLowerCase().includes(kw) ||
        (b.isbn && b.isbn.includes(kw))
    );
  }
  if (category) list = list.filter((b) => b.category === category);
  if (location) list = list.filter((b) => Number((b.stocks && b.stocks[location]) || 0) > 0);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const total = list.length;
  const start = (page - 1) * pageSize;
  return { list: list.slice(start, start + pageSize).map(safeBook), total };
}

async function getBook(id) {
  const db = getDb();
  const book = db.books.find((b) => b._id === id);
  return book ? safeBook(book) : null;
}

function getCategories() {
  return require('../utils/constants').CATEGORIES;
}

function getBookByIsbn(isbn) {
  const db = getDb();
  return db.books.find((b) => b.isbn === isbn) || null;
}

async function addBook(data) {
  const db = getDb();
  if (data.isbn) {
    const dup = getBookByIsbn(data.isbn);
    if (dup) {
      return { ok: false, code: 'DUPLICATE', msg: '该 ISBN 已存在', book: safeBook(dup) };
    }
  }
  const stocks = data.stocks || {};
  const total = sumStocks(stocks);
  const book = {
    _id: genId('bk'),
    title: data.title,
    author: data.author,
    isbn: data.isbn || '',
    category: data.category || '其他',
    publisher: data.publisher || '',
    year: data.year || '',
    // 新增图书默认不分配馆藏（stocks 为空），后续在编辑页调整
    stock: total,
    stocks,
    cover: data.cover || '',
    description: data.description || '',
    status: total > 0 ? 'available' : 'unstocked',
    borrowCount: 0,
    createdAt: Date.now()
  };
  db.books.push(book);
  saveDb(db);
  return { ok: true, book: safeBook(book) };
}

async function updateBook(id, data) {
  const db = getDb();
  const idx = db.books.findIndex((b) => b._id === id);
  if (idx < 0) return { ok: false, msg: '图书不存在' };
  if (data.isbn) {
    const dup = getBookByIsbn(data.isbn);
    if (dup && dup._id !== id) return { ok: false, msg: '该 ISBN 已存在' };
  }
  const book = db.books[idx];
  ['title', 'author', 'isbn', 'category', 'publisher', 'year', 'stock', 'cover', 'description'].forEach(
    (k) => {
      if (data[k] !== undefined) book[k] = data[k];
    }
  );
  if (data.stock !== undefined) book.stock = Number(data.stock) || 0;
  if (data.stocks) {
    // 调整馆藏：校验调整后的库存不能低于未归还的借阅数量（按地点 + 总馆藏兜底）
    const stocks = {};
    Object.keys(data.stocks).forEach((k) => {
      stocks[k] = Number(data.stocks[k]) || 0;
    });
    const active = db.borrows.filter((r) => r.bookId === id && r.status !== BORROW_STATUS.RETURNED);
    if (active.length > 0) {
      const byLoc = {};
      active.forEach((r) => {
        const loc = r.location || '';
        byLoc[loc] = (byLoc[loc] || 0) + 1;
      });
      for (const loc of Object.keys(byLoc)) {
        if (loc && (stocks[loc] || 0) < byLoc[loc]) {
          return { ok: false, msg: `馆藏「${loc}」正在借出 ${byLoc[loc]} 本，调整后该地点库存不能低于借出数量` };
        }
      }
      if (sumStocks(stocks) < active.length) {
        return { ok: false, msg: `该图书正在借出 ${active.length} 本，调整后总馆藏不能低于借出数量` };
      }
    }
    const total = sumStocks(stocks);
    book.stocks = stocks;
    book.stock = total;
    book.status = total > 0 ? 'available' : 'unstocked';
  }
  saveDb(db);
  return { ok: true, book: safeBook(book) };
}

async function deleteBook(id) {
  const db = getDb();
  const book = db.books.find((b) => b._id === id);
  if (!book) return { ok: false, msg: '图书不存在' };
  // 有馆藏库存时不允许删除，需先在编辑页将各地点库存调整为 0
  if (sumStocks(book.stocks) > 0) {
    return { ok: false, msg: '该图书仍有馆藏库存，请先在编辑页将各地点库存调整为 0 后再删除' };
  }
  const active = db.borrows.find((r) => r.bookId === id && isActiveStatus(r.status));
  if (active) return { ok: false, msg: '该图书存在未归还的借阅，无法删除' };
  db.books = db.books.filter((b) => b._id !== id);
  saveDb(db);
  return { ok: true };
}

/** 预约借出：用户发起借阅申请（不扣库存），需选择可操作日期，等待管理员确认借出 */
async function borrowBook(bookId, location, pickupDate, profile, subscribedReturn) {
  const db = getDb();
  const book = db.books.find((b) => b._id === bookId);
  if (!book) return { ok: false, msg: '图书不存在' };
  if (!pickupDate || !/^\d{4}-\d{2}-\d{2}$/.test(pickupDate)) return { ok: false, msg: '请选择取书日期' };
  if (pickupDate < formatDate(new Date())) return { ok: false, msg: '不能选择过去的日期' };
  const schedule = getSchedulesDb(db)[location];
  if (!isScheduledOn(schedule, pickupDate)) {
    return { ok: false, msg: `所选日期（${pickupDate}）「${location}」无人值班，请选择其他日期` };
  }
  const user = await login(profile);
  // 借书证权限：管理员身份只是叠加的管理权限，不豁免借阅规则。
  // 所有用户（含管理员）都必须持有效借书证，且只能借其归属馆藏的图书
  const card = user.card || { status: CARD_STATUS.NONE };
  if (card.status !== CARD_STATUS.ACTIVE) {
    if (card.status === CARD_STATUS.PENDING) {
      return { ok: false, msg: '借书证审批中，通过后方可借阅' };
    }
    if (card.status === CARD_STATUS.REJECTED) {
      return { ok: false, msg: '借书证申请被驳回，请在我的页面重新申请后再借阅' };
    }
    return { ok: false, msg: '尚未开通借书证，请先在我的页面申请开通借书证' };
  }
  if (location !== card.location) {
    return { ok: false, msg: `您仅可借阅「${card.location}」馆藏的图书` };
  }
  const stocks = book.stocks || {};
  if (!location || !(stocks[location] > 0)) {
    return { ok: false, msg: '该馆藏地点无可用库存，暂不可借' };
  }
  const settings = getSettingsDb(db);
  const maxBorrow = Number(settings.maxBorrow) || 3;
  const activeCount = db.borrows.filter(
    (r) => r.userId === user.openid && isActiveStatus(r.status)
  ).length;
  if (activeCount >= maxBorrow) return { ok: false, msg: '每人同时最多借阅 ' + maxBorrow + ' 本' };
  // 库存锁定：同书该地点的未归还借阅（含待确认的申请）同样占用库存，防止超售
  const occupied = db.borrows.filter(
    (r) => r.bookId === book._id && r.location === location && isActiveStatus(r.status)
  ).length;
  if ((Number(stocks[location]) || 0) - occupied <= 0) {
    return { ok: false, msg: '该馆藏地点可借库存已被预约，暂不可借' };
  }
  // 同一用户同一本书存在未归还记录时不允许重复申请
  const mine = db.borrows.find(
    (r) => r.bookId === book._id && r.userId === user.openid && isActiveStatus(r.status)
  );
  if (mine) return { ok: false, msg: '你已有该书的借阅或申请记录，请勿重复申请' };
  const borrowId = genId('br');
  db.borrows.push({
    _id: borrowId,
    bookId: book._id,
    bookTitle: book.title,
    bookCover: book.cover,
    location,
    userId: user.openid,
    userName: user.nickname,
    borrowDate: new Date(),      // 申请时间
    scheduledPickupDate: pickupDate, // 预约取书日期
    dueDate: null,               // 确认借出时计算
    returnDate: null,
    subscribedReturn: false, // 借阅申请成功、授权通过后再由 setSubscribedReturn 回写
    status: BORROW_STATUS.PENDING
  });
  saveDb(db);
  return { ok: true, borrowId };
}

/** 借阅申请成功后再回写「是否授权到期提醒」标记 */
function setSubscribedReturn(borrowId, value) {
  const db = getDb();
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  record.subscribedReturn = !!value;
  saveDb(db);
  return { ok: true };
}

/** 管理员确认借出：扣减对应地点库存并生成应还日期 */
async function confirmBorrow(borrowId) {
  const db = getDb();
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  if (record.status !== BORROW_STATUS.PENDING) return { ok: false, msg: '该申请已被处理，请刷新后重试' };
  const book = db.books.find((b) => b._id === record.bookId);
  if (!book) return { ok: false, msg: '图书不存在' };
  const stocks = Object.assign({}, book.stocks || {});
  const loc = record.location || Object.keys(stocks)[0] || '';
  if (!stocks[loc] || stocks[loc] <= 0) return { ok: false, msg: '该馆藏地点暂无可用库存，无法确认借出' };
  stocks[loc] -= 1;
  const left = sumStocks(stocks);
  record.status = BORROW_STATUS.BORROWING;
  record.deliverDate = new Date(); // 交付（确认借出）时间，申请时间 borrowDate 保持不变
  record.dueDate = addDays(new Date(), Number(getSettingsDb(db).borrowDays) || BORROW_DAYS);
  book.stocks = stocks;
  book.stock = left;
  book.status = left > 0 ? 'available' : 'borrowed';
  book.borrowCount = (book.borrowCount || 0) + 1;
  saveDb(db);
  return { ok: true };
}

/** 用户预约还书：需选择可操作日期，等待管理员线下回收确认 */
async function requestReturn(borrowId, returnDate) {
  const db = getDb();
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  if (record.status !== BORROW_STATUS.BORROWING) return { ok: false, msg: '当前状态不能预约还书' };
  if (!returnDate || !/^\d{4}-\d{2}-\d{2}$/.test(returnDate)) return { ok: false, msg: '请选择还书日期' };
  if (returnDate < formatDate(new Date())) return { ok: false, msg: '不能选择过去的日期' };
  const schedule = getSchedulesDb(db)[record.location];
  if (!isScheduledOn(schedule, returnDate)) {
    return { ok: false, msg: `所选日期（${returnDate}）「${record.location}」无人值班，请选择其他日期` };
  }
  record.status = BORROW_STATUS.RETURN_REQUESTED;
  record.scheduledReturnDate = returnDate;
  saveDb(db);
  return { ok: true };
}

/** 借阅人续借：逾期前自主申请，延长应还日期（按馆藏设置续借次数与天数） */
async function renewBorrow(borrowId) {
  const db = getDb();
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  const settings = getSettingsDb(db);
  const maxRenew = Number(settings.renewTimes) || 0;
  const renewDays = Number(settings.renewDays) || 0;
  if (maxRenew <= 0 || renewDays <= 0) return { ok: false, msg: '当前馆藏未开启续借' };
  if (record.status !== BORROW_STATUS.BORROWING) return { ok: false, msg: '仅借出中可续借' };
  if (record.dueDate && cstDateStr(record.dueDate) < cstTodayStr()) return { ok: false, msg: '已逾期，无法续借' };
  const renewCount = Number(record.renewCount) || 0;
  if (renewCount >= maxRenew) return { ok: false, msg: '已达最大续借次数' };
  record.dueDate = addDays(new Date(record.dueDate), renewDays);
  record.renewCount = renewCount + 1;
  record.renewedAt = new Date();
  saveDb(db);
  return { ok: true, dueDate: record.dueDate, renewCount: record.renewCount };
}

/** 值班安排列表（按馆藏地点返回周规则与日期覆盖） */
async function getSchedules() {
  const db = getDb();
  const scheds = getSchedulesDb(db);
  return Object.keys(scheds).map((location) => ({
    location,
    weekly: (scheds[location].weekly || []).slice(),
    overrides: Object.assign({}, scheds[location].overrides || {})
  }));
}

/** 保存某地点值班安排（周规则 + 日期覆盖） */
async function saveSchedule(data) {
  const db = getDb();
  const scheds = getSchedulesDb(db);
  if (!scheds[data.location]) {
    scheds[data.location] = { weekly: [false, false, false, false, false, false, false], overrides: {} };
  }
  if (Array.isArray(data.weekly) && data.weekly.length === 7) {
    scheds[data.location].weekly = data.weekly.map(Boolean);
  }
  if (data.overrides && typeof data.overrides === 'object') {
    scheds[data.location].overrides = Object.assign({}, data.overrides);
  }
  saveDb(db);
  return { ok: true };
}

/** 管理员确认归还（归还到借出时的馆藏地点） */
async function returnBook(borrowId) {
  const db = getDb();
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  if (record.status === BORROW_STATUS.RETURNED) return { ok: false, msg: '该记录已归还' };
  if (record.status !== BORROW_STATUS.RETURN_REQUESTED) return { ok: false, msg: '用户尚未提交归还申请' };
  record.status = BORROW_STATUS.RETURNED;
  record.returnDate = new Date();
  const book = db.books.find((b) => b._id === record.bookId);
  if (book) {
    const stocks = Object.assign({}, book.stocks || {});
    const loc = record.location || Object.keys(stocks)[0] || '';
    if (loc) stocks[loc] = (stocks[loc] || 0) + 1;
    book.stocks = stocks;
    book.stock = sumStocks(stocks);
    book.status = 'available';
  }
  saveDb(db);
  return { ok: true };
}

/** 取消预约借出申请：本人或管理员可取消；仅 pending 状态可取消，取消后为终态 cancelled */
async function cancelBorrow(borrowId, profile) {
  const db = getDb();
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  if (record.status !== BORROW_STATUS.PENDING) return { ok: false, msg: '仅待确认借出的申请可以取消' };
  const user = await login(profile);
  const isOwner = record.userId === user.openid;
  const isAdminUser = user.role === ROLE.ADMIN;
  if (!isOwner && !isAdminUser) return { ok: false, msg: '无权限取消该申请' };
  record.status = BORROW_STATUS.CANCELLED;
  record.cancelDate = new Date();
  saveDb(db);
  return { ok: true };
}

/** 取消预约还书申请：本人或管理员可取消；回到借出中状态，可再次预约还书 */
async function cancelReturn(borrowId, profile) {
  const db = getDb();
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  if (record.status !== BORROW_STATUS.RETURN_REQUESTED) return { ok: false, msg: '当前状态不能取消还书申请' };
  const user = await login(profile);
  const isOwner = record.userId === user.openid;
  const isAdminUser = user.role === ROLE.ADMIN;
  if (!isOwner && !isAdminUser) return { ok: false, msg: '无权限取消该申请' };
  record.status = BORROW_STATUS.BORROWING;
  record.scheduledReturnDate = null;
  saveDb(db);
  return { ok: true };
}

/** 我的借阅 */
async function getMyBorrows(profile) {
  const db = getDb();
  const user = await login(profile);
  return db.borrows
    .filter((r) => r.userId === user.openid)
    .sort((a, b) => new Date(b.borrowDate) - new Date(a.borrowDate))
    .map((r) => ({
      ...r,
      borrowDateText: formatDate(r.borrowDate),
      deliverDateText: r.deliverDate ? formatDate(r.deliverDate) : '',
      dueDateText: formatCST(r.dueDate),
      returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
      scheduledPickupDateText: r.scheduledPickupDate || '',
      scheduledReturnDateText: r.scheduledReturnDate || '',
      status: r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr()
        ? BORROW_STATUS.OVERDUE
        : r.status
    }));
}

/** 各馆藏地点该书的未归还占用数（含待确认申请），用于展示锁定后的可借数量 */
async function getBookOccupied(bookId) {
  const db = getDb();
  const occupied = {};
  db.borrows.forEach((r) => {
    if (r.bookId !== bookId || !isActiveStatus(r.status) || !r.location) return;
    occupied[r.location] = (occupied[r.location] || 0) + 1;
  });
  return occupied;
}

/** 全部借阅（管理端）：支持状态筛选 */
async function getBorrows({ status = '' } = {}) {
  const db = getDb();
  let list = db.borrows.slice();
  if (status) {
    if (status === BORROW_STATUS.OVERDUE) {
      // 逾期是派生状态：借出中且已超过应还日期（仓库内 status 仍为 borrowing），按中国时区判定
      list = list.filter(
        (r) => r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr()
      );
    } else {
      list = list.filter((r) => r.status === status);
    }
  }
  return list
    .sort((a, b) => new Date(b.borrowDate) - new Date(a.borrowDate))
    .map((r) => ({
      ...r,
      borrowDateText: formatDate(r.borrowDate),
      deliverDateText: r.deliverDate ? formatDate(r.deliverDate) : '',
      dueDateText: formatCST(r.dueDate),
      returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
      scheduledPickupDateText: r.scheduledPickupDate || '',
      scheduledReturnDateText: r.scheduledReturnDate || '',
      status: r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr()
        ? BORROW_STATUS.OVERDUE
        : r.status
    }));
}

/** 某本书的全部借阅记录（含未归还），供管理员在详情页查看 */
async function getBorrowsByBook(bookId) {
  if (!bookId) return [];
  const db = getDb();
  const now = Date.now();
  return db.borrows
    .filter((r) => r.bookId === bookId)
    .sort((a, b) => new Date(b.borrowDate) - new Date(a.borrowDate))
    .map((r) => {
      const overdue = r.status === BORROW_STATUS.BORROWING && r.dueDate && new Date(r.dueDate).getTime() < now;
      return {
        ...r,
        status: overdue ? BORROW_STATUS.OVERDUE : r.status,
        borrowDateText: formatDate(r.borrowDate),
        deliverDateText: r.deliverDate ? formatDate(r.deliverDate) : '',
        dueDateText: formatCST(r.dueDate),
        returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
        scheduledPickupDateText: r.scheduledPickupDate || '',
        scheduledReturnDateText: r.scheduledReturnDate ? formatDate(r.scheduledReturnDate) : ''
      };
    });
}

/** 用户列表（管理端） */
async function getUsers() {
  const db = getDb();
  return db.users.slice();
}

/** 设置用户角色 */
async function setUserRole(userId, role) {
  const db = getDb();
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  user.role = role === ROLE.ADMIN ? ROLE.ADMIN : ROLE.USER;
  saveDb(db);
  return { ok: true };
}

/** ISBN 在线查询（本地模拟模式不支持，返回提示） */
async function lookupBook() {
  return { ok: false, msg: '本地模拟模式暂不支持在线查询，请手动填写图书信息' };
}

/** 统计概览（管理端）
 *  口径（与页面卡片文案一致）：
 *  - 借出中 borrowedTotal = borrowing + return_requested（书还在读者手上，含预约还书待确认）
 *  - 待确认 pendingTotal = pending + return_requested（管理员所有待确认处理项）
 *  - 逾期 overdueTotal = 仅 borrowing 且超过应还日期（未借出的 pending 不参与）
 */
async function getStats() {
  const db = getDb();
  const books = db.books;
  const borrows = db.borrows;
  const borrowing = borrows.filter((r) => r.status === BORROW_STATUS.BORROWING);
  const returnRequested = borrows.filter((r) => r.status === BORROW_STATUS.RETURN_REQUESTED);
  const pending = borrows.filter((r) => r.status === BORROW_STATUS.PENDING);
  return {
    bookTotal: books.length,
    availableTotal: books.filter((b) => b.status === 'available').length,
    borrowedTotal: borrowing.length + returnRequested.length,
    overdueTotal: borrowing.filter(
      (r) => r.dueDate && new Date(r.dueDate).getTime() < Date.now()
    ).length,
    pendingTotal: pending.length + returnRequested.length,
    memberTotal: db.users.length,
    borrowTotal: borrows.length
  };
}

module.exports = {
  init,
  login,
  updateProfile,
  applyCard,
  updateCardLocation,
  approveCard,
  rejectCard,
  removeCard,
  promoteAdmin,
  demoteAdmin,
  getTestAccounts,
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
  returnBook,
  getMyBorrows,
  getBorrows,
  getBorrowsByBook,
  getBookOccupied,
  getUsers,
  setUserRole,
  getStats,
  lookupBook,
  getSettings,
  saveSettings,
  getSchedules,
  saveSchedule
};
