/**
 * 云函数：lookupBook
 * 通过 ISBN 查询图书信息（书名 / 作者 / 出版社 / 出版年 / 简介 / 封面）
 * - 数据源：豆瓣读书（国内可访问，HTML 解析）
 * - 封面：下载后转存到云存储，返回 fileID（避免小程序图片域名白名单限制）
 * 调用：wx.cloud.callFunction({ name: 'lookupBook', data: { isbn } })
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const https = require('https');

const UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/** 发起 GET 请求，返回文本（自动跟随 3xx 重定向，最多 5 次） */
function getText(url, timeout = 8000, redirects = 5) {
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
        // 跟随 301/302/303 重定向（如豆瓣 /isbn/xxx/ -> /subject/{id}/）
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

/** 下载图片为 Buffer（自动跟随重定向）
 *  注意：豆瓣图片 CDN 有反爬，请求必须带 Referer: https://book.douban.com/
 *  否则返回 HTTP 418 拒绝访问（本地实测 200 OK 需 Referer）。 */
function getBuffer(url, timeout = 10000, redirects = 3) {
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
    });
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

/** 提取 key1 与 key2 之间的字段文本 */
function fieldBetween(text, key, nextKey) {
  const i = text.indexOf(key);
  if (i < 0) return '';
  const j = nextKey ? text.indexOf(nextKey, i + key.length) : text.length;
  const raw = text.slice(i + key.length, j > 0 ? j : text.length);
  return stripTags(raw).replace(/^[:：\s]+/, '');
}

/** 数据源 1：豆瓣读书（国内可访问） */
async function queryDouban(isbn) {
  const html = await getText('https://book.douban.com/isbn/' + isbn + '/', 6000);
  const titleM = html.match(/v:itemreviewed">([^<]+)<\/span>/);
  if (!titleM) return null;

  const infoM = html.match(/<div id="info">([\s\S]*?)<\/div>/);
  const info = infoM ? infoM[1] : '';
  const title = stripTags(titleM[1]);

  // 简介：取第一个 intro 段落
  const introM = html.match(/<div class="intro">[\s\S]*?<p>([\s\S]*?)<\/p>/);
  const description = introM ? stripTags(introM[1]) : '';

  // 封面：第一张 subject 图片，升级为大图（l 尺寸）
  const coverM = html.match(/src="(https:\/\/img[0-9]+\.doubanio\.com\/view\/subject\/[^"]+)"/);
  const coverUrl = coverM ? coverM[1].replace('/s/public/', '/l/public/') : '';

  return {
    title,
    author: fieldBetween(info, '作者', '出版社'),
    publisher: fieldBetween(info, '出版社', '出版年'),
    year: fieldBetween(info, '出版年', '页数').slice(0, 4),
    description,
    coverUrl
  };
}

/** 上传封面到云存储，返回 fileID */
async function uploadCover(isbn, buffer) {
  const res = await cloud.uploadFile({
    cloudPath: 'covers/' + isbn + '.jpg',
    fileContent: buffer
  });
  return res.fileID;
}

exports.main = async (event) => {
  const isbn = String((event && event.isbn) || '')
    .replace(/[^0-9Xx]/g, '')
    .toUpperCase();
  if (!/^(978|979)?\d{9}[\dX]$/.test(isbn)) {
    return { ok: false, msg: 'ISBN 格式不正确，请输入 10 或 13 位书号' };
  }

  // 数据源：豆瓣读书（国内可访问）
  let info = null;
  try {
    info = await queryDouban(isbn);
  } catch (e) {
    return { ok: false, msg: '豆瓣查询失败：' + e.message };
  }
  if (!info || !info.title) {
    return { ok: false, msg: '未查询到该 ISBN 的图书信息，请手动填写' };
  }

  // 封面双保险：
  // 1) cover:      转存云存储的 fileID（体积小，但依赖云存储「公开读」权限）
  // 2) coverBase64: 图片 base64 dataURL（不依赖任何权限/白名单，任何环境都能显示）
  // 依次尝试 l 大图 -> s 小图，任一成功即停止
  let cover = info.coverUrl || '';
  let coverBase64 = '';
  let coverError = '';
  if (info.coverUrl) {
    const candidates = [info.coverUrl];
    const sUrl = info.coverUrl.replace('/l/public/', '/s/public/');
    if (sUrl !== info.coverUrl) candidates.push(sUrl);
    for (const u of candidates) {
      try {
        const buf = await getBuffer(u, 6000);
        if (buf && buf.length > 500) {
          const fileID = await uploadCover(isbn, buf);
          if (fileID) cover = fileID;
          coverBase64 = 'data:image/jpeg;base64,' + buf.toString('base64');
          break;
        }
        coverError = '封面内容为空';
      } catch (e) {
        coverError = e.message;
        console.warn('[lookupBook] cover fail:', u, e.message);
      }
    }
  }

  return {
    ok: true,
    data: {
      title: info.title,
      author: info.author,
      publisher: info.publisher,
      year: info.year,
      description: info.description,
      cover,
      coverBase64,
      coverError
    }
  };
};
