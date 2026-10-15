/**
 * 云函数：notify（由定时触发器每天执行）
 * 扫描「借出中 + 用户曾授权图书到期提醒 + 尚未提醒过」且应还日期在 3 天内（含已逾期）的借阅，
 * 推送一次性订阅消息「图书到期提醒」。
 * 一次性订阅每位用户对每条模板仅能接收 1 条，故发送后置 reminded=true 防止重复。
 */
const cloud = require('wx-server-sdk');
cloud.init({ env: cloud.DYNAMIC_CURRENT_ENV });

const db = cloud.database();
const _ = db.command;

const BORROW_STATUS = { BORROWING: 'borrowing' };
const TMPL_RETURN_REMIND = 'opgxSjtbN8zWIerXYN8fphLzfHmGwhXY13swG9tdBTM';
const MP_STATE = 'developer'; // 上线后改为 'formal'

/** 日期格式化 yyyy-MM-dd */
function formatDate(date) {
  if (!date) return '';
  const d = new Date(date);
  if (isNaN(d.getTime())) return '';
  const pad = (n) => (n < 10 ? '0' + n : '' + n);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/** 推送「图书到期提醒」；失败（含 43101 未授权）时标记 reminded 避免反复重试 */
async function sendReturnRemind(record) {
  try {
    await cloud.openapi.subscribeMessage.send({
      touser: record.userId,
      templateId: TMPL_RETURN_REMIND,
      page: 'pages/my/index',
      miniprogram_state: MP_STATE,
      lang: 'zh_CN',
      // 字段名需与模板关键词一致（thing1/date2…），否则报 47003
      data: {
                date1: { value: formatDate(record.dueDate) },
        thing3: { value: String(record.bookTitle || '图书').slice(0, 20) },
        number2: { value: record.bookId },
        thing4: { value: new Date(record.dueDate) < new Date() ? '已逾期' : '即将到期' }
      }
    });
    await db.collection('borrows').doc(record._id).update({ data: { reminded: true } });
  } catch (e) {
    const code = (e && e.errCode) || (e && e.code);
    console.error('[notify] 发送失败', record._id, code || e);
    // 一次性订阅仅能发送一次；未授权(43101)或字段不匹配(47003)时也置为已提醒，停止后续重试
    if (code === 43101 || code === 47003) {
      await db.collection('borrows').doc(record._id).update({ data: { reminded: true } }).catch(() => {});
    }
  }
}

exports.main = async () => {
  const in3Days = new Date(Date.now() + 3 * 86400000);
  // dueDate 存储为日期类型，用 _.lte 与 Date 比较；只处理 3 天内（含已逾期）且曾授权的记录
  const res = await db
    .collection('borrows')
    .where({
      status: BORROW_STATUS.BORROWING,
      subscribedReturn: true,
      reminded: _.neq(true),
      dueDate: _.lte(in3Days)
    })
    .limit(100)
    .get();
  for (const r of res.data) {
    await sendReturnRemind(r);
  }
  return { ok: true, scanned: res.data.length };
};
