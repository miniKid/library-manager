/**
 * 自动测试入口
 * 运行：node test/run-tests.js
 * 通过则退出码 0，存在失败用例退出码非 0。
 */
'use strict';

const { run } = require('./helpers');

require('./cases/business');
require('./cases/static');

run().catch((e) => {
  console.error('测试运行器异常：', e);
  process.exitCode = 1;
});
