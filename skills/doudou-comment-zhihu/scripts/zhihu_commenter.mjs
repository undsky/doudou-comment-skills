/**
 * 知乎自动查找相关主题并回复脚本生成器
 * 适配 chrome-devtools-mcp 的 evaluate_script 调用
 */

/**
 * 生成在知乎首页 (https://www.zhihu.com/) 执行关键词搜索的浏览器注入脚本
 * @param {string} keyword 搜索关键词
 * @returns {string} 可在 evaluate_script 中执行的自包含异步函数字符串
 */
export function buildSearchScript(keyword) {
  const kw = JSON.stringify(keyword || '');
  return `async () => {
  const keyword = ${kw};
  const delay = ms => new Promise(res => setTimeout(res, ms));
  const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

  // 1. 登录态与反爬阻断检测
  const userAvatar = document.querySelector('.AppHeader-userAvatar, .Avatar, img[alt*="头像"]');
  const loginModal = document.querySelector('.sign-flow-modal, .Modal-wrapper');
  if (loginModal) {
    return { success: false, error: '检测到知乎登录弹窗拦截，请先在浏览器完成登录' };
  }

  // 2. 定位首页搜索框
  const searchInput = document.querySelector('input#Popover1-toggle, .SearchBar-input input, input[type="text"], input[placeholder*="搜索"]');
  if (!searchInput) {
    return { success: false, error: '未定位到知乎搜索框' };
  }

  // 3. 拟真聚焦与输入
  searchInput.focus();
  await randomDelay(300, 600);

  // React 原生受控组件状态同步
  const nativeInputValueSetter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set;
  nativeInputValueSetter.call(searchInput, keyword);
  searchInput.dispatchEvent(new Event('input', { bubbles: true }));
  searchInput.dispatchEvent(new Event('change', { bubbles: true }));

  await randomDelay(300, 600);

  // 4. 点击搜索按钮或派发 Enter 回车
  const searchBtn = document.querySelector('.SearchBar-searchButton, button[aria-label="搜索"]');
  if (searchBtn) {
    searchBtn.click();
  } else {
    searchInput.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 13, code: 'Enter', bubbles: true }));
  }

  return { success: true, keyword, message: '已触发搜索' };
}`;
}

/**
 * 生成在知乎搜索结果页 (https://www.zhihu.com/search?type=content&q=...) 批量回帖并自动发布的浏览器注入脚本
 * @param {Object} options
 * @param {string} options.content 回复文本内容
 * @param {number} [options.count=5] 处理条数
 * @param {number} [options.cooldownMin=1500] 步骤间防风控最小冷却时间 (ms)
 * @param {number} [options.cooldownMax=3000] 步骤间防风控最大冷却时间 (ms)
 * @returns {string} 可在 evaluate_script 中执行的自包含异步函数字符串
 */
export function buildCommentScript(options = {}) {
  const payload = JSON.stringify({
    content: options.content || '',
    count: Number(options.count) || 5,
    cooldownMin: Number(options.cooldownMin) || 1500,
    cooldownMax: Number(options.cooldownMax) || 3000
  });

  return `async () => {
  const options = ${payload};
  const logs = [];
  const results = [];

  function log(msg) {
    logs.push('[' + new Date().toLocaleTimeString() + '] ' + msg);
  }

  const delay = ms => new Promise(res => setTimeout(res, ms));
  const randomDelay = (min, max) => delay(Math.floor(Math.random() * (max - min + 1)) + min);

  log('开始扫描知乎搜索结果卡片，目标回帖处理条数: ' + options.count);

  // 辅助函数：扫描当前页面上的候选卡片
  function scanCandidates() {
    const cards = Array.from(document.querySelectorAll('.SearchResult-Card, .ContentItem'));
    const list = [];
    for (const card of cards) {
      const titleLink = card.querySelector('h2 a, .ContentItem-title a, a[data-za-detail-view-element_name="Title"]');
      const commentBtn = Array.from(card.querySelectorAll('button')).find(b => {
        const t = b.innerText.trim();
        return (t.includes('评论') || t.includes('添加评论')) && !t.includes('收起评论');
      });

      if (titleLink && commentBtn) {
        const title = titleLink.innerText.trim();
        const href = titleLink.href;
        if (!list.some(item => item.href === href || item.title === title)) {
          list.push({ card, titleLink, commentBtn, title, href });
        }
      }
    }
    return list;
  }

  let candidates = scanCandidates();

  // 若首屏候选卡片不足，自动平滑滚动加载更多
  if (candidates.length < options.count) {
    log('当前候选条数 (' + candidates.length + ') 少于目标条数 (' + options.count + ')，正在平滑滚动加载更多...');
    window.scrollBy({ top: 1200, behavior: 'smooth' });
    await delay(1800);
    candidates = scanCandidates();
  }

  log('检索到有效候选主题共 ' + candidates.length + ' 条');

  const targetList = candidates.slice(0, options.count);

  for (let i = 0; i < targetList.length; i++) {
    const item = targetList[i];
    const index = i + 1;
    log('----------------------------------------');
    log('正在处理第 [' + index + '/' + targetList.length + '] 条: 《' + item.title + '》');

    try {
      // 1. 拟真平滑滚动至视口中心
      item.card.scrollIntoView({ behavior: 'smooth', block: 'center' });
      await randomDelay(800, 1200);

      // 2. 点击展开评论按钮
      item.commentBtn.click();
      log('已触发展开评论区');
      await randomDelay(1200, 1800);

      // 3. 定位评论区容器与 Draft.js 编辑器
      const commentContainer = item.card.querySelector('.Comments-container, [class*="Comments"]');
      if (!commentContainer) {
        log('未检测到评论区展开，跳过本条');
        results.push({ index, title: item.title, href: item.href, status: 'failed', reason: '评论容器未展开' });
        continue;
      }

      const editor = commentContainer.querySelector('.public-DraftEditor-content');
      if (!editor) {
        log('未找到评论输入框（可能作者关闭评论或开启精选），跳过本条');
        results.push({ index, title: item.title, href: item.href, status: 'skipped', reason: '评论已关闭或需精选' });
        continue;
      }

      // 4. 聚焦编辑器并注入回复文本
      editor.focus();
      await randomDelay(300, 600);

      const dt = new DataTransfer();
      dt.setData('text/plain', options.content);
      const pasteEvt = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      editor.dispatchEvent(pasteEvt);
      log('已注入回复文本并派发 Draft.js 剪贴板事件');
      await randomDelay(800, 1200);

      // 5. 校验「发布」按钮激活状态
      const publishBtn = Array.from(commentContainer.querySelectorAll('button')).find(b => b.innerText.trim() === '发布');
      const isReady = Boolean(publishBtn && !publishBtn.disabled);
      log('发布按钮检测: ' + (isReady ? '已激活 (disabled=false)' : '未激活'));

      if (!publishBtn) {
        results.push({ index, title: item.title, href: item.href, status: 'failed', reason: '未找到发布按钮' });
        continue;
      }

      // 6. 自动点击「发布」按钮
      log('正在点击「发布」按钮...');
      publishBtn.focus();
      await randomDelay(300, 500);
      publishBtn.click();
      await randomDelay(1500, 2500);
      log('已提交发布');

      results.push({
        index,
        title: item.title,
        href: item.href,
        status: 'published',
        published: true
      });

      // 7. 防风控冷却时延
      if (i < targetList.length - 1) {
        const cooldown = Math.floor(Math.random() * (options.cooldownMax - options.cooldownMin + 1)) + options.cooldownMin;
        log('进入防风控冷却间隔 ' + cooldown + 'ms...');
        await delay(cooldown);
      }
    } catch (err) {
      log('处理单条异常: ' + err.message);
      results.push({ index, title: item.title, href: item.href, status: 'error', reason: err.message });
    }
  }

  log('批量处理完毕，共完成 ' + results.length + ' 条主题交互');
  return {
    success: true,
    totalTarget: options.count,
    processedCount: results.length,
    results,
    logs
  };
}`;
}

// 命令行直接运行支撑
if (process.argv[1] && process.argv[1].endsWith('zhihu_commenter.mjs')) {
  const args = process.argv.slice(2);
  const getArg = (flag, def) => {
    const idx = args.indexOf(flag);
    return idx !== -1 && args[idx + 1] ? args[idx + 1] : def;
  };

  const keyword = getArg('--keyword', '自媒体');
  const content = getArg('--content', '自媒体创作避坑 https://zhuanlan.zhihu.com/p/2078843612532568622');
  const count = parseInt(getArg('--count', '5'), 10);

  console.log('知乎自动回帖配置参数:');
  console.log({ keyword, content, count });
  console.log('\n生成的搜索脚本:\n', buildSearchScript(keyword).slice(0, 200) + '...\n');
  console.log('生成的批处理回帖脚本:\n', buildCommentScript({ content, count }).slice(0, 200) + '...\n');
}
