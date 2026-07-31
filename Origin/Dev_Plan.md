# 抖音续火助手 · 浏览器插件版 实施计划

决策已确认：**Chrome/Edge（Chromium）MV3 扩展**、**保留页面内面板**、**去掉后端回调**、**网络权限 `<all_urls>`**。

## 一、必要知识（新手速成）

**浏览器扩展的本质**：一个包含 `manifest.json`（清单）和若干脚本的文件夹，浏览器以"解压扩展"方式加载后，注入代码到指定网页执行。你不需要服务器，扩展在本地。

**MV3 扩展里的三种角色**：
1. **Content Script（内容脚本）** —— 注入到抖音页面里、能操作页面 DOM 的脚本。你的续火脚本 99% 逻辑都属于这类。
2. **Service Worker（后台脚本）** —— 扩展自己的后台进程，**不在页面里**，用来做内容脚本做不了的事（如：绕过 CORS 的网络请求、系统通知）。
3. **Options / Popup 页面** —— 扩展自己的界面（本方案不启用，因为保留页面内面板）。

**三个最容易混淆的概念**：
- **隔离世界（ISOLATED world）**：内容脚本默认运行在一个隔离环境，能看到/操作页面 DOM，但**改不了页面自己的 JavaScript 变量和 XHR 原型**。你的脚本里 `interceptUserDetailApi()` 改写页面 `XMLHttpRequest` 的代码，在隔离世界是**无效的**——必须放到 MAIN world。
- **MAIN world（主世界）**：和页面脚本共享同一个 JS 环境。Chrome 111+ 可以在 manifest 里声明 `"world": "MAIN"`，让某段脚本在页面环境执行（不违反页面 CSP）。这就是解决 XHR 拦截问题的钥匙。
- **消息传递**：内容脚本（页面内）↔ 后台（页面外）不能直接调用函数，只能通过 `chrome.runtime.sendMessage` 收发消息。

**权限（permissions）**：`storage`（存数据）、`notifications`（发通知）、`host_permissions`（允许访问哪些网站，解决跨域——`<all_urls>` 表示所有域名）。

**开发调试**：打开 `chrome://extensions` → 右上角开启"开发者模式" → "加载已解压的扩展程序"选择文件夹。改代码后点刷新按钮即可。Edge 同理（`edge://extensions`）。

## 二、总体架构

```
抖音页面 (www.douyin.com/chat)
 ├── interceptor.js (MAIN world)  ── 拦截页面自己的 fetch/XHR，拿用户列表
 │        └── window.postMessage ──► 内容脚本监听
 ├── content.js (ISOLATED world)  ── 原脚本全部逻辑 + GM shim
 │        ├── chrome.storage.local ── 同步 shim（内存缓存+异步落盘）
 │        └── chrome.runtime.sendMessage ──► background.js (service worker)
 │                                              └── fetch 代发 hitokoto/TXTAPI（绕过 CORS）
 └── 注入的浮动面板 UI（保留原样）
```

**核心思路：原脚本 4388 行几乎不动**，只做四件事——(1) 顶部加一个 GM API 兼容 shim；(2) 把 XHR 拦截函数拆去 MAIN world；(3) 删掉后端回调；(4) 改启动代码。风险极低，功能 1:1 保留。

## 三、文件结构

```
extension/                  （新建，放在仓库根目录）
├── manifest.json           MV3 清单
├── background.js           后台：跨域 fetch 代理 + 通知
├── content.js              主逻辑（原脚本移植 + GM shim）
├── interceptor.js          MAIN world：XHR/fetch 拦截器
└── icons/
    ├── icon16.png  icon48.png  icon128.png   （用 PowerShell 生成，见阶段1）
```

## 四、分步实施

### 阶段 1：脚手架 + 加载验证（最小可运行）
1. 新建 `extension/` 目录，创建 `manifest.json`（草稿见下）。
2. 用 PowerShell `System.Drawing` 画 3 个占位图标（红底白色"火"字，16/48/128 像素，纯 .NET 无需额外依赖）。
3. 放一个空 `background.js` 和只打印一句日志的 `content.js`。
4. 打开 `chrome://extensions` → 开发者模式 → 加载已解压扩展 → 打开抖音聊天页验证注入生效。

### 阶段 2：GM shim 层（关键，保证同步读写不炸）
在 `content.js` 顶部实现 5 个与原脚本同名的 GM 函数，**函数签名完全一致**，主体代码零改动：

```js
const storeCache = {};
async function gmStoreInit() { Object.assign(storeCache, await chrome.storage.local.get(null)); }

function GM_getValue(k, d)    { return (k in storeCache) ? storeCache[k] : d; }
function GM_setValue(k, v)    { storeCache[k] = v; chrome.storage.local.set({ [k]: v }); }
function GM_deleteValue(k)    { delete storeCache[k]; chrome.storage.local.remove(k); }
function GM_listValues()      { return Object.keys(storeCache); }

// 其他标签页改存储时同步到本标签页缓存
chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== 'local') return;
  for (const [k, { newValue }] of Object.entries(ch)) {
    if (newValue === undefined) delete storeCache[k]; else storeCache[k] = newValue;
  }
});

function GM_xmlhttpRequest(o) {
  chrome.runtime.sendMessage({
    type: 'PROXY_FETCH', method: o.method, url: o.url,
    headers: o.headers, body: o.data, responseType: o.responseType, timeout: o.timeout,
  }, (res) => {
    if (chrome.runtime.lastError) { o.onerror && o.onerror({}); return; }
    if (res && res.ok) o.onload && o.onload({
      status: res.status, statusText: res.statusText, responseText: res.responseText,
      response: res.responseType === 'json' ? JSON.parse(res.responseText) : res.responseText,
    });
    else o.onerror && o.onerror(res || {});
  });
}
function GM_notification(o) { chrome.runtime.sendMessage({ type: 'NOTIFY', title: o.title || '', text: o.text || '' }); }
```

**为什么这么写**：`chrome.storage` 是异步的，而原脚本几百处 `GM_getValue` 都是同步调用。用一个"启动时一次性读进内存、每次写立刻落盘 + 更新缓存"的 shim，就能让原代码一行不改继续同步调用。

### 阶段 3：移植主体逻辑（content.js）
1. 删除文件头的 `==UserScript==` 元数据块。
2. 把原脚本 IIFE 主体全部复制进来（函数定义原样保留）。
3. 删除后端回调相关：`DEFAULT_CONFIG` 里的 `enableScriptBCallback`/`scriptBCallbackPort`/`backendRetryMinutes`，`notifyScriptB()` 函数，设置面板里"🔗 后端调度器回调"区块及其在 `saveSettings()` 里的读取代码，并把 `checkAllUsersProcessed()` 里的 4 处 `notifyScriptB(...)` 调用改成 `addHistoryLog(...)`。
4. 替换 `interceptUserDetailApi()`：原实现（改写 XHR/fetch）删除，改为监听 `window` 的 `message` 事件并回调 `processUserApiResponse`（见阶段 4）。
5. 改启动代码（原 4388 行末尾）为：
```js
(async function bootstrap() {
  await gmStoreInit();
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data.__dyFireExtMsg__ !== true) return;
    if (e.data.type === 'USER_LIST') processUserApiResponse(e.data.data);
  });
  const start = () => init();
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
```

### 阶段 4：MAIN world 拦截器（interceptor.js）
原 `interceptUserDetailApi()` 原样放进独立文件，在 manifest 里声明 `"world": "MAIN"`（只改原型、只 postMessage，不触碰 chrome API）：

```js
// interceptor.js —— 在页面环境执行
(function () {
  const TARGET_URL = '/aweme/v1/creator/im/user_detail/';
  const post = (data) => window.postMessage({ __dyFireExtMsg__: true, type: 'USER_LIST', data }, '*');
  // ...原 XHR.open/send 改写 + fetch 改写（捕获 data.user_list 后 post 出去）
})();
```

### 阶段 5：测试清单
在 `chrome://extensions` 里加载、打开 `https://www.douyin.com/chat`，逐项验证：
- 浮动面板出现、可拖动、可关闭/重新打开
- "立即发送"能发出一条带一言/TXTAPI/天数的消息
- 设置面板：改时间、消息模板、多用户列表 → 保存 → 刷新页面后配置仍在（存储生效）
- 多用户模式：连续给多个用户发；"用户选择"面板能滚动收集列表（此时日志会出现"从API获取到用户数据"——验证拦截器生效）
- 火花天数自动 +1
- 历史日志导出（Blob 下载在内容脚本里可用）

### 阶段 6：打包
`chrome://extensions` → "打包扩展程序"生成 `.crx` 安装包；或直接 zip 整个 `extension/` 目录分发。

## 五、注意的坑（提前告知）

1. **数据不迁移**：油猴里已有的配置/天数不会自动带到扩展里，首次使用从默认配置开始。
2. **和油猴一样"页面开着才工作"**：扩展的内容脚本也只在抖音聊天页打开时运行，页面关掉就不自动发。这和原脚本行为一致。
3. **需要登录**：发送逻辑依赖你的抖音登录态，测试请用真实账号。
4. **跨标签一致性**：同步 shim 做了 `storage.onChanged` 同步，多开聊天页基本一致，但极端并发下可能有轻微竞态，个人使用可接受。
5. **权限提示**：`<all_urls>` 会使安装时提示"读取和更改所有网站数据"，正常现象。

## 六、后续可选增强（本次不做）
- 设置/日志搬进扩展自己的 options 页面
- 用 `chrome.alarms` 在后台定时唤醒 + 自动打开聊天标签页（解决"必须开着页面"）
- Firefox 兼容（FF 不支持 manifest 的 `world` 字段，需改为脚本注入方式）
- 一键导入油猴旧数据
