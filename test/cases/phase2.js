/**
 * 第二期功能回归用例
 * 覆盖：书评（发布/编辑/聚合/隐藏/点赞约束）、通知（群发/未读/已读）、
 *       待办（增删改）、统计接口字段、CSV 导出、推荐（排除已借阅）
 */
'use strict';

const { test, mock, assert, resetDb, rawDb, getFirstBook, util } = require('../helpers');

/* ------------------------------- 书评 ------------------------------- */

test('书评：首次发布后再次提交视为编辑，评分聚合回写书籍', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book } = getFirstBook();

  const r1 = await mock.submitReview({ bookId: book._id, rating: 5, content: '这本书写得非常好，值得反复阅读' });
  assert.strictEqual(r1.ok, true, '首次发布应成功');

  let summary = await mock.getReviews({ bookId: book._id });
  assert.strictEqual(summary.summary.count, 1, '应有一条书评');
  assert.strictEqual(summary.summary.avg, 5, '平均分应为 5');

  const r2 = await mock.submitReview({ bookId: book._id, rating: 3, content: '再读一遍，觉得节奏稍慢了一些' });
  assert.strictEqual(r2.ok, true, '重复提交应成功');
  assert.strictEqual(r2.data.updated, true, '重复提交应视为编辑');

  summary = await mock.getReviews({ bookId: book._id });
  assert.strictEqual(summary.total, 1, '一人一书只保留一条');

  const stored = rawDb().books.find((b) => b._id === book._id);
  assert.strictEqual(stored.ratingCount, 1, '书籍评论数应同步');
  assert.strictEqual(stored.ratingAvg, 3, '书籍平均分应同步为编辑后的 3 分');
});

test('书评：内容过短、命中敏感词均被拒绝', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book } = getFirstBook();

  const tooShort = await mock.submitReview({ bookId: book._id, rating: 5, content: '好' });
  assert.strictEqual(tooShort.ok, false, '少于 5 字应被拒绝');

  const banned = await mock.submitReview({ bookId: book._id, rating: 5, content: '想看的加微信联系我' });
  assert.strictEqual(banned.ok, false, '敏感词应被拒绝');

  const noRating = await mock.submitReview({ bookId: book._id, rating: 0, content: '这本书还不错，推荐一读' });
  assert.strictEqual(noRating.ok, false, '未评分应被拒绝');
});

test('书评：管理员隐藏后不再展示，评分聚合归零；不能给自己点赞', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });
  const { book } = getFirstBook();
  await mock.submitReview({ bookId: book._id, rating: 4, content: '内容扎实，适合入门阅读' });

  const list = await mock.getReviews({ bookId: book._id });
  const reviewId = list.list[0]._id;

  const selfLike = await mock.likeReview(reviewId);
  assert.strictEqual(selfLike.ok, false, '不能给自己的书评点赞');

  const hide = await mock.adminSetReviewStatus(reviewId, 'hidden');
  assert.strictEqual(hide.ok, true);

  const after = await mock.getReviews({ bookId: book._id });
  assert.strictEqual(after.summary.count, 0, '隐藏后不应计入展示列表');

  const stored = rawDb().books.find((b) => b._id === book._id);
  assert.strictEqual(stored.ratingCount, 0, '隐藏后评分聚合应归零');
});

/* ------------------------------- 通知 ------------------------------- */

test('通知：管理员群发写入站内通知，未读数与全部已读联动', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });

  const send = await mock.sendNotification({ scope: 'all', title: '闭馆通知', content: '本周日闭馆一天' });
  assert.strictEqual(send.ok, true);
  assert.ok(send.data.sent >= 1, '至少送达 1 人');

  assert.strictEqual(await mock.getUnreadNotifCount(), 1, '未读数应为 1');

  const list = await mock.getNotifications({ page: 1, pageSize: 20 });
  assert.strictEqual(list.total, 1);
  assert.strictEqual(list.list[0].title, '闭馆通知');

  await mock.markAllNotifRead();
  assert.strictEqual(await mock.getUnreadNotifCount(), 0, '全部已读后未读数应为 0');
});

/* ------------------------------- 待办 ------------------------------- */

test('待办：新增→出现在未完成→勾选完成→删除', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });

  const add = await mock.addTodo({ title: '整理书架', dueDate: util.cstTodayStr(), priority: 'high' });
  assert.strictEqual(add.ok, true);

  let todos = await mock.getTodos();
  const item = todos.active.find((t) => t.title === '整理书架');
  assert.ok(item, '新待办应出现在未完成列表');
  assert.strictEqual(item.priority, 'high');

  await mock.toggleTodo(add.data.id, true);
  todos = await mock.getTodos();
  assert.strictEqual(todos.active.filter((t) => t.title === '整理书架').length, 0, '完成后应移出未完成');
  assert.ok(todos.done.some((t) => t.title === '整理书架'), '应进入已完成');

  await mock.removeTodo(add.data.id);
  todos = await mock.getTodos();
  assert.strictEqual(todos.done.filter((t) => t.title === '整理书架').length, 0, '删除后应彻底移除');
});

/* ------------------------------- 借阅页签计数 ------------------------------- */

test('借阅页签计数：各状态数量与列表条数一致，逾期为借出中的子集', async () => {
  resetDb();
  const me = await mock.login({ nickname: '管理员' });
  const db = rawDb();
  const book = db.books[0];
  const DAY = 86400000;
  const base = { userId: me.openid, bookId: book._id, bookTitle: book.title, borrowDate: Date.now() - 10 * DAY };
  db.borrows = [
    Object.assign({ _id: 't1', status: 'pending' }, base),
    Object.assign({ _id: 't2', status: 'borrowing', dueDate: Date.now() + 5 * DAY }, base),
    Object.assign({ _id: 't3', status: 'borrowing', dueDate: Date.now() - 2 * DAY }, base),
    Object.assign({ _id: 't4', status: 'return_requested', dueDate: Date.now() + 3 * DAY }, base),
    Object.assign({ _id: 't5', status: 'returned', dueDate: Date.now() - 1 * DAY, returnDate: Date.now() }, base),
    Object.assign({ _id: 't6', status: 'cancelled' }, base)
  ];

  const c = await mock.getBorrowStatusCounts();
  assert.strictEqual(c.all, 6, '全部应为 6 条');
  assert.strictEqual(c.pending, 1);
  assert.strictEqual(c.borrowing, 2, '借出中为 DB 原始 borrowing 条数（含逾期）');
  assert.strictEqual(c.overdue, 1, '逾期只算 borrowing 且已过应还日期');
  assert.strictEqual(c.return_requested, 1);
  assert.strictEqual(c.returned, 1);
  assert.strictEqual(c.cancelled, 1);

  const borrowingList = await mock.getBorrows({ status: 'borrowing' });
  assert.strictEqual(borrowingList.length, c.borrowing, '「借出中」页签数字应等于点进去的列表条数');
  const overdueList = await mock.getBorrows({ status: 'overdue' });
  assert.strictEqual(overdueList.length, c.overdue, '「逾期」页签数字应等于点进去的列表条数');
  assert.ok(overdueList.length <= borrowingList.length, '逾期是借出中的子集，不应多于借出中');
});

test('借阅记录不再携带 bookCover：存量字段在出口被剔除', async () => {
  resetDb();
  const me = await mock.login({ nickname: '管理员' });
  const db = rawDb();
  const book = db.books[0];
  // 模拟存量记录：早期写入过 base64 封面副本
  db.borrows = [
    {
      _id: 'legacy1',
      bookId: book._id,
      bookTitle: book.title,
      bookCover: 'data:image/jpeg;base64,AAAA',
      userId: me.openid,
      userName: me.nickname,
      location: '广州',
      status: 'returned',
      borrowDate: Date.now() - 86400000,
      dueDate: Date.now() - 3600000,
      returnDate: Date.now() - 1800000
    }
  ];

  const has = (o) => Object.prototype.hasOwnProperty.call(o, 'bookCover');
  const adminList = await mock.getBorrows({});
  assert.ok(adminList.length === 1 && !has(adminList[0]), '管理端列表应剔除 bookCover');
  const mine = await mock.getMyBorrows({ nickname: '管理员' });
  assert.ok(mine.length === 1 && !has(mine[0]), '我的借阅应剔除 bookCover');
  const byBook = await mock.getBorrowsByBook(book._id);
  assert.ok(byBook.length === 1 && !has(byBook[0]), '图书借阅记录应剔除 bookCover');
});

/* ------------------------------- 统计与导出 ------------------------------- */

test('统计：用户/书籍统计返回完整结构，CSV 含 BOM 与表头', async () => {
  resetDb();
  await mock.login({ nickname: '管理员' });

  const userStats = await mock.getUserStats(30);
  assert.ok(!userStats.error, '用户统计不应报错');
  assert.ok(userStats.cards && userStats.cards.total >= 1, '应有注册用户数');
  assert.ok(Array.isArray(userStats.trend) && userStats.trend.length === 30, '趋势应有 30 个点');

  const bookStats = await mock.getBookStats(30);
  assert.ok(!bookStats.error, '书籍统计不应报错');
  assert.ok(bookStats.cards.kinds > 0, '应有书籍种类数');
  assert.ok(Array.isArray(bookStats.categoryChart), '应有分类分布');

  const users = await mock.exportUsersCsv(30);
  assert.ok(users.content.charCodeAt(0) === 0xfeff, 'CSV 应带 UTF-8 BOM（Excel 中文不乱码）');
  assert.ok(users.content.indexOf('昵称') >= 0, 'CSV 应包含表头');

  const books = await mock.exportBooksCsv(30);
  assert.ok(books.content.indexOf('书名') >= 0, '书籍 CSV 应包含表头');
  assert.ok(books.rows > 0, '书籍导出行数应大于 0');
});

/* ------------------------------- 推荐 ------------------------------- */

test('推荐：返回可借图书且排除已借阅/已评论，理由文案非空', async () => {
  resetDb();
  const me = await mock.login({ nickname: '管理员' });
  const db = rawDb();
  const target = db.books[0];

  // 构造一条历史借阅，验证推荐会排除它
  db.borrows.push({
    _id: 'b_test',
    userId: me.openid,
    bookId: target._id,
    bookTitle: target.title,
    status: 'returned',
    borrowDate: Date.now() - 86400000,
    dueDate: Date.now() + 86400000
  });

  const res = await mock.getRecommendations({ limit: 6, offset: 0 });
  assert.ok(Array.isArray(res.list), '应返回列表');
  assert.ok(res.list.length > 0, '应有推荐结果');
  assert.ok(
    res.list.every((b) => b._id !== target._id),
    '不应推荐用户已借过的书'
  );
  assert.ok(
    res.list.every((b) => !!b.reason),
    '每条推荐都应有推荐理由'
  );
});
