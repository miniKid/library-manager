/**
 * 云函数：login
 * 通过 openid 获取或创建用户。
 * 管理员判定：settings.global.adminOpenid 指定了 openid 则仅该用户为管理员；
 * 未指定时沿用原逻辑，第一个注册用户自动成为管理员。
 */
const cloud = require('wx-server-sdk');

cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const users = db.collection('users');

exports.main = async (event) => {
  const { OPENID } = cloud.getWXContext();
  const profile = event.profile || {};

  let user = null;
  try {
    const res = await users.where({ openid: OPENID }).get();
    user = res.data[0] || null;
  } catch (e) {
    // users 集合不存在时创建
    await db.createCollection('users');
    user = null;
  }

  if (!user) {
    // 读取全局设置：指定管理员 openid（settings.global.adminOpenid），空表示由首个登录用户兜底
    let firstLoc = '';
    let adminOpenid = process.env.ADMIN_OPENID || '';
    try {
      const sRes = await db.collection('settings').limit(1).get();
      const s = sRes.data && sRes.data[0];
      if (s && Array.isArray(s.locations)) firstLoc = s.locations[0] || '';
      // 集合里的配置优先于环境变量（便于运营期在管理端直接换人）
      if (s && s.adminOpenid) adminOpenid = s.adminOpenid;
    } catch (e) {
      // settings 集合尚未初始化（尚未运行 initDB），暂无可归属馆藏
    }

    // 管理员判定：指定了 adminOpenid 则仅该用户为管理员；
    // 未指定时沿用原逻辑，第一个注册用户为管理员
    let isAdmin = false;
    if (adminOpenid) {
      isAdmin = adminOpenid === OPENID;
    } else {
      const countRes = await users.count();
      isAdmin = countRes.total === 0;
    }

    const doc = {
      openid: OPENID,
      nickname: profile.nickname || '微信用户',
      avatarUrl: profile.avatarUrl || '',
      role: isAdmin ? 'admin' : 'user',
      card: isAdmin && firstLoc ? { status: 'active', location: firstLoc, openedDate: db.serverDate() } : { status: 'none' },
      createdAt: db.serverDate()
    };
    const addRes = await users.add({ data: doc });
    doc._id = addRes._id;
    return { user: doc };
  }

  // 已有用户：更新头像昵称
  if (profile.nickname) {
    const patch = { nickname: profile.nickname };
    if (profile.avatarUrl) patch.avatarUrl = profile.avatarUrl;
    await users.doc(user._id).update({ data: patch });
    user.nickname = profile.nickname;
    if (profile.avatarUrl) user.avatarUrl = profile.avatarUrl;
  }

  // 兼容旧数据：老用户（含管理员）无借书证字段时补未开通，借阅一律按读者身份走借书证流程
  if (!user.card) {
    user.card = { status: 'none' };
    await users.doc(user._id).update({ data: { card: user.card } });
  }

  // 若指定了管理员 openid 且命中当前用户，确保其拥有管理员权限（支持为已注册用户指定管理员）
  try {
    const sRes = await db.collection('settings').limit(1).get();
    const s = sRes.data && sRes.data[0];
    const adminOpenid = (s && s.adminOpenid) || process.env.ADMIN_OPENID || '';
    if (adminOpenid && adminOpenid === OPENID && user.role !== 'admin') {
      await users.doc(user._id).update({ data: { role: 'admin' } });
      user.role = 'admin';
    }
  } catch (e) {}

  return { user };
};
