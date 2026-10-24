/**
 * 云函数：borrowManager
 * 借书 / 归还 / 我的借阅
 * 数据库事务（db.runTransaction）仅在服务端可用，故在此实现，保证库存与借阅记录一致。
 * 用户身份以 cloud.getWXContext().OPENID 为准，不信任客户端传入。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const BORROW_STATUS = {
  PENDING: 'pending',
  BORROWING: 'borrowing',
  RETURN_REQUESTED: 'return_requested',
  RETURNED: 'returned',
  CANCELLED: 'cancelled'
};
const ROLE = { ADMIN: 'admin', USER: 'user' };

// 订阅消息模板配置：模板 ID 与「关键词 -> 取值器」字段映射一并放在 settings.global.templates，
// 运行时读取，可在云开发控制台或管理端「设置」页直接改，换模板/换小程序都不必改代码、不必重新部署。
// 仅当 settings 未配置时才回落到仓库内置的示例模板（保证开箱即跑；上线前请替换成自己在「订阅消息」申请的真实模板）。
// 关键词名（thing1/time5…）随模板走，因此是数据；但取值通常要计算（逾期天数、日期格式），故取值逻辑留在代码里。
const DEFAULT_TEMPLATES = {
  borrowOk: {
    templateId: 'gZphulGBNq3xfluQHwHT52nAyhZcU8G5J_QvJlbzQE4', // 借阅成功通知
    fields: { thing1: 'bookTitle', time5: 'deliverDate', time3: 'dueDateFull' }
  },
  returnRemind: {
    templateId: 'opgxSjtbN8zWIerXYN8fphLzfHmGwhXY13swG9tdBTM', // 图书到期提醒（定时）
    fields: { date1: 'dueDate', thing3: 'bookTitle', number2: 'bookId', thing4: 'dueStatus' }
  },
  overdueRemind: {
    templateId: 'FAPXsyLsQ-cpHvgphgx8eNH-3YJQT2JHM7NwLYRtQmo', // 逾期提醒（管理员手动触发）
    fields: { thing1: 'bookTitle', short_thing4: 'overdueDays', thing5: 'overdueTip' }
  }
};

/** 取值器：把取值器名解析为发送给订阅消息的字符串值（值多需计算，故留在代码；关键词名数据化） */
function resolveTmplValue(name, ctx) {
  const r = ctx.record || {};
  switch (name) {
    case 'bookTitle':
      return String(r.bookTitle || '图书').slice(0, 20);
    case 'bookId':
      return r.bookId || '';
    case 'deliverDate':
      return formatDate(r.deliverDate);
    case 'dueDate':
      return formatDate(r.dueDate);
    case 'dueDateFull':
      return formatCST(r.dueDate);
    case 'dueStatus':
      return new Date(r.dueDate) < new Date() ? '已逾期' : '即将到期';
    case 'overdueDays':
      return String(ctx.days != null ? ctx.days : 0);
    case 'overdueTip':
      return '你借出书籍已逾期，请尽快提交还书订单';
    default:
      return '';
  }
}

/** 合并 settings.templates 与默认：settings 缺哪块就用默认，便于增量升级 */
function getTemplate(settings, name) {
  const def = DEFAULT_TEMPLATES[name] || { templateId: '', fields: {} };
  const cfg = ((settings || {}).templates || {})[name] || {};
  return {
    templateId: cfg.templateId || def.templateId,
    fields: cfg.fields || def.fields
  };
}

/** 按模板 fields 把取值器结果组装成 subscribeMessage.send 的 data */
function buildTmplData(tpl, ctx) {
  const data = {};
  const fields = (tpl || {}).fields || {};
  Object.keys(fields).forEach((kw) => {
    data[kw] = { value: String(resolveTmplValue(fields[kw], ctx)) };
  });
  return data;
}
// 订阅消息点击后的跳转版本：默认 'formal'（正式版）；
// 开发/体验阶段在云函数环境变量里配 MP_STATE=developer / trial，不要写死在代码里，
// 否则上线后用户点消息会提示「小程序不存在」。
const MP_STATE = process.env.MP_STATE || 'formal';

/** 汇总各地点馆藏总数 */
function sumStocks(stocks) {
  if (!stocks) return 0;
  return Object.keys(stocks).reduce((s, k) => s + (Number(stocks[k]) || 0), 0);
}

async function getSettings() {
  try {
    const res = await db.collection('settings').doc('global').get();
    const data = res.data || {};
    // 兜底续借默认值：避免旧数据/未配置时客户端 maxRenew=0 导致「申请续借」按钮不显示
    if (data.renewTimes === undefined) data.renewTimes = 1;
    if (data.renewDays === undefined) data.renewDays = 15;
    return data;
  } catch (e) {
    return { renewTimes: 1, renewDays: 15 };
  }
}

/** 是否管理员（用户集合中 openid 对应 role=admin） */
async function isAdmin(openid) {
  if (!openid) return false;
  const r = await db.collection('users').where({ openid, role: ROLE.ADMIN }).count();
  return r.total > 0;
}

/** 读取全局设置（供客户端调用，服务端读取不受集合权限限制） */
async function doGetSettings() {
  return { ok: true, data: await getSettings() };
}

/** 保存全局设置：仅管理员；至少保留一个地点；移除地点前校验库存与未归还借阅 */
async function doSaveSettings(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };

  const oldSettings = await getSettings();
  // 基于完整旧文档合并，避免覆盖 schedules 等字段（set 为整体替换）
  const data = Object.assign({}, oldSettings);
  delete data._id;
  if (Array.isArray(event.locations)) {
    const list = event.locations.map((s) => String(s).trim()).filter(Boolean);
    if (list.length === 0) return { ok: false, msg: '至少保留一个馆藏地点' };
    // 被移除的地点：若有库存或未归还借阅则拒绝移除
    const removed = (oldSettings.locations || []).filter((l) => list.indexOf(l) === -1);
    for (const loc of removed) {
      const stocked = await db
        .collection('books')
        .where({ ['stocks.' + loc]: _.gt(0) })
        .count();
      if (stocked.total > 0) {
        return { ok: false, msg: `地点「${loc}」仍有 ${stocked.total} 本书配置库存，请先调整这些书的馆藏` };
      }
      const lending = await db
        .collection('borrows')
        .where({ location: loc, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
        .count();
      if (lending.total > 0) {
        return { ok: false, msg: `地点「${loc}」仍有 ${lending.total} 本未归还，暂不能移除` };
      }
    }
    data.locations = list;
    // 清理被移除地点的值班配置
    if (data.schedules) {
      removed.forEach((loc) => {
        if (data.schedules[loc]) delete data.schedules[loc];
      });
    }
    // 清理被移除地点的书籍库存字段（前置校验已确保该地点库存为 0）
    for (const loc of removed) {
      await db
        .collection('books')
        .where({ ['stocks.' + loc]: _.exists(true) })
        .update({ data: { ['stocks.' + loc]: _.remove() } });
    }
    // 将被移除地点归属的借书证重置为未开通（前置校验已确保该地点无未归还借阅）
    for (const loc of removed) {
      await db
        .collection('users')
        .where({ 'card.location': loc })
        .update({ data: { card: { status: 'none' } } });
    }
  }
  if (event.borrowDays !== undefined) data.borrowDays = Math.max(1, Number(event.borrowDays) || 30);
  if (event.maxBorrow !== undefined) data.maxBorrow = Math.max(1, Number(event.maxBorrow) || 3);
  if (event.renewTimes !== undefined) data.renewTimes = Math.max(0, Number(event.renewTimes) || 0);
  if (event.renewDays !== undefined) data.renewDays = Math.max(1, Number(event.renewDays) || 15);
  await db.collection('settings').doc('global').set({ data });
  return { ok: true };
}

/** 新增图书：仅管理员；ISBN 查重；默认不分配馆藏 */
async function doAddBook(event) {
  const data = event.data || event;
  if (!data.title) return { ok: false, msg: '请填写书名' };
  if (data.isbn) {
    const dup = await db.collection('books').where({ isbn: data.isbn }).get();
    if (dup.data.length > 0) {
      return { ok: false, code: 'DUPLICATE', msg: '该 ISBN 已存在', book: dup.data[0] };
    }
  }
  const stocks = data.stocks || {};
  const total = sumStocks(stocks);
  const doc = {
    title: data.title,
    author: data.author || '',
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
    createdAt: db.serverDate()
  };
  const res = await db.collection('books').add({ data: doc });
  return { ok: true, book: { _id: res._id, ...doc } };
}

/** 编辑图书：仅管理员；调整馆藏时校验库存不能低于未归还借阅数 */
async function doUpdateBook(event) {
  const { id } = event;
  if (!id) return { ok: false, msg: '参数错误' };
  const data = event.data || event;
  const patch = {};
  ['title', 'author', 'isbn', 'category', 'publisher', 'year', 'stock', 'cover', 'description'].forEach((k) => {
    if (data[k] !== undefined) patch[k] = data[k];
  });
  if (patch.stock !== undefined) patch.stock = Number(patch.stock) || 0;
  if (data.stocks) {
    const stocks = {};
    Object.keys(data.stocks).forEach((k) => {
      stocks[k] = Number(data.stocks[k]) || 0;
    });
    // 校验调整后的库存不能低于未归还的借阅数量（按地点 + 总馆藏兜底）
    const active = await db
      .collection('borrows')
      .where({ bookId: id, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
      .get();
    if (active.data.length > 0) {
      const byLoc = {};
      active.data.forEach((r) => {
        const loc = r.location || '';
        byLoc[loc] = (byLoc[loc] || 0) + 1;
      });
      for (const loc of Object.keys(byLoc)) {
        if (loc && (stocks[loc] || 0) < byLoc[loc]) {
          return { ok: false, msg: `馆藏「${loc}」正在借出 ${byLoc[loc]} 本，调整后该地点库存不能低于借出数量` };
        }
      }
      if (sumStocks(stocks) < active.data.length) {
        return { ok: false, msg: `该图书正在借出 ${active.data.length} 本，调整后总馆藏不能低于借出数量` };
      }
    }
    const total = sumStocks(stocks);
    patch.stocks = stocks;
    patch.stock = total;
    patch.status = total > 0 ? 'available' : 'unstocked';
  }
  await db.collection('books').doc(id).update({ data: patch });
  return { ok: true };
}

/** 删除图书：仅管理员；有馆藏或未归还借阅时拒绝 */
async function doDeleteBook(event) {
  const { id } = event;
  if (!id) return { ok: false, msg: '参数错误' };
  let book = null;
  try {
    const res = await db.collection('books').doc(id).get();
    book = res.data;
  } catch (e) {
    return { ok: false, msg: '图书不存在' };
  }
  if (sumStocks(book.stocks) > 0) {
    return { ok: false, msg: '该图书仍有馆藏库存，请先在编辑页将各地点库存调整为 0 后再删除' };
  }
  const active = await db
    .collection('borrows')
    .where({ bookId: id, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
    .get();
  if (active.data.length > 0) return { ok: false, msg: '该图书存在未归还的借阅，无法删除' };
  await db.collection('books').doc(id).remove();
  return { ok: true };
}

/** 日期加 N 天 */
function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d;
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/** 读取某地点的值班配置（存储于 settings 管理参数表的 schedules 字段，键为地点名） */
async function getSchedule(location) {
  if (!location) return null;
  const settings = await getSettings();
  return (settings.schedules && settings.schedules[location]) || null;
}

/** 某日期（yyyy-MM-dd）该地点是否有人值班（可选）：优先看 overrides，其次 weekly */
function isScheduledOn(schedule, dateStr) {
  if (!schedule) return false;
  if (schedule.overrides && schedule.overrides[dateStr] !== undefined) {
    return !!schedule.overrides[dateStr];
  }
  if (!Array.isArray(schedule.weekly)) return false;
  const d = new Date(dateStr + 'T00:00:00');
  const wd = d.getDay();
  const idx = wd === 0 ? 6 : wd - 1; // 0=周一
  return !!schedule.weekly[idx];
}

/** 值班安排列表（所有人可读，用于预约时选择可操作日期） */
async function doGetSchedules() {
  const settings = await getSettings();
  const schedules = settings.schedules || {};
  const list = Object.keys(schedules).map((location) => ({
    location,
    weekly: (schedules[location].weekly || []).slice(),
    overrides: Object.assign({}, schedules[location].overrides || {})
  }));
  return { ok: true, data: list };
}

/** 保存某地点值班安排（周规则 + 日期覆盖）：仅管理员；写入 settings 管理参数表 */
async function doSaveSchedule(event, openid) {
  if (!(await isAdmin(openid))) return { ok: false, msg: '无权限执行此操作' };
  const { location } = event;
  if (!location) return { ok: false, msg: '参数错误' };
  const settings = await getSettings();
  if (!(settings.locations || []).includes(location)) {
    return { ok: false, msg: '馆藏地点不存在，请先添加' };
  }
  const entry = {};
  if (Array.isArray(event.weekly) && event.weekly.length === 7) {
    entry.weekly = event.weekly.map(Boolean);
  }
  if (event.overrides && typeof event.overrides === 'object') {
    const overrides = {};
    Object.keys(event.overrides).forEach((k) => {
      if (DATE_RE.test(k)) overrides[k] = !!event.overrides[k];
    });
    entry.overrides = overrides;
  }
  // 基于完整旧文档合并后整体写回，保留 locations / borrowDays / maxBorrow 等字段
  const data = Object.assign({}, settings);
  delete data._id;
  data.schedules = Object.assign({}, settings.schedules || {});
  data.schedules[location] = entry;
  await db.collection('settings').doc('global').set({ data });
  return { ok: true };
}

/** 各馆藏地点该书的未归还占用数（含待确认申请），用于用户端展示锁定后的可借数量 */
async function doBookOccupied(event) {
  const { bookId } = event;
  if (!bookId) return { ok: false, msg: '参数错误' };
  const res = await db
    .collection('borrows')
    .where({ bookId, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
    .field({ location: true })
    .limit(1000)
    .get();
  const occupied = {};
  res.data.forEach((r) => {
    if (!r.location) return;
    occupied[r.location] = (occupied[r.location] || 0) + 1;
  });
  return { ok: true, data: { occupied } };
}

/** 预约借出：用户发起借阅申请（不扣库存），需选择可操作日期，等待管理员确认借出 */
async function doBorrow(event, openid) {
  const { bookId, location, pickupDate, profile } = event;
  if (!bookId) return { ok: false, msg: '参数错误' };
  if (!pickupDate || !DATE_RE.test(pickupDate)) return { ok: false, msg: '请选择取书日期' };
  if (pickupDate < formatDate(new Date())) return { ok: false, msg: '不能选择过去的日期' };
  const schedule = await getSchedule(location);
  if (!isScheduledOn(schedule, pickupDate)) {
    return { ok: false, msg: `所选日期（${pickupDate}）「${location}」无人值班，请选择其他日期` };
  }
  const settings = await getSettings();
  const maxBorrow = Number(settings.maxBorrow) || 3;

  // 借书证权限：管理员身份只是叠加的管理权限，不豁免借阅规则。
  // 所有用户（含管理员）都必须持有效借书证，且只能借其归属馆藏的图书
  const meRes = await db.collection('users').where({ openid }).get();
  const me = meRes.data[0];
  if (!me) return { ok: false, msg: '请先登录后再借阅' };
  const card = me.card || { status: 'none' };
  if (card.status !== 'active') {
    if (card.status === 'pending') return { ok: false, msg: '借书证审批中，通过后方可借阅' };
    if (card.status === 'rejected') return { ok: false, msg: '借书证申请被驳回，请在我的页面重新申请后再借阅' };
    return { ok: false, msg: '尚未开通借书证，请先在我的页面申请开通借书证' };
  }
  if (location !== card.location) {
    return { ok: false, msg: `您仅可借阅「${card.location}」馆藏的图书` };
  }

  // 校验图书与该地点当前有可用库存（确认借出时还会二次校验）
  let book = null;
  try {
    const res = await db.collection('books').doc(bookId).get();
    book = res.data;
  } catch (e) {
    return { ok: false, msg: '图书不存在' };
  }
  const stocks = book.stocks || {};
  if (!location || !(stocks[location] > 0)) {
    return { ok: false, msg: '该馆藏地点无可用库存，暂不可借' };
  }
  const active = await db
    .collection('borrows')
    .where({ userId: openid, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
    .count();
  if (active.total >= maxBorrow) return { ok: false, msg: '每人同时最多借阅 ' + maxBorrow + ' 本' };
  // 库存锁定：同书该地点的未归还借阅（含待确认的申请）同样占用库存，防止多人同时申请导致超售
  const occupied = await db
    .collection('borrows')
    .where({ bookId, location, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
    .count();
  if ((Number(stocks[location]) || 0) - occupied.total <= 0) {
    return { ok: false, msg: '该馆藏地点可借库存已被预约，暂不可借' };
  }
  // 同一用户同一本书存在未归还记录时不允许重复申请
  const mine = await db
    .collection('borrows')
    .where({ bookId, userId: openid, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
    .count();
  if (mine.total > 0) return { ok: false, msg: '你已有该书的借阅或申请记录，请勿重复申请' };

  const addRes = await db.collection('borrows').add({
    data: {
      bookId,
      bookTitle: book.title,
      // 不写 bookCover：每条借阅记录复制一份 base64 封面既撑大响应体也没有消费方
      location,
      userId: openid,
      userName: (profile && profile.nickname) || '微信用户',
      borrowDate: db.serverDate(),      // 申请时间
      scheduledPickupDate: pickupDate,  // 预约取书日期
      dueDate: null,                    // 确认借出时计算应还日期
      returnDate: null,
      subscribedReturn: !!event.subscribedReturn, // 用户是否授权了「图书到期提醒」一次性订阅
      status: BORROW_STATUS.PENDING
    }
  });
  return { ok: true, borrowId: addRes._id };
}

/** 借阅申请成功后再回写「是否授权到期提醒」标记（订阅授权需在用户手势后、校验通过后才弹窗） */
async function doSetSubscribedReturn(event, openid) {
  const { borrowId } = event;
  if (!borrowId) return { ok: false, msg: '参数错误' };
  const rec = await db.collection('borrows').doc(borrowId).get().catch(() => null);
  if (!rec || !rec.data) return { ok: false, msg: '借阅记录不存在' };
  if (rec.data.userId !== openid) return { ok: false, msg: '无权限' };
  await db.collection('borrows').doc(borrowId).update({ data: { subscribedReturn: !!event.value } });
  return { ok: true };
}

/** 确认借出：管理员线下交收后线上确认，此时扣减对应地点库存 */
async function doConfirmBorrow(event) {
  const { borrowId } = event;
  if (!borrowId) return { ok: false, msg: '参数错误' };
  const settings = await getSettings();
  const borrowDays = Number(settings.borrowDays) || 30;

  await db.runTransaction(async (transaction) => {
    const res = await transaction.collection('borrows').doc(borrowId).get();
    const record = res.data;
    if (!record) throw new Error('借阅记录不存在');
    if (record.status !== BORROW_STATUS.PENDING) throw new Error('该申请已被处理，请刷新后重试');
    const bookRes = await transaction.collection('books').doc(record.bookId).get();
    const book = bookRes.data;
    const stocks = Object.assign({}, book.stocks || {});
    const loc = record.location || Object.keys(stocks)[0] || '';
    if (!stocks[loc] || stocks[loc] <= 0) throw new Error('该馆藏地点暂无可用库存，无法确认借出');
    stocks[loc] -= 1;
    const left = sumStocks(stocks);
    await transaction.collection('books').doc(record.bookId).update({
      data: { stocks, stock: left, status: left > 0 ? 'available' : 'borrowed', borrowCount: _.inc(1) }
    });
    await transaction.collection('borrows').doc(borrowId).update({
      data: {
        status: BORROW_STATUS.BORROWING,
        deliverDate: db.serverDate(), // 交付（确认借出）时间，申请时间 borrowDate 保持不变
        dueDate: addDays(new Date(), borrowDays)
      }
    });
  });
  // 确认借出成功后，向借书用户推送「借阅成功通知」（一次性订阅，用户已在借阅时授权）
  const rec = (await db.collection('borrows').doc(borrowId).get()).data;
  await sendBorrowOk(rec);
  // 同时写一条站内通知，保证未授权订阅的用户也能在小程序内看到
  await pushNotice(
    rec.userId,
    'borrow',
    '借阅成功',
    `《${rec.bookTitle || '图书'}》已借出，应还日期 ${cstDateStr(rec.dueDate)}`,
    '/pages/my/borrows/index',
    'info'
  );
  return { ok: true };
}

/** 预约还书：用户提交归还申请（需选择可操作日期），等待管理员线下回收后确认 */
async function doRequestReturn(event, openid) {
  const { borrowId, returnDate } = event;
  if (!borrowId) return { ok: false, msg: '参数错误' };
  if (!returnDate || !DATE_RE.test(returnDate)) return { ok: false, msg: '请选择还书日期' };
  if (returnDate < formatDate(new Date())) return { ok: false, msg: '不能选择过去的日期' };
  let record = null;
  try {
    const res = await db.collection('borrows').doc(borrowId).get();
    record = res.data;
  } catch (e) {
    return { ok: false, msg: '借阅记录不存在' };
  }
  if (record.userId !== openid) return { ok: false, msg: '无权限操作该记录' };
  if (record.status !== BORROW_STATUS.BORROWING) {
    return { ok: false, msg: '当前状态不能预约还书' };
  }
  const schedule = await getSchedule(record.location);
  if (!isScheduledOn(schedule, returnDate)) {
    return { ok: false, msg: `所选日期（${returnDate}）「${record.location}」无人值班，请选择其他日期` };
  }
  await db.collection('borrows').doc(borrowId).update({
    data: { status: BORROW_STATUS.RETURN_REQUESTED, scheduledReturnDate: returnDate }
  });
  return { ok: true };
}

/** 取消预约借出申请：本人或管理员可取消；仅 pending 状态可取消，取消后为终态 cancelled */
async function doCancelBorrow(event, openid) {
  const { borrowId } = event;
  if (!borrowId) return { ok: false, msg: '参数错误' };
  let record = null;
  try {
    const res = await db.collection('borrows').doc(borrowId).get();
    record = res.data;
  } catch (e) {
    return { ok: false, msg: '借阅记录不存在' };
  }
  if (record.status !== BORROW_STATUS.PENDING) return { ok: false, msg: '仅待确认借出的申请可以取消' };
  if (record.userId !== openid && !(await isAdmin(openid))) return { ok: false, msg: '无权限取消该申请' };
  await db.collection('borrows').doc(borrowId).update({
    data: { status: BORROW_STATUS.CANCELLED, cancelDate: db.serverDate() }
  });
  return { ok: true };
}

/** 取消预约还书申请：本人或管理员可取消；回到借出中状态，可再次预约还书 */
async function doCancelReturn(event, openid) {
  const { borrowId } = event;
  if (!borrowId) return { ok: false, msg: '参数错误' };
  let record = null;
  try {
    const res = await db.collection('borrows').doc(borrowId).get();
    record = res.data;
  } catch (e) {
    return { ok: false, msg: '借阅记录不存在' };
  }
  if (record.status !== BORROW_STATUS.RETURN_REQUESTED) return { ok: false, msg: '当前状态不能取消还书申请' };
  if (record.userId !== openid && !(await isAdmin(openid))) return { ok: false, msg: '无权限取消该申请' };
  await db.collection('borrows').doc(borrowId).update({
    data: { status: BORROW_STATUS.BORROWING, scheduledReturnDate: null }
  });
  return { ok: true };
}

/** 确认归还：管理员线下回收后线上确认，归还到借出时的馆藏地点 */
async function doConfirmReturn(event) {
  const { borrowId } = event;
  if (!borrowId) return { ok: false, msg: '参数错误' };
  await db.runTransaction(async (transaction) => {
    const res = await transaction.collection('borrows').doc(borrowId).get();
    const record = res.data;
    if (!record) throw new Error('借阅记录不存在');
    if (record.status === BORROW_STATUS.RETURNED) throw new Error('该记录已归还');
    if (record.status !== BORROW_STATUS.RETURN_REQUESTED) throw new Error('用户尚未提交归还申请');
    await transaction.collection('borrows').doc(borrowId).update({
      data: { status: BORROW_STATUS.RETURNED, returnDate: db.serverDate() }
    });
    const bookRes = await transaction.collection('books').doc(record.bookId).get();
    const book = bookRes.data;
    const stocks = Object.assign({}, book.stocks || {});
    const loc = record.location || Object.keys(stocks)[0] || '';
    if (loc) stocks[loc] = (stocks[loc] || 0) + 1;
    await transaction.collection('books').doc(record.bookId).update({
      data: { stocks, stock: sumStocks(stocks), status: 'available' }
    });
  });
  return { ok: true };
}

/** 日期格式化 yyyy-MM-dd。默认按中国时区（UTC+8）展示，与客户端一致 */
function formatDate(date) {
  if (!date) return '';
  const d = toChinaDate(date);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** 默认按中国时区（UTC+8）展示与判定借阅日期；如需多时区可后续扩展 */
const CHINA_OFFSET_MS = 8 * 3600 * 1000;
function toChinaDate(date) {
  return new Date(new Date(date).getTime() + CHINA_OFFSET_MS);
}
function formatCST(date, withTime) {
  if (!date) return '';
  const d = toChinaDate(date);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  const base = `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  return withTime ? `${base} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}` : base;
}
function cstDateStr(date) { return formatCST(date, false); }
function cstTodayStr() { return formatCST(new Date(), false); }

/** 推送「借阅成功通知」给借书用户；失败（如用户未授权 43101）不影响主流程 */
async function sendBorrowOk(record) {
  if (!record || !record.userId) return;
  try {
    const settings = await getSettings();
    const tpl = getTemplate(settings, 'borrowOk');
    await cloud.openapi.subscribeMessage.send({
      touser: record.userId,
      templateId: tpl.templateId,
      page: 'pages/my/index',            // 点击消息进入「我的」页
      miniprogram_state: MP_STATE,
      lang: 'zh_CN',
      // 字段名（thing1/time5/time3…）与取值来自 settings.global.templates.borrowOk，
      // 关键词与你的模板不一致时改 settings 即可，不必改代码
      data: buildTmplData(tpl, { record })
    });
  } catch (e) {
    console.error('[borrowManager] 借阅成功通知发送失败', record._id, (e && e.errCode) || e);
  }
}

/** 写站内通知（notifications 集合仅云函数可写）；失败不影响主流程
 *  通知偏好（users.notifyPrefs）里把该类关掉的用户不再收到，与消息中心的开关保持一致 */
async function pushNotice(toOpenid, type, title, content, link, level) {
  if (!toOpenid) return;
  try {
    const uRes = await db.collection('users').where({ openid: toOpenid }).field({ notifyPrefs: true }).get();
    const prefs = (uRes.data[0] || {}).notifyPrefs || {};
    if (prefs[type] === false) return;
    await db.collection('notifications').add({
      data: {
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
        createdAt: db.serverDate()
      }
    });
  } catch (e) {
    console.error('[borrowManager] 站内通知写入失败', type, toOpenid, (e && e.errCode) || e);
  }
}

/** 管理员手动发送「逾期提醒」给借阅人（新模板 OVERDUE_REMIND，需借阅人此前已授权，可多次授权累加次数）
 *  thing1=书籍名称，short_thing4=逾期天数，thing5=固定文案「你借出书籍已逾期，请尽快提交还书订单」
 *  失败 43101 表示用户未订阅/次数用尽，返回明确提示由前端转达。
 */
async function doSendOverdueRemind(event = {}) {
  const borrowId = event.borrowId;
  if (!borrowId) return { ok: false, msg: '缺少借阅记录 ID' };
  const rec = await db.collection('borrows').doc(borrowId).get();
  const record = rec && rec.data;
  if (!record) return { ok: false, msg: '借阅记录不存在' };
  if (!record.userId) return { ok: false, msg: '该记录缺少借阅人信息' };
  const due = new Date(record.dueDate);
  const days = Math.max(0, Math.ceil((Date.now() - due.getTime()) / 86400000));
  // 无论订阅消息是否成功，先写一条站内通知（订阅额度可能已用完）
  await pushNotice(
    record.userId,
    'overdue',
    `《${record.bookTitle || '图书'}》已逾期 ${days} 天`,
    '请尽快提交还书申请，逾期会影响信用',
    '/pages/my/borrows/index',
    'danger'
  );
  try {
    const settings = await getSettings();
    const tpl = getTemplate(settings, 'overdueRemind');
    await cloud.openapi.subscribeMessage.send({
      touser: record.userId,
      templateId: tpl.templateId,
      page: 'pages/my/index',            // 点击消息进入「我的」页
      miniprogram_state: MP_STATE,
      lang: 'zh_CN',
      // 字段名（thing1/short_thing4/thing5…）与取值来自 settings.global.templates.overdueRemind
      data: buildTmplData(tpl, { record, days })
    });
    return { ok: true };
  } catch (e) {
    const code = e && e.errCode;
    const msg = (e && e.errMsg) || '';
    if (code === 43101 || /43101/.test(msg)) {
      return { ok: false, code: 'NO_GRANT', msg: '该用户未订阅或订阅次数已用完' };
    }
    return { ok: false, msg: '发送失败：' + (msg || code || '未知错误') };
  }
}

/** 我的借阅：按当前用户 openid 查询（借出中且已过应还日期派生为已逾期） */
async function doMyBorrows(openid) {
  if (!openid) return [];
  const res = await db
    .collection('borrows')
    .where({ userId: openid })
    .orderBy('borrowDate', 'desc')
    // 临时限制 100 条：当前「我的借阅」页只展示近期记录，暂不实现分页。
    // 注意：此处无 skip / page，借阅记录超过 100 条时更早的记录会被静默截断；
    // 若将来需要翻看更早记录，再补 page/skip 或按 borrowDate 游标翻页。
    .limit(100)
    .get();
  return res.data.map((r) => {
    const overdue = r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr();
    return {
      ...r,
      status: overdue ? 'overdue' : r.status,
      borrowDateText: formatDate(r.borrowDate),
      deliverDateText: r.deliverDate ? formatDate(r.deliverDate) : '',
      dueDateText: formatCST(r.dueDate),
      returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
      scheduledPickupDateText: r.scheduledPickupDate || '',
      scheduledReturnDateText: r.scheduledReturnDate || ''
    };
  });
}

/** 借阅记录的对外形态：派生逾期状态 + 页面直接可用的文案 */
function decorateBorrow(r) {
  // 注意：逾期是派生值，不落库；BORROW_STATUS 里没有 OVERDUE 键，必须用字面量
  const overdue = r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr();
  const out = {
    ...r,
    status: overdue ? 'overdue' : r.status,
    borrowDateText: formatDate(r.borrowDate),
    deliverDateText: r.deliverDate ? formatDate(r.deliverDate) : '',
    dueDateText: formatCST(r.dueDate),
    returnDateText: r.returnDate ? formatDate(r.returnDate) : '',
    scheduledPickupDateText: r.scheduledPickupDate || '',
    scheduledReturnDateText: r.scheduledReturnDate || ''
  };
  return out;
}

/**
 * 管理端借阅列表（原客户端直读 borrows，已收回云函数：该集合不再对外开放读权限）
 * @param {string} status '' | pending | borrowing | return_requested | returned | cancelled | overdue
 */
async function doAdminBorrows(event = {}) {
  const status = String(event.status || '');
  const where = {};
  if (status) {
    // 逾期是派生状态：库里 status 仍是 borrowing，先按 borrowing 查再按应还日期过滤
    where.status = status === 'overdue' ? BORROW_STATUS.BORROWING : status;
  }
  const size = Math.min(Math.max(parseInt(event.limit, 10) || 100, 1), 100);
  const res = await db
    .collection('borrows')
    .where(where)
    .orderBy('borrowDate', 'desc')
    .limit(size)
    .get();
  let list = res.data;
  if (status === 'overdue') {
    list = list.filter(
      (r) => r.status === BORROW_STATUS.BORROWING && r.dueDate && cstDateStr(r.dueDate) < cstTodayStr()
    );
  }
  return { ok: true, data: list.map(decorateBorrow) };
}

/** 某本书的全部借阅记录（管理端图书详情 → 借阅记录页），同样走云函数 */
async function doBookBorrows(event = {}) {
  const bookId = String(event.bookId || '');
  if (!bookId) return { ok: false, msg: '参数错误' };
  const size = Math.min(Math.max(parseInt(event.limit, 10) || 100, 1), 100);
  const res = await db
    .collection('borrows')
    .where({ bookId })
    .orderBy('borrowDate', 'desc')
    .limit(size)
    .get();
  return { ok: true, data: res.data.map(decorateBorrow) };
}

/** 统计概览（管理端）
 *  口径（与页面卡片文案一致）：
 *  - 借出中 borrowedTotal = borrowing + return_requested（书还在读者手上，含预约还书待确认）
 *  - 待确认 pendingTotal = pending + return_requested（管理员所有待确认处理项）
 *  - 逾期 overdueTotal = 仅 borrowing 且超过应还日期（未借出的 pending 不参与）
 */
async function doGetStats() {
  const [bookTotal, available, borrowing, returnRequested, pending, users, allBorrows, borrowingList] =
    await Promise.all([
      db.collection('books').count(),
      db.collection('books').where({ status: 'available' }).count(),
      db.collection('borrows').where({ status: BORROW_STATUS.BORROWING }).count(),
      db.collection('borrows').where({ status: BORROW_STATUS.RETURN_REQUESTED }).count(),
      db.collection('borrows').where({ status: BORROW_STATUS.PENDING }).count(),
      db.collection('users').count(),
      db.collection('borrows').count(),
      db.collection('borrows')
        .where({ status: BORROW_STATUS.BORROWING })
        .field({ dueDate: true })
        .limit(1000)
        .get()
    ]);
  let overdueTotal = 0;
  for (const r of borrowingList.data) {
    if (r.dueDate && cstDateStr(r.dueDate) < cstTodayStr()) overdueTotal++;
  }
  return {
    ok: true,
    data: {
      bookTotal: bookTotal.total,
      availableTotal: available.total,
      borrowedTotal: borrowing.total + returnRequested.total,
      overdueTotal,
      pendingTotal: pending.total + returnRequested.total,
      memberTotal: users.total,
      borrowTotal: allBorrows.total
    }
  };
}

/** 借阅管理筛选栏计数（管理端）
 *  与 doGetStats 同口径，但拆到每个状态，供页签徽标使用：
 *  - borrowing 为 DB 原始借出中总数（含已逾期，逾期是其派生标签）
 *  - overdue 单独返回，便于页面把「逾期」标红
 */
async function doGetBorrowCounts() {
  const [all, pending, borrowing, returnRequested, returned, cancelled, borrowingList] = await Promise.all([
    db.collection('borrows').count(),
    db.collection('borrows').where({ status: BORROW_STATUS.PENDING }).count(),
    db.collection('borrows').where({ status: BORROW_STATUS.BORROWING }).count(),
    db.collection('borrows').where({ status: BORROW_STATUS.RETURN_REQUESTED }).count(),
    db.collection('borrows').where({ status: BORROW_STATUS.RETURNED }).count(),
    db.collection('borrows').where({ status: BORROW_STATUS.CANCELLED }).count(),
    db
      .collection('borrows')
      .where({ status: BORROW_STATUS.BORROWING })
      .field({ dueDate: true })
      .limit(1000)
      .get()
  ]);
  let overdue = 0;
  for (const r of borrowingList.data) {
    if (r.dueDate && cstDateStr(r.dueDate) < cstTodayStr()) overdue++;
  }
  return {
    ok: true,
    data: {
      all: all.total,
      pending: pending.total,
      borrowing: borrowing.total,
      return_requested: returnRequested.total,
      overdue,
      returned: returned.total,
      cancelled: cancelled.total
    }
  };
}

/** 查询某 openid 的用户 */
async function getUserByOpenid(openid) {
  const r = await db.collection('users').where({ openid }).get();
  return r.data[0] || null;
}

/** 借书证申请（本人）：提交手机号 + 归属馆藏；审批中/被驳回可重新申请（覆盖旧申请） */
async function doApplyCard(event, openid) {
  const { phone, location } = event;
  const me = await getUserByOpenid(openid);
  if (!me) return { ok: false, msg: '用户不存在，请重新登录' };
  // 管理员身份只是叠加的管理权限，借阅仍需持卡：无有效卡时同样可申请开通借书证
  const card = me.card || { status: 'none' };
  if (card.status === 'active') return { ok: false, msg: '您已开通借书证，无需重复申请' };
  if (!phone || !String(phone).trim()) return { ok: false, msg: '请填写手机号' };
  if (!/^1\d{10}$/.test(String(phone).trim())) return { ok: false, msg: '请输入正确的手机号' };
  const settings = await getSettings();
  const locs = settings.locations || [];
  if (!location || !locs.includes(location)) return { ok: false, msg: '请选择有效的馆藏地点' };
  await db.collection('users').doc(me._id).update({
    data: {
      card: {
        status: 'pending',
        phone: String(phone).trim(),
        location,
        applyDate: db.serverDate()
      }
    }
  });
  return { ok: true };
}

/** 修改借书证归属馆藏（本人）：仅更新 location，不重置审批状态；仅 active/pending 可改，且只能设置一个地点 */
async function doUpdateCardLocation(event, openid) {
  const { location } = event;
  const me = await getUserByOpenid(openid);
  if (!me) return { ok: false, msg: '用户不存在，请重新登录' };
  const card = me.card || { status: 'none' };
  if (card.status !== 'active' && card.status !== 'pending') {
    return { ok: false, msg: '当前借书证状态不可修改归属馆藏' };
  }
  const settings = await getSettings();
  const locs = settings.locations || [];
  if (!location || !locs.includes(location)) return { ok: false, msg: '请选择有效的馆藏地点' };
  if (location === card.location) return { ok: false, msg: '所选馆藏与当前一致' };
  // 切换前须先归还/取消原馆藏的全部借阅（含待确认借出、借出中/已逾期、待确认归还）
  const outstanding = await db.collection('borrows').where({
    userId: openid,
    location: card.location,
    status: _.in([BORROW_STATUS.PENDING, BORROW_STATUS.BORROWING, BORROW_STATUS.RETURN_REQUESTED])
  }).count();
  if (outstanding.total > 0) {
    return { ok: false, msg: '请先归还/取消原馆藏（' + card.location + '）的全部借阅后再修改地址' };
  }
  await db.collection('users').doc(me._id).update({ data: { 'card.location': location } });
  return { ok: true };
}

/** 通过 / 驳回借书证申请（管理员） */
async function doAuditCard(event, pass) {
  const { userId, reason } = event;
  if (!userId) return { ok: false, msg: '参数错误' };
  let u;
  try {
    const r = await db.collection('users').doc(userId).get();
    u = r.data;
  } catch (e) {
    return { ok: false, msg: '用户不存在' };
  }
  // 管理员亦须遵循借书证规则，其申请同样可被审批
  if (!u.card || u.card.status !== 'pending') return { ok: false, msg: '该用户当前没有待审批的借书证申请' };
  const patch = {
    card: Object.assign({}, u.card, {
      status: pass ? 'active' : 'rejected',
      auditDate: db.serverDate(),
      rejectReason: pass ? '' : (reason && String(reason).trim()) || '资料不符合要求'
    })
  };
  await db.collection('users').doc(userId).update({ data: patch });
  // 审批结果通知（站内 + 用户打开「我的」即可看到原因）
  await pushNotice(
    u.openid,
    'card',
    pass ? '借书证已开通' : '借书证申请被驳回',
    pass
      ? `归属馆藏：${(u.card && u.card.location) || '未设置'}，现在可以借阅该馆藏的图书了`
      : `原因：${patch.card.rejectReason}，可修改资料后重新申请`,
    '/pages/my/index',
    pass ? 'info' : 'warning'
  );
  return { ok: true };
}

/** 剔除借书证（管理员清理僵尸用户）：删除该用户全部关联借阅数据；存在未归还借阅时拒绝 */
async function doRemoveCard(event) {
  const { userId } = event;
  if (!userId) return { ok: false, msg: '参数错误' };
  let u;
  try {
    const r = await db.collection('users').doc(userId).get();
    u = r.data;
  } catch (e) {
    return { ok: false, msg: '用户不存在' };
  }
  // 剔除只影响借书证（借阅身份），管理员的 role 不受影响；管理员须持卡方可借阅，同样适用
  const active = await db
    .collection('borrows')
    .where({ userId: u.openid, status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED]) })
    .count();
  if (active.total > 0) return { ok: false, msg: '该用户存在未归还的借阅，请先处理后再剔除' };
  // 分批删除其全部关联借阅数据（服务端单次 remove 有数量上限）
  for (;;) {
    const list = await db.collection('borrows').where({ userId: u.openid }).limit(100).get();
    if (!list.data.length) break;
    await db.collection('borrows').where({ userId: u.openid }).remove();
  }
  await db.collection('users').doc(userId).update({ data: { card: { status: 'none' } } }); // 可重新申请
  return { ok: true };
}

/** 升格某注册用户为管理员（管理员身份叠加在原读者身份上，借书证与馆藏范围保持不变） */
async function doPromoteAdmin(event) {
  const { userId } = event;
  if (!userId) return { ok: false, msg: '参数错误' };
  let u;
  try {
    const r = await db.collection('users').doc(userId).get();
    u = r.data;
  } catch (e) {
    return { ok: false, msg: '用户不存在' };
  }
  if (u.role === ROLE.ADMIN) return { ok: false, msg: '该用户已是管理员' };
  // 仅叠加管理权限，不清卡：有卡保留、无卡则仍为未开通，借阅须先办卡
  await db.collection('users').doc(userId).update({ data: { role: ROLE.ADMIN } });
  return { ok: true };
}

/** 将某管理员降级为普通用户（保留其借书证；无卡则置为未开通，可重新申请） */
async function doDemoteAdmin(event) {
  const { userId } = event;
  if (!userId) return { ok: false, msg: '参数错误' };
  let u;
  try {
    const r = await db.collection('users').doc(userId).get();
    u = r.data;
  } catch (e) {
    return { ok: false, msg: '用户不存在' };
  }
  if (u.role !== ROLE.ADMIN) return { ok: false, msg: '该用户不是管理员' };
  const card = u.card || { status: 'none' };
  await db.collection('users').doc(userId).update({ data: { role: ROLE.USER, card } });
  return { ok: true };
}

/** 用户列表（管理员） */
async function doGetUsers(event = {}) {
  const { keyword = '', role = '', cardStatus = '', page = 1, pageSize = 20 } = event;
  const where = {};
  if (role) where.role = role;
  if (cardStatus) where['card.status'] = cardStatus;
  if (keyword) {
    // 转义正则特殊字符，避免用户输入 ()[] 等导致正则报错
    const escaped = String(keyword).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    where.nickname = db.RegExp({ regexp: escaped, options: 'i' });
  }
  const size = Math.min(Math.max(parseInt(pageSize, 10) || 20, 1), 100);
  const p = Math.max(parseInt(page, 10) || 1, 1);
  const coll = db.collection('users').field({ avatarUrl: false }).where(where);
  const countRes = await coll.count();
  const r = await coll.orderBy('createdAt', 'desc').skip((p - 1) * size).limit(size).get();
  return { ok: true, data: { list: r.data, total: countRes.total } };
}

/** 借阅人续借：逾期前自主申请，延长应还日期（按馆藏设置续借次数与天数） */
async function doRenewBorrow(event, openid) {
  const { borrowId } = event;
  if (!borrowId) return { ok: false, msg: '参数错误' };
  const settings = await getSettings();
  const maxRenew = Number(settings.renewTimes) || 0;
  const renewDays = Number(settings.renewDays) || 0;
  if (maxRenew <= 0 || renewDays <= 0) return { ok: false, msg: '当前馆藏未开启续借' };
  let record = null;
  try {
    const res = await db.collection('borrows').doc(borrowId).get();
    record = res.data;
  } catch (e) {
    return { ok: false, msg: '借阅记录不存在' };
  }
  if (!record || record.userId !== openid) return { ok: false, msg: '无权限操作该记录' };
  if (record.status !== BORROW_STATUS.BORROWING) return { ok: false, msg: '仅借出中可续借' };
  if (record.dueDate && cstDateStr(record.dueDate) < cstTodayStr()) return { ok: false, msg: '已逾期，无法续借' };
  const renewCount = Number(record.renewCount) || 0;
  if (renewCount >= maxRenew) return { ok: false, msg: '已达最大续借次数' };
  const newDue = addDays(new Date(record.dueDate), renewDays);
  await db.collection('borrows').doc(borrowId).update({
    data: { dueDate: newDue, renewCount: renewCount + 1, renewedAt: db.serverDate() }
  });
  return { ok: true, dueDate: newDue, renewCount: renewCount + 1 };
}

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  try {
    switch (event.action) {
      case 'borrow':
        return await doBorrow(event, OPENID);
      case 'setSubscribedReturn':
        return await doSetSubscribedReturn(event, OPENID);
      case 'bookOccupied':
        return await doBookOccupied(event);
      case 'confirmBorrow':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doConfirmBorrow(event);
      case 'requestReturn':
        return await doRequestReturn(event, OPENID);
      case 'renewBorrow':
        return await doRenewBorrow(event, OPENID);
      case 'cancelBorrow':
        return await doCancelBorrow(event, OPENID);
      case 'cancelReturn':
        return await doCancelReturn(event, OPENID);
      case 'confirmReturn':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doConfirmReturn(event);
      case 'myBorrows':
        return await doMyBorrows(OPENID);
      case 'getSettings':
        return await doGetSettings();
      case 'saveSettings':
        return await doSaveSettings(event, OPENID);
      case 'getSchedules':
        return await doGetSchedules();
      case 'saveSchedule':
        return await doSaveSchedule(event, OPENID);
      case 'addBook':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doAddBook(event);
      case 'updateBook':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doUpdateBook(event);
      case 'deleteBook':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doDeleteBook(event);
      case 'stats':
        return await doGetStats();
      // ---- 借阅查询（管理端）：borrows 集合已关闭客户端读权限，只能经这里查 ----
      case 'adminBorrows':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doAdminBorrows(event);
      case 'bookBorrows':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doBookBorrows(event);
      case 'borrowCounts':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doGetBorrowCounts();
      // ---- 用户 / 借书证管理 ----
      case 'users':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doGetUsers(event);
      case 'applyCard':
        return await doApplyCard(event, OPENID);
      case 'updateCardLocation':
        return await doUpdateCardLocation(event, OPENID);
      case 'approveCard':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doAuditCard(event, true);
      case 'rejectCard':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doAuditCard(event, false);
      case 'removeCard':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doRemoveCard(event);
      case 'promoteAdmin':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doPromoteAdmin(event);
      case 'demoteAdmin':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doDemoteAdmin(event);
      // 管理员手动发送「逾期提醒」（新模板，需用户此前已授权）
      case 'sendOverdueRemind':
        if (!(await isAdmin(OPENID))) return { ok: false, msg: '无权限执行此操作' };
        return await doSendOverdueRemind(event);
      default:
        return { ok: false, msg: '未知操作' };
    }
  } catch (e) {
    console.error('[borrowManager] ', e);
    let msg = (e && e.message) || '操作失败';
    if (msg.includes('does not exist')) msg = '图书不存在';
    return { ok: false, msg };
  }
};
