/**
 * 云函数：notify（由定时触发器每天 09:00 执行）
 *
 * 职责一：订阅消息（一次性）——应还日期在 3 天内（含已逾期）且用户曾授权，推送「图书到期提醒」。
 * 职责二：站内通知——不依赖订阅授权，保证用户打开小程序就能看到提醒：
 *         · 3 天内到期 → type=due
 *         · 已逾期     → type=overdue（每天最多一条，按 bizId 去重）
 * 职责三：清理 90 天前的站内通知，避免集合无限增长。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const BORROW_STATUS = { BORROWING: 'borrowing' };
// 订阅消息跳转版本：默认正式版；开发/体验阶段用云函数环境变量 MP_STATE=developer / trial 覆盖
// （MP_STATE 是真正的「环境切换」，保留为环境变量；模板 ID 与字段映射见下方 DEFAULT_TEMPLATES / settings.global.templates）
const MP_STATE = process.env.MP_STATE || 'formal';

// 订阅消息「到期提醒」模板配置：ID 与字段映射放在 settings.global.templates.returnRemind，运行时读取，
// 换模板/换小程序在控制台或管理端改即可，不必重新部署。未配置时回落到仓库内置示例模板。
const DEFAULT_TEMPLATES = {
  returnRemind: {
    templateId: 'opgxSjtbN8zWIerXYN8fphLzfHmGwhXY13swG9tdBTM',
    fields: { date1: 'dueDate', thing3: 'bookTitle', number2: 'dueCount', thing4: 'dueTip' }
  }
};

/** 取值器：把取值器名解析为发送字符串（值需计算，故留代码；关键词名随模板数据化） */
function resolveTmplValue(name, ctx) {
  const r = ctx.record || {};
  switch (name) {
    case 'bookTitle':
      return String(r.bookTitle || '图书').slice(0, 20);
    case 'dueDate':
      return formatDate(r.dueDate);
    case 'dueCount':
      return 1; // 单条借阅对应 1 本；模板 number2 为数字类型，必须为数值
    case 'dueTip':
      return '请于到期前归还或续借，避免逾期'; // 模板 thing4 为 thing 类型，≤20 字
    default:
      return '';
  }
}

function getTemplate(settings, name) {
  const def = DEFAULT_TEMPLATES[name] || { templateId: '', fields: {} };
  const cfg = ((settings || {}).templates || {})[name] || {};
  return {
    templateId: cfg.templateId || def.templateId,
    fields: cfg.fields || def.fields
  };
}

function buildTmplData(tpl, ctx) {
  const data = {};
  const fields = (tpl || {}).fields || {};
  Object.keys(fields).forEach((kw) => {
    data[kw] = { value: String(resolveTmplValue(fields[kw], ctx)) };
  });
  return data;
}

/** 读全局设置（含 templates），失败回落空对象，由默认模板兜底 */
async function getSettings() {
  try {
    const res = await db.collection('settings').doc('global').get();
    return res.data || {};
  } catch (e) {
    return {};
  }
}

const NOTICE = 'notifications';
const KEEP_DAYS = 90;

/** 日期格式化 yyyy-MM-dd（东八区） */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(new Date(date).getTime() + 8 * 3600 * 1000);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function cstToday() {
  return formatDate(new Date());
}

/** 读用户通知偏好（缺省全开；system 不可关闭） */
async function getPrefs(openid) {
  try {
    const r = await db.collection('users').where({ openid }).field({ notifyPrefs: true }).limit(1).get();
    return ((r.data[0] || {}).notifyPrefs) || {};
  } catch (e) {
    return {};
  }
}

/** 写站内通知（bizId 用于去重，避免同一天重复提醒） */
async function pushInApp(record, type, title, content, bizId) {
  if (!record || !record.userId) return false;
  try {
    const prefs = await getPrefs(record.userId);
    if (prefs[type] === false) return false;
    const dup = await db.collection(NOTICE).where({ toOpenid: record.userId, type, bizId }).count();
    if (dup.total > 0) return false;
    await db.collection(NOTICE).add({
      data: {
        toOpenid: record.userId,
        type,
        title,
        content,
        link: '/pages/my/borrows/index',
        level: type === 'overdue' ? 'danger' : 'warning',
        bizId,
        read: false,
        readAt: null,
        senderOpenid: 'system',
        senderName: '图书馆',
        createdAt: db.serverDate()
      }
    });
    return true;
  } catch (e) {
    console.error('[notify] 站内通知写入失败', record._id, e);
    return false;
  }
}

/** 推送「图书到期提醒」；失败（含 43101 未授权）时标记 reminded 避免反复重试 */
async function sendReturnRemind(record, tpl) {
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: record.userId,
      templateId: tpl.templateId,
      page: 'pages/my/borrows/index',
      miniprogram_state: MP_STATE,
      lang: 'zh_CN',
      // 字段名（date1/thing3/number2/thing4…）与取值来自 settings.global.templates.returnRemind
      data: buildTmplData(tpl, { record })
    });
    await db.collection('borrows').doc(record._id).update({ data: { reminded: true } });
    console.log('[notify] 订阅消息已发送', record._id, 'templateId:', tpl.templateId);
  } catch (e) {
    const code = (e && e.errCode) || (e && e.code);
    console.error('[notify] 订阅消息发送失败', record._id, code || e);
    // 一次性订阅仅能发送一次；未授权(43101)或字段不匹配(47003)时也置为已提醒，停止后续重试
    if (code === 43101 || code === 47003) {
      await db.collection('borrows').doc(record._id).update({ data: { reminded: true } }).catch(() => {});
    }
  }
}

/** 清理过期通知：分批删除，每批 200 条，避免单次超时或过期通知堆积漏清 */
async function cleanupOldNotices() {
  const before = new Date(Date.now() - KEEP_DAYS * 86400000);
  let total = 0;
  try {
    for (;;) {
      const r = await db.collection(NOTICE).where({ createdAt: _.lt(before) }).limit(200).get();
      if (!r.data.length) break;
      await Promise.all(r.data.map((n) => db.collection(NOTICE).doc(n._id).remove().catch(() => {})));
      total += r.data.length;
    }
    return total;
  } catch (e) {
    console.error('[notify] 清理通知失败', e);
    return total;
  }
}

exports.main = async () => {
  const in3Days = new Date(Date.now() + 3 * 86400000);
  // 一次性读取模板配置（含到期提醒），避免循环内反复查库
  const returnTpl = getTemplate(await getSettings(), 'returnRemind');

  // 1) 订阅消息：仅处理曾授权且未提醒过的记录
  const subRes = await db
    .collection('borrows')
    .where({
      status: BORROW_STATUS.BORROWING,
      subscribedReturn: true,
      reminded: _.neq(true),
      dueDate: _.lte(in3Days)
    })
    .limit(100)
    .get();
  for (const r of subRes.data) {
    await sendReturnRemind(r, returnTpl);
  }

  // 2) 站内通知：不依赖订阅授权（含未授权用户）
  const inAppRes = await db
    .collection('borrows')
    .where({ status: BORROW_STATUS.BORROWING, dueDate: _.lte(in3Days) })
    .field({ userId: true, bookTitle: true, bookId: true, dueDate: true })
    .limit(200)
    .get();

  const today = cstToday();
  let dueWritten = 0;
  let overdueWritten = 0;
  for (const r of inAppRes.data) {
    const due = formatDate(r.dueDate);
    if (!due) continue;
    if (due < today) {
      const days = Math.round((new Date(today + 'T00:00:00Z') - new Date(due + 'T00:00:00Z')) / 86400000);
      const ok = await pushInApp(
        r,
        'overdue',
        `《${r.bookTitle || '图书'}》已逾期 ${days} 天`,
        '请尽快提交还书申请，逾期会影响信用',
        `overdue-${r._id}-${today}`
      );
      if (ok) overdueWritten++;
    } else {
      const left = Math.round((new Date(due + 'T00:00:00Z') - new Date(today + 'T00:00:00Z')) / 86400000);
      const ok = await pushInApp(
        r,
        'due',
        `《${r.bookTitle || '图书'}》还有 ${left} 天到期`,
        '可续借，或按时归还',
        `due-${r._id}-${due}`
      );
      if (ok) dueWritten++;
    }
  }

  // 3) 清理过期通知
  const cleaned = await cleanupOldNotices();

  return {
    ok: true,
    scanned: subRes.data.length,
    inApp: { due: dueWritten, overdue: overdueWritten },
    cleaned
  };
};
