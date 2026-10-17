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
const rangeUtil = require('../utils/analytics-range');

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
  const db = ensureCollections(getDb());
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  // 管理员亦须遵循借书证规则，其申请同样可被审批
  if (!user.card || user.card.status !== CARD_STATUS.PENDING) {
    return { ok: false, msg: '该用户当前没有待审批的借书证申请' };
  }
  user.card.status = CARD_STATUS.ACTIVE;
  user.card.auditDate = Date.now();
  user.card.rejectReason = '';
  // 与云端 borrowManager 保持一致：审批结果同步写一条站内通知
  pushMockNotice(
    db,
    user.openid,
    'card',
    '借书证已开通',
    `你的借书证已开通（归属馆藏：${user.card.location || '—'}），现在可以借书了。`,
    '/pages/my/index',
    'success'
  );
  saveDb(db);
  return { ok: true };
}

/** 管理员：驳回某用户的借书证申请 */
async function rejectCard(userId, reason) {
  const db = ensureCollections(getDb());
  const user = db.users.find((u) => u._id === userId);
  if (!user) return { ok: false, msg: '用户不存在' };
  if (!user.card || user.card.status !== CARD_STATUS.PENDING) {
    return { ok: false, msg: '该用户当前没有待审批的借书证申请' };
  }
  user.card.status = CARD_STATUS.REJECTED;
  user.card.auditDate = Date.now();
  user.card.rejectReason = (reason && String(reason).trim()) || '资料不符合要求';
  pushMockNotice(
    db,
    user.openid,
    'card',
    '借书证申请被驳回',
    `驳回原因：${user.card.rejectReason}。补全资料后可重新申请。`,
    '/pages/my/index',
    'warning'
  );
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
  const db = ensureCollections(getDb());
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
  // 与云端一致：确认借出后写一条「借阅成功」站内通知
  pushMockNotice(
    db,
    record.userId,
    'borrow',
    '借阅成功',
    `《${record.bookTitle || book.title}》已借出，请于 ${formatDate(record.dueDate)} 前归还。`,
    '/pages/my/borrows/index',
    'success'
  );
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
async function getUsers({ keyword = '', role = '', cardStatus = '', page = 1, pageSize = 20 } = {}) {
  const db = getDb();
  let list = db.users.slice();
  if (role) list = list.filter((u) => u.role === role);
  if (cardStatus) list = list.filter((u) => (u.card && u.card.status) === cardStatus);
  if (keyword) {
    const kw = String(keyword).trim().toLowerCase();
    if (kw) list = list.filter((u) => (u.nickname || '').toLowerCase().indexOf(kw) !== -1);
  }
  const total = list.length;
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  list = list
    .sort((a, b) => new Date(b.createdAt || 0) - new Date(a.createdAt || 0))
    .slice((p - 1) * size, p * size);
  return { list, total };
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

/** 管理员手动发送「逾期提醒」（模拟模式无真实订阅，直接返回成功） */
async function sendOverdueRemind(borrowId) {
  const db = ensureCollections(getDb());
  const record = db.borrows.find((r) => r._id === borrowId);
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  if (!record.userId) return { ok: false, msg: '该记录缺少借阅人信息' };
  const days = Math.max(0, Math.ceil((Date.now() - new Date(record.dueDate).getTime()) / 86400000));
  // 模拟层没有订阅消息，只写站内通知（云端两者都发）
  pushMockNotice(
    db,
    record.userId,
    'overdue',
    `《${record.bookTitle || '图书'}》已逾期 ${days} 天`,
    '请尽快提交还书申请，逾期会影响信用',
    '/pages/my/borrows/index',
    'danger'
  );
  record.reminded = true;
  saveDb(db);
  return { ok: true };
}

/* ==================================================================
 * 第二期：通知 / 待办 / 书评 / 统计导出 / 推荐
 * 与 cloud.js 保持同名同签名；云端有权限校验，这里为本地体验简化
 * ================================================================== */

const DEFAULT_PREFS = { borrow: true, due: true, overdue: true, card: true, system: true, review: true };

function ensureCollections(db) {
  ['reviews', 'notifications', 'todos', 'noticeLogs'].forEach((k) => {
    if (!Array.isArray(db[k])) db[k] = [];
  });
  return db;
}

/** 写站内通知：等价于云函数的 pushNotice，同样遵守 users.notifyPrefs 开关 */
function pushMockNotice(db, toOpenid, type, title, content, link, level) {
  if (!toOpenid) return;
  const u = (db.users || []).find((x) => x.openid === toOpenid);
  const prefs = (u && u.notifyPrefs) || {};
  if (prefs[type] === false) return;
  db.notifications.push({
    _id: genId('nt'),
    toOpenid,
    type,
    title,
    content: content || '',
    link: link || '',
    level: level || 'info',
    read: false,
    readAt: null,
    senderOpenid: 'system',
    senderName: '图书馆',
    createdAt: Date.now()
  });
}

function meUser(db) {
  const openid = currentSessionOpenid();
  return (db.users || []).find((u) => u.openid === openid) || null;
}

function isAdminMe(db) {
  const u = meUser(db);
  return !!(u && u.role === ROLE.ADMIN);
}

function nowStr() {
  return formatCST(Date.now(), true);
}

/* ---------------- 通知 ---------------- */

async function getNotifications(options) {
  const { page = 1, pageSize = 20, onlyUnread = false } = options || {};
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  let list = (db.notifications || []).filter((n) => n.toOpenid === openid);
  if (onlyUnread) list = list.filter((n) => !n.read);
  list.sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
  const total = list.length;
  const pageList = list.slice((page - 1) * pageSize, page * pageSize).map((n) => ({
    _id: n._id,
    type: n.type,
    title: n.title,
    content: n.content,
    link: n.link,
    level: n.level || 'info',
    read: !!n.read,
    senderName: n.senderName || '',
    createdAtText: formatCST(n.createdAt, true)
  }));
  return { list: pageList, total, page, pageSize };
}

async function getUnreadNotifCount() {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  return (db.notifications || []).filter((n) => n.toOpenid === openid && !n.read).length;
}

async function markNotifRead(id) {
  const db = ensureCollections(getDb());
  const n = (db.notifications || []).find((x) => x._id === id);
  if (!n) return { ok: false, msg: '通知不存在' };
  n.read = true;
  n.readAt = Date.now();
  saveDb(db);
  return { ok: true };
}

async function markAllNotifRead() {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  let n = 0;
  (db.notifications || []).forEach((x) => {
    if (x.toOpenid === openid && !x.read) {
      x.read = true;
      x.readAt = Date.now();
      n++;
    }
  });
  saveDb(db);
  return { ok: true, data: { updated: n } };
}

async function getNotifyPrefs() {
  const db = ensureCollections(getDb());
  const u = meUser(db);
  return Object.assign({}, DEFAULT_PREFS, (u && u.notifyPrefs) || {});
}

async function saveNotifyPrefs(prefs) {
  const db = ensureCollections(getDb());
  const u = meUser(db);
  if (!u) return { ok: false, msg: '请先登录' };
  const next = Object.assign({}, DEFAULT_PREFS, u.notifyPrefs || {});
  Object.keys(DEFAULT_PREFS).forEach((k) => {
    if (k === 'system') return;
    if (prefs && typeof prefs[k] === 'boolean') next[k] = prefs[k];
  });
  u.notifyPrefs = next;
  saveDb(db);
  return { ok: true, data: { prefs: next } };
}

/* ---------------- 待办 ---------------- */

async function getTodos() {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const admin = isAdminMe(db);
  const today = cstTodayStr();
  const system = [];

  if (admin) {
    const cardPending = (db.users || []).filter((u) => u.card && u.card.status === CARD_STATUS.PENDING).length;
    const borrowPending = (db.borrows || []).filter((r) => r.status === BORROW_STATUS.PENDING).length;
    const returnPending = (db.borrows || []).filter((r) => r.status === BORROW_STATUS.RETURN_REQUESTED).length;
    const overdue = (db.borrows || []).filter(
      (r) => r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < today
    ).length;
    if (cardPending) system.push({ id: 'sys-admin-card', type: 'system', title: `有 ${cardPending} 条借书证申请待审批`, desc: '点击进入成员管理处理', level: 'warning', link: '/pages/admin/members/index?tab=pending' });
    if (borrowPending) system.push({ id: 'sys-admin-borrow', type: 'system', title: `有 ${borrowPending} 笔借出待确认`, desc: '线下交收后线上确认', level: 'warning', link: '/pages/admin/borrows/index?status=pending' });
    if (returnPending) system.push({ id: 'sys-admin-return', type: 'system', title: `有 ${returnPending} 笔归还待确认`, desc: '回收后线上确认', level: 'warning', link: '/pages/admin/borrows/index?status=return_requested' });
    if (overdue) system.push({ id: 'sys-admin-overdue', type: 'system', title: `有 ${overdue} 本书已逾期未还`, desc: '可发送逾期提醒', level: 'danger', link: '/pages/admin/borrows/index?status=overdue' });
  } else {
    (db.borrows || [])
      .filter((r) => r.userId === openid && ['pending', 'borrowing', 'return_requested'].indexOf(r.status) >= 0)
      .forEach((r) => {
        const title = r.bookTitle || '图书';
        if (r.status === BORROW_STATUS.BORROWING && r.dueDate) {
          const due = cstDateStr(r.dueDate);
          const left = Math.round((new Date(due + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
          if (left < 0) system.push({ id: 'sys-overdue-' + r._id, type: 'system', title: `《${title}》已逾期 ${-left} 天`, desc: '请尽快提交还书申请', level: 'danger', dueDateText: due, link: '/pages/my/borrows/index' });
          else if (left <= 3) system.push({ id: 'sys-due-' + r._id, type: 'system', title: `《${title}》还有 ${left} 天到期`, desc: '可续借，或按时归还', level: 'warning', dueDateText: due, link: '/pages/my/borrows/index' });
        }
        if (r.status === BORROW_STATUS.RETURN_REQUESTED) system.push({ id: 'sys-ret-' + r._id, type: 'system', title: `《${title}》等待管理员确认归还`, desc: '请按时到馆交接', level: 'info', dueDateText: r.scheduledReturnDate || '', link: '/pages/my/borrows/index' });
        if (r.status === BORROW_STATUS.PENDING && r.scheduledPickupDate) {
          const gap = Math.round((new Date(r.scheduledPickupDate + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
          if (gap <= 1) system.push({ id: 'sys-pick-' + r._id, type: 'system', title: `《${title}》待取书`, desc: gap <= 0 ? '取书日期已到，请到馆领取' : '取书日期是明天', level: 'warning', dueDateText: r.scheduledPickupDate, link: '/pages/my/borrows/index' });
        }
      });
  }

  const mine = (db.todos || []).filter((t) => t.ownerOpenid === openid);
  const active = [];
  const done = [];
  mine.forEach((t) => {
    const item = {
      id: t._id,
      type: 'custom',
      title: t.title,
      desc: t.note || '',
      priority: t.priority || 'normal',
      level: t.priority === 'high' ? 'danger' : t.priority === 'low' ? 'info' : 'warning',
      dueDateText: t.dueDate || '',
      done: !!t.done,
      overdue: !t.done && t.dueDate && t.dueDate < today,
      overdueDays: !t.done && t.dueDate && t.dueDate < today
        ? Math.round((new Date(today + 'T00:00:00Z') - new Date(t.dueDate + 'T00:00:00Z')) / 86400000)
        : 0,
      createdAtText: formatCST(t.createdAt, true)
    };
    (t.done ? done : active).push(item);
  });
  active.sort((a, b) => {
    if (a.dueDateText && b.dueDateText) return a.dueDateText < b.dueDateText ? -1 : 1;
    if (a.dueDateText) return -1;
    if (b.dueDateText) return 1;
    return 0;
  });
  return { isAdmin: admin, system, active, done, today };
}

async function addTodo(data) {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const title = String((data && data.title) || '').trim();
  if (!title) return { ok: false, msg: '请填写待办标题' };
  if (title.length > 30) return { ok: false, msg: '标题最多 30 个字' };
  const activeCount = (db.todos || []).filter((t) => t.ownerOpenid === openid && !t.done).length;
  if (activeCount >= 100) return { ok: false, msg: '未完成待办已达 100 条，请先清理' };
  const todo = {
    _id: genId('td'),
    ownerOpenid: openid,
    title,
    note: String((data && data.note) || '').trim(),
    dueDate: /^\d{4}-\d{2}-\d{2}$/.test((data && data.dueDate) || '') ? data.dueDate : '',
    priority: ['high', 'normal', 'low'].indexOf(data && data.priority) >= 0 ? data.priority : 'normal',
    done: false,
    doneAt: null,
    createdAt: Date.now()
  };
  db.todos.push(todo);
  saveDb(db);
  return { ok: true, data: { id: todo._id } };
}

async function toggleTodo(id, done) {
  const db = ensureCollections(getDb());
  const t = (db.todos || []).find((x) => x._id === id);
  if (!t) return { ok: false, msg: '待办不存在' };
  t.done = typeof done === 'boolean' ? done : !t.done;
  t.doneAt = t.done ? Date.now() : null;
  saveDb(db);
  return { ok: true, data: { done: t.done } };
}

async function removeTodo(id) {
  const db = ensureCollections(getDb());
  const idx = (db.todos || []).findIndex((x) => x._id === id);
  if (idx < 0) return { ok: false, msg: '待办不存在' };
  db.todos.splice(idx, 1);
  saveDb(db);
  return { ok: true };
}

/* ---------------- 管理端群发 ---------------- */

async function sendNotification(data) {
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { ok: false, msg: '无权限执行此操作' };
  const title = String((data && data.title) || '').trim();
  const content = String((data && data.content) || '').trim();
  if (!title) return { ok: false, msg: '请填写通知标题' };
  const type = (data && data.type) || 'system';
  const me = meUser(db);
  let targets = db.users || [];
  if (data && data.scope === 'location' && data.location) {
    targets = targets.filter((u) => u.card && u.card.location === data.location);
  }
  targets = targets.filter((u) => type === 'system' || !(u.notifyPrefs && u.notifyPrefs[type] === false));
  targets.forEach((u) => {
    db.notifications.push({
      _id: genId('nt'),
      toOpenid: u.openid,
      type,
      title,
      content,
      link: (data && data.link) || '',
      level: type === 'system' ? 'info' : 'warning',
      read: false,
      readAt: null,
      senderOpenid: me ? me.openid : '',
      senderName: (me && me.nickname) || '图书馆',
      createdAt: Date.now()
    });
  });
  db.noticeLogs.push({
    _id: genId('nl'),
    senderOpenid: me ? me.openid : '',
    senderName: (me && me.nickname) || '图书馆',
    title,
    content,
    type,
    scope: (data && data.scope) || 'all',
    location: (data && data.location) || '',
    targetCount: targets.length,
    truncated: false,
    createdAt: Date.now()
  });
  saveDb(db);
  return { ok: true, data: { sent: targets.length, truncated: false } };
}

async function getSentNotifications(options) {
  const { page = 1, pageSize = 20 } = options || {};
  const db = ensureCollections(getDb());
  const list = (db.noticeLogs || []).slice().sort((a, b) => b.createdAt - a.createdAt);
  return {
    list: list.slice((page - 1) * pageSize, page * pageSize).map((r) => Object.assign({}, r, { createdAtText: formatCST(r.createdAt, true) })),
    total: list.length,
    page,
    pageSize
  };
}

/* ---------------- 书评 ---------------- */

const REVIEW_BANNED = ['加微信', '代写', '刷单', '博彩', '色情', '贷款', '兼职日结'];

function refreshBookRating(db, bookId) {
  const rows = (db.reviews || []).filter((r) => r.bookId === bookId && r.status === 'approved');
  const book = (db.books || []).find((b) => b._id === bookId);
  if (!book) return;
  book.ratingCount = rows.length;
  book.reviewCount = rows.length;
  book.ratingAvg = rows.length ? Math.round((rows.reduce((s, r) => s + (Number(r.rating) || 0), 0) / rows.length) * 10) / 10 : 0;
}

function shapeReview(r, openid) {
  const anonymous = !!r.anonymous;
  return {
    _id: r._id,
    bookId: r.bookId,
    bookTitle: r.bookTitle || '',
    userName: anonymous ? '匿名读者' : r.userName || '读者',
    avatar: anonymous ? '' : r.avatar || '',
    anonymous,
    rating: Number(r.rating) || 0,
    content: r.content || '',
    likeCount: Number(r.likeCount) || 0,
    liked: (r.likedBy || []).indexOf(openid) >= 0,
    mine: r.openid === openid,
    status: r.status || 'approved',
    reply: r.reply || null,
    replyText: r.reply ? formatCST(r.reply.createdAt, true) : '',
    createdAtText: formatCST(r.createdAt, true),
    edited: !!(r.updatedAt && r.createdAt && r.updatedAt - r.createdAt > 1000)
  };
}

async function getReviews(options) {
  const { bookId, page = 1, pageSize = 10, sort = 'latest' } = options || {};
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const rows = (db.reviews || []).filter((r) => r.bookId === bookId && r.status === 'approved');
  rows.sort((a, b) => (sort === 'helpful' ? (b.likeCount || 0) - (a.likeCount || 0) : b.createdAt - a.createdAt));
  const dist = [0, 0, 0, 0, 0];
  rows.forEach((r) => {
    const i = Math.round(Number(r.rating)) - 1;
    if (i >= 0 && i < 5) dist[i]++;
  });
  const avg = rows.length ? Math.round((rows.reduce((s, r) => s + (Number(r.rating) || 0), 0) / rows.length) * 10) / 10 : 0;
  return {
    list: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => shapeReview(r, openid)),
    total: rows.length,
    page,
    pageSize,
    summary: { count: rows.length, avg, dist }
  };
}

async function getMyReview(bookId) {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const r = (db.reviews || []).find((x) => x.bookId === bookId && x.openid === openid);
  if (!r) return null;
  return { _id: r._id, rating: r.rating, content: r.content, anonymous: !!r.anonymous, status: r.status };
}

async function submitReview(data) {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const bookId = data && data.bookId;
  const book = (db.books || []).find((b) => b._id === bookId);
  if (!book) return { ok: false, msg: '图书不存在' };
  const rating = Math.round(Number(data.rating) || 0);
  if (rating < 1 || rating > 5) return { ok: false, msg: '请先选择 1-5 星评分' };
  const content = String(data.content || '').trim();
  if (content.length < 5) return { ok: false, msg: '评论至少 5 个字' };
  if (content.length > 500) return { ok: false, msg: '评论最多 500 个字' };
  if (REVIEW_BANNED.some((w) => content.indexOf(w) >= 0)) return { ok: false, msg: '内容包含不适合发布的词汇' };
  const me = meUser(db);
  const exist = (db.reviews || []).find((r) => r.bookId === bookId && r.openid === openid);
  if (exist) {
    exist.rating = rating;
    exist.content = content;
    exist.anonymous = !!data.anonymous;
    exist.updatedAt = Date.now();
    if (exist.status === 'hidden') exist.status = 'approved';
    refreshBookRating(db, bookId);
    saveDb(db);
    return { ok: true, data: { id: exist._id, updated: true } };
  }
  const row = {
    _id: genId('rv'),
    bookId,
    bookTitle: book.title,
    openid,
    userName: (me && me.nickname) || '读者',
    avatar: (me && me.avatarUrl) || '',
    anonymous: !!data.anonymous,
    rating,
    content,
    likeCount: 0,
    likedBy: [],
    status: 'approved',
    reply: null,
    createdAt: Date.now(),
    updatedAt: Date.now()
  };
  db.reviews.push(row);
  refreshBookRating(db, bookId);
  saveDb(db);
  return { ok: true, data: { id: row._id, created: true } };
}

async function removeMyReview(bookId) {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const idx = (db.reviews || []).findIndex((r) => r.bookId === bookId && r.openid === openid);
  if (idx < 0) return { ok: false, msg: '评论不存在' };
  db.reviews.splice(idx, 1);
  refreshBookRating(db, bookId);
  saveDb(db);
  return { ok: true };
}

async function likeReview(reviewId) {
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const r = (db.reviews || []).find((x) => x._id === reviewId);
  if (!r) return { ok: false, msg: '评论不存在' };
  if (r.openid === openid) return { ok: false, msg: '不能给自己的评论点赞' };
  r.likedBy = r.likedBy || [];
  const i = r.likedBy.indexOf(openid);
  if (i >= 0) {
    r.likedBy.splice(i, 1);
    r.likeCount = Math.max(0, (r.likeCount || 0) - 1);
  } else {
    r.likedBy.push(openid);
    r.likeCount = (r.likeCount || 0) + 1;
  }
  saveDb(db);
  return { ok: true, data: { liked: i < 0, likeCount: r.likeCount } };
}

async function adminGetReviews(options) {
  const { status = 'all', keyword = '', page = 1, pageSize = 20 } = options || {};
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { list: [], total: 0, msg: '无权限' };
  let rows = (db.reviews || []).slice();
  if (status !== 'all') rows = rows.filter((r) => r.status === status);
  if (keyword) rows = rows.filter((r) => (r.content || '').indexOf(keyword) >= 0);
  rows.sort((a, b) => b.createdAt - a.createdAt);
  return {
    list: rows.slice((page - 1) * pageSize, page * pageSize).map((r) => Object.assign(shapeReview(r, ''), { openid: r.openid })),
    total: rows.length,
    page,
    pageSize
  };
}

async function adminSetReviewStatus(reviewId, status) {
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { ok: false, msg: '无权限执行此操作' };
  const r = (db.reviews || []).find((x) => x._id === reviewId);
  if (!r) return { ok: false, msg: '评论不存在' };
  r.status = status === 'hidden' ? 'hidden' : 'approved';
  refreshBookRating(db, r.bookId);
  saveDb(db);
  return { ok: true };
}

async function adminRemoveReview(reviewId) {
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { ok: false, msg: '无权限执行此操作' };
  const idx = (db.reviews || []).findIndex((x) => x._id === reviewId);
  if (idx < 0) return { ok: false, msg: '评论不存在' };
  const bookId = db.reviews[idx].bookId;
  db.reviews.splice(idx, 1);
  refreshBookRating(db, bookId);
  saveDb(db);
  return { ok: true };
}

async function adminReplyReview(reviewId, content) {
  const db = ensureCollections(getDb());
  const me = meUser(db);
  if (!isAdminMe(db)) return { ok: false, msg: '无权限执行此操作' };
  const text = String(content || '').trim();
  if (!text) return { ok: false, msg: '请填写回复内容' };
  const r = (db.reviews || []).find((x) => x._id === reviewId);
  if (!r) return { ok: false, msg: '评论不存在' };
  r.reply = { content: text, openid: me.openid, createdAt: Date.now() };
  db.notifications.push({
    _id: genId('nt'),
    toOpenid: r.openid,
    type: 'review',
    title: '馆员回复了你的书评',
    content: `《${r.bookTitle}》：${text.slice(0, 40)}`,
    link: `/pages/book-reviews/index?bookId=${r.bookId}`,
    level: 'info',
    read: false,
    readAt: null,
    senderOpenid: me.openid,
    senderName: me.nickname || '馆员',
    createdAt: Date.now()
  });
  saveDb(db);
  return { ok: true };
}

/* ---------------- 统计与导出 ---------------- */

function toCsv(headers, rows) {
  const esc = (v) => {
    const s = v === null || v === undefined ? '' : String(v);
    return /[",\n\r]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s;
  };
  return '\ufeff' + [headers.map(esc).join(',')].concat(rows.map((r) => r.map(esc).join(','))).join('\r\n');
}

async function getUserStats(input) {
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { error: '无权限' };
  // 与书籍统计同一套区间口径：数字 = 近 N 天；{ startDate, endDate } = 自定义（含首含尾）
  const range = rangeUtil.normalizeRange(input);
  const start = range.startMs;
  const endEx = range.endExclusiveMs;
  const users = db.users || [];
  const borrows = (db.borrows || []).filter((r) => r.status !== BORROW_STATUS.CANCELLED);
  const inRange = borrows.filter((r) => {
    const t = new Date(r.borrowDate).getTime();
    return t >= start && t < endEx;
  });
  const newUsers = users.filter((u) => {
    const t = new Date(u.createdAt).getTime();
    return t >= start && t < endEx;
  });

  const byUserId = {};
  inRange.forEach((r) => {
    byUserId[r.userId] = (byUserId[r.userId] || 0) + 1;
  });
  const groups = Object.keys(byUserId).map((k) => ({ id: k, n: byUserId[k] })).sort((a, b) => b.n - a.n);

  const locs = (getSettingsDb(db).locations || []);
  const byLocation = locs.map((loc) => ({ label: loc, value: users.filter((u) => u.card && u.card.location === loc).length })).sort((a, b) => b.value - a.value);

  const activeCards = users.filter((u) => u.card && u.card.status === CARD_STATUS.ACTIVE).length;
  const buckets = [
    { label: '0 次', value: Math.max(0, users.length - groups.length) },
    { label: '1-2 次', value: groups.filter((g) => g.n <= 2).length },
    { label: '3-5 次', value: groups.filter((g) => g.n >= 3 && g.n <= 5).length },
    { label: '6 次以上', value: groups.filter((g) => g.n >= 6).length }
  ];

  return {
    days: range.days,
    range: {
      mode: range.mode,
      days: range.days,
      startDate: range.startDate,
      endDate: range.endDate,
      unit: range.unit,
      unitLabel: range.unitLabel,
      label: range.label,
      notices: range.notices || []
    },
    cards: {
      total: users.length,
      admins: users.filter((u) => u.role === ROLE.ADMIN).length,
      activeCards,
      pendingCards: users.filter((u) => u.card && u.card.status === CARD_STATUS.PENDING).length,
      newUsers: newUsers.length,
      borrowTotal: inRange.length,
      activeBorrowers: groups.length,
      perCapita: groups.length ? Math.round((inRange.length / groups.length) * 10) / 10 : 0
    },
    byLocation,
    roleChart: [
      { label: '普通用户', value: users.filter((u) => u.role !== ROLE.ADMIN).length },
      { label: '管理员', value: users.filter((u) => u.role === ROLE.ADMIN).length }
    ],
    buckets,
    trend: rangeUtil.trendOf(users, range, (u) => u.createdAt),
    topBorrowers: groups.slice(0, 20).map((g) => {
      const u = users.find((x) => x.openid === g.id) || {};
      return {
        openid: g.id,
        nickname: u.nickname || '已注销用户',
        cardStatus: (u.card && u.card.status) || 'none',
        location: (u.card && u.card.location) || '',
        count: g.n
      };
    })
  };
}

async function getBookStats(input) {
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { error: '无权限' };
  const range = rangeUtil.normalizeRange(input);
  const start = range.startMs;
  const endEx = range.endExclusiveMs;
  const books = db.books || [];
  const borrows = (db.borrows || []).filter((r) => r.status !== BORROW_STATUS.CANCELLED);
  const inRange = borrows.filter((r) => {
    const t = new Date(r.borrowDate).getTime();
    return t >= start && t < endEx;
  });

  const cat = {};
  let copies = 0;
  let available = 0;
  let zeroStock = 0;
  books.forEach((b) => {
    const total = sumStocks(b.stocks);
    copies += total;
    const used = borrows.filter((r) => r.bookId === b._id && isActiveStatus(r.status)).length;
    available += Math.max(0, total - used);
    if (total <= 0) zeroStock++;
    cat[b.category || '未分类'] = (cat[b.category || '未分类'] || 0) + 1;
  });

  const locs = getSettingsDb(db).locations || [];
  const byLocation = locs.map((loc) => ({
    label: loc,
    value: books.reduce((s, b) => s + ((b.stocks && Number(b.stocks[loc])) || 0), 0)
  }));

  const hotMap = {};
  inRange.forEach((r) => {
    hotMap[r.bookId] = (hotMap[r.bookId] || 0) + 1;
  });
  let hotBooks = Object.keys(hotMap)
    .map((id) => {
      const b = books.find((x) => x._id === id) || {};
      return { bookId: id, title: b.title || '未知图书', author: b.author || '', count: hotMap[id] };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 20);
  if (!hotBooks.length) {
    hotBooks = books
      .slice()
      .sort((a, b) => (b.borrowCount || 0) - (a.borrowCount || 0))
      .slice(0, 20)
      .map((b) => ({ bookId: b._id, title: b.title, author: b.author, count: b.borrowCount || 0 }));
  }

  const cold = books
    .filter((b) => !b.borrowCount && b.createdAt && new Date(b.createdAt) < new Date(Date.now() - 30 * 86400000))
    .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt))
    .slice(0, 20)
    .map((b) => ({ bookId: b._id, title: b.title, author: b.author, createdAtText: formatCST(b.createdAt) }));

  const dist = [0, 0, 0, 0, 0];
  (db.reviews || []).filter((r) => r.status === 'approved').forEach((r) => {
    const i = Math.round(Number(r.rating)) - 1;
    if (i >= 0 && i < 5) dist[i]++;
  });

  return {
    days: range.days,
    range: {
      mode: range.mode,
      days: range.days,
      startDate: range.startDate,
      endDate: range.endDate,
      unit: range.unit,
      unitLabel: range.unitLabel,
      label: range.label,
      notices: range.notices || []
    },
    cards: {
      kinds: books.length,
      copies,
      available,
      zeroStock,
      newBooks: books.filter((b) => {
        const t = new Date(b.createdAt).getTime();
        return t >= start && t < endEx;
      }).length,
      coldCount: cold.length
    },
    byLocation,
    categoryChart: Object.keys(cat).map((k) => ({ label: k, value: cat[k] })).sort((a, b) => b.value - a.value),
    hotBooks,
    coldBooks: cold,
    ratingChart: dist.map((n, i) => ({ label: i + 1 + ' 星', value: n })),
    trend: rangeUtil.trendOf(books, range, (b) => b.createdAt)
  };
}

async function exportUsersCsv(input) {
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { error: '无权限' };
  const range = rangeUtil.normalizeRange(input);
  const users = db.users || [];
  const borrows = (db.borrows || []).filter((r) => r.status !== BORROW_STATUS.CANCELLED);
  const rows = users.map((u) => {
    const mine = borrows.filter((r) => r.userId === u.openid);
    const last = mine.length ? mine[mine.length - 1].borrowDate : null;
    const inRange = mine.filter((r) => {
      const t = new Date(r.borrowDate).getTime();
      return t >= range.startMs && t < range.endExclusiveMs;
    }).length;
    const card = u.card || {};
    return [
      u.nickname || '',
      u.role === ROLE.ADMIN ? '管理员' : '普通用户',
      card.status === 'active' ? '已开通' : card.status === 'pending' ? '审批中' : card.status === 'rejected' ? '已驳回' : '未申请',
      card.location || '',
      String(card.phone || '').replace(/^(\d{3})\d{4}(\d{4})$/, '$1****$2'),
      formatCST(u.createdAt),
      mine.length,
      inRange,
      last ? formatCST(last) : ''
    ];
  });
  return {
    filename: `用户统计_${range.startDate.replace(/-/g, '')}-${range.endDate.replace(/-/g, '')}.csv`,
    content: toCsv(['昵称', '角色', '借书证状态', '归属馆藏', '手机号', '注册时间', '累计借阅', `区间借阅（${range.label}）`, '最近借阅'], rows),
    rows: rows.length,
    truncated: false
  };
}

async function exportBooksCsv() {
  const db = ensureCollections(getDb());
  if (!isAdminMe(db)) return { error: '无权限' };
  const books = db.books || [];
  const rows = books.map((b) => [
    b.title,
    b.author,
    b.isbn,
    b.category,
    b.publisher,
    b.year,
    sumStocks(b.stocks),
    sumStocks(b.stocks),
    b.borrowCount || 0,
    b.ratingAvg || 0,
    b.ratingCount || 0,
    formatCST(b.createdAt)
  ]);
  return {
    filename: `书籍统计_${cstTodayStr().replace(/-/g, '')}.csv`,
    content: toCsv(['书名', '作者', 'ISBN', '分类', '出版社', '出版年', '馆藏总册', '在架册数', '累计借阅', '平均评分', '评论数', '上架时间'], rows),
    rows: rows.length,
    truncated: false
  };
}

/* ---------------- 推荐 ---------------- */

async function getRecommendations(options) {
  const { limit = 6, offset = 0 } = options || {};
  const db = ensureCollections(getDb());
  const openid = currentSessionOpenid();
  const books = (db.books || []).filter((b) => sumStocks(b.stocks) > 0);
  const myBorrows = (db.borrows || []).filter((r) => r.userId === openid);
  const borrowedIds = myBorrows.map((r) => r.bookId);
  const myReviews = (db.reviews || []).filter((r) => r.openid === openid).map((r) => r.bookId);

  const cat = {};
  const authors = {};
  let totalCat = 0;
  borrowedIds.forEach((id) => {
    const b = books.find((x) => x._id === id);
    if (!b) return;
    if (b.category) {
      cat[b.category] = (cat[b.category] || 0) + 1;
      totalCat++;
    }
    if (b.author) authors[b.author] = true;
  });

  const maxHot = books.reduce((m, b) => Math.max(m, b.borrowCount || 0), 0) || 1;
  const now = Date.now();

  const scored = books
    .filter((b) => borrowedIds.indexOf(b._id) < 0 && myReviews.indexOf(b._id) < 0)
    .map((b) => {
      const catScore = totalCat ? ((cat[b.category] || 0) / totalCat) * 35 : 0;
      const authorScore = authors[b.author] ? 15 : 0;
      const hotScore = ((b.borrowCount || 0) / maxHot) * 20;
      const rating = b.ratingAvg || 3;
      const rateScore = (rating / 5) * 20;
      const age = b.createdAt ? (now - new Date(b.createdAt).getTime()) / 86400000 : 999;
      const newScore = age <= 30 ? 10 : Math.max(0, 10 - (age - 30) / 30);
      const score = catScore + authorScore + hotScore + rateScore + newScore;
      let reason = '新书上架';
      if (catScore > 0 && catScore >= authorScore && catScore >= hotScore) reason = `因为你在读「${b.category}」类`;
      else if (authorScore > 0) reason = `你借过 ${b.author} 的书`;
      else if (hotScore >= rateScore) reason = '本馆热门';
      else if (b.ratingCount) reason = `读者好评 ${rating} 分`;
      return { book: b, score, reason };
    })
    .sort((a, b) => b.score - a.score);

  const authorCount = {};
  const ordered = [];
  scored.forEach((it) => {
    const a = it.book.author || '';
    authorCount[a] = authorCount[a] || 0;
    if (authorCount[a] >= 2) return;
    authorCount[a]++;
    ordered.push(it);
  });
  const slice = ordered.slice(offset, offset + limit);
  return {
    list: slice.map((it) => ({
      _id: it.book._id,
      title: it.book.title,
      author: it.book.author,
      category: it.book.category,
      cover: it.book.cover || '',
      borrowCount: it.book.borrowCount || 0,
      ratingAvg: it.book.ratingAvg || 0,
      ratingCount: it.book.ratingCount || 0,
      reason: it.reason,
      score: Math.round(it.score)
    })),
    total: ordered.length,
    hasMore: offset + limit < ordered.length
  };
}

/** 本地模式无云存储：头像直接沿用本地临时路径 */
async function uploadAvatar(localPath) {
  return localPath;
}

/** CSV 导出与云模式共用同一实现（见 services/export.js） */
async function exportCsv(payload) {
  return require('./export').exportCsv(payload);
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
  saveSchedule,
  sendOverdueRemind,
  // 第二期
  getNotifications,
  getUnreadNotifCount,
  markNotifRead,
  markAllNotifRead,
  getNotifyPrefs,
  saveNotifyPrefs,
  getTodos,
  addTodo,
  toggleTodo,
  removeTodo,
  sendNotification,
  getSentNotifications,
  getReviews,
  getMyReview,
  submitReview,
  removeMyReview,
  likeReview,
  adminGetReviews,
  adminSetReviewStatus,
  adminReplyReview,
  adminRemoveReview,
  getUserStats,
  getBookStats,
  exportUsersCsv,
  exportBooksCsv,
  exportCsv,
  uploadAvatar,
  getRecommendations
};
