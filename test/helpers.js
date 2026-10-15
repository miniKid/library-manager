/**
 * 测试辅助模块
 * -------------------------------
 * 1. 注入内存版 global.wx（getStorageSync / setStorageSync），
 *    使 miniprogram/services/mock.js 可以在 Node 中完整运行（无任何依赖）。
 * 2. 提供 DB 重置、日期/值班工具等测试基础设施。
 * 3. 提供微型测试运行器（test / run），无需安装任何 npm 依赖。
 *
 * 运行：node test/run-tests.js
 */
'use strict';

const path = require('path');
const fs = require('fs');
const assert = require('assert');

const ROOT = path.resolve(__dirname, '..');
const PAGES_DIR = path.join(ROOT, 'miniprogram/pages');
const DB_KEY = '__mock_db';

/* ------------------------- 内存版 wx（mock.js 仅在函数内部使用 wx） ------------------------- */

const store = {};
global.wx = {
  getStorageSync(key) {
    return Object.prototype.hasOwnProperty.call(store, key) ? store[key] : '';
  },
  setStorageSync(key, value) {
    store[key] = value;
  },
  removeStorageSync(key) {
    delete store[key];
  }
};

/* ------------------------- 被测模块加载 ------------------------- */

const mock = require(path.join(ROOT, 'miniprogram/services/mock'));
const sched = require(path.join(ROOT, 'miniprogram/utils/schedule'));
const constants = require(path.join(ROOT, 'miniprogram/utils/constants'));
const util = require(path.join(ROOT, 'miniprogram/utils/util'));

/* ------------------------- DB 与数据工具 ------------------------- */

/** 重置本地数据库（每个用例前调用，保证用例相互独立） */
function resetDb() {
  Object.keys(store).forEach((k) => delete store[k]);
  mock.init();
}

/** 直接访问底层存储中的原始 db 对象（用于模拟多用户、构造异常数据等 mock 接口无法表达的场景） */
function rawDb() {
  return store[DB_KEY];
}

/**
 * 取一本有库存的书及其借阅地点。
 * 首个管理员/测试账号预置卡均归属第一个馆藏地点，因此借阅地点固定为第一馆藏：
 * 若该书第一馆藏无库存则自动补足 1 本，保证测试借阅能命中卡归属馆藏。
 */
function getFirstBook() {
  const db = rawDb();
  const locs = (db.settings && db.settings.locations) || constants.DEFAULT_LOCATIONS || [];
  const loc = locs[0];
  const book =
    db.books.find((b) => b.stocks && loc && (Number(b.stocks[loc]) || 0) > 0) ||
    db.books.find((b) => b.stocks && Object.keys(b.stocks).some((k) => (Number(b.stocks[k]) || 0) > 0));
  if (!book) throw new Error('种子数据中没有有库存的书');
  if (loc && (!book.stocks[loc] || Number(book.stocks[loc]) < 1)) {
    book.stocks[loc] = Math.max(Number(book.stocks[loc]) || 0, 1);
  }
  return { book, loc };
}

/** 从 from 起（默认明天）找到第一个值班 / 非值班日期 yyyy-MM-dd */
function scanDate(schedule, from, want) {
  const d = util.addDays(from || new Date(), 1);
  for (let i = 0; i < 120; i++) {
    const s = util.formatDate(d);
    if (sched.isScheduledOn(schedule, s) === want) return s;
    d.setDate(d.getDate() + 1);
  }
  throw new Error('120 天内未找到 ' + (want ? '值班' : '非值班') + ' 日期');
}
function nextScheduledDate(schedule, from) {
  return scanDate(schedule, from, true);
}
function nextNonScheduledDate(schedule, from) {
  return scanDate(schedule, from, false);
}

/* ------------------------- 文件工具（静态检查用） ------------------------- */

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

function walk(dir, ext, out) {
  out = out || [];
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name);
    const st = fs.statSync(p);
    if (st.isDirectory()) walk(p, ext, out);
    else if (p.endsWith(ext)) out.push(p);
  }
  return out;
}

/* ------------------------- 微型测试运行器 ------------------------- */

const tests = [];

/** 注册一个测试用例 */
function test(name, fn) {
  tests.push({ name, fn });
}

/** 运行全部用例，失败时设置非 0 退出码 */
async function run() {
  let pass = 0;
  const failed = [];
  for (const t of tests) {
    try {
      await t.fn();
      pass++;
      console.log('  [PASS] ' + t.name);
    } catch (e) {
      failed.push({ name: t.name, err: e });
      console.log('  [FAIL] ' + t.name);
      const lines = (e && e.stack ? e.stack : String(e)).split('\n');
      lines.slice(0, 6).forEach((l) => console.log('         ' + l));
    }
  }
  console.log('');
  console.log('==== 结果：' + pass + '/' + tests.length + ' 通过，' + failed.length + ' 失败 ====');
  if (failed.length > 0) {
    process.exitCode = 1;
  }
}

module.exports = {
  ROOT,
  PAGES_DIR,
  DB_KEY,
  store,
  mock,
  sched,
  constants,
  util,
  assert,
  resetDb,
  rawDb,
  getFirstBook,
  nextScheduledDate,
  nextNonScheduledDate,
  read,
  walk,
  test,
  run
};
