/**
 * 数据服务统一出口
 * 根据 config/env.js 的 useCloud 自动选择实现，
 * 页面层无需关心底层是云开发还是本地模拟
 */
const env = require('../config/env');
const { exportCsv } = require('./export');
const impl = env.useCloud ? require('./cloud') : require('./mock');

/**
 * 将头像本地临时文件上传到云存储，返回可持久访问的 cloud:// fileID。
 * 若传入的已是云 fileID / 网络地址 / 空值，则原样返回，不做上传。
 * 仅在云模式下上传；模拟模式直接返回原路径。
 */
async function uploadAvatar(localPath) {
  if (!localPath) return localPath;
  const isLocalTemp =
    /^(wxfile:\/\/tmp|http:\/\/tmp|https?:\/\/127\.0\.0\.1)/.test(localPath) ||
    /\/__tmp__\//.test(localPath) ||
    /^tmp_/.test(localPath);
  if (!isLocalTemp || !env.useCloud) return localPath;
  const ext = (localPath.match(/\.(\w+)(?:\?.*)?$/) || [, 'png'])[1];
  const cloudPath = `avatars/${Date.now()}-${Math.random().toString(36).slice(2, 10)}.${ext}`;
  const res = await wx.cloud.uploadFile({ cloudPath, filePath: localPath });
  return res.fileID;
}

module.exports = Object.assign({}, impl, { uploadAvatar, exportCsv });
