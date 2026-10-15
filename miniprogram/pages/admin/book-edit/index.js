const services = require('../../../services/index');
const { toLocalFile } = require('../../../utils/cover');

/** 读取本地文件为 base64 字符串 */
function readBase64(filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileSystemManager().readFile({
      filePath,
      encoding: 'base64',
      success: (r) => resolve(r.data),
      fail: reject
    });
  });
}

/**
 * 用离屏 canvas 把图片缩放到小尺寸并返回 base64 dataURL。
 * 目的：控制入库封面大小（≤40KB），避免书架列表查询时多本累加超过单次返回大小限制。
 */
function compressToDataUrl(tempFilePath, maxW, maxH, quality) {
  return new Promise((resolve, reject) => {
    wx.getImageInfo({
      src: tempFilePath,
      success: (info) => {
        try {
          let w = info.width;
          let h = info.height;
          const scale = Math.min(maxW / w, maxH / h, 1);
          w = Math.max(1, Math.round(w * scale));
          h = Math.max(1, Math.round(h * scale));
          const canvas = wx.createOffscreenCanvas({ type: '2d', width: w, height: h });
          const ctx = canvas.getContext('2d');
          const img = canvas.createImage();
          img.onload = () => {
            ctx.drawImage(img, 0, 0, w, h);
            resolve(canvas.toDataURL('image/jpeg', quality));
          };
          img.onerror = reject;
          img.src = tempFilePath;
        } catch (e) {
          reject(e);
        }
      },
      fail: reject
    });
  });
}

Page({
  data: {
    isEdit: false,
    bookId: '',
    categories: [],
    // 馆藏地点列表（来自 settings）
    locations: [],
    // 各地点库存输入 [{ loc, num }]
    stockInputs: [],
    form: {
      title: '',
      author: '',
      isbn: '',
      category: '',
      publisher: '',
      year: '',
      stock: 1,
      description: '',
      cover: ''
    },
    categoryIndex: 0,
    saving: false,
    lookupLoading: false
  },

  async onLoad(options) {
    this.setData({ categories: services.getCategories() });
    // 读取全局设置中的馆藏地点
    let locations = [];
    const settings = await services.getSettings();
    if (settings && settings.locations && settings.locations.length) {
      locations = settings.locations.slice();
    }
    if (options.id) {
      this.setData({ isEdit: true, bookId: options.id });
      wx.setNavigationBarTitle({ title: '编辑图书' });
      const book = await services.getBook(options.id);
      if (book) {
        // 图书已有 stocks 地点兜底（settings 读取失败时仍可调整馆藏）
        Object.keys(book.stocks || {}).forEach((l) => {
          if (locations.indexOf(l) === -1) locations.push(l);
        });
        this.setData({ locations });
        const idx = Math.max(0, this.data.categories.indexOf(book.category));
        // base64 封面转本地文件后显示（<image> 不支持直接渲染 dataURL）
        const coverSrc = await toLocalFile(book.cover || '', 'edit_' + options.id);
        // 按地点初始化库存输入（无 stocks 的老数据按 stock 分给第一个地点）
        const stocks = book.stocks || {};
        const stockInputs = locations.map((loc) => ({
          loc,
          num: String(stocks[loc] !== undefined ? stocks[loc] : loc === locations[0] ? (book.stock || 0) : 0)
        }));
        this.setData({
          form: {
            title: book.title || '',
            author: book.author || '',
            isbn: book.isbn || '',
            category: book.category || '',
            publisher: book.publisher || '',
            year: book.year || '',
            stock: book.stock || 0,
            description: book.description || '',
            cover: book.cover || ''
          },
          stockInputs,
          categoryIndex: idx,
          coverSrc
        });
      }
    } else {
      this.setData({
        locations,
        stockInputs: locations.map((loc) => ({ loc, num: '0' }))
      });
      this.setData({ 'form.category': this.data.categories[0] || '其他' });
    }
  },

  /** 各馆藏地点库存输入 */
  onStockInput(e) {
    const idx = Number(e.currentTarget.dataset.idx);
    const key = 'stockInputs[' + idx + '].num';
    this.setData({ [key]: e.detail.value });
  },

  onInput(e) {
    const field = e.currentTarget.dataset.field;
    this.setData({ ['form.' + field]: e.detail.value });
  },

  onCategoryChange(e) {
    const idx = Number(e.detail.value);
    this.setData({
      categoryIndex: idx,
      'form.category': this.data.categories[idx]
    });
  },

  /** 输入 ISBN 后自动获取图书信息 */
  async onLookupIsbn() {
    const isbn = this.data.form.isbn.trim();
    if (!isbn) {
      wx.showToast({ title: '请先输入 ISBN', icon: 'none' });
      return;
    }
    if (this.data.lookupLoading) return;
    this.setData({ lookupLoading: true });
    try {
      const res = await services.lookupBook(isbn);
      if (res && res.ok && res.data) {
        const d = res.data;
        const patch = {
          'form.title': d.title,
          'form.author': d.author,
          'form.publisher': d.publisher,
          'form.year': d.year,
          'form.description': d.description
        };
        // 自动获取仅在用户未手动设置封面时填充，避免覆盖已拍摄/选择的封面
        // 优先用 base64（不依赖云存储公开读权限，任何环境都能显示），fileID 兜底
        if (!this.data.form.cover) {
          const newCover = d.coverBase64 || d.cover || '';
          if (newCover) {
            patch['form.cover'] = newCover;
            patch['coverSrc'] = await toLocalFile(newCover, 'lookup_' + Date.now());
          }
        }
        if (!this.data.form.category) {
          patch['form.category'] = this.data.categories[0] || '其他';
        }
        this.setData(patch);
        if (d.coverError) {
          console.warn('[book-edit] cover 转存失败，已使用网络直链:', d.coverError);
          wx.showToast({
            title: '封面已用网络直链（转存失败）',
            icon: 'none'
          });
        } else {
          wx.showToast({ title: '查询成功，已自动填充', icon: 'success' });
        }
      } else {
        wx.showToast({ title: (res && res.msg) || '未查询到该图书', icon: 'none' });
      }
    } catch (e) {
      console.error('[book-edit] lookup isbn error:', e);
      const msg = (e && e.errMsg) || e.message || '查询失败，请检查网络';
      wx.showToast({ title: msg.length > 20 ? msg.slice(0, 20) + '…' : msg, icon: 'none' });
    } finally {
      this.setData({ lookupLoading: false });
    }
  },

  /** 点击封面放大预览 */
  onPreviewCover() {
    const src = this.data.coverSrc || this.data.form.cover;
    if (!src) return;
    wx.previewImage({ urls: [src], current: src });
  },

  /** 拍照或从相册选择封面图片 */
  onChooseCover() {
    wx.chooseMedia({
      count: 1,
      mediaType: ['image'],
      sourceType: ['camera', 'album'],
      sizeType: ['compressed'],
      success: (res) => {
        const file = res.tempFiles && res.tempFiles[0];
        if (file && file.tempFilePath) {
          this.handleLocalImage(file.tempFilePath);
        }
      },
      fail: () => {}
    });
  },

  /**
   * 处理本地图片：canvas 缩放降分辨率后转 base64 存库（不依赖云存储权限）。
   * 严格控制 ≤40KB，避免书架列表查询多本累加超过单次返回大小限制。
   * form.cover 保存入库用的 base64 dataURL；coverSrc 为可直接渲染的本地路径。
   */
  async handleLocalImage(tempFilePath) {
    wx.showLoading({ title: '处理中...' });
    try {
      let dataUrl = '';
      try {
        // 首选：canvas 缩放到 320x480 内，稳定控制体积
        dataUrl = await compressToDataUrl(tempFilePath, 320, 480, 0.72);
      } catch (canvasErr) {
        console.warn('[book-edit] canvas 压缩失败，降级 compressImage:', canvasErr);
        const compressed = await new Promise((resolve) => {
          wx.compressImage({
            src: tempFilePath,
            quality: 40,
            success: (r) => resolve(r.tempFilePath || tempFilePath),
            fail: () => resolve(tempFilePath)
          });
        });
        const base64 = await readBase64(compressed);
        dataUrl = 'data:image/jpeg;base64,' + base64;
      }
      if (!dataUrl) throw new Error('读取图片失败');
      if (dataUrl.length > 45000) {
        wx.showToast({ title: '图片过大，请裁剪或换一张', icon: 'none' });
        return;
      }
      const coverSrc = await toLocalFile(dataUrl, 'local_' + Date.now());
      this.setData({ 'form.cover': dataUrl, coverSrc });
      wx.showToast({ title: '封面已设置', icon: 'success' });
    } catch (e) {
      console.error('[book-edit] handle local image error:', e);
      wx.showToast({ title: '图片处理失败，请重试', icon: 'none' });
    } finally {
      wx.hideLoading();
    }
  },

  /** 移除封面 */
  onRemoveCover() {
    this.setData({ 'form.cover': '', coverSrc: '' });
  },

  async onSave() {
    const form = this.data.form;
    if (!form.title.trim()) {
      wx.showToast({ title: '请输入书名', icon: 'none' });
      return;
    }
    if (!form.author.trim()) {
      wx.showToast({ title: '请输入作者', icon: 'none' });
      return;
    }
    if (this.data.saving) return;
    // 馆藏库存：编辑模式下按地点输入汇总（0 库存地点也保留字段）；
    // 新增模式不分配馆藏；编辑时若无地点可配则保留原库存不动
    let stocks;
    let totalStock;
    if (this.data.isEdit && this.data.stockInputs.length) {
      stocks = {};
      this.data.stockInputs.forEach((s) => {
        stocks[s.loc] = Math.max(0, Number(s.num) || 0);
      });
      totalStock = Object.keys(stocks).reduce((sum, k) => sum + stocks[k], 0);
    }
    this.setData({ saving: true });
    wx.showLoading({ title: '保存中...' });
    try {
      const payload = {
        title: form.title.trim(),
        author: form.author.trim(),
        isbn: form.isbn.trim(),
        category: form.category,
        publisher: form.publisher.trim(),
        year: form.year.trim(),
        description: form.description.trim(),
        cover: form.cover || ''
      };
      if (stocks !== undefined) {
        payload.stock = totalStock;
        payload.stocks = stocks;
      }
      const result = this.data.isEdit
        ? await services.updateBook(this.data.bookId, payload)
        : await services.addBook(payload);
      wx.hideLoading();
      if (result && result.ok) {
        wx.showToast({ title: '保存成功', icon: 'success' });
        setTimeout(() => wx.navigateBack(), 600);
      } else if (result && result.code === 'DUPLICATE' && result.book && result.book._id) {
        this.setData({ saving: false });
        const dupTitle = result.book.title || '该图书';
        wx.showModal({
          title: 'ISBN 已存在',
          content: '《' + dupTitle + '》已收录该 ISBN，是否跳转到编辑页面？',
          confirmText: '去编辑',
          cancelText: '取消',
          success: (r) => {
            if (r.confirm) {
              wx.redirectTo({ url: '../book-edit/index?id=' + result.book._id });
            }
          }
        });
      } else {
        this.setData({ saving: false });
        wx.showToast({ title: (result && result.msg) || '保存失败', icon: 'none' });
      }
    } catch (e) {
      wx.hideLoading();
      this.setData({ saving: false });
      wx.showToast({ title: '保存失败', icon: 'none' });
    }
  }
});
