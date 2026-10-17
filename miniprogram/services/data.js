/**
 * 本地模拟模式的种子数据
 * 仅当 env.useCloud = false 时使用，数据存储在本地缓存中可持久化
 */
const { BORROW_STATUS, BORROW_DAYS, DEFAULT_LOCATIONS, DEFAULT_MAX_BORROW, DEFAULT_RENEW_TIMES, DEFAULT_RENEW_DAYS } = require('../utils/constants');

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
  { title: '三体（全集）', author: '刘慈欣', isbn: '9787536692930', category: '科技', publisher: '重庆出版社', year: '2008', stock: 5, cover: '', description: '地球文明与三体文明的信息交流、生死搏杀及两个文明在宇宙中的兴衰历程。' },
  { title: '活着', author: '余华', isbn: '9787506365437', category: '文学', publisher: '作家出版社', year: '2012', stock: 3, cover: '', description: '讲述了农村人福贵悲惨的人生遭遇，人是为了活着本身而活着。' },
  { title: '百年孤独', author: '加西亚·马尔克斯', isbn: '9787544253994', category: '文学', publisher: '南海出版公司', year: '2011', stock: 2, cover: '', description: '布恩迪亚家族七代人的传奇故事，魔幻现实主义文学的代表作。' },
  { title: '人类简史', author: '尤瓦尔·赫拉利', isbn: '9787508647357', category: '历史', publisher: '中信出版社', year: '2014', stock: 4, cover: '', description: '从认知革命、农业革命到科学革命，梳理人类历史脉络。' },
  { title: '深入理解计算机系统', author: 'Randal E. Bryant', isbn: '9787111544937', category: '计算机', publisher: '机械工业出版社', year: '2016', stock: 2, cover: '', description: '从程序员视角讲解计算机系统的底层原理与性能优化。' },
  { title: '算法导论（原书第3版）', author: 'Thomas H. Cormen', isbn: '9787111407010', category: '计算机', publisher: '机械工业出版社', year: '2013', stock: 2, cover: '', description: '全面介绍经典算法与数据结构，算法领域的标准教材。' },
  { title: '经济学原理', author: '曼昆', isbn: '9787301256905', category: '经济管理', publisher: '北京大学出版社', year: '2015', stock: 3, cover: '', description: '经济学入门经典教材，涵盖微观与宏观经济学核心概念。' },
  { title: '红楼梦', author: '曹雪芹', isbn: '9787020002207', category: '小说', publisher: '人民文学出版社', year: '1996', stock: 4, cover: '', description: '中国古典四大名著之一，封建社会的百科全书。' },
  { title: '小王子', author: '安托万·德·圣埃克苏佩里', isbn: '9787020042494', category: '少儿', publisher: '人民文学出版社', year: '2003', stock: 6, cover: '', description: '一部写给大人看的童话，关于爱、责任与生命的意义。' },
  { title: '心理学与生活', author: '理查德·格里格', isbn: '9787115353346', category: '心理学', publisher: '人民邮电出版社', year: '2016', stock: 3, cover: '', description: '心理学入门经典，将心理学理论应用于日常生活。' },
  { title: '文明之光', author: '吴军', isbn: '9787108053068', category: '历史', publisher: '人民文学出版社', year: '2014', stock: 2, cover: '', description: '以文明为主线，讲述人类科技与文明发展的宏大历史。' },
  { title: '思考，快与慢', author: '丹尼尔·卡尼曼', isbn: '9787508633558', category: '心理学', publisher: '中信出版社', year: '2012', stock: 3, cover: '', description: '诺贝尔奖得主卡尼曼带你了解大脑的两种思考系统。' }
];

function buildSeed() {
  const now = Date.now();
  return {
    books: seedBooks.map((b, i) => {
      const stocks = randomStocks(b.stock);
      return {
        _id: 'bk_' + (i + 1),
        ...b,
        stocks,
        status: Object.keys(stocks).some((k) => stocks[k] > 0) ? 'available' : 'borrowed',
        createdAt: now - (seedBooks.length - i) * 86400000,
        borrowCount: 0,
        ratingAvg: 0,
        ratingCount: 0,
        reviewCount: 0
      };
    }),
    borrows: [],
    users: [],
    // 第二期新增集合（本地模拟与云端保持同名）
    reviews: [],
    notifications: [],
    todos: [],
    noticeLogs: [],
    settings: {
      _id: 'global',
      locations: DEFAULT_LOCATIONS.slice(),
      borrowDays: BORROW_DAYS,
      maxBorrow: DEFAULT_MAX_BORROW,
      renewTimes: DEFAULT_RENEW_TIMES,
      renewDays: DEFAULT_RENEW_DAYS
    }
  };
}

module.exports = { buildSeed };
