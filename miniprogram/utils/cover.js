/**
 * 封面 base64 dataURL 处理工具
 *
 * 微信小程序 <image> 组件的 src 支持：网络路径 / 本地路径 / 云文件ID，
 * 不支持直接渲染 base64 dataURL（真机显示空白）。
 * 因此 dataURL 封面必须先通过 FileSystemManager 写入本地用户目录，
 * 再用本地文件路径作为 image 的 src。
 */
const fs = wx.getFileSystemManager();

/** 内存缓存：dataURL -> 本地文件路径，避免同一封面重复写盘 */
const cache = {};

/** 判断是否为 base64 dataURL 封面 */
function isDataUrl(cover) {
  return (
    typeof cover === 'string' && /^data:image\/(jpeg|jpg|png|webp|gif);base64,/i.test(cover)
  );
}

/** 从 dataURL 的 mime 推导扩展名 */
function extOf(dataUrl) {
  const m = dataUrl.match(/^data:image\/(jpeg|jpg|png|webp|gif);base64,/i);
  const t = m ? m[1].toLowerCase() : 'jpg';
  return t === 'jpeg' ? 'jpg' : t;
}

/**
 * 把 base64 dataURL 写入本地用户目录，返回本地文件路径
 * @param {string} dataUrl 封面 dataURL
 * @param {string} key 唯一键（建议用图书 _id）
 * @returns {Promise<string>} 本地路径；非 dataURL 原样返回；写入失败返回空串
 */
function toLocalFile(dataUrl, key) {
  if (!dataUrl) return Promise.resolve('');
  if (!isDataUrl(dataUrl)) return Promise.resolve(dataUrl);
  const hit = cache[key];
  if (hit && hit.url === dataUrl) return Promise.resolve(hit.path);
  return new Promise((resolve) => {
    const m = dataUrl.match(/^data:image\/[^;]+;base64,(.*)$/);
    if (!m || !m[1]) return resolve('');
    const filePath = wx.env.USER_DATA_PATH + '/cover_' + key + '.' + extOf(dataUrl);
    fs.writeFile({
      filePath,
      data: m[1],
      encoding: 'base64',
      success: () => {
        cache[key] = { url: dataUrl, path: filePath };
        console.log('[cover] base64->local ok:', key, filePath, 'srcLen=' + dataUrl.length);
        resolve(filePath);
      },
      fail: (err) => {
        console.error('[cover] writeFile fail:', key, err, 'srcLen=' + dataUrl.length);
        resolve('');
      }
    });
  });
}

/** 单条封面归一化（用于详情页 / 编辑页回显） */
function normalizeCover(cover, key) {
  return toLocalFile(cover, key);
}

/**
 * 列表批量归一化：把每项 cover 从 base64 转为本地文件路径
 * @param {Array} list 图书列表（每项含 _id、cover）
 * @returns {Promise<Array>} 新数组，不影响原数组
 */
async function normalizeList(list) {
  if (!Array.isArray(list) || list.length === 0) return list;
  return Promise.all(
    list.map(async (item) => {
      if (!item || !isDataUrl(item.cover)) return item;
      const local = await toLocalFile(item.cover, item._id);
      return Object.assign({}, item, { cover: local });
    })
  );
}

module.exports = { isDataUrl, toLocalFile, normalizeCover, normalizeList };
