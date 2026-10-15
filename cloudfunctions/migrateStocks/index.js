/**
 * 云函数：migrateStocks
 * 一次性迁移任务：
 *  1. 初始化 settings 集合（馆藏地点 / 借期 / 每人限借数），幂等
 *  2. 为已存在的图书补齐 stocks 字段（现有馆藏随机分配到各地点），幂等
 * 可重复执行
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const LOCATIONS = ['广州', '西安'];

/** 把总库存随机分配到各地点（允许某地点为 0） */
function randomStocks(total) {
  const stocks = {};
  let remaining = Math.max(0, total);
  LOCATIONS.forEach((loc, i) => {
    if (i === LOCATIONS.length - 1) {
      stocks[loc] = remaining;
    } else {
      const n = remaining > 0 ? Math.floor(Math.random() * (remaining + 1)) : 0;
      stocks[loc] = n;
      remaining -= n;
    }
  });
  return stocks;
}

exports.main = async () => {
  // 1. 初始化 settings 集合
  try {
    await db.createCollection('settings');
  } catch (e) {
    // 已存在则忽略
  }
  let settingsRes = null;
  try {
    settingsRes = await db.collection('settings').doc('global').get();
  } catch (e) {
    settingsRes = null;
  }
  if (!settingsRes || !settingsRes.data) {
    await db.collection('settings').add({
      data: {
        _id: 'global',
        locations: LOCATIONS,
        borrowDays: 30,
        maxBorrow: 3
      }
    });
  }

  // 2. 为缺少 stocks 的图书随机分配馆藏地点
  const books = await db.collection('books').limit(1000).get();
  let updated = 0;
  for (const b of books.data) {
    if (b.stocks) continue;
    const total = b.stock || 1;
    await db.collection('books').doc(b._id).update({
      data: { stocks: randomStocks(total) }
    });
    updated++;
  }

  return { ok: true, total: books.data.length, updated };
};
