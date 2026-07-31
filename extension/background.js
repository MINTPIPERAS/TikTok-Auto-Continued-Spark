// 后台 service worker：跨域 fetch 代理 + 系统通知
// 注意：service worker 可能随时被浏览器休眠，消息可将其唤醒。

chrome.runtime.onInstalled.addListener(() => {
  console.log('[抖音续火助手] background service worker 已启动');
});

chrome.runtime.onStartup.addListener(() => {
  console.log('[抖音续火助手] background service worker 已启动 (onStartup)');
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'PROXY_FETCH') {
    handleProxyFetch(message)
      .then((response) => sendResponse(response))
      .catch((error) => sendResponse({ ok: false, error: String(error) }));
    return true; // 保持消息通道开启以支持异步响应
  }

  if (message && message.type === 'NOTIFY') {
    chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: message.title || '抖音续火助手',
      message: message.text || ''
    }, () => {
      if (chrome.runtime.lastError) {
        console.warn('[抖音续火助手] 通知发送失败:', chrome.runtime.lastError.message);
      }
    });
    sendResponse({ ok: true });
  }
});

async function handleProxyFetch(message) {
  const controller = new AbortController();
  const timeoutMs = message.timeout || 15000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(message.url, {
      method: message.method || 'GET',
      headers: message.headers || {},
      body: message.body,
      signal: controller.signal
    });
    const responseText = await response.text();
    return {
      ok: response.ok,
      status: response.status,
      statusText: response.statusText,
      responseText,
      responseType: message.responseType
    };
  } catch (error) {
    return {
      ok: false,
      status: 0,
      error: String(error),
      timedOut: error && error.name === 'AbortError'
    };
  } finally {
    clearTimeout(timer);
  }
}
