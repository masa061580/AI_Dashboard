// AIサービスのURL定義
const SERVICE_URLS = {
  chatgpt: 'https://chatgpt.com/',
  claude: 'https://claude.ai/',
  gemini: 'https://gemini.google.com/',
  notebooklm: 'https://notebooklm.google.com/'
};

const SERVICE_NAMES = {
  chatgpt: 'ChatGPT',
  claude: 'Claude',
  gemini: 'Gemini',
  notebooklm: 'NotebookLM'
};

// タブ管理
const managedTabs = new Map();
const MAX_TABS = 10;

// 初期化
document.addEventListener('DOMContentLoaded', async () => {
  await loadSettings();
  setupEventListeners();
  // 初回ロード時にバックグラウンドと同期
  await syncWithBackground();
  await refreshTabList();
  startPolling();
});

// バックグラウンドの状態と同期
async function syncWithBackground() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'GET_TAB_STATES' });
    if (response && response.states) {
      // 既存の管理マップをクリアして再構築（またはマージ）
      // ここではマージする戦略をとる
      const backgroundStates = new Map(response.states);

      // バックグラウンドにあるものは管理対象に追加
      for (const [tabId, state] of backgroundStates.entries()) {
        if (!managedTabs.has(tabId)) {
          managedTabs.set(tabId, state);
        }
      }
    }
  } catch (error) {
    console.error('バックグラウンドとの同期に失敗:', error);
  }
}

// イベントリスナーの設定
function setupEventListeners() {
  // サービス起動ボタン
  const serviceButtons = document.querySelectorAll('.service-btn');
  serviceButtons.forEach(button => {
    button.addEventListener('click', handleServiceLaunch);
  });

  // 設定ボタン
  document.getElementById('settingsButton').addEventListener('click', () => {
    document.getElementById('settingsPanel').classList.remove('hidden');
  });

  document.getElementById('closeSettings').addEventListener('click', () => {
    document.getElementById('settingsPanel').classList.add('hidden');
  });

  // 通知音の選択
  const soundRadios = document.querySelectorAll('input[name="sound"]');
  soundRadios.forEach(radio => {
    radio.addEventListener('change', handleSoundChange);
  });

  // 試聴ボタン
  const previewButtons = document.querySelectorAll('.preview-btn');
  previewButtons.forEach(button => {
    button.addEventListener('click', handleSoundPreview);
  });
}

// サービス起動
async function handleServiceLaunch(event) {
  const button = event.currentTarget;
  const service = button.dataset.service;

  // 起動前に最新の状態を確認
  await refreshTabList();

  if (managedTabs.size >= MAX_TABS) {
    alert(`最大${MAX_TABS}個までのタブしか管理できません`);
    return;
  }

  try {
    // 新しいタブで開く
    const tab = await chrome.tabs.create({
      url: SERVICE_URLS[service],
      active: true  // タブをアクティブにして、確実に検知できるようにする
    });

    managedTabs.set(tab.id, {
      service: service,
      status: 'idle',
      url: tab.url,
      title: 'Loading...'
    });

    await refreshTabList();
  } catch (error) {
    console.error('タブの作成に失敗:', error);
  }
}

// タブリストを更新
async function refreshTabList() {
  const tabListContainer = document.getElementById('tabList');

  // 現在のタブ情報を取得（全ウィンドウ対象）
  const allTabs = await chrome.tabs.query({});
  const allTabIds = new Set(allTabs.map(t => t.id));

  // 存在しないタブを管理マップから削除（ガベージコレクション）
  for (const tabId of managedTabs.keys()) {
    if (!allTabIds.has(tabId)) {
      managedTabs.delete(tabId);
    }
  }

  // 管理対象のタブをフィルタ（URLベースで再チェック）
  const activeTabs = allTabs.filter(tab => {
    const url = tab.url || '';
    return url.includes('chatgpt.com') ||
      url.includes('chat.openai.com') ||
      url.includes('claude.ai') ||
      url.includes('gemini.google.com') ||
      url.includes('notebooklm.google.com');
  });

  // URLベースで見つかったタブが管理マップになければ追加
  activeTabs.forEach(tab => {
    if (!managedTabs.has(tab.id)) {
      managedTabs.set(tab.id, {
        service: detectServiceFromUrl(tab.url),
        status: 'idle',
        url: tab.url,
        title: tab.title
      });
    }
  });

  // 表示を更新
  if (activeTabs.length === 0) {
    tabListContainer.innerHTML = '<div class="empty-message">AIサービスのタブを開いてください</div>';
    return;
  }

  tabListContainer.innerHTML = '';

  activeTabs.forEach(tab => {
    const tabState = managedTabs.get(tab.id) || { status: 'idle' };
    const service = detectServiceFromUrl(tab.url);
    const tabItem = createTabItem(tab.id, service, tabState.status, tab.title || tab.url);
    tabListContainer.appendChild(tabItem);
  });
}

// URLからサービスを検出
function detectServiceFromUrl(url) {
  if (!url) return 'unknown';

  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
    return 'chatgpt';
  } else if (url.includes('claude.ai')) {
    return 'claude';
  } else if (url.includes('gemini.google.com')) {
    return 'gemini';
  } else if (url.includes('notebooklm.google.com')) {
    return 'notebooklm';
  }

  return 'unknown';
}

// タブアイテムを作成
function createTabItem(tabId, service, status, title) {
  const item = document.createElement('div');
  item.className = `tab-item status-${status}`;
  item.dataset.tabId = tabId;

  const statusText = {
    generating: '思考中',
    completed: '完了',
    idle: 'アイドル'
  };

  item.innerHTML = `
    <div class="tab-header">
      <span class="tab-service">${SERVICE_NAMES[service] || service}</span>
      <span class="tab-actions">
        <span class="tab-status ${status}">${statusText[status] || 'アイドル'}</span>
        <button class="tab-delete" title="タブを閉じる" aria-label="タブを閉じる">✕</button>
      </span>
    </div>
    <div class="tab-title">${title}</div>
  `;

  item.addEventListener('click', async () => {
    try {
      // タブ情報を取得してウィンドウIDを確認
      const tab = await chrome.tabs.get(tabId);

      // ウィンドウを最前面に持ってくる
      await chrome.windows.update(tab.windowId, { focused: true });

      // タブをアクティブにする
      await chrome.tabs.update(tabId, { active: true });

      // タブをアクティブにしたので、完了状態をクリア
      const state = managedTabs.get(tabId);
      if (state && state.status === 'completed') {
        state.status = 'idle';
        managedTabs.set(tabId, state);
        await refreshTabList();
      }
    } catch (error) {
      console.error('タブの切り替えに失敗:', error);
    }
  });

  // 削除ボタン（タブを閉じる）
  const deleteButton = item.querySelector('.tab-delete');
  deleteButton.addEventListener('click', async (e) => {
    e.stopPropagation();
    try {
      await chrome.tabs.remove(tabId);
      managedTabs.delete(tabId);
      await refreshTabList();
    } catch (error) {
      console.error('タブのクローズに失敗:', error);
    }
  });

  return item;
}

// 定期的にタブリストを更新
function startPolling() {
  setInterval(refreshTabList, 2000);
}

// バックグラウンドからのメッセージを受信
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'TAB_STATE_UPDATE') {
    managedTabs.set(message.tabId, message.state);
    refreshTabList();
  } else if (message.type === 'TASK_COMPLETED') {
    managedTabs.set(message.tabId, {
      ...managedTabs.get(message.tabId),
      status: 'completed'
    });
    refreshTabList();
  } else if (message.type === 'TAB_REMOVED') {
    managedTabs.delete(message.tabId);
    refreshTabList();
  }
});

// 通知音の設定変更
async function handleSoundChange(event) {
  const sound = event.target.value;
  try {
    await chrome.runtime.sendMessage({
      type: 'SET_NOTIFICATION_SOUND',
      sound: sound
    });
    console.log('通知音を変更しました:', sound);
  } catch (error) {
    console.error('通知音の変更に失敗:', error);
  }
}

// 通知音の試聴
async function handleSoundPreview(event) {
  event.stopPropagation();
  const button = event.target;
  const sound = button.dataset.sound;

  try {
    await chrome.runtime.sendMessage({
      type: 'PLAY_SOUND',
      sound: sound
    });
  } catch (error) {
    console.error('音声再生エラー:', error);
  }
}

// 設定を読み込み
async function loadSettings() {
  try {
    const response = await chrome.runtime.sendMessage({
      type: 'GET_NOTIFICATION_SOUND'
    });

    if (response && response.sound) {
      const radio = document.querySelector(`input[name="sound"][value="${response.sound}"]`);
      if (radio) {
        radio.checked = true;
      }
    }
  } catch (error) {
    console.error('設定の読み込みに失敗:', error);
  }
}

// エラーハンドリング
window.addEventListener('error', (event) => {
  console.error('エラーが発生しました:', event.error);
});
