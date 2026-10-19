/**
 * 云函数：initDB
 * 初始化数据库集合与种子数据，幂等操作，可重复执行
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();

const DEFAULT_LOCATIONS = ['广州', '西安'];

// 订阅消息模板默认配置（ID + 字段映射）。仅当 settings.global.templates 未配置时回落；
// 上线前请替换成自己在公众平台「订阅消息」申请的真实模板，或部署后在控制台/管理端改。
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

/** 把总库存随机分配到各地点 */
function randomStocks(total) {
  const stocks = {};
  let remaining = Math.max(0, total);
  DEFAULT_LOCATIONS.forEach((loc, i) => {
    if (i === DEFAULT_LOCATIONS.length - 1) {
      stocks[loc] = remaining;
    } else {
      const n = remaining > 0 ? Math.floor(Math.random() * (remaining + 1)) : 0;
      stocks[loc] = n;
      remaining -= n;
    }
  });
  return stocks;
}

const seedBooks = [
  { title: '三体（全集）', author: '刘慈欣', isbn: '9787536692930', category: '科幻', publisher: '重庆出版社', year: '2008', stock: 5, description: '地球文明与三体文明的信息交流、生死搏杀及两个文明在宇宙中的兴衰历程。' },
  { title: '活着', author: '余华', isbn: '9787506365437', category: '文学', publisher: '作家出版社', year: '2012', stock: 3, description: '讲述了农村人福贵悲惨的人生遭遇，人是为了活着本身而活着。' },
  { title: '百年孤独', author: '加西亚·马尔克斯', isbn: '9787544253994', category: '文学', publisher: '南海出版公司', year: '2011', stock: 2, description: '布恩迪亚家族七代人的传奇故事，魔幻现实主义文学的代表作。' },
  { title: '人类简史', author: '尤瓦尔·赫拉利', isbn: '9787508647357', category: '历史', publisher: '中信出版社', year: '2014', stock: 4, description: '从认知革命、农业革命到科学革命，梳理人类历史脉络。' },
  { title: '深入理解计算机系统', author: 'Randal E. Bryant', isbn: '9787111544937', category: '计算机', publisher: '机械工业出版社', year: '2016', stock: 2, description: '从程序员视角讲解计算机系统的底层原理与性能优化。' },
  { title: '算法导论（原书第3版）', author: 'Thomas H. Cormen', isbn: '9787111407010', category: '计算机', publisher: '机械工业出版社', year: '2013', stock: 2, description: '全面介绍经典算法与数据结构，算法领域的标准教材。' },
  { title: '经济学原理', author: '曼昆', isbn: '9787301256905', category: '经济管理', publisher: '北京大学出版社', year: '2015', stock: 3, description: '经济学入门经典教材，涵盖微观与宏观经济学核心概念。' },
  { title: '红楼梦', author: '曹雪芹', isbn: '9787020002207', category: '小说', publisher: '人民文学出版社', year: '1996', stock: 4, description: '中国古典四大名著之一，封建社会的百科全书。' },
  { title: '小王子', author: '安托万·德·圣埃克苏佩里', isbn: '9787020042494', category: '少儿', publisher: '人民文学出版社', year: '2003', stock: 6, description: '一部写给大人看的童话，关于爱、责任与生命的意义。' },
  { title: '心理学与生活', author: '理查德·格里格', isbn: '9787115353346', category: '心理学', publisher: '人民邮电出版社', year: '2016', stock: 3, description: '心理学入门经典，将心理学理论应用于日常生活。' }
];

async function ensureCollection(name) {
  try {
    await db.createCollection(name);
  } catch (e) {
    // 已存在则忽略
  }
}

exports.main = async () => {
  await ensureCollection('books');
  await ensureCollection('borrows');
  await ensureCollection('users');
  await ensureCollection('settings');

  // 初始化 settings（幂等）
  let settingsDoc = null;
  try {
    settingsDoc = await db.collection('settings').doc('global').get();
  } catch (e) {
    settingsDoc = null;
  }
  if (!settingsDoc || !settingsDoc.data) {
    await db.collection('settings').add({
      data: {
        _id: 'global',
        locations: DEFAULT_LOCATIONS,
        borrowDays: 30,
        maxBorrow: 3,
        // 留空 = 首个登录用户自动成为管理员（部署到自己的环境时必须留空，
        // 否则会被锁在管理端之外：login 判定「配了 adminOpenid 就只认这一个人」）。
        // 需要指定管理员时，优先在云函数环境变量里配 ADMIN_OPENID（仓库里不出现真实 openid），
        // 也可以部署后在管理端「设置」页或控制台改 settings.global.adminOpenid。
        adminOpenid: process.env.ADMIN_OPENID || ''
      }
    });
  }

  // 确保 settings 含 adminOpenid 字段（指定初始管理员用，空表示由首个登录用户兜底）
  try {
    const sDoc = await db.collection('settings').doc('global').get();
    if (sDoc.data && sDoc.data.adminOpenid === undefined) {
      await db
        .collection('settings')
        .doc('global')
        .update({ data: { adminOpenid: process.env.ADMIN_OPENID || '' } });
    }
  } catch (e) {}

  // 确保 settings 含 templates（订阅消息模板的 ID 与字段映射；可在控制台/管理端改，免重新部署）
  try {
    const sDoc = await db.collection('settings').doc('global').get();
    const data = sDoc.data || {};
    if (!data.templates) {
      // 首次：整体写入默认模板
      await db
        .collection('settings')
        .doc('global')
        .update({ data: { templates: DEFAULT_TEMPLATES } });
    } else {
      // 已存在：增量补齐缺失的模板/字段（升级用），不覆盖用户已改过的值
      let changed = false;
      const next = Object.assign({}, data.templates);
      Object.keys(DEFAULT_TEMPLATES).forEach((k) => {
        if (!next[k]) {
          next[k] = DEFAULT_TEMPLATES[k];
          changed = true;
        } else {
          if (!next[k].templateId) { next[k].templateId = DEFAULT_TEMPLATES[k].templateId; changed = true; }
          if (!next[k].fields) { next[k].fields = DEFAULT_TEMPLATES[k].fields; changed = true; }
        }
      });
      if (changed) {
        await db
          .collection('settings')
          .doc('global')
          .update({ data: { templates: next } });
      }
    }
  } catch (e) {}

  const countRes = await db.collection('books').count();
  if (countRes.total > 0) {
    return { ok: true, message: 'books 已有数据，跳过种子初始化' };
  }

  const tasks = seedBooks.map((b) =>
    db.collection('books').add({
      data: {
        ...b,
        stocks: randomStocks(b.stock),
        status: 'available',
        cover: '',
        borrowCount: 0,
        createdAt: db.serverDate()
      }
    })
  );
  await Promise.all(tasks);

  return { ok: true, message: '初始化完成，已写入 ' + seedBooks.length + ' 本种子图书' };
};
