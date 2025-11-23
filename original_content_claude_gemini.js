// 現在のサービスを判定
const currentService = detectService();

// 状態管理
let isGenerating = false;
let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN = 3000; // 3秒間は再通知しない
let generationStartTime = 0;
let completedInBackground = false; // バックグラウンドで完了したかどうか

// 枠要素
let borderFrame = null;
const DISPLAY_FRAME = false; // ユーザーリクエストにより無効化

// デバッグモード
const DEBUG = true;

function log(...args) {
  if (DEBUG) {
    console.log('[AI Dashboard]', ...args);
  }
}

function isElementVisible(element) {
  if (!element) {
    return false;
  }

  const style = window.getComputedStyle(element);
  if (style.display === 'none' || style.visibility === 'hidden' || style.opacity === '0') {
    return false;
  }

  if (element.offsetParent === null && style.position !== 'fixed') {
    return false;
  }

  return true;
}

// 初期化
if (currentService) {
  log(`${currentService} を検知しました`);
  createBorderFrame();
  registerServiceTab(currentService);
  interceptNetworkRequests(currentService);
} else {
  log('対象サービスではありません:', window.location.hostname);
}

// サービスを判定
function detectService() {
  const hostname = window.location.hostname;

  if (hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) {
    return 'chatgpt';
  } else if (hostname.includes('claude.ai')) {
    return 'claude';
  } else if (hostname.includes('gemini.google.com')) {
    return 'gemini';
  } else if (hostname.includes('notebooklm.google.com')) {
    return 'notebooklm';
  }

  return null;
}

// サービスタブを登録（tabIdを自動解決）
function registerServiceTab(service) {
  chrome.runtime.sendMessage({ type: 'REGISTER_SERVICE_TAB', service }, (response) => {
    if (response?.registered) {
      log(`[Register] ${service} タブを登録しました`);
    } else {
      log(`[Register] ${service} タブ登録に失敗しました`);
    }
  });
  window.addEventListener('beforeunload', () => {
    try {
      chrome.runtime.sendMessage({ type: 'UNREGISTER_SERVICE_TAB', service });
      log(`[Register] ${service} タブを登録解除しました`);
    } catch (e) {
      // 拡張機能のコンテキストが無効になっている場合は無視
    }
  });
}

// ネットワークリクエストのインターセプト（Monkey Patch）
function interceptNetworkRequests(service) {
  // APIエンドポイントのパターン
  const apiPatterns = {
    claude: [
      /claude\.ai\/api\/append_message/,
      /claude\.ai\/api\/messages/,
      /claude\.ai\/api\/projects\/.*\/messages/,
      /claude\.ai\/api\/organizations\/.*\/chat_conversations/
    ],
    gemini: [
      /gemini\.google\.com\/_\/BardChatUi\/data/,
      /gemini\.google\.com\/_\/BardChatUi\/streamingrpc/,
      /gemini\.googleusercontent\.com\/_\/BardChatUi\/data/,
      /gemini\.google\.com\/_\/assistant/,
      /gemini\.google\.com\/u\/.*\/_\/BardChatUi\/data/
    ]
  };

  const patterns = apiPatterns[service] || [];

  function matchesPattern(url) {
    return patterns.some(pattern => pattern.test(url));
  }

  // fetch のインターセプト
  const originalFetch = window.fetch;
  window.fetch = function (...args) {
    const url = args[0]?.toString() || '';

    if (matchesPattern(url)) {
      log(`🔄 Fetch detected: ${url}`);
      chrome.runtime.sendMessage({
        type: 'NETWORK_EVENT',
        service: service,
        status: 'generating'
      });
    }

    return originalFetch.apply(this, args).then(response => {
      if (matchesPattern(url)) {
        log(`✅ Fetch completed: ${url}`);
        chrome.runtime.sendMessage({
          type: 'NETWORK_EVENT',
          service: service,
          status: 'completed'
        });
      }
      return response;
    }).catch(error => {
      if (matchesPattern(url)) {
        log(`❌ Fetch error: ${url}`);
        chrome.runtime.sendMessage({
          type: 'NETWORK_EVENT',
          service: service,
          status: 'idle'
        });
      }
      throw error;
    });
  };

  // XMLHttpRequest のインターセプト
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url, ...rest) {
    this._url = url.toString();
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function (...args) {
    const url = this._url || '';

    if (matchesPattern(url)) {
      log(`🔄 XHR detected: ${url}`);
      chrome.runtime.sendMessage({
        type: 'NETWORK_EVENT',
        service: service,
        status: 'generating'
      });

      this.addEventListener('load', () => {
        log(`✅ XHR completed: ${url}`);
        chrome.runtime.sendMessage({
          type: 'NETWORK_EVENT',
          service: service,
          status: 'completed'
        });
      });

      this.addEventListener('error', () => {
        log(`❌ XHR error: ${url}`);
        chrome.runtime.sendMessage({
          type: 'NETWORK_EVENT',
          service: service,
          status: 'idle'
        });
      });
    }

    return originalXHRSend.apply(this, args);
  };

  log(`ネットワークインターセプトを開始しました ${service}`);
}

// バックグラウンドからのメッセージを受信
chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'FORCE_STATUS' || message.service !== currentService) {
    return;
  }

  if (message.status === 'generating') {
    isGenerating = true;
    generationStartTime = message.timestamp || Date.now();
    updateFrameStatus('generating');
    completedInBackground = false;
  } else if (message.status === 'completed') {
    if (isGenerating) {
      isGenerating = false;

      // バックグラウンドタブかどうかを確認
      if (document.hidden) {
        completedInBackground = true;
        log('バックグラウンドで完了しました。タブに戻ると緑枠が表示されます');
      } else {
        updateFrameStatus('completed');
      }
    }
    // 通知はService Workerで行われるため、ここでは通知しない
    lastNotificationTime = message.timestamp || Date.now();
  } else if (message.status === 'idle') {
    isGenerating = false;
    updateFrameStatus('idle');
    completedInBackground = false;
  }
});

// Page Visibility API: タブがアクティブになったときに緑枠を表示
document.addEventListener('visibilitychange', () => {
  if (!document.hidden && completedInBackground) {
    log('タブがアクティブになりました。完了状態を表示します');
    updateFrameStatus('completed');

    // 5秒後に緑枠を非表示にする
    setTimeout(() => {
      if (borderFrame && !isGenerating) {
        borderFrame.style.borderWidth = '0px';
        completedInBackground = false;
        log('枠を非表示にしました');
      }
    }, 5000);
  }
});

// 枠要素を作成
function createBorderFrame() {
  if (!DISPLAY_FRAME) return;

  // 既存の枠があれば削除
  if (borderFrame) {
    borderFrame.remove();
  }

  // 枠要素を作成
  borderFrame = document.createElement('div');
  borderFrame.id = 'ai-multi-sidebar-frame';
  borderFrame.style.cssText = `
    position: fixed;
    top: 0;
    left: 0;
    right: 0;
    bottom: 0;
    pointer-events: none;
    z-index: 999999;
    border: 0px solid transparent;
    transition: border-width 0.3s ease, border-color 0.3s ease;
  `;

  document.body.appendChild(borderFrame);
  log('枠要素を作成しました');
}

// 枠の状態を更新
function updateFrameStatus(status) {
  if (!DISPLAY_FRAME) return;

  if (!borderFrame) {
    log('Frame element missing; recreating');
    createBorderFrame();
  }

  if (status === 'generating') {
    // 思考中: 赤枠
    borderFrame.style.borderWidth = '8px';
    borderFrame.style.borderColor = '#ff4444';
    log('🔴 生成開始 - 赤枠表示');
  } else if (status === 'completed') {
    // 完了: 緑枠
    borderFrame.style.borderWidth = '8px';
    borderFrame.style.borderColor = '#44ff44';
    log('🟢 生成完了 - 緑枠表示');

    // バックグラウンドで完了した場合は保持、フォアグラウンドなら非表示
    if (!completedInBackground) {
      // フォアグラウンドで完了した場合、3秒後に非表示にする
      setTimeout(() => {
        if (borderFrame && !isGenerating && !completedInBackground) {
          borderFrame.style.borderWidth = '0px';
          log('枠を非表示にしました');
        }
      }, 3000);
    }
  } else {
    // アイドル: 枠なし
    borderFrame.style.borderWidth = '0px';
    log('アイドル状態 - 枠非表示');
  }
}

