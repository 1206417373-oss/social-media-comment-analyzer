/**
 * 接收 content.js 提取的数据，发送到本地后端分析，
 * 然后将结果存入 storage 并打开 index.html。
 */

const BACKEND_URL = 'http://localhost:8000/analyze-direct';

chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request.action === 'analyze') {
    handleAnalyze(request.payload).then(sendResponse);
    return true;
  }
});

async function handleAnalyze(payload) {
  try {
    const stored = await chrome.storage.local.get(['deepseek_api_key']);
    const apiKey = stored.deepseek_api_key || '';

    if (!apiKey) {
      return { success: false, error: '请先在插件中配置 DeepSeek API Key' };
    }

    const requestBody = {
      platform: 'xiaohongshu',
      post_content: payload.post_content || '',
      images: payload.images || [],
      comments: payload.comments || [],
      deepseek_api_key: apiKey
    };

    console.log('[background] 发送 analyze-direct 请求, 评论数:', requestBody.comments.length);

    let resp;
    try {
      resp = await fetch(BACKEND_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(requestBody)
      });
    } catch (fetchErr) {
      return {
        success: false,
        error: `无法连接后端服务 (${BACKEND_URL}): ${fetchErr.message}。请确认后端已启动。`
      };
    }

    console.log('[background] 响应状态:', resp.status);

    if (resp.status !== 200) {
      let bodyPreview = '';
      try { bodyPreview = (await resp.text()).substring(0, 300); } catch (e) {}
      return {
        success: false,
        error: `后端返回 HTTP ${resp.status}: ${bodyPreview}`
      };
    }

    let result;
    try {
      result = await resp.json();
    } catch (jsonErr) {
      return {
        success: false,
        error: `后端响应无法解析为JSON: ${jsonErr.message}`
      };
    }

    if (result.success) {
      // 将结果存到后端内存
      await fetch('http://localhost:8000/store-result', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ result: result.data })
      });

      // 打开后端serve的 index.html
      const pageUrl = 'http://localhost:8000/';
      const tabs = await chrome.tabs.query({});
      const existingTab = tabs.find(t => t.url === pageUrl || t.url === pageUrl + '#');
      if (existingTab) {
        await chrome.tabs.update(existingTab.id, { active: true });
        await chrome.tabs.reload(existingTab.id);
      } else {
        await chrome.tabs.create({ url: pageUrl });
      }
    }

    return result;

  } catch (err) {
    return { success: false, error: `未知错误: ${err.message}` };
  }
}
