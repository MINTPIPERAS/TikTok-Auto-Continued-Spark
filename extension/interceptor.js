// ==================== MAIN world 用户列表 API 拦截器 ====================
// 运行在页面环境（manifest 中声明 world: "MAIN"），与页面脚本共享 JS 环境，
// 因此可以改写页面自身的 XMLHttpRequest / fetch 原型。
// 注意：此文件不可使用 chrome.* API，捕获到数据后通过 window.postMessage
// 传给隔离世界的内容脚本（content.js 中 interceptUserDetailApi 注册的监听）。

(function () {
	'use strict';

	const TARGET_URL = '/aweme/v1/creator/im/user_detail/';

	const postUserList = (userList) => {
		window.postMessage({
			__dyFireExtMsg__: true,
			type: 'USER_LIST',
			data: userList
		}, '*');
	};

	const origOpen = XMLHttpRequest.prototype.open;
	const origSend = XMLHttpRequest.prototype.send;
	XMLHttpRequest.prototype.open = function (method, url) {
		this.__dyFireInterceptUrl = url;
		return origOpen.apply(this, arguments);
	};
	XMLHttpRequest.prototype.send = function () {
		if (this.__dyFireInterceptUrl && this.__dyFireInterceptUrl.includes(TARGET_URL)) {
			this.addEventListener('load', function () {
				try {
					const data = JSON.parse(this.responseText);
					if (data && data.user_list) postUserList(data.user_list);
				} catch (e) {}
			});
		}
		return origSend.apply(this, arguments);
	};

	const origFetch = window.fetch;
	window.fetch = function (input, init) {
		const url = typeof input === 'string' ? input : (input && input.url) || '';
		const result = origFetch.apply(this, arguments);
		if (url.includes(TARGET_URL)) {
			result.then((response) => {
				response.clone().json().then((data) => {
					if (data && data.user_list) postUserList(data.user_list);
				}).catch(() => {});
			}).catch(() => {});
		}
		return result;
	};

	console.log('[抖音续火助手] interceptor.js (MAIN world) 已就绪', window.location.href);
})();
