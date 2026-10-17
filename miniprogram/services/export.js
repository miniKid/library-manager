/**
 * CSV 导出落盘与转发（客户端）
 * -------------------------------------
 * 小程序无法直接「下载到电脑」，可行路径是：写本地临时文件 → 转发到聊天（文件传输助手）
 * → 在电脑端打开。基础库不支持 wx.shareFileMessage 时降级为复制内容到剪贴板。
 *
 * 单独成文件是为了让 cloud / mock 两种实现共用同一段逻辑，
 * 避免测试里的「exports 必须一致」检查出现两套实现。
 */

/**
 * @param {{filename:string, content:string}} payload
 * @returns {Promise<{ok:boolean, method?:'share'|'cancel'|'clipboard', path?:string, msg?:string}>}
 */
async function exportCsv(payload) {
  const filename = (payload && payload.filename) || 'export.csv';
  const content = (payload && payload.content) || '';
  if (!content) return { ok: false, msg: '没有可导出的数据' };

  let filePath = '';
  try {
    const fs = wx.getFileSystemManager();
    const dir = `${wx.env.USER_DATA_PATH}/export`;
    try {
      fs.mkdirSync(dir, true);
    } catch (e) {
      // 目录已存在，忽略
    }
    filePath = `${dir}/${filename}`;
    fs.writeFileSync(filePath, content, 'utf8');
  } catch (e) {
    console.error('[exportCsv] 写文件失败', e);
    return { ok: false, msg: '生成文件失败：' + ((e && e.errMsg) || '未知错误') };
  }

  if (typeof wx.shareFileMessage === 'function') {
    try {
      await new Promise((resolve, reject) => {
        wx.shareFileMessage({ filePath, fileName: filename, success: resolve, fail: reject });
      });
      return { ok: true, method: 'share', path: filePath };
    } catch (e) {
      const msg = (e && e.errMsg) || '';
      // 用户主动取消不算失败：文件已经生成，可再次导出
      if (/cancel/i.test(msg)) return { ok: true, method: 'cancel', path: filePath };
      console.warn('[exportCsv] 转发失败，降级为剪贴板', e);
    }
  }

  try {
    await new Promise((resolve, reject) => wx.setClipboardData({ data: content, success: resolve, fail: reject }));
    return { ok: true, method: 'clipboard', path: filePath };
  } catch (e) {
    return { ok: false, msg: '导出失败，文件已保存在本地：' + filePath };
  }
}

module.exports = { exportCsv };
