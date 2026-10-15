/**
 * 业务回归用例
 * 覆盖此前发现/修复的 bug 场景：
 *  - 完整借还流程（申请 → 确认借出 → 交付时间不覆盖申请时间 → 归还回补库存）
 *  - 库存锁定（防止多人同时申请导致超售）
 *  - 同一用户同一本书防重
 *  - maxBorrow 每人限借
 *  - 值班日期校验（过去日期 / 无人值班日期 / 单日覆盖优先）
 *  - 状态机非法流转拦截
 *  - 统计与占用接口
 *  - 月历工具边界
 */
'use strict';

const {
  test,
  mock,
  sched,
  constants,
  util,
  assert,
  resetDb,
  rawDb,
  getFirstBook,
  nextScheduledDate,
  nextNonScheduledDate
} = require('../helpers');

const { BORROW_STATUS } = constants;

test('登录：首个注册用户自动成为管理员', async () => {
  resetDb();
  const u = await mock.login({ nickname: '管理员' });
  assert.strictEqual(u.role, 'admin', '首个用户应为管理员');
  assert.ok(u.openid, '应有 openid');
});

test('完整借还流程：申请→确认借出（交付时间/库存扣减）→预约还书→归还（库存回补）', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const beforeStock = book.stocks[loc];
  const beforeCount = book.borrowCount || 0;
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  // 1) 提交借阅申请
  const r1 = await mock.borrowBook(book._id, loc, pickup, { nickname: '管理员' });
  assert.strictEqual(r1.ok, true, '借阅申请应成功');

  const mine1 = await mock.getMyBorrows();
  assert.strictEqual(mine1.length, 1);
  assert.strictEqual(mine1[0].status, BORROW_STATUS.PENDING);
  assert.ok(mine1[0].borrowDateText, '申请时间文本应存在');
  assert.strictEqual(mine1[0].deliverDateText, '', '未交付时交付时间应为空');
  assert.strictEqual(mine1[0].scheduledPickupDateText, pickup, '预约取书日期应记录');
  const applyTime = mine1[0].borrowDate.getTime();

  // 2) 管理员确认借出
  const bid = mine1[0]._id;
  const r2 = await mock.confirmBorrow(bid);
  assert.strictEqual(r2.ok, true, '确认借出应成功');

  const mine2 = await mock.getMyBorrows();
  assert.strictEqual(mine2[0].status, BORROW_STATUS.BORROWING);
  assert.ok(mine2[0].deliverDate, '确认借出后应写入交付时间');
  assert.ok(mine2[0].deliverDateText, '交付时间文本应存在');
  assert.strictEqual(mine2[0].borrowDate.getTime(), applyTime, '申请时间不应被交付时间覆盖');
  assert.ok(mine2[0].dueDate, '确认借出后应有应还日期');

  const afterBook = await mock.getBook(book._id);
  assert.strictEqual(afterBook.stocks[loc], beforeStock - 1, '确认借出后库存应减 1');
  assert.strictEqual(afterBook.borrowCount, beforeCount + 1, '借阅次数应 +1');

  // 3) 预约还书
  const r3 = await mock.requestReturn(bid, nextScheduledDate(schedule));
  assert.strictEqual(r3.ok, true, '预约还书应成功');
  const mine3 = await mock.getMyBorrows();
  assert.strictEqual(mine3[0].status, BORROW_STATUS.RETURN_REQUESTED);
  assert.strictEqual(mine3[0].scheduledReturnDateText, nextScheduledDate(schedule), '应记录预约还书日期');

  // 4) 管理员确认归还 → 库存回补
  const r4 = await mock.returnBook(bid);
  assert.strictEqual(r4.ok, true, '确认归还应成功');
  const mine4 = await mock.getMyBorrows();
  assert.strictEqual(mine4[0].status, BORROW_STATUS.RETURNED);
  assert.ok(mine4[0].returnDateText, '归还时间文本应存在');
  const retBook = await mock.getBook(book._id);
  assert.strictEqual(retBook.stocks[loc], beforeStock, '归还后库存应回补');
});

test('借阅管理「已逾期」筛选：借出中且过期的记录应出现在逾期列表（同时仍在借出中列表）', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedule = (await mock.getSchedules()).find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  // 提交并确认借出（默认 borrowDays=30，应还日期在未来）
  const r1 = await mock.borrowBook(book._id, loc, pickup, { nickname: '管理员' });
  assert.strictEqual(r1.ok, true, '借阅申请应成功');
  const bid = (await mock.getMyBorrows())[0]._id;
  await mock.confirmBorrow(bid);

  // 确认借出后、未过期前：逾期列表应为空
  let overdueList = await mock.getBorrows({ status: BORROW_STATUS.OVERDUE });
  assert.strictEqual(overdueList.length, 0, '未过期时逾期列表应为空');

  // 把应还日期改到过去 → 变为逾期（模拟逾期场景）
  rawDb().borrows.find((r) => r._id === bid).dueDate = new Date(Date.now() - 86400000);

  // 逾期列表应出现该记录（派生状态为 overdue）
  overdueList = await mock.getBorrows({ status: BORROW_STATUS.OVERDUE });
  assert.strictEqual(overdueList.length, 1, '逾期列表应出现 1 条过期记录');
  assert.strictEqual(overdueList[0]._id, bid, '逾期列表应包含过期的借阅');
  assert.strictEqual(overdueList[0].status, BORROW_STATUS.OVERDUE, '派生状态应为 overdue');

  // 同时，它仍应出现在「借出中」列表（带已逾期标记）—— 修复前此处为空
  const borrowingList = await mock.getBorrows({ status: BORROW_STATUS.BORROWING });
  const inBorrowing = borrowingList.find((r) => r._id === bid);
  assert.ok(inBorrowing, '过期记录仍应出现在借出中列表');
  assert.strictEqual(inBorrowing.status, BORROW_STATUS.OVERDUE, '借出中列表里该记录应显示已逾期');
});

test('续借：借出中可延长到期、达次数上限后不可续借、逾期不可续借，且受馆藏配置控制', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedule = (await mock.getSchedules()).find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  await mock.borrowBook(book._id, loc, pickup, { nickname: '管理员' });
  const bid = (await mock.getMyBorrows())[0]._id;
  await mock.confirmBorrow(bid); // 模拟模式无需管理员身份即可确认借出

  // 默认配置：renewTimes=1（种子），renewDays=15
  let rec = (await mock.getMyBorrows())[0];
  const baseDue = new Date(rec.dueDate).getTime();
  assert.strictEqual(rec.renewCount || 0, 0, '初始续借次数应为 0');

  const r1 = await mock.renewBorrow(bid);
  assert.strictEqual(r1.ok, true, '借出中应可续借');
  rec = (await mock.getMyBorrows())[0];
  assert.strictEqual(rec.renewCount, 1, '续借后次数应为 1');
  assert.ok(new Date(rec.dueDate).getTime() >= baseDue + 14 * 86400000, '应还日期应延长约 15 天');

  // 达上限后不可再续借
  const r2 = await mock.renewBorrow(bid);
  assert.strictEqual(r2.ok, false, '达最大续借次数后不可续借');

  // 修改馆藏配置：提高续借次数，并把该记录重置为未过期且未用尽次数
  await mock.saveSettings({ renewTimes: 3, renewDays: 7 });
  rawDb().borrows.find((x) => x._id === bid).renewCount = 0;
  rawDb().borrows.find((x) => x._id === bid).dueDate = new Date(Date.now() + 10 * 86400000);
  const settings = await mock.getSettings();
  assert.strictEqual(settings.renewTimes, 3, '保存后馆藏应记录续借次数');
  assert.strictEqual(settings.renewDays, 7, '保存后馆藏应记录续借天数');

  // 配置生效后按 7 天延长
  const r3 = await mock.renewBorrow(bid);
  assert.strictEqual(r3.ok, true, '配置提高后续借应成功');
  rec = (await mock.getMyBorrows())[0];
  assert.strictEqual(rec.renewCount, 1, '重置后再次续借次数应为 1');
  assert.ok(new Date(rec.dueDate).getTime() >= Date.now() + 15 * 86400000, '应按 7 天延长（原 +10 天 → +17 天）');

  // 逾期不可续借：把到期日改到过去
  rawDb().borrows.find((x) => x._id === bid).dueDate = new Date(Date.now() - 86400000);
  const r4 = await mock.renewBorrow(bid);
  assert.strictEqual(r4.ok, false, '已逾期不可续借');
});

test('管理首页卡片深链：借出中/待确认/已逾期 各自跳转到对应 tab（getBorrows 过滤正确）', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedule = (await mock.getSchedules()).find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  // 提交借阅申请（未确认 → 待确认借出 pending）
  const rb = await mock.borrowBook(book._id, loc, pickup, { nickname: '管理员' });
  assert.strictEqual(rb.ok, true, '借阅申请应成功');
  const bid = (await mock.getMyBorrows())[0]._id;

  // 未确认：应出现在 pending tab，不在 borrowing tab
  let pendingList = await mock.getBorrows({ status: BORROW_STATUS.PENDING });
  let borrowingList = await mock.getBorrows({ status: BORROW_STATUS.BORROWING });
  assert.ok(pendingList.some((r) => r._id === bid), '待确认卡片目标 tab 应含该申请');
  assert.ok(!borrowingList.some((r) => r._id === bid), '未确认时不应出现在借出中 tab');

  // 确认借出 → 应出现在 borrowing tab，不在 pending tab
  await mock.confirmBorrow(bid);
  borrowingList = await mock.getBorrows({ status: BORROW_STATUS.BORROWING });
  pendingList = await mock.getBorrows({ status: BORROW_STATUS.PENDING });
  assert.ok(borrowingList.some((r) => r._id === bid), '借出中卡片目标 tab 应含该借阅');
  assert.ok(!pendingList.some((r) => r._id === bid), '确认后不应再出现在待确认 tab');

  // 改到期日为过去 → 应出现在 overdue tab（已逾期卡片目标）
  rawDb().borrows.find((r) => r._id === bid).dueDate = new Date(Date.now() - 86400000);
  const overdueList = await mock.getBorrows({ status: BORROW_STATUS.OVERDUE });
  assert.ok(overdueList.some((r) => r._id === bid), '已逾期卡片目标 tab 应含该逾期借阅');
});

test('详情页「被借次数」点击：管理员可查该书全部借阅记录（含未归还）', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();

  // 初始该书应无借阅记录
  let list = await mock.getBorrowsByBook(book._id);
  assert.strictEqual(list.length, 0, '初始该书应无借阅记录');

  const schedule = (await mock.getSchedules()).find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  // 1) 申请并确认借出 → 借出中（未归还）
  const rb = await mock.borrowBook(book._id, loc, pickup, { nickname: '管理员' });
  assert.strictEqual(rb.ok, true, '借阅申请应成功');
  const bid = (await mock.getMyBorrows())[0]._id;
  await mock.confirmBorrow(bid);

  list = await mock.getBorrowsByBook(book._id);
  assert.strictEqual(list.length, 1, '确认借出后应出现 1 条借阅记录');
  assert.strictEqual(list[0].status, BORROW_STATUS.BORROWING, '未归还记录状态应为借出中');
  assert.ok(list[0].borrowDateText && list[0].dueDateText, '未归还记录应带借出/应还日期文本');

  // 2) 归还该笔 → 已归还；同时直接造一条未归还记录，验证「含未归还」一并返回
  await mock.requestReturn(bid, nextScheduledDate(schedule));
  await mock.returnBook(bid);

  rawDb().borrows.push({
    _id: 'raw-active-' + book._id,
    bookId: book._id,
    bookTitle: book.title,
    userId: 'u_x',
    userName: '未归还用户',
    location: loc,
    status: BORROW_STATUS.BORROWING,
    borrowDate: new Date(),
    dueDate: new Date(Date.now() + 5 * 86400000),
    deliverDate: new Date()
  });

  list = await mock.getBorrowsByBook(book._id);
  assert.strictEqual(list.length, 2, '该书应返回全部 2 条记录（已归还 + 未归还）');

  const returned = list.find((r) => r._id === bid);
  assert.ok(returned, '已归还记录应被返回');
  assert.strictEqual(returned.status, BORROW_STATUS.RETURNED, '第一笔应为已归还');
  assert.ok(returned.returnDateText, '已归还记录应带归还日期文本');

  const active = list.find((r) => r._id === 'raw-active-' + book._id);
  assert.ok(active, '未归还记录也应被返回');
  assert.strictEqual(active.status, BORROW_STATUS.BORROWING, '未归还记录状态应为借出中');
});

test('借书日期为过去日期时被拒绝', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const yesterday = util.formatDate(util.addDays(new Date(), -1));
  const r = await mock.borrowBook(book._id, loc, yesterday);
  assert.strictEqual(r.ok, false);
  assert.ok((r.msg || '').includes('过去'), '提示应包含"过去"');
});

test('借书日期无人值班时被拒绝', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const off = nextNonScheduledDate(schedule);
  const r = await mock.borrowBook(book._id, loc, off);
  assert.strictEqual(r.ok, false);
  assert.ok((r.msg || '').includes('值班'), '提示应包含"值班"');
});

test('确认借出时馆藏无库存被拒绝', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);
  await mock.borrowBook(book._id, loc, pickup);
  const mine = await mock.getMyBorrows();

  // 直接改库模拟"申请后库存被清零"的极端情况
  const db = rawDb();
  const b = db.books.find((x) => x._id === book._id);
  b.stocks[loc] = 0;
  b.stock = 0;
  b.status = 'borrowed';

  const r = await mock.confirmBorrow(mine[0]._id);
  assert.strictEqual(r.ok, false);
  assert.ok((r.msg || '').includes('库存'), '提示应包含"库存"');
});

test('库存锁定：他人占用后当前用户无法申请，释放后可申请', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();

  // 将目标地点库存固定为 1 本，使锁定语义确定
  const up = await mock.updateBook(book._id, { stocks: { [loc]: 1 } });
  assert.strictEqual(up.ok, true, '调整库存应成功');

  // 模拟"其他用户"（mock 登录固定 openid，直接改库注入多用户数据）
  const db = rawDb();
  db.users.push({ _id: 'u_other', openid: 'openid_other', nickname: '其他用户', role: 'user', createdAt: Date.now() });
  db.borrows.push({
    _id: 'br_other',
    bookId: book._id,
    location: loc,
    userId: 'openid_other',
    userName: '其他用户',
    borrowDate: new Date(),
    scheduledPickupDate: util.formatDate(util.addDays(new Date(), 1)),
    dueDate: null,
    returnDate: null,
    status: BORROW_STATUS.PENDING
  });

  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  const r = await mock.borrowBook(book._id, loc, pickup, { nickname: '管理员' });
  assert.strictEqual(r.ok, false, '库存被占用时应拒绝申请');
  assert.ok((r.msg || '').includes('预约'), '提示应包含"预约"');

  // 占用释放（直接删除该记录模拟"他人归还/取消"）后可正常申请
  db.borrows = db.borrows.filter((x) => x._id !== 'br_other');
  const r2 = await mock.borrowBook(book._id, loc, pickup, { nickname: '管理员' });
  assert.strictEqual(r2.ok, true, '释放占用后应可申请');
});

test('同一用户同一本书不能重复申请', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  // 调大库存，确保第二次申请命中"防重"分支而非"库存锁定"分支（种子库存随机）
  const up = await mock.updateBook(book._id, { stocks: { [loc]: 5 } });
  assert.strictEqual(up.ok, true);
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  const r1 = await mock.borrowBook(book._id, loc, pickup);
  assert.strictEqual(r1.ok, true, '首次申请应成功');
  const r2 = await mock.borrowBook(book._id, loc, pickup);
  assert.strictEqual(r2.ok, false, '重复申请应被拒绝');
  assert.ok((r2.msg || '').includes('重复'), '提示应包含"重复"');
});

test('每人同时最多借阅数量限制', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const s = await mock.saveSettings({ maxBorrow: 1 });
  assert.strictEqual(s.ok, true);

  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s2) => s2.location === loc);
  const pickup = nextScheduledDate(schedule);

  const r1 = await mock.borrowBook(book._id, loc, pickup);
  assert.strictEqual(r1.ok, true, '第一本应可申请');

  // 找/造第二本有库存的书
  let second = rawDb().books.find((b) => b._id !== book._id && (b.stocks[loc] || 0) > 0);
  if (!second) {
    const add = await mock.addBook({ title: '测试书', author: '测试', isbn: 'TEST-' + Date.now(), stocks: { [loc]: 2 } });
    assert.strictEqual(add.ok, true);
    second = add.book;
  }
  const r2 = await mock.borrowBook(second._id, loc, pickup);
  assert.strictEqual(r2.ok, false, '达到上限后应拒绝');
  assert.ok((r2.msg || '').includes('最多借阅'), '提示应包含"最多借阅"');
});

test('状态机：非法流转被拒绝', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  await mock.borrowBook(book._id, loc, pickup);
  const mine = await mock.getMyBorrows();
  const bid = mine[0]._id;

  // pending：不能预约还书 / 不能直接确认归还
  const r1 = await mock.requestReturn(bid, nextScheduledDate(schedule));
  assert.strictEqual(r1.ok, false, 'pending 状态不能预约还书');
  const r2 = await mock.returnBook(bid);
  assert.strictEqual(r2.ok, false, 'pending 状态不能直接确认归还');

  // 确认借出后：不能重复确认；borrowing 状态不能直接归还（必须先预约还书）
  await mock.confirmBorrow(bid);
  const r3 = await mock.confirmBorrow(bid);
  assert.strictEqual(r3.ok, false, '已确认的申请不能重复确认');
  const r4 = await mock.returnBook(bid);
  assert.strictEqual(r4.ok, false, 'borrowing 状态需先预约还书');

  // 正常归还后：不能再归还 / 不能再预约还书
  await mock.requestReturn(bid, nextScheduledDate(schedule));
  await mock.returnBook(bid);
  const r5 = await mock.returnBook(bid);
  assert.strictEqual(r5.ok, false, '已归还记录不能重复归还');
  const r6 = await mock.requestReturn(bid, nextScheduledDate(schedule));
  assert.strictEqual(r6.ok, false, '已归还记录不能再预约还书');
});

test('统计口径：借出中=借出中+预约还书待确认，待确认=待确认借出+预约还书待确认，逾期仅已借出', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const stats0 = await mock.getStats();
  assert.strictEqual(stats0.bookTotal, rawDb().books.length, '图书总数应一致');
  assert.strictEqual(stats0.borrowTotal, 0, '初始借阅总数为 0');
  assert.strictEqual(stats0.borrowedTotal, 0, '初始借出中为 0');
  assert.strictEqual(stats0.overdueTotal, 0, '初始逾期为 0');
  assert.strictEqual(stats0.pendingTotal, 0, '初始待确认为 0');

  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  // ① 待确认借出申请（pending）：书还没借出 → 不计入"借出中"；是管理员待办 → 计入"待确认"；不计入逾期
  await mock.borrowBook(book._id, loc, pickup);
  let s = await mock.getStats();
  assert.strictEqual(s.borrowedTotal, 0, '待确认申请（还没借出）不应计入借出中');
  assert.strictEqual(s.pendingTotal, 1, '待确认申请应计入待确认');
  assert.strictEqual(s.overdueTotal, 0, 'pending 不应计入逾期');
  assert.strictEqual(s.borrowTotal, 1, '待确认申请应计入总借阅');

  // ② 确认借出（borrowing）：书借出 → 计入"借出中"；待确认减为 0
  const mine = await mock.getMyBorrows();
  const bid = mine[0]._id;
  await mock.confirmBorrow(bid);
  s = await mock.getStats();
  assert.strictEqual(s.borrowedTotal, 1, '借出中应计入 borrowing');
  assert.strictEqual(s.pendingTotal, 0, '确认后待确认为 0');
  assert.strictEqual(s.overdueTotal, 0, '未过期不应计入逾期');

  // ③ 将应还日期改为过去：逾期 +1（口径仍仅限 borrowing，借出中保持不变）
  rawDb().borrows.find((r) => r._id === bid).dueDate = new Date(Date.now() - 86400000);
  s = await mock.getStats();
  assert.strictEqual(s.overdueTotal, 1, '已借出且过期应计入逾期');
  assert.strictEqual(s.borrowedTotal, 1, '逾期的书仍在读者手上，计入借出中');
  assert.strictEqual(s.pendingTotal, 0);

  // ④ 预约还书（return_requested）：书还在读者手上 → 计入"借出中"；是管理员待办 → 计入"待确认"；不再计入逾期
  const rr = await mock.requestReturn(bid, nextScheduledDate(schedule));
  assert.strictEqual(rr.ok, true);
  s = await mock.getStats();
  assert.strictEqual(s.borrowedTotal, 1, '预约还书待确认的书还在读者手上，计入借出中');
  assert.strictEqual(s.pendingTotal, 1, '预约还书待确认是管理员待办，计入待确认');
  assert.strictEqual(s.overdueTotal, 0, '预约还书待确认不再计入逾期');
  assert.strictEqual(s.borrowTotal, 1);

  // ⑤ 管理员确认归还（returned）：借出中 / 待确认 / 逾期全部归 0
  const ret = await mock.returnBook(bid);
  assert.strictEqual(ret.ok, true);
  s = await mock.getStats();
  assert.strictEqual(s.borrowedTotal, 0, '归还后借出中为 0');
  assert.strictEqual(s.pendingTotal, 0, '归还后待确认为 0');
  assert.strictEqual(s.overdueTotal, 0, '归还后逾期为 0');
  assert.strictEqual(s.borrowTotal, 1, '总借阅数保持不变');
});

test('统计口径：多状态混合统计——已归还/已取消不占借出中与待确认', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book: book0, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  // 放开每人限借数，便于同一用户构造多条记录
  const cap = await mock.saveSettings({ maxBorrow: 20 });
  assert.strictEqual(cap.ok, true);

  // 取 4 本互不相同的书，分别走成 4 种状态
  const pick = (exclude) => {
    const b = rawDb().books.find((x) => !exclude.includes(x._id) && (x.stocks[loc] || 0) > 0);
    assert.ok(b, '应有足够的可借书');
    return b;
  };
  const b1 = book0;
  const b2 = pick([b1._id]);
  const b3 = pick([b1._id, b2._id]);
  const b4 = pick([b1._id, b2._id, b3._id]);

  // b1：借出中（borrowing）
  assert.strictEqual((await mock.borrowBook(b1._id, loc, pickup)).ok, true);
  // b2：预约还书待确认（return_requested）
  assert.strictEqual((await mock.borrowBook(b2._id, loc, pickup)).ok, true);
  // b3：已归还（returned）
  assert.strictEqual((await mock.borrowBook(b3._id, loc, pickup)).ok, true);
  // b4：已取消（cancelled，pending 时取消）
  assert.strictEqual((await mock.borrowBook(b4._id, loc, pickup)).ok, true);

  const mine = await mock.getMyBorrows();
  const byBook = {};
  mine.forEach((r) => { byBook[r.bookId] = r._id; });
  await mock.confirmBorrow(byBook[b1._id]); // borrowing
  await mock.confirmBorrow(byBook[b2._id]);
  await mock.confirmBorrow(byBook[b3._id]);
  await mock.requestReturn(byBook[b2._id], nextScheduledDate(schedule)); // return_requested
  await mock.requestReturn(byBook[b3._id], nextScheduledDate(schedule));
  await mock.returnBook(byBook[b3._id]); // returned
  await mock.cancelBorrow(byBook[b4._id]); // cancelled

  const s = await mock.getStats();
  // 借出中 = b1(borrowing) + b2(return_requested) = 2（b3 已归还、b4 已取消不计入）
  assert.strictEqual(s.borrowedTotal, 2, '借出中只含 borrowing 与 return_requested');
  // 待确认 = b2(return_requested) = 1（b1 借出中不需确认、b4 已取消不计入）
  assert.strictEqual(s.pendingTotal, 1, '待确认只含 pending 与 return_requested');
  assert.strictEqual(s.overdueTotal, 0, '无人逾期');
  assert.strictEqual(s.borrowTotal, 4, '总借阅数为 4');
  assert.strictEqual(s.memberTotal, 1, '注册用户为 1');
});

test('占用统计：待确认申请计入，借出中计入，归还后清零', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  await mock.borrowBook(book._id, loc, pickup);
  let occ = await mock.getBookOccupied(book._id);
  assert.strictEqual(occ[loc], 1, '待确认申请应占用 1 本');

  const mine = await mock.getMyBorrows();
  await mock.confirmBorrow(mine[0]._id);
  occ = await mock.getBookOccupied(book._id);
  assert.strictEqual(occ[loc], 1, '借出中同样占用');

  await mock.requestReturn(mine[0]._id, nextScheduledDate(schedule));
  await mock.returnBook(mine[0]._id);
  occ = await mock.getBookOccupied(book._id);
  assert.strictEqual(occ[loc], undefined, '归还后该地点应无占用');
});

test('值班配置：单日覆盖优先于周规则，且保存后持久化', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { loc } = getFirstBook();

  // 默认周规则：周一至周五可选
  const list = await mock.getSchedules();
  const s0 = list.find((x) => x.location === loc);
  assert.deepStrictEqual(s0.weekly, [true, true, true, true, true, false, false], '默认周一至周五值班');

  // 找一个周一（默认可选，改为不可选）与一个周六（默认不可选，改为可选）
  const d = new Date();
  let mon = null;
  let sat = null;
  for (let i = 1; i <= 60 && (!mon || !sat); i++) {
    const t = util.addDays(d, i);
    const wd = t.getDay();
    const s = util.formatDate(t);
    if (wd === 1 && !mon) mon = s;
    if (wd === 6 && !sat) sat = s;
  }
  assert.ok(mon && sat, '60 天内应能找到周一与周六');

  const save = await mock.saveSchedule({ location: loc, overrides: { [mon]: false, [sat]: true } });
  assert.strictEqual(save.ok, true);

  const list2 = await mock.getSchedules();
  const s1 = list2.find((x) => x.location === loc);
  assert.strictEqual(s1.overrides[mon], false, '周一覆盖应保存');
  assert.strictEqual(s1.overrides[sat], true, '周六覆盖应保存');

  // 覆盖规则生效：周一不可选、周六可选
  const cal = sched.buildDateMonthCalendar(Number(mon.slice(0, 4)), Number(mon.slice(5, 7)), s1, '2000-01-01', '2100-01-01');
  const cellMon = cal.weeks.flat().find((c) => c && c.date === mon);
  const cellSat = cal.weeks.flat().find((c) => c && c.date === sat);
  assert.ok(cellMon && cellSat, '月历中应能找到对应日期');
  assert.strictEqual(cellMon.available, false, '周一 override=false 后不可选');
  assert.strictEqual(cellSat.available, true, '周六 override=true 后可选');

  // 借书校验同样遵循覆盖规则
  const { book } = getFirstBook();
  const rMon = await mock.borrowBook(book._id, loc, mon);
  assert.strictEqual(rMon.ok, false, '覆盖为不可选的周一应拒绝借书');
  const rSat = await mock.borrowBook(book._id, loc, sat);
  assert.strictEqual(rSat.ok, true, '覆盖为可选的周六应可借书');
});

test('值班调整后重新读取即最新：模拟还书日历缓存刷新（回归调整值班后还书可选日期不变）', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { loc } = getFirstBook();

  // 第一次读取 = 页面首次加载时缓存的旧值班配置
  const oldList = await mock.getSchedules();
  const oldS = oldList.find((x) => x.location === loc);
  assert.ok(oldS, '该地点应有默认值班配置');
  const onDay = nextScheduledDate(oldS); // 旧配置中的值班日
  const offDay = nextNonScheduledDate(oldS); // 旧配置中的非值班日
  assert.strictEqual(sched.isScheduledOn(oldS, onDay), true, '旧配置 onDay 应值班');
  assert.strictEqual(sched.isScheduledOn(oldS, offDay), false, '旧配置 offDay 应无人值班');

  // 管理员调整值班日期：单日覆盖停掉 onDay、新开 offDay
  const r = await mock.saveSchedule({ location: loc, overrides: { [onDay]: false, [offDay]: true } });
  assert.strictEqual(r.ok, true);

  // 若页面沿用旧缓存（修复前 bug 场景）：offDay 依然不可选、onDay 仍可选
  assert.strictEqual(sched.isScheduledOn(oldS, offDay), false, '旧缓存中 offDay 仍不可选（复现修复前 bug）');
  assert.strictEqual(sched.isScheduledOn(oldS, onDay), true, '旧缓存中 onDay 仍可选（复现修复前 bug）');

  // 修复后：onShow 清缓存重新拉取 → 拿到包含新单日覆盖的最新配置
  const freshList = await mock.getSchedules();
  const freshS = freshList.find((x) => x.location === loc);
  assert.strictEqual(freshS.overrides[offDay], true, '重新拉取应包含 offDay 的单日开启');
  assert.strictEqual(freshS.overrides[onDay], false, '重新拉取应包含 onDay 的单日关闭');
  assert.strictEqual(sched.isScheduledOn(freshS, offDay), true, '重新拉取后 offDay 应可预约还书');
  assert.strictEqual(sched.isScheduledOn(freshS, onDay), false, '重新拉取后 onDay 应不可预约还书');

  // 且不影响其他地点
  const other = freshList.find((x) => x.location !== loc);
  assert.ok(other, '应存在其他地点配置');
  assert.strictEqual(other.overrides[offDay], undefined, '其他地点不应被本次调整污染');
});

test('全局设置保存后可读回', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const r = await mock.saveSettings({ borrowDays: 15, maxBorrow: 2, locations: ['广州', '西安'] });
  assert.strictEqual(r.ok, true);
  const s = await mock.getSettings();
  assert.strictEqual(s.borrowDays, 15);
  assert.strictEqual(s.maxBorrow, 2);
  assert.deepStrictEqual(s.locations, ['广州', '西安']);
});

test('月历工具：结构、范围、today 标记、值班标记正确', () => {
  const schedule = { weekly: [true, true, true, true, true, false, false], overrides: {} };
  const cal = sched.buildDateMonthCalendar(2026, 8, schedule, '2026-08-01', '2026-08-31');
  assert.strictEqual(cal.year, 2026);
  assert.strictEqual(cal.month, 8);
  cal.weeks.forEach((row) => assert.strictEqual(row.length, 7, '每行应为 7 列'));
  const all = cal.weeks.flat();
  assert.strictEqual(all.filter((c) => c && c.date.indexOf('2026-08-') === 0).length, 31, '8 月应有 31 个日期');

  // 2026-08-01 为周六（minDate）：today 标记、范围外不允许
  const first = all.find((c) => c && c.date === '2026-08-01');
  assert.strictEqual(first.today, true, 'minDate 应标记为 today');
  assert.strictEqual(first.inRange, true);

  // 2026-08-02 周日：默认不可选
  const sun = all.find((c) => c && c.date === '2026-08-02');
  assert.strictEqual(sched.weekdayIndex('2026-08-02'), 6, '周日应为最后一天');
  assert.strictEqual(sun.available, false, '周日默认不可选');

  // 2026-08-03 周一：默认可选
  const mon = all.find((c) => c && c.date === '2026-08-03');
  assert.strictEqual(mon.available, true, '周一默认可选');

  // 范围外日期不可选
  const cal2 = sched.buildDateMonthCalendar(2026, 7, schedule, '2026-08-10', '2026-08-31');
  const cPrev = cal2.weeks.flat().find((c) => c && c.date === '2026-07-31');
  assert.strictEqual(cPrev.inRange, false);
  assert.strictEqual(cPrev.available, false);

  // isScheduledOn 边界
  assert.strictEqual(sched.isScheduledOn(null, '2026-08-03'), false, 'null 配置不可选');
  assert.strictEqual(sched.isScheduledOn({ weekly: 'bad' }, '2026-08-03'), false, 'weekly 非数组不可选');
  assert.strictEqual(sched.isScheduledOn({ weekly: [true] }, '2026-08-03'), false, 'weekly 长度不足不可选');
});

test('图书管理：ISBN 查重 / 有库存不可删除 / 馆藏下限校验', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();

  // ISBN 查重
  const dup = await mock.addBook({ title: '重复书', author: 'A', isbn: book.isbn, stocks: { [loc]: 1 } });
  assert.strictEqual(dup.ok, false, '重复 ISBN 应拒绝');
  assert.strictEqual(dup.code, 'DUPLICATE');

  // 新增成功
  const add = await mock.addBook({ title: '新书', author: 'B', isbn: 'X-' + Date.now(), stocks: { [loc]: 1 } });
  assert.strictEqual(add.ok, true, '新增图书应成功');

  // 有库存不可删除
  const del = await mock.deleteBook(book._id);
  assert.strictEqual(del.ok, false, '有库存的书不可删除');
  assert.ok((del.msg || '').includes('库存'));

  // 有未归还借阅时，调低馆藏低于占用应拒绝
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);
  await mock.borrowBook(book._id, loc, pickup);
  const low = await mock.updateBook(book._id, { stocks: { [loc]: 0 } });
  assert.strictEqual(low.ok, false, '馆藏低于未归还数量应拒绝');
  assert.ok((low.msg || '').includes('库存'));

  // 归还并清零库存后可删除
  const mine = await mock.getMyBorrows();
  await mock.confirmBorrow(mine[0]._id);
  await mock.requestReturn(mine[0]._id, nextScheduledDate(schedule));
  await mock.returnBook(mine[0]._id);
  const zero = await mock.updateBook(book._id, { stocks: { [loc]: 0 } });
  assert.strictEqual(zero.ok, true, '归还后可将库存清零');
  const del2 = await mock.deleteBook(book._id);
  assert.strictEqual(del2.ok, true, '库存清零且无借阅后应可删除');
});

test('取消预约借出（本人）：取消后释放库存与限借名额，可重新申请', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);

  const r1 = await mock.borrowBook(book._id, loc, pickup);
  assert.strictEqual(r1.ok, true, '申请应成功');
  const mine = await mock.getMyBorrows();
  const bid = mine[0]._id;

  // 取消前：占用 1 本、待确认 1
  let occ = await mock.getBookOccupied(book._id);
  assert.strictEqual(occ[loc], 1, '取消前占用 1 本');
  let stats = await mock.getStats();
  assert.strictEqual(stats.pendingTotal, 1);

  // 本人取消
  const c = await mock.cancelBorrow(bid);
  assert.strictEqual(c.ok, true, '本人取消应成功');
  const mine2 = await mock.getMyBorrows();
  assert.strictEqual(mine2[0].status, BORROW_STATUS.CANCELLED, '取消后应为已取消');

  // 库存与名额释放
  occ = await mock.getBookOccupied(book._id);
  assert.strictEqual(occ[loc], undefined, '取消后不再占用库存');
  stats = await mock.getStats();
  assert.strictEqual(stats.pendingTotal, 0, '取消后待确认为 0');
  assert.strictEqual(stats.borrowedTotal, 0, '已取消不计入未归还数');

  // 已取消不能确认借出 / 不能重复取消
  const cf = await mock.confirmBorrow(bid);
  assert.strictEqual(cf.ok, false, '已取消的申请不能再确认借出');
  const c2 = await mock.cancelBorrow(bid);
  assert.strictEqual(c2.ok, false, '已取消的申请不能再取消');

  // 同一用户可重新申请同一本书（防重判断应排除已取消记录）
  const r2 = await mock.borrowBook(book._id, loc, pickup);
  assert.strictEqual(r2.ok, true, '取消后应可重新申请');
});

test('管理员可取消他人的预约借出申请', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  // 注入其他用户的待确认申请
  const db = rawDb();
  db.users.push({ _id: 'u_other', openid: 'openid_other', nickname: '其他用户', role: 'user', createdAt: Date.now() });
  db.borrows.push({
    _id: 'br_other',
    bookId: book._id,
    location: loc,
    userId: 'openid_other',
    userName: '其他用户',
    borrowDate: new Date(),
    scheduledPickupDate: util.formatDate(util.addDays(new Date(), 1)),
    dueDate: null,
    returnDate: null,
    status: BORROW_STATUS.PENDING
  });

  const c = await mock.cancelBorrow('br_other');
  assert.strictEqual(c.ok, true, '管理员可取消他人申请');
  const rec = rawDb().borrows.find((r) => r._id === 'br_other');
  assert.strictEqual(rec.status, BORROW_STATUS.CANCELLED);
});

test('非本人且非管理员不能取消他人的预约借出申请', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const db = rawDb();
  // 将当前用户降为普通读者，模拟"非本人非管理员"
  db.users[0].role = 'user';
  db.users.push({ _id: 'u_other', openid: 'openid_other', nickname: '其他用户', role: 'user', createdAt: Date.now() });
  db.borrows.push({
    _id: 'br_other',
    bookId: book._id,
    location: loc,
    userId: 'openid_other',
    userName: '其他用户',
    borrowDate: new Date(),
    scheduledPickupDate: util.formatDate(util.addDays(new Date(), 1)),
    dueDate: null,
    returnDate: null,
    status: BORROW_STATUS.PENDING
  });

  const c = await mock.cancelBorrow('br_other');
  assert.strictEqual(c.ok, false, '无权限应拒绝');
  assert.ok((c.msg || '').includes('权限'), '提示应包含"权限"');
  const rec = rawDb().borrows.find((r) => r._id === 'br_other');
  assert.strictEqual(rec.status, BORROW_STATUS.PENDING, '状态不应改变');
});

test('取消预约还书（本人）：回到借出中，可再次预约还书', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);
  const returnDate = nextScheduledDate(schedule, new Date(pickup + 'T00:00:00'));

  await mock.borrowBook(book._id, loc, pickup);
  const mine = await mock.getMyBorrows();
  const bid = mine[0]._id;
  await mock.confirmBorrow(bid);
  await mock.requestReturn(bid, returnDate);
  const mine2 = await mock.getMyBorrows();
  assert.strictEqual(mine2[0].status, BORROW_STATUS.RETURN_REQUESTED, '应先处于预约还书状态');
  assert.ok(mine2[0].scheduledReturnDateText, '应有预约还书日期');

  // 本人取消还书申请
  const c = await mock.cancelReturn(bid);
  assert.strictEqual(c.ok, true, '取消还书申请应成功');
  const mine3 = await mock.getMyBorrows();
  assert.strictEqual(mine3[0].status, BORROW_STATUS.BORROWING, '取消后回到借出中');
  assert.strictEqual(mine3[0].scheduledReturnDateText, '', '预约还书日期应清空');

  // 可再次预约还书
  const r = await mock.requestReturn(bid, returnDate);
  assert.strictEqual(r.ok, true, '取消后可再次预约还书');
});

test('管理员可取消他人的预约还书申请', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const db = rawDb();
  db.users.push({ _id: 'u_other', openid: 'openid_other', nickname: '其他用户', role: 'user', createdAt: Date.now() });
  db.borrows.push({
    _id: 'br_other',
    bookId: book._id,
    location: loc,
    userId: 'openid_other',
    userName: '其他用户',
    borrowDate: new Date(),
    scheduledPickupDate: util.formatDate(util.addDays(new Date(), 1)),
    dueDate: new Date(Date.now() + 86400000 * 10),
    returnDate: null,
    status: BORROW_STATUS.RETURN_REQUESTED,
    scheduledReturnDate: util.formatDate(util.addDays(new Date(), 2))
  });

  const c = await mock.cancelReturn('br_other');
  assert.strictEqual(c.ok, true, '管理员可取消他人还书申请');
  const rec = rawDb().borrows.find((r) => r._id === 'br_other');
  assert.strictEqual(rec.status, BORROW_STATUS.BORROWING, '回到借出中');
  assert.strictEqual(rec.scheduledReturnDate, null, '预约还书日期清空');
});

test('非本人且非管理员不能取消他人的预约还书申请', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const db = rawDb();
  db.users[0].role = 'user';
  db.users.push({ _id: 'u_other', openid: 'openid_other', nickname: '其他用户', role: 'user', createdAt: Date.now() });
  db.borrows.push({
    _id: 'br_other',
    bookId: book._id,
    location: loc,
    userId: 'openid_other',
    userName: '其他用户',
    borrowDate: new Date(),
    scheduledPickupDate: util.formatDate(util.addDays(new Date(), 1)),
    dueDate: new Date(Date.now() + 86400000 * 10),
    returnDate: null,
    status: BORROW_STATUS.RETURN_REQUESTED,
    scheduledReturnDate: util.formatDate(util.addDays(new Date(), 2))
  });

  const c = await mock.cancelReturn('br_other');
  assert.strictEqual(c.ok, false, '无权限应拒绝');
  assert.ok((c.msg || '').includes('权限'), '提示应包含"权限"');
  const rec = rawDb().borrows.find((r) => r._id === 'br_other');
  assert.strictEqual(rec.status, BORROW_STATUS.RETURN_REQUESTED, '状态不应改变');
});

test('非法状态不能取消：borrowing 不能取消借出申请 / pending 不能取消还书', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book, loc } = getFirstBook();
  const schedules = await mock.getSchedules();
  const schedule = schedules.find((s) => s.location === loc);
  const pickup = nextScheduledDate(schedule);
  const returnDate = nextScheduledDate(schedule, new Date(pickup + 'T00:00:00'));

  await mock.borrowBook(book._id, loc, pickup);
  const mine = await mock.getMyBorrows();
  const bid = mine[0]._id;

  // pending：不能取消还书申请
  const r1 = await mock.cancelReturn(bid);
  assert.strictEqual(r1.ok, false, 'pending 状态不能取消还书申请');

  await mock.confirmBorrow(bid);
  // borrowing：不能取消借出申请
  const r2 = await mock.cancelBorrow(bid);
  assert.strictEqual(r2.ok, false, 'borrowing 状态不能取消借出申请');
  // borrowing：未预约还书，不能取消还书申请
  const r3 = await mock.cancelReturn(bid);
  assert.strictEqual(r3.ok, false, 'borrowing 状态不能取消还书申请');

  // 已归还：同样不能取消
  await mock.requestReturn(bid, returnDate);
  await mock.returnBook(bid);
  const r4 = await mock.cancelBorrow(bid);
  assert.strictEqual(r4.ok, false, '已归还记录不能取消借出申请');
  const r5 = await mock.cancelReturn(bid);
  assert.strictEqual(r5.ok, false, '已归还记录不能取消还书申请');
});

// ---------- 借书证 / 用户身份体系 ----------

/** 取某 openid 用户（列表刷新后再取） */
async function userByOpenid(openid) {
  const list = await mock.getUsers();
  return list.find((u) => u.openid === openid);
}

/** 借书证可借日期（某地点） */
async function pickupOf(loc) {
  const schedules = await mock.getSchedules();
  return nextScheduledDate(schedules.find((s) => s.location === loc));
}

test('借书证：首个用户自动为管理员（默认开通第一馆藏卡）；后续用户初始身份为空，仅可浏览不可借阅', async () => {
  resetDb();
  const admin = await mock.login();
  assert.strictEqual(admin.role, 'admin', '首个登录的主账号应自动成为管理员');
  // 管理员是复合身份：创建时默认开通第一馆藏借书证，但借阅仍限该馆藏
  const adminSettings = await mock.getSettings();
  assert.strictEqual(admin.card && admin.card.status, 'active', '首个管理员应默认开通借书证');
  assert.strictEqual(admin.card.location, adminSettings.locations[0], '首个管理员默认卡归属第一馆藏');

  // 新注册用户（无卡初始身份）
  const t1 = await mock.login({ openid: 'mock_test_001' });
  assert.strictEqual(t1.role, 'user');
  assert.ok(!t1.card || t1.card.status === 'none', '初始身份应为无借书证');

  const { book, loc } = getFirstBook();
  await mock.updateBook(book._id, { stocks: { [loc]: 5 } });
  const pickup = await pickupOf(loc);
  const r = await mock.borrowBook(book._id, loc, pickup, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '无借书证不可借阅');
  assert.ok(/借书证/.test(r.msg), '应提示申请开通借书证：' + r.msg);
});

test('借书证：申请→驳回→重新申请→审批通过→方可借阅', async () => {
  resetDb();
  await mock.login(); // 主账号管理员
  const { book, loc } = getFirstBook();
  await mock.updateBook(book._id, { stocks: { [loc]: 5 } });
  const pickup = await pickupOf(loc);

  // 非法馆藏被拒
  let r = await mock.applyCard({ phone: '13800001001', location: '不存在馆藏' }, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '非法馆藏应被拒');

  // 提交申请 → pending
  r = await mock.applyCard({ phone: '13800001001', location: loc }, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, true, '申请提交成功');
  assert.strictEqual(r.card.status, 'pending');

  // 审批中不可借
  r = await mock.borrowBook(book._id, loc, pickup, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '审批中不可借阅');
  assert.ok(/审批中/.test(r.msg), r.msg);

  // 重复申请覆盖旧手机号
  await mock.applyCard({ phone: '13800001002', location: loc }, { openid: 'mock_test_001' });
  let t1 = await userByOpenid('mock_test_001');
  assert.strictEqual(t1.card.phone, '13800001002', '重复申请应覆盖旧申请');

  // 驳回 → rejected → 不可借
  r = await mock.rejectCard(t1._id);
  assert.strictEqual(r.ok, true, '驳回成功');
  r = await mock.borrowBook(book._id, loc, pickup, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '被驳回不可借阅');
  assert.ok(/驳回/.test(r.msg), r.msg);

  // 重新申请 → 审批通过 → 可借
  await mock.applyCard({ phone: '13800001001', location: loc }, { openid: 'mock_test_001' });
  t1 = await userByOpenid('mock_test_001');
  r = await mock.approveCard(t1._id);
  assert.strictEqual(r.ok, true, '审批通过成功');
  r = await mock.borrowBook(book._id, loc, pickup, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, true, '审批通过后可借阅');
});

test('借书证：已开通用户仅可借其归属馆藏的图书（跨馆藏被拒）', async () => {
  resetDb();
  await mock.login();
  const settings = await mock.getSettings();
  const locs = settings.locations || [];
  assert.ok(locs.length >= 2, '应配置至少两个馆藏地点');
  const [gz, xa] = locs;
  const book = rawDb().books.find((x) => (x.stocks[gz] || 0) > 0 && (x.stocks[xa] || 0) > 0);
  assert.ok(book, '应存在两馆藏均有库存的图书');
  await mock.updateBook(book._id, { stocks: { [gz]: 5, [xa]: 5 } });

  // test2 预置已开通卡：归属第一个馆藏 gz
  const t2 = await mock.login({ openid: 'mock_test_002' });
  assert.strictEqual(t2.card.status, 'active', 'test2 应预置已开通借书证');
  assert.strictEqual(t2.card.location, gz, 'test2 归属馆藏应为第一个地点');

  // 跨馆藏借阅被拒
  let r = await mock.borrowBook(book._id, xa, await pickupOf(xa), { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, false, '跨馆藏不可借');
  assert.ok(r.msg.includes('仅可借阅'), r.msg);

  // 归属馆藏可借
  r = await mock.borrowBook(book._id, gz, await pickupOf(gz), { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, true, '归属馆藏可借阅');
});

test('借书证：管理员剔除借书证——存在未归还借阅时拒绝，剔除后删除全部关联数据', async () => {
  resetDb();
  await mock.login();
  const settings = await mock.getSettings();
  const gz = settings.locations[0];
  const book = rawDb().books.find((x) => (x.stocks[gz] || 0) > 0);
  await mock.updateBook(book._id, { stocks: { [gz]: 5 } });
  const pickup = await pickupOf(gz);
  await mock.login({ openid: 'mock_test_002' });
  let t2 = await userByOpenid('mock_test_002');
  assert.ok(t2, 'test2 用户应存在');

  // 有活跃借阅时不可剔除
  let r = await mock.borrowBook(book._id, gz, pickup, { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, true);
  r = await mock.removeCard(t2._id);
  assert.strictEqual(r.ok, false, '存在未归还借阅不可剔除');
  assert.ok(/未归还/.test(r.msg), r.msg);

  // 完成归还后剔除：删除其全部借阅数据、卡回到未开通
  const mine = await mock.getMyBorrows({ openid: 'mock_test_002' });
  assert.strictEqual(mine.length, 1, '借阅记录应落库');
  const rec = mine[0];
  await mock.confirmBorrow(rec._id);
  const returnDate = nextScheduledDate((await mock.getSchedules()).find((s) => s.location === gz), new Date(pickup + 'T00:00:00'));
  const rr = await mock.requestReturn(rec._id, returnDate);
  assert.strictEqual(rr.ok, true, '预约还书成功');
  assert.strictEqual((await mock.returnBook(rec._id)).ok, true, '确认归还成功');
  r = await mock.removeCard(t2._id);
  assert.strictEqual(r.ok, true, '归还后剔除成功');
  assert.ok(!rawDb().borrows.some((x) => x.userId === 'mock_test_002'), '关联借阅数据已全部删除');
  t2 = await userByOpenid('mock_test_002');
  assert.strictEqual(t2.card.status, 'none', '剔除后卡状态为未开通');
  r = await mock.borrowBook(book._id, gz, pickup, { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, false, '剔除后不可借阅，需重新申请');
});

test('复合身份：管理员并非借阅豁免——无卡管理员须先办卡、带卡管理员仍限归属馆藏、升降级不清卡', async () => {
  resetDb();
  const admin = await mock.login(); // 主账号：首个管理员（默认开通第一馆藏卡）
  await mock.login({ openid: 'mock_test_001' }); // t1：无卡 user
  await mock.login({ openid: 'mock_test_002' }); // t2：预置 gz 卡 user
  const settings = await mock.getSettings();
  const locs = settings.locations || [];
  assert.ok(locs.length >= 2, '应配置至少两个馆藏地点');
  const [gz, xa] = locs;
  const book = rawDb().books.find((x) => (x.stocks[gz] || 0) > 0 && (x.stocks[xa] || 0) > 0);
  assert.ok(book, '应存在两馆藏均有库存的图书');
  await mock.updateBook(book._id, { stocks: { [gz]: 5, [xa]: 5 } });
  const pgz = await pickupOf(gz);
  const pxa = await pickupOf(xa);

  // 0) 首个管理员（主账号）默认卡：本馆藏可借、跨馆藏被拒（管理员不豁免馆藏范围）
  let r = await mock.borrowBook(book._id, gz, pgz, {});
  assert.strictEqual(r.ok, true, '首个管理员可借本馆藏');
  r = await mock.borrowBook(book._id, xa, pxa, {});
  assert.strictEqual(r.ok, false, '首个管理员跨馆藏被拒');
  assert.ok(r.msg.includes('仅可借阅'), r.msg);

  // 无卡 user 不可借
  r = await mock.borrowBook(book._id, gz, pgz, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '无卡 user 不可借');

  // 1) 升格 t1 为管理员（无卡）：仅叠加角色，卡仍无 → 借阅依旧被拒
  let t1 = await userByOpenid('mock_test_001');
  let rp = await mock.promoteAdmin(t1._id);
  assert.strictEqual(rp.ok, true, '升格成功');
  const t1Admin = await mock.login({ openid: 'mock_test_001' });
  assert.strictEqual(t1Admin.role, 'admin');
  assert.ok(!t1Admin.card || t1Admin.card.status === 'none', '升格不清卡：无卡管理员仍无卡');
  r = await mock.borrowBook(book._id, gz, pgz, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '无卡管理员同样不可借（管理员身份不是借阅豁免）');
  assert.ok(/借书证/.test(r.msg), r.msg);

  // 2) 管理员无卡可申请借书证，并由另一管理员审批通过
  r = await mock.applyCard({ phone: '13800009999', location: gz }, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, true, '管理员可提交借书证申请');
  t1 = await userByOpenid('mock_test_001');
  r = await mock.approveCard(t1._id);
  assert.strictEqual(r.ok, true, '管理员的借书证申请可被审批通过');

  // 3) 带卡管理员：本馆藏可借、跨馆藏被拒
  r = await mock.borrowBook(book._id, gz, pgz, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, true, '带卡管理员可借归属馆藏');
  r = await mock.borrowBook(book._id, xa, pxa, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '带卡管理员跨馆藏被拒');
  assert.ok(r.msg.includes('仅可借阅'), r.msg);

  // 4) 降级回 user：保留原卡（active），且限制随读者身份走
  t1 = await userByOpenid('mock_test_001');
  let rd = await mock.demoteAdmin(t1._id);
  assert.strictEqual(rd.ok, true, '降级成功');
  const t1After = await userByOpenid('mock_test_001');
  assert.strictEqual(t1After.role, 'user', '降级后为普通用户');
  assert.strictEqual(t1After.card.status, 'active', '降级保留原借书证');
  r = await mock.borrowBook(book._id, xa, pxa, { openid: 'mock_test_001' });
  assert.strictEqual(r.ok, false, '降级后仍限归属馆藏（跨馆藏被拒）');

  // 5) 对非管理员执行降级 → 拒绝
  rp = await mock.demoteAdmin(t1._id);
  assert.strictEqual(rp.ok, false, '非管理员不能降级');
  assert.ok(/不是管理员/.test(rp.msg), rp.msg);

  // 6) 带卡 user 升格为管理员：卡保留，跨馆藏依旧被拒
  const t2 = await userByOpenid('mock_test_002');
  rp = await mock.promoteAdmin(t2._id);
  assert.strictEqual(rp.ok, true, '带卡用户升格成功');
  const t2After = await userByOpenid('mock_test_002');
  assert.strictEqual(t2After.role, 'admin');
  assert.strictEqual(t2After.card.status, 'active', '升格不清卡，原卡保留');
  r = await mock.borrowBook(book._id, gz, pgz, { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, true, '带卡管理员可借归属馆藏');
  r = await mock.borrowBook(book._id, xa, pxa, { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, false, '带卡管理员跨馆藏仍被拒');
  assert.ok(r.msg.includes('仅可借阅'), r.msg);
});

test('复合身份：管理员的借书证可被剔除（不影响管理角色，仅不可借阅），剔除后仍可重新申请', async () => {
  resetDb();
  await mock.login(); // 主账号管理员（操作者）
  const settings = await mock.getSettings();
  const gz = settings.locations[0];
  // 让 test2（user + gz 卡）升格为带卡管理员
  const book = rawDb().books.find((x) => (x.stocks[gz] || 0) > 0);
  await mock.updateBook(book._id, { stocks: { [gz]: 5 } });
  const pickup = await pickupOf(gz);
  await mock.login({ openid: 'mock_test_002' });
  let t2 = await userByOpenid('mock_test_002');
  let rp = await mock.promoteAdmin(t2._id);
  assert.strictEqual(rp.ok, true, '升格成功');
  t2 = await userByOpenid('mock_test_002');
  assert.strictEqual(t2.role, 'admin');
  assert.strictEqual(t2.card.status, 'active');

  // 带卡管理员可借归属馆藏
  let r = await mock.borrowBook(book._id, gz, pickup, { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, true, '带卡管理员可借');

  // 有未归还借阅时不可剔除
  r = await mock.removeCard(t2._id);
  assert.strictEqual(r.ok, false, '存在未归还借阅不可剔除');
  assert.ok(/未归还/.test(r.msg), r.msg);

  // 完成还书后剔除带卡管理员：卡回到未开通，但 role 仍是 admin（管理权限不受影响）
  const mine = await mock.getMyBorrows({ openid: 'mock_test_002' });
  const rec = mine[0];
  await mock.confirmBorrow(rec._id);
  const returnDate = nextScheduledDate((await mock.getSchedules()).find((s) => s.location === gz), new Date(pickup + 'T00:00:00'));
  const rr = await mock.requestReturn(rec._id, returnDate);
  assert.strictEqual(rr.ok, true, '预约还书成功');
  assert.strictEqual((await mock.returnBook(rec._id)).ok, true, '确认归还成功');
  r = await mock.removeCard(t2._id);
  assert.strictEqual(r.ok, true, '管理员的借书证可被剔除');
  t2 = await userByOpenid('mock_test_002');
  assert.strictEqual(t2.role, 'admin', '剔除借书证不影响管理角色');
  assert.strictEqual(t2.card.status, 'none', '剔除后卡状态为未开通');
  r = await mock.borrowBook(book._id, gz, pickup, { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, false, '无卡管理员不可借（借阅需持卡）');

  // 管理员重新申请借书证 → 可恢复借阅
  r = await mock.applyCard({ phone: '13800002002', location: gz }, { openid: 'mock_test_002' });
  assert.strictEqual(r.ok, true, '管理员可重新申请借书证');
  t2 = await userByOpenid('mock_test_002');
  assert.strictEqual(t2.card.status, 'pending', '重新申请后为待审批');
});

test('测试后门：getTestAccounts 提供主账号/test1/test2 模拟身份，test2 预置开通卡', async () => {
  resetDb();
  const accs = await mock.getTestAccounts();
  assert.strictEqual(accs.length, 3, '应返回主账号 + test1 + test2');
  const t1 = accs.find((a) => a.nickname === 'test1');
  const t2 = accs.find((a) => a.nickname === 'test2');
  assert.ok(t1 && t2, '应包含 test1 与 test2');
  assert.ok(/新注册用户/.test(t1.desc), 'test1 描述：新用户无卡');
  assert.ok(/借书证/.test(t2.desc), 'test2 描述：已开通借书证');

  // 模拟登录 test1 → user 无卡
  const u1 = await mock.login({ openid: t1.openid });
  assert.strictEqual(u1.role, 'user');
  assert.strictEqual(u1.nickname, 'test1');
  assert.ok(!u1.card || u1.card.status === 'none');

  // 模拟登录 test2 → user 且带已开通卡
  const u2 = await mock.login({ openid: t2.openid });
  assert.strictEqual(u2.role, 'user');
  assert.strictEqual(u2.card.status, 'active');
  assert.ok(u2.card.location, 'test2 应有归属馆藏');

  // 无参登录回到主账号（管理员）
  const admin = await mock.login();
  assert.strictEqual(admin.role, 'admin', '回到主账号仍是管理员');
});
