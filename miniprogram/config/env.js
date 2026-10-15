/**
 * 环境配置
 * -------------------------------
 * useCloud: true  -> 使用微信云开发（需要真实 AppID 并在开发者工具中开通云环境）
 * useCloud: false -> 使用本地模拟数据（无需 AppID，游客模式即可预览体验完整功能）
 *
 * 前期预览体验：保持 useCloud = false 即可
 * 后期真实上线：注册小程序获取 AppID、开通云开发后，
 *              将 useCloud 改为 true 并填入 cloudEnv（云环境 ID）
 */
module.exports = {
  useCloud: true,
  cloudEnv: 'cloudbase-d4g8acmf9ed3f9ed6',

  // 本地模拟模式下：留空则第一个登录的用户自动成为管理员
  // 可填入特定 openid 来指定管理员
  mockAdminOpenid: ''
};
