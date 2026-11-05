/**
 * 首页弹窗公告「点击跳转」的可选目标。
 * 配置页 picker 与弹窗跳转共用同一份白名单，避免显示值与实际跳转地址不一致。
 */
const NOTICE_LINKS = [
  { label: '不跳转', value: '' },
  { label: '我的借阅', value: '/pages/my/index' }
];

// 历史配置：曾指向「完整借阅记录」或已下线的栏目，现统一收敛到「我的」tab，
// 避免旧配置归一化成「不跳转」后跳转键直接消失
const LEGACY_LINK_MAP = {
  '/pages/my/borrows/index': '/pages/my/index',
  '/pages/index/index': '/pages/my/index',
  '/pages/recommend/index': '/pages/my/index'
};

/** 把任意历史值规整为白名单内的链接，非法值一律视为「不跳转」 */
function normalizeNoticeLink(value) {
  const raw = String(value || '');
  const link = LEGACY_LINK_MAP[raw] || raw;
  return NOTICE_LINKS.some((item) => item.value === link) ? link : '';
}

module.exports = { NOTICE_LINKS, normalizeNoticeLink };
