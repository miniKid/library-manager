/**
 * 云函数：fixBookCover
 * 批量修复存量图书封面：统一转为【小尺寸 base64 dataURL】存入数据库。
 *
 * 背景：
 * 1. 云存储为 PRIVATE（免费套餐无法改权限），fileID 在真机不可读；
 * 2. 小程序 <image> 不支持直接渲染 base64 dataURL，前端需写入本地文件显示；
 * 3. 关键：客户端列表查询（getBooks）单次返回数据总大小有限制（约 512KB），
 *    若封面是大图 base64（如 192KB），多本累加超限会导致 cover 被截断/置空，
 *    书架因此看不到封面（而详情页单条查询不受影响）。
 *
 * 策略：
 * - 统一使用豆瓣 s 小图（约 270x390，base64 ~27KB），单封面 ≤ SIZE_LIMIT(40KB)；
 * - cover 为 fileID（cloud://）：云函数管理端下载 -> base64；
 * - cover 为空 / http 直链 / 过大的 base64：按 ISBN 调豆瓣抓取 s 小图 -> base64；
 * - cover 已是 ≤40KB 的 base64：跳过。
 * 调用：tcb fn invoke fixBookCover 或 wx.cloud.callFunction({ name: 'fixBookCover' })
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });
const db = cloud.database();

const https = require('https');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 发起 GET 请求，返回文本（自动跟随 3xx 重定向） */
function getText(url, timeout = 6000, redirects = 5) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8',
          'Accept-Language': 'zh-CN,zh;q=0.9'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('重定向次数过多'));
          const next = new URL(res.headers.location, url).href;
          return getText(next, timeout, redirects - 1).then(resolve, reject);
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
  });
}

/** 下载图片为 Buffer（豆瓣图床需带 Referer，否则 418） */
function getBuffer(url, timeout = 8000, redirects = 3) {
  return new Promise((resolve, reject) => {
    const req = https.get(
      url,
      {
        headers: {
          'User-Agent': UA,
          Referer: 'https://book.douban.com/',
          Accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8'
        }
      },
      (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
          res.resume();
          if (redirects <= 0) return reject(new Error('重定向次数过多'));
          const next = new URL(res.headers.location, url).href;
          return getBuffer(next, timeout, redirects - 1).then(resolve, reject);
        }
        if (res.statusCode >= 400) {
          res.resume();
          return reject(new Error('HTTP ' + res.statusCode));
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve(Buffer.concat(chunks)));
      }
    );
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('请求超时')));
  });
}

function stripTags(s) {
  return (s || '')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 豆瓣按 ISBN 查询，返回图书信息（含封面 URL） */
async function queryDouban(isbn) {
  const html = await getText('https://book.douban.com/isbn/' + isbn + '/', 6000);
  const titleM = html.match(/v:itemreviewed">([^<]+)<\/span>/);
  if (!titleM) return null;
  const coverM = html.match(/src="(https:\/\/img[0-9]+\.doubanio\.com\/view\/subject\/[^"]+)"/);
  return {
    title: stripTags(titleM[1]),
    coverUrl: coverM ? coverM[1].replace('/s/public/', '/l/public/') : ''
  };
}

/** 按 ISBN 抓取封面，返回小尺寸 base64 dataURL（优先 s 小图，保证列表查询不超限） */
async function fetchCoverByIsbn(isbn, sizeLimit) {
  const info = await queryDouban(isbn);
  if (!info || !info.coverUrl) return '';
  // 统一优先 s 小图（约 270x390，base64 ~27KB）
  const sUrl = info.coverUrl.replace('/l/public/', '/s/public/');
  const candidates = sUrl !== info.coverUrl ? [sUrl, info.coverUrl] : [info.coverUrl];
  for (const u of candidates) {
    try {
      const buf = await getBuffer(u, 8000);
      if (!buf || buf.length <= 500) continue;
      const dataUrl = 'data:image/jpeg;base64,' + buf.toString('base64');
      if (dataUrl.length <= sizeLimit) return dataUrl;
      console.warn('[fixBookCover] cover too large:', dataUrl.length, u);
    } catch (e) {
      console.warn('[fixBookCover] cover fail:', u, e.message);
    }
  }
  return '';
}

exports.main = async (event) => {
  const MAX = event && event.max ? Number(event.max) : 200; // 本次最多处理条数
  // 单封面 base64 上限 40KB：保证列表查询多本累加不触碰单次返回大小限制
  const SIZE_LIMIT = 40000;

  let processed = 0;
  let fixed = 0;
  let skipped = 0;
  let failed = 0;
  const errors = [];

  for (let offset = 0; processed < MAX; offset += 100) {
    const res = await db.collection('books').skip(offset).limit(100).get();
    const list = res.data;
    if (!list.length) break;
    for (const book of list) {
      if (processed >= MAX) break;
      processed++;
      const cur = book.cover || '';
      const isB64 = /^data:image\//.test(cur);

      // 已是合格小尺寸 base64：跳过
      if (isB64 && cur.length <= SIZE_LIMIT) {
        skipped++;
        continue;
      }
      // 已是 base64 但过大，且无 ISBN 无法重新下载小图：跳过并提示
      if (isB64 && cur.length > SIZE_LIMIT && !book.isbn) {
        skipped++;
        errors.push((book.title || book._id) + ': base64 过大(' + cur.length + ')且无 ISBN，无法自动压缩');
        continue;
      }

      let dataUrl = '';
      try {
        if (!isB64 && cur.startsWith('cloud://')) {
          const dl = await cloud.downloadFile({ fileID: cur });
          if (dl.fileContent && dl.fileContent.length > 500) {
            dataUrl = 'data:image/jpeg;base64,' + dl.fileContent.toString('base64');
          }
        } else if (book.isbn) {
          dataUrl = await fetchCoverByIsbn(book.isbn, SIZE_LIMIT);
        }
      } catch (e) {
        errors.push((book.title || book._id) + ': ' + e.message);
        failed++;
        continue;
      }

      if (!dataUrl) {
        errors.push((book.title || book._id) + ': 未获取到封面');
        failed++;
        continue;
      }
      if (dataUrl.length > SIZE_LIMIT) {
        errors.push((book.title || book._id) + ': 下载后仍过大(' + dataUrl.length + ')，未写入');
        failed++;
        continue;
      }
      await db.collection('books').doc(book._id).update({ data: { cover: dataUrl } });
      fixed++;
    }
  }

  return { ok: true, processed, fixed, skipped, failed, sizeLimit: SIZE_LIMIT, errors: errors.slice(0, 20) };
};
