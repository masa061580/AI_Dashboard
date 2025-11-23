// タブの状態を管理
const tabStates = new Map();
const serviceTabMap = new Map();  // service -> Set(tabId)

// 通知音の設定
let notificationSound = 'bell'; // デフォルトは'bell'

// 拡張機能アイコンクリック時にサイドパネルを開く
chrome.action.onClicked.addListener(async (tab) => {
  try {
    await chrome.sidePanel.open({ windowId: tab.windowId });
  } catch (error) {
    console.error('サイドパネルを開けませんでした:', error);
  }
});

// サービス名の日本語マッピング
const SERVICE_NAMES = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  notebooklm: 'NotebookLM'
};

// タブごとのネットワークリクエスト数を管理
const activeNetworkRequests = new Map(); // key: `${service}:${tabId}` → { count, timer }
const NETWORK_COMPLETE_DELAY = 600;      // 0.6s 後に完了扱い（フリッカー防止）

function networkKey(tabId, service) {
  return `${service}:${tabId}`;
}

function markNetworkGenerating(tabId, service) {
  const key = networkKey(tabId, service);
  const state = activeNetworkRequests.get(key) || { count: 0, timer: null };
  state.count += 1;
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  activeNetworkRequests.set(key, state);

  console.debug(`[Network] ${service} generating (count: ${state.count}, tabId: ${tabId})`);

  if (state.count === 1) {
    setTabStatusFromNetwork(tabId, service, 'generating');
  }
}

function markNetworkIdle(tabId, service, finalStatus = 'completed') {
  const key = networkKey(tabId, service);
  const state = activeNetworkRequests.get(key) || { count: 0, timer: null };

  if (state.count > 0) {
    state.count -= 1;
  }

  console.debug(`[Network] ${service} idle (count: ${state.count}, finalStatus: ${finalStatus}, tabId: ${tabId})`);

  if (state.count === 0) {
    state.timer = setTimeout(() => {
      activeNetworkRequests.delete(key);
      setTabStatusFromNetwork(tabId, service, finalStatus);
    }, NETWORK_COMPLETE_DELAY);
  }

  activeNetworkRequests.set(key, state);
}

// content scriptからのメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'STATUS_UPDATE') {
    handleStatusUpdate(message, sender);
    sendResponse({ received: true });
  } else if (message.type === 'TASK_COMPLETED') {
    handleTaskCompletion(message, sender);
    sendResponse({ received: true });
  } else if (message.type === 'NETWORK_EVENT') {
    // content.jsからのネットワークイベント（monkey patch）
    const tabId = sender.tab?.id;
    if (tabId && message.service && message.status) {
      if (message.status === 'generating') {
        markNetworkGenerating(tabId, message.service);
      } else if (message.status === 'completed') {
        markNetworkIdle(tabId, message.service, 'completed');
      } else if (message.status === 'idle') {
        markNetworkIdle(tabId, message.service, 'idle');
      }
    }
    sendResponse({ received: true });
  } else if (message.type === 'REGISTER_SERVICE_TAB') {
    const tabId = sender.tab?.id;
    if (tabId && message.service) {
      if (!serviceTabMap.has(message.service)) {
        serviceTabMap.set(message.service, new Set());
      }
      serviceTabMap.get(message.service).add(tabId);
      console.debug(`[ServiceTab] Registered ${message.service} tab: ${tabId}`);
    }
    sendResponse({ registered: true });
  } else if (message.type === 'UNREGISTER_SERVICE_TAB') {
    const tabId = sender.tab?.id;
    if (tabId && message.service && serviceTabMap.has(message.service)) {
      serviceTabMap.get(message.service).delete(tabId);
      if (serviceTabMap.get(message.service).size === 0) {
        serviceTabMap.delete(message.service);
      }
      console.debug(`[ServiceTab] Unregistered ${message.service} tab: ${tabId}`);
    }
    sendResponse({ removed: true });
  } else if (message.type === 'GET_TAB_STATES') {
    sendResponse({ states: Array.from(tabStates.entries()) });
  } else if (message.type === 'SET_NOTIFICATION_SOUND') {
    notificationSound = message.sound;
    chrome.storage.local.set({ notificationSound: message.sound });
    sendResponse({ success: true });
  } else if (message.type === 'GET_NOTIFICATION_SOUND') {
    sendResponse({ sound: notificationSound });
  }
  return true; // 非同期レスポンスを許可
});

// 状態更新の処理
async function handleStatusUpdate(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  tabStates.set(tabId, {
    service: message.service,
    status: message.status,
    timestamp: message.timestamp,
    url: sender.tab.url,
    title: sender.tab.title
  });

  // サイドパネルに状態を送信
  broadcastToSidePanel({
    type: 'TAB_STATE_UPDATE',
    tabId: tabId,
    state: tabStates.get(tabId)
  });

  // 生成開始時はバッジをクリア
  if (message.status === 'generating') {
    // この タブの完了状態をクリア
    const state = tabStates.get(tabId);
    if (state) {
      state.status = 'generating';
      tabStates.set(tabId, state);
    }
    await updateBadge();
  }
}

// ネットワークイベントからタブ状態を更新
async function setTabStatusFromNetwork(tabId, service, status) {
  const timestamp = Date.now();
  const previous = tabStates.get(tabId) || {};
  let tabInfo = previous;

  try {
    const tab = await chrome.tabs.get(tabId);
    tabInfo = {
      url: tab.url,
      title: tab.title
    };
  } catch (error) {
    // タブが閉じられた場合は処理をスキップ
    if (error.message && error.message.includes('No tab with id')) {
      console.debug(`[Network] Tab ${tabId} already closed, skipping status update`);
      return;
    }
    console.warn('タブ情報を取得できませんでした:', error);
  }

  // 同じ状態への重複更新を回避
  if (previous.status === status) {
    return;
  }

  // completedの場合、既にcompletedなら通知しない
  if (status === 'completed' && previous.status === 'completed') {
    return;
  }

  const nextState = {
    ...tabInfo,
    service,
    status,
    timestamp
  };

  tabStates.set(tabId, nextState);

  broadcastToSidePanel({
    type: 'TAB_STATE_UPDATE',
    tabId,
    state: nextState
  });

  try {
    await chrome.tabs.sendMessage(tabId, {
      type: 'FORCE_STATUS',
      service,
      status,
      timestamp
    });
  } catch (error) {
    // コンテンツスクリプト未読込時は無視
  }

  if (status === 'completed') {
    const message = `${SERVICE_NAMES[service] || service}の回答生成が完了しました`;
    await createCompletionNotification(tabId, service, message, timestamp, tabInfo);
  } else {
    await updateBadge();
  }
}

// 完了通知を作成（共通ヘルパー）
async function createCompletionNotification(tabId, service, message, timestamp, tabInfo = {}) {
  const serviceName = SERVICE_NAMES[service] || service;

  try {
    const notificationId = await chrome.notifications.create({
      type: 'basic',
      iconUrl: 'icons/icon128.png',
      title: `${serviceName} - 作業完了`,
      message: message || 'クエリの処理が完了しました',
      priority: 2,
      silent: true,
      requireInteraction: true  // ユーザーが閉じるまで表示し続ける
    });

    console.log(`通知を作成しました: ID=${notificationId}, service=${serviceName}`);
    await playNotificationSound();
  } catch (error) {
    console.error('通知の作成に失敗しました:', error);
  }

  tabStates.set(tabId, {
    service,
    status: 'completed',
    timestamp,
    url: tabInfo.url,
    title: tabInfo.title
  });

  broadcastToSidePanel({
    type: 'TASK_COMPLETED',
    tabId,
    service,
    message
  });

  await updateBadge();
}

// タスク完了時の処理
async function handleTaskCompletion(message, sender) {
  const tabId = sender.tab?.id;
  if (!tabId) return;

  const tabInfo = {
    url: sender.tab.url,
    title: sender.tab.title
  };

  await createCompletionNotification(
    tabId,
    message.service,
    message.message,
    message.timestamp,
    tabInfo
  );

  console.log(`通知を送信しました: ${SERVICE_NAMES[message.service] || message.service}`);
}

// バッジ表示を更新
async function updateBadge() {
  // 完了状態のタブをカウント
  const completedCount = Array.from(tabStates.values())
    .filter(state => state.status === 'completed')
    .length;

  if (completedCount > 0) {
    await chrome.action.setBadgeText({ text: completedCount.toString() });
    await chrome.action.setBadgeBackgroundColor({ color: '#44ff44' });
  } else {
    await chrome.action.setBadgeText({ text: '' });
  }
}

// 通知音を再生
async function playNotificationSound() {
  try {
    // 設定を読み込み
    const result = await chrome.storage.local.get('notificationSound');
    const sound = result.notificationSound || 'bell';

    // オフスクリーンドキュメントで音を再生
    await ensureOffscreenDocument();
    await chrome.runtime.sendMessage({
      type: 'PLAY_SOUND',
      sound: sound
    });
  } catch (error) {
    console.error('通知音再生エラー:', error);
  }
}

// オフスクリーンドキュメントを確保
async function ensureOffscreenDocument() {
  const existingContexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT']
  });

  if (existingContexts.length > 0) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['AUDIO_PLAYBACK'],
    justification: '通知音を再生するため'
  });
}

// サイドパネルにメッセージをブロードキャスト
function broadcastToSidePanel(message) {
  chrome.runtime.sendMessage(message).catch(() => {
    // サイドパネルが開いていない場合はエラーを無視
  });
}

// 通知クリック時の処理
chrome.notifications.onClicked.addListener((notificationId) => {
  chrome.notifications.clear(notificationId);
});

// タブが閉じられた時の処理
chrome.tabs.onRemoved.addListener(async (tabId) => {
  if (tabStates.has(tabId)) {
    tabStates.delete(tabId);

    // サイドパネルに通知
    broadcastToSidePanel({
      type: 'TAB_REMOVED',
      tabId: tabId
    });

    // バッジを更新
    await updateBadge();
  }

  // serviceTabMapからも削除
  for (const [service, tabs] of serviceTabMap.entries()) {
    if (tabs.has(tabId)) {
      tabs.delete(tabId);
      if (tabs.size === 0) {
        serviceTabMap.delete(service);
      }
      console.debug(`[ServiceTab] Removed ${service} tab: ${tabId}`);
    }
  }
});

// タブがアクティブになった時の処理
chrome.tabs.onActivated.addListener(async (activeInfo) => {
  const tabId = activeInfo.tabId;
  const state = tabStates.get(tabId);

  // アクティブになったタブが完了状態だった場合、そのタブの完了状態をクリア
  if (state && state.status === 'completed') {
    state.status = 'idle';
    tabStates.set(tabId, state);
    await updateBadge();
  }
});

// 拡張機能インストール時の初期化
chrome.runtime.onInstalled.addListener(async (details) => {
  if (details.reason === 'install') {
    console.log('AI Dashboard がインストールされました');
    await chrome.storage.local.set({ notificationSound: 'bell' });
  } else if (details.reason === 'update') {
    console.log('AI Dashboard がアップデートされました');
  }

  // 設定を読み込み
  const result = await chrome.storage.local.get('notificationSound');
  notificationSound = result.notificationSound || 'bell';
});

// 起動時に設定を読み込み
chrome.storage.local.get('notificationSound').then(result => {
  notificationSound = result.notificationSound || 'bell';
});

// tabId解決ヘルパー（tabId === -1の場合に登録タブから解決）
async function resolveTabId(details, service) {
  if (details.tabId && details.tabId >= 0) {
    console.debug(`[ResolveTab] ${service} - tabId from request: ${details.tabId}`);
    return details.tabId;
  }

  const candidates = serviceTabMap.get(service);
  console.debug(`[ResolveTab] ${service} - serviceTabMap candidates:`, candidates ? Array.from(candidates) : 'none');
  if (candidates && candidates.size > 0) {
    for (const id of candidates) {
      console.debug(`[ResolveTab] ${service} - resolved from serviceTabMap: ${id}`);
      return id;
    }
  }

  const urls = {
    claude: '*://claude.ai/*',
    gemini: '*://gemini.google.com/*'
  };
  const tabs = await chrome.tabs.query({ url: urls[service] });
  console.debug(`[ResolveTab] ${service} - chrome.tabs.query result:`, tabs.map(t => ({ id: t.id, url: t.url, lastAccessed: t.lastAccessed })));
  if (tabs.length > 0) {
    tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
    console.debug(`[ResolveTab] ${service} - resolved from tabs.query: ${tabs[0].id}`);
    return tabs[0].id;
  }

  console.debug(`[ResolveTab] ${service} - no tab context found`, details);
  return undefined;
}

// ネットワークイベントをtabId解決後に転送
function forwardNetworkEvent(details, service, status) {
  // ホワイトリスト方式: 生成に直接関係するリクエストのみカウント
  const includePatterns = {
    claude: [
      /\/completion$/,           // 実際の生成リクエスト
      /\/completion\?/           // クエリパラメータ付き
    ],
    gemini: [
      /StreamGenerate/           // 実際の生成リクエスト
    ]
  };

  const patterns = includePatterns[service] || [];
  const shouldInclude = patterns.some(pattern => pattern.test(details.url));

  if (!shouldInclude) {
    console.debug('[NetworkEvent] Ignored (not generation):', service, details.url);
    return;
  }

  resolveTabId(details, service).then((tabId) => {
    console.debug('[NetworkEvent]', service, status, 'url=', details.url, 'tabId=', tabId);
    if (tabId !== undefined) {
      if (status === 'generating') {
        markNetworkGenerating(tabId, service);
      } else {
        markNetworkIdle(tabId, service, status);
      }
    } else {
      console.debug('[NetworkEvent] No tab resolved', {
        service,
        status,
        url: details.url,
        initiator: details.initiator,
        requestId: details.requestId
      });
    }
  }).catch((error) => {
    console.error(`[Network] Failed to resolve tab for ${service}:`, error);
  });
}

// ネットワークリスナーを登録
function registerNetworkListeners() {
  // Claude - より広範なURLパターン
  const claudeUrls = {
    urls: [
      'https://claude.ai/api/append_message*',
      'https://claude.ai/api/messages/*',
      'https://claude.ai/api/projects/*/messages*',
      'https://claude.ai/api/organizations/*/chat_conversations/*',
      'https://claude.ai/api/organizations/*/chats/*',
      'https://claude.ai/api/organizations/*/chat_conversations/*/completion*',
      'https://claude.ai/api/organizations/*/chat_conversations/*/events*',
      'https://claude.ai/api/organizations/*/chat_conversations/*/messages*'
    ],
    types: ['xmlhttprequest', 'other']
  };

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => forwardNetworkEvent(details, 'claude', 'generating'),
    claudeUrls
  );
  chrome.webRequest.onCompleted.addListener(
    (details) => forwardNetworkEvent(details, 'claude', 'completed'),
    claudeUrls
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => forwardNetworkEvent(details, 'claude', 'idle'),
    claudeUrls
  );

  // Gemini - より広範なURLパターン
  const geminiUrls = {
    urls: [
      'https://gemini.google.com/_/BardChatUi/data/*',
      'https://gemini.google.com/_/BardChatUi/streamingrpc/*',
      'https://gemini.googleusercontent.com/_/BardChatUi/data/*',
      'https://gemini.google.com/_/assistant/*',
      'https://gemini.google.com/u/*/_/BardChatUi/data/*'
    ],
    types: ['xmlhttprequest', 'other']
  };

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => forwardNetworkEvent(details, 'gemini', 'generating'),
    geminiUrls
  );
  chrome.webRequest.onCompleted.addListener(
    (details) => forwardNetworkEvent(details, 'gemini', 'completed'),
    geminiUrls
  );
  chrome.webRequest.onErrorOccurred.addListener(
    (details) => forwardNetworkEvent(details, 'gemini', 'idle'),
    geminiUrls
  );
}

registerNetworkListeners();

// エラーハンドリング
self.addEventListener('error', (event) => {
  console.error('Service Worker エラー:', event.error);
});

self.addEventListener('unhandledrejection', (event) => {
  console.error('未処理のPromise拒否:', event.reason);
});
