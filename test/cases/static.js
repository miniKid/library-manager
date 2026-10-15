/**
 * 静态源码检查用例
 * 不运行小程序/云函数，直接读取源码做一致性校验，用于回归历史 bug：
 *  - cloud.js 中 `_` 是函数，必须 `_().neq(...)`（回归 "_.neq is not a function"）
 *  - 云函数中 `_ = db.command` 是对象，直接 `_.neq(...)`
 *  - mock/cloud 的 module.exports 必须包含页面调用的全部方法（回归 confirmBorrow/requestReturn 未导出）
 *  - WXML data- 属性命名与页面 JS 的 dataset 解构大小写一致（回归书名 undefined）
 *  - getBorrows / getMyBorrows 输出 deliverDateText（回归交付时间字段缺失）
 *  - 云函数确认借出写入 deliverDate 而非覆盖 borrowDate（回归申请时间被覆盖）
 *  - 预约还书值班配置须在 onShow 清缓存并重新拉取（回归调整值班后还书可选日期不刷新）
 */
'use strict';

const path = require('path');

const {
  test,
  mock,
  assert,
  read,
  walk,
  ROOT,
  PAGES_DIR
} = require('../helpers');

const CLOUD_JS = path.join(ROOT, 'miniprogram/services/cloud.js');
const MOCK_JS = path.join(ROOT, 'miniprogram/services/mock.js');
const FN_JS = path.join(ROOT, 'cloudfunctions/borrowManager/index.js');

const cloudJs = read(CLOUD_JS);
const mockJs = read(MOCK_JS);
const fnJs = read(FN_JS);

const ADMIN_INDEX_JS = path.join(PAGES_DIR, 'admin/index.js');
const ADMIN_INDEX_WXML = path.join(PAGES_DIR, 'admin/index.wxml');
const BORROWS_INDEX_JS = path.join(PAGES_DIR, 'admin/borrows/index.js');

const adminIndexJs = read(ADMIN_INDEX_JS);
const adminIndexWxml = read(ADMIN_INDEX_WXML);
const borrowsIndexJs = read(BORROWS_INDEX_JS);
const BOOK_DETAIL_JS = path.join(PAGES_DIR, 'book-detail/index.js');
const bookDetailJs = read(BOOK_DETAIL_JS);

test('静态检查：cloud.js 不使用裸 _.xxx（回归 "_.neq is not a function"）', () => {
  // cloud.js 的 command 一律经 db().command / d.command 访问，禁止把 _ 当裸对象直接 _.neq(...
  const bad = cloudJs.match(/(?<![A-Za-z0-9_$])_\.(neq|nin|gt|lt|gte|lte|in|exists|inc|mul)\s*\(/);
  assert.strictEqual(bad, null, 'cloud.js 不应出现裸 _ .xxx( 调用' + (bad ? '，实际为：' + bad[0].trim() : ''));
  // 与云函数区分：cloud.js 中不得定义 const _ = db.command（_ 不是 command 对象）
  assert.ok(!/const\s+_\s*=\s*db\.command/.test(cloudJs), 'cloud.js 不应定义 const _ = db.command');
  assert.ok(!/const\s+_\s*=/.test(cloudJs), 'cloud.js 不应定义 const _ =（命令对象请经 db().command / d.command 访问）');
  // 若未来重新引入 _ 函数，必须是 _().xxx 形式
  if (/_\(\)/.test(cloudJs)) {
    assert.ok(/_\(\)\.(neq|nin|gt|lt|gte|lte|in|exists)\s*\(/.test(cloudJs), 'cloud.js 若用 _() 必须是 _().xxx(...) 形式');
  }
});

test('静态检查：云函数中 _ 为 db.command 对象，用法与 cloud.js 相反', () => {
  assert.ok(fnJs.includes('const _ = db.command'), '云函数应定义 const _ = db.command');
  assert.ok(/_\.(neq|nin)\s*\(/.test(fnJs), '云函数可直接 _ .neq( / _ .nin(...)');
  const bad = fnJs.match(/_\(\)\.(neq|nin)\s*\(/);
  assert.strictEqual(bad, null, '云函数不应出现 _().xxx(...)（_ 不是函数）');
});

test('静态检查：mock.js / cloud.js 的 exports 必须覆盖页面调用的全部 services 方法', () => {
  // 运行时：页面所有 services.xxx( 调用在 mock 上都应存在
  const used = new Set();
  for (const jsFile of walk(PAGES_DIR, '.js')) {
    const src = read(jsFile);
    const re = /\bservices\.([A-Za-z0-9_]+)\s*\(/g;
    let m;
    while ((m = re.exec(src))) used.add(m[1]);
  }
  assert.ok(used.size > 0, '应扫描到页面中的 services 调用');
  for (const name of used) {
    assert.strictEqual(typeof mock[name], 'function', '页面调用 services.' + name + '，但 mock.js 未导出该函数');
  }
  // 源码层面：cloud.js exports 块与 mock.js exports 块同步
  const mockExports = mockJs.slice(mockJs.indexOf('module.exports'));
  const cloudExports = cloudJs.slice(cloudJs.indexOf('module.exports'));
  for (const name of used) {
    assert.ok(cloudExports.includes(name), 'cloud.js exports 缺少页面调用的 ' + name);
  }
});

test('静态检查：WXML data- 属性与页面 JS 的 dataset 解构大小写一致（回归书名 undefined）', () => {
  const pairs = [];
  for (const wxml of walk(PAGES_DIR, '.wxml')) {
    const js = wxml.replace(/\.wxml$/, '.js');
    if (require('fs').existsSync(js)) pairs.push({ js, wxml });
  }
  assert.ok(pairs.length > 0, '应扫描到页面文件对');
  for (const { js, wxml } of pairs) {
    const wsrc = read(wxml);
    const jsrc = read(js);
    const attrs = new Set();
    // 收集 WXML 中所有 data- 属性（含 data-field="isbn" 这类静态值，同样会进入 dataset）
    const re = /\bdata-([a-zA-Z0-9-]+)=/g;
    let m;
    while ((m = re.exec(wsrc))) {
      const raw = m[1];
      assert.ok(!/[A-Z]/.test(raw), js + ': WXML 属性 data-' + raw + ' 含大写字母，dataset 会转为小写，存在 undefined 风险（应改用小写连字符，如 data-' + raw.toLowerCase() + '）');
      // 微信 dataset 规则：data-foo-bar -> fooBar；data-foo -> foo
      const datasetName = raw.indexOf('-') >= 0 ? raw.replace(/-([a-z])/g, (_, c) => c.toUpperCase()) : raw;
      attrs.add(datasetName);
    }
    // JS 中从 dataset 解构的变量必须能在 WXML 中找到对应属性
    const destr = /const\s*\{([^}]*)\}\s*=\s*[^;\n]*dataset/g;
    let dm;
    while ((dm = destr.exec(jsrc))) {
      dm[1]
        .split(',')
        .map((s) => s.split('=')[0].split(':')[0].trim())
        .filter(Boolean)
        .forEach((name) => {
          assert.ok(attrs.has(name), js + ': JS 解构 dataset.' + name + '，但 WXML 中无匹配的 data- 属性（请检查连字符写法，如 data-' + name.replace(/([A-Z])/g, '-$1').toLowerCase() + '）');
        });
    }
    // JS 中 dataset.xxx 点访问同样要求 WXML 有对应属性
    const dot = /dataset\.([A-Za-z0-9_]+)/g;
    let dm2;
    while ((dm2 = dot.exec(jsrc))) {
      assert.ok(attrs.has(dm2[1]), js + ': JS 使用 dataset.' + dm2[1] + '，但 WXML 中无匹配的 data- 属性');
    }
  }
});

test('静态检查：借阅列表接口均输出 deliverDateText 交付时间字段', () => {
  // mock.js：getMyBorrows 与 getBorrows 函数体之间
  const m1 = mockJs.indexOf('async function getMyBorrows');
  const m2 = mockJs.indexOf('async function getBorrows');
  const m3 = mockJs.indexOf('async function getBookOccupied');
  assert.ok(m1 >= 0 && m2 >= 0 && m3 >= 0, 'mock.js 应包含对应函数');
  assert.ok(mockJs.slice(m1, m3).includes('deliverDateText'), 'mock.js getMyBorrows/getBorrows 应输出 deliverDateText');

  // cloud.js：getBorrows 函数体
  const c1 = cloudJs.indexOf('async function getBorrows');
  const c2 = cloudJs.indexOf('async function getBookOccupied');
  assert.ok(c1 >= 0 && c2 >= 0, 'cloud.js 应包含对应函数');
  assert.ok(cloudJs.slice(c1, c2).includes('deliverDateText'), 'cloud.js getBorrows 应输出 deliverDateText');

  // 云函数：doMyBorrows 函数体
  const f1 = fnJs.indexOf('async function doMyBorrows');

test('静态检查：cloud.js getBorrows 将 overdue 视为 borrowing 派生状态（回归逾期列表为空）', () => {
  const c1 = cloudJs.indexOf('async function getBorrows');
  const c2 = cloudJs.indexOf('async function getBookOccupied');
  const body = cloudJs.slice(c1, c2);
  assert.ok(body.includes('BORROW_STATUS.OVERDUE ? BORROW_STATUS.BORROWING'), 'cloud.js 应将 overdue 查询映射为 borrowing 后再查');
  assert.ok(body.includes('status !== BORROW_STATUS.OVERDUE'), 'cloud.js 应在筛选 overdue 时按到期日过滤（而非用不存在的 overdue 状态去查）');
});

test('静态检查：管理首页卡片深链到借阅管理具体 tab（data-status + onLoad 预设）', () => {
  // wxml：三张借阅卡片带 data-status 跳到对应 tab
  assert.ok(adminIndexWxml.includes('data-status="borrowing"'), '借出中卡片应带 data-status="borrowing"');
  assert.ok(adminIndexWxml.includes('data-status="pending"'), '待确认卡片应带 data-status="pending"');
  assert.ok(adminIndexWxml.includes('data-status="overdue"'), '已逾期卡片应带 data-status="overdue"');

  // index.js：goBorrows 读取 dataset.status 并拼 ?status= 跳转
  assert.ok(adminIndexJs.includes('?status='), 'goBorrows 应拼 ?status= 跳转');
  assert.ok(adminIndexJs.includes('currentTarget.dataset'), 'goBorrows 应读取 data-status');

  // borrows 页 onLoad 读 options.status 校验后预设 activeFilter
  const b1 = borrowsIndexJs.indexOf('onLoad');
  const b2 = borrowsIndexJs.indexOf('onShow');
  const body = borrowsIndexJs.slice(b1, b2 > b1 ? b2 : borrowsIndexJs.length);
  assert.ok(body.includes('options.status'), 'onLoad 应读取 options.status');
  assert.ok(body.includes('activeFilter'), 'onLoad 应预设 activeFilter');
  assert.ok(body.includes('FILTERS'), 'onLoad 应校验 status 属于 FILTERS 的 key');
});

test('静态检查：详情页「被借次数」跳转完整页面（admin/book-borrows/index）', () => {
  assert.ok(bookDetailJs.includes('/pages/admin/book-borrows/index'), '详情页应跳转到借阅记录完整页面');
  assert.ok(bookDetailJs.includes('onTapBorrowCount'), '详情页应保留 onTapBorrowCount 入口');
  assert.ok(!bookDetailJs.includes('recordPanel'), '详情页不应再保留底部弹窗 recordPanel');
  const bp = path.join(PAGES_DIR, 'admin/book-borrows/index.js');
  assert.ok(require('fs').existsSync(bp), '借阅记录页面 index.js 应存在');
  const bpJs = read(bp);
  assert.ok(bpJs.includes('getBorrowsByBook'), '借阅记录页面应调用 getBorrowsByBook');
  // 筛选应精简：仅检查 FILTERS 数组本身，避免误伤 STATUS_LABEL 中的状态文案
  const fm = bpJs.match(/const FILTERS = \[([\s\S]*?)\];/);
  assert.ok(fm, '借阅记录页应存在 FILTERS 数组');
  const filtersBlock = fm[1];
  assert.ok(!filtersBlock.includes('待确认借出'), 'FILTERS 不应单列「待确认借出」筛选');
  assert.ok(!filtersBlock.includes('已取消'), 'FILTERS 不应单列「已取消」筛选');
  assert.ok(filtersBlock.includes('借出中') && filtersBlock.includes('已归还'), 'FILTERS 应保留 借出中 / 已归还 两个筛选');
  // 借出中筛选应同时覆盖逾期（applyFilter 中 borrowing || overdue）
  assert.ok(bpJs.includes('BORROW_STATUS.BORROWING || r.status === BORROW_STATUS.OVERDUE'), 'applyFilter 中借出中应覆盖逾期状态');
});

test('静态检查：续借功能接线（借阅人申请 + 管理员馆藏配置）', () => {
  // 借阅人页：调用 renewBorrow、提供 onRenew 与可续借判定
  const myJs = read(path.join(PAGES_DIR, 'my/index.js'));
  assert.ok(myJs.includes('services.renewBorrow('), 'my/index.js 应调用 services.renewBorrow');
  assert.ok(myJs.includes('onRenew('), 'my/index.js 应定义 onRenew 处理函数');
  assert.ok(myJs.includes('canRenew'), 'my/index.js 应计算 canRenew（逾期前且未达上限）');
  assert.ok(myJs.includes('renewTip'), 'my/index.js 应展示已续借次数提示');

  // 管理员馆藏设置页：配置续借次数与天数并保存
  const setJs = read(path.join(PAGES_DIR, 'admin/settings/index.js'));
  assert.ok(setJs.includes('renewTimes'), '设置页应含 renewTimes 配置');
  assert.ok(setJs.includes('renewDays'), '设置页应含 renewDays 配置');
  assert.ok(setJs.includes('onRenewTimesInput'), '设置页应绑定续借次数输入');
  assert.ok(setJs.includes('saveSettings(') && setJs.includes('renewTimes'), '设置页保存时应把续借配置传给 saveSettings');

  const setWxml = read(path.join(PAGES_DIR, 'admin/settings/index.wxml'));
  assert.ok(setWxml.includes('onRenewTimesInput'), '设置页 wxml 应绑定续借次数输入框');
  assert.ok(setWxml.includes('onRenewDaysInput'), '设置页 wxml 应绑定续借天数输入框');

  // 服务层与云函数均实现 renewBorrow（导出完整性由统一用例校验）
  assert.ok(cloudJs.includes('async function renewBorrow'), 'cloud.js 应实现 renewBorrow');
  assert.ok(mockJs.includes('async function renewBorrow'), 'mock.js 应实现 renewBorrow');
  assert.ok(fnJs.includes("case 'renewBorrow':"), '云函数应分发 renewBorrow 动作');
  assert.ok(fnJs.includes('async function doRenewBorrow'), '云函数应实现 doRenewBorrow');
});
  const f2 = fnJs.indexOf('exports.main');
  assert.ok(f1 >= 0 && f2 >= 0, '云函数应包含 doMyBorrows');
  assert.ok(fnJs.slice(f1, f2).includes('deliverDateText'), '云函数 doMyBorrows 应输出 deliverDateText');
});

test('静态检查：确认借出写入 deliverDate 且不覆盖 borrowDate（回归申请时间被覆盖）', () => {
  const s1 = fnJs.indexOf('async function doConfirmBorrow');
  const s2 = fnJs.indexOf('async function doRequestReturn');
  assert.ok(s1 >= 0 && s2 >= 0, '云函数应包含 doConfirmBorrow/doRequestReturn');
  const seg = fnJs.slice(s1, s2);
  assert.ok(seg.includes('deliverDate:'), '确认借出应写入 deliverDate');
  assert.ok(!seg.includes('borrowDate:'), '确认借出不应再赋值 borrowDate');

  // mock.js 对应逻辑
  const m1 = mockJs.indexOf('async function confirmBorrow');
  const m2 = mockJs.indexOf('async function requestReturn');
  assert.ok(m1 >= 0 && m2 >= 0, 'mock.js 应包含 confirmBorrow/requestReturn');
  const mseg = mockJs.slice(m1, m2);
  assert.ok(mseg.includes('deliverDate = '), 'mock 确认借出应写入 deliverDate');
  assert.ok(!mseg.includes('borrowDate = '), 'mock 确认借出不应覆盖 borrowDate');
});

test('静态检查：库存锁定查询存在（同书同地点未归还计入占用，排除已取消）', () => {
  // 云函数 doBorrow
  const s1 = fnJs.indexOf('async function doBorrow');
  const s2 = fnJs.indexOf('async function doConfirmBorrow');
  const seg = fnJs.slice(s1, s2);
  assert.ok(
    seg.includes('status: _.nin([BORROW_STATUS.RETURNED, BORROW_STATUS.CANCELLED])'),
    '云函数 doBorrow 应有库存锁定查询（排除已归还与已取消）'
  );
  // mock borrowBook
  const m1 = mockJs.indexOf('async function borrowBook');
  const m2 = mockJs.indexOf('async function confirmBorrow');
  const mseg = mockJs.slice(m1, m2);
  assert.ok(mseg.includes('occupied'), 'mock borrowBook 应包含占用统计逻辑');
});

test('静态检查：预约还书值班配置每次进入页面都刷新（回归调整值班后还书可选日期不更新）', () => {
  const myJs = read(path.join(PAGES_DIR, 'my/index.js'));

  // 页面须定义 onShow
  const showStart = myJs.indexOf('onShow() {');
  assert.ok(showStart >= 0, 'my/index.js 应定义 onShow');
  const loadStart = myJs.indexOf('loadPage() {', showStart);
  assert.ok(loadStart > showStart, 'onShow 之后应紧跟/包含 loadPage 调用');
  const showBlock = myJs.slice(showStart, loadStart);

  // onShow 必须清空缓存的 scheduleMap：否则 my 为 tab 常驻页，管理员调整值班后
  // 点"预约还书"仍会命中旧缓存（含旧周规则与旧单日覆盖），可选日期不刷新
  assert.ok(
    /(?:this\.)?scheduleMap\s*=\s*null|delete\s+this\.scheduleMap/.test(showBlock),
    'onShow 必须清空 scheduleMap 值班缓存（this.scheduleMap = null 或 delete this.scheduleMap）'
  );
  assert.ok(showBlock.includes('loadPage'), 'onShow 清缓存后应刷新页面');

  // 无缓存路径必须能重新拉取最新值班配置
  const reqStart = myJs.indexOf('onRequestReturn(');
  assert.ok(reqStart >= 0, 'my/index.js 应定义 onRequestReturn');
  const reqBlock = myJs.slice(reqStart, reqStart + 1500);
  assert.ok(
    /services\.getSchedules\(\)/.test(reqBlock),
    'onRequestReturn 应通过 services.getSchedules() 拉取最新值班配置'
  );

  // 缓存命中与失效分支必须并存（命中 scheduleMap 时直接弹窗；无缓存时先拉取）
  const hitIdx = myJs.indexOf('if (this.scheduleMap)', reqStart);
  assert.ok(hitIdx >= 0 && hitIdx < reqStart + 500, 'onRequestReturn 应先判断缓存 this.scheduleMap 是否命中');
});

test('静态检查：登录云函数初始化借书证——首个管理员默认开通第一馆藏卡，后续用户初始身份为空', () => {
  const loginJs = read(path.join(ROOT, 'cloudfunctions/login/index.js'));
  const seg = loginJs.slice(loginJs.indexOf('const isAdmin'), loginJs.indexOf('return { user: doc }'));
  assert.ok(!/card:\s*isAdmin\s*\?\s*null/.test(seg),
    'login 云函数创建用户时不应再给管理员 null 卡（管理员为复合身份，须持卡借阅）');
  assert.ok(/card:\s*isAdmin\s*&&\s*firstLoc\s*\?/.test(seg),
    'login 云函数首个管理员应默认开通第一馆藏地点借书证（isAdmin && firstLoc 时 active）');
  assert.ok(/:\s*\{\s*status:\s*['"]none['"]\s*\}\s*,/.test(seg),
    'login 云函数未持默认卡的用户应初始化为 { status: "none" }（含无馆藏可配时的首个管理员）');
  // 兼容旧数据：补齐卡不应再排除管理员
  assert.ok(loginJs.includes('if (!user.card) {'), 'login 云函数应对所有无卡老用户（含管理员）补齐借书证字段');
  assert.ok(!loginJs.includes("user.role !== 'admin' && !user.card"), '兼容旧数据补卡不应再排除管理员');
});

test('静态检查：借书证/用户管理体系——云函数注册 action 且预约借出校验借书证', () => {
  // borrowManager 云函数须注册用户/借书证相关 action
  const actions = ['applyCard', 'approveCard', 'rejectCard', 'removeCard', 'promoteAdmin', 'demoteAdmin', 'users'];
  for (const a of actions) {
    assert.ok(new RegExp("case '" + a + "':").test(fnJs), '云函数 main 应注册 case ' + a);
  }
  // 借出（doBorrow）须含借书证校验：所有用户（含管理员）active 卡 + 归属馆藏匹配，无管理员豁免
  const s1 = fnJs.indexOf('async function doBorrow');
  const s2 = fnJs.indexOf('async function doConfirmBorrow');
  const seg = fnJs.slice(s1, s2);
  assert.ok(seg.includes("card.status !== 'active'"), '云函数 doBorrow 应校验借书证 active 状态');
  assert.ok(/尚未开通借书证/.test(seg), '云函数 doBorrow 无卡时应提示申请借书证');
  assert.ok(!seg.includes('ROLE.ADMIN'), '云函数 doBorrow 不应存在管理员豁免（管理员为复合身份，亦须持卡并遵循馆藏范围）');
  assert.ok(/仅可借阅/.test(seg), '云函数 doBorrow 应限制只能借归属馆藏');
});
