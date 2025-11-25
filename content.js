// Unified content script for AI Dashboard
const currentService = detectService();
// Disable on-page frame visualization (browser page red/green frame)
const DISPLAY_FRAME = false;

// Global state
let isGenerating = false;
let lastNotificationTime = 0;
const NOTIFICATION_COOLDOWN = 3000;
let generationStartTime = 0;
let completedInBackground = false;
let hasSeenGeneration = false; // used to gate premature completed states on some services
let notebooklmLoadingObserved = false; // gate external status until real DOM loading is seen

let borderFrame = null;
let completionTimeoutId = null;
let frameCompletedAt = 0;
let isFrameGreen = false;

const DEBUG = true;
function log(...args) {
  if (DEBUG) {
    console.log('[AI Dashboard]', ...args);
  }
}

// Capability flags per service
const SERVICE_CAPABILITIES = {
  chatgpt: {
    needsTabRegistration: false,
    needsNetworkIntercept: false,
    frameTimeout: 3000,
    minGenerationTime: 500,
    completionCheckDelay: 300,
    restartDebounceMs: 400,
  },
  claude: {
    needsTabRegistration: true,
    needsNetworkIntercept: false,
    frameTimeout: 3000,
    minGenerationTime: 1000,
    completionCheckDelay: 800,
    restartDebounceMs: 1200,
  },
  gemini: {
    needsTabRegistration: true,
    needsNetworkIntercept: false,
    frameTimeout: 3000,
    minGenerationTime: 1000,
    completionCheckDelay: 800,
    restartDebounceMs: 1200,
  },
  notebooklm: {
    needsTabRegistration: false,
    needsNetworkIntercept: false,
    frameTimeout: 3000,
    minGenerationTime: 500,
    completionCheckDelay: 800,
    restartDebounceMs: 800,
  },
};

if (currentService) {
  log(`Detected service: ${currentService}`);
  if (DISPLAY_FRAME) {
    createBorderFrame();
  }
  const capabilities = SERVICE_CAPABILITIES[currentService];
  if (capabilities?.needsTabRegistration) {
    registerServiceTab(currentService);
  }
  if (capabilities?.needsNetworkIntercept) {
    interceptNetworkRequests(currentService);
  }
  initializeCompletionDetection(currentService);
} else {
  log('Current page is not a supported service');
}

function detectService() {
  const hostname = window.location.hostname;
  if (hostname.includes('chatgpt.com') || hostname.includes('chat.openai.com')) {
    return 'chatgpt';
  }
  if (hostname.includes('claude.ai')) {
    return 'claude';
  }
  if (hostname.includes('gemini.google.com')) {
    return 'gemini';
  }
  if (hostname.includes('notebooklm.google.com')) {
    return 'notebooklm';
  }
  return null;
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

function registerServiceTab(service) {
  try {
    chrome.runtime.sendMessage({ type: 'REGISTER_SERVICE_TAB', service }, (response) => {
      if (response?.registered) {
        log(`[Register] Registered tab for ${service}`);
      }
    });
    window.addEventListener('beforeunload', () => {
      chrome.runtime.sendMessage({ type: 'UNREGISTER_SERVICE_TAB', service });
      log(`[Register] Unregistered tab for ${service}`);
    });
  } catch (error) {
    log('[Register] Failed to register service tab', error);
  }
}

function interceptNetworkRequests(service) {
  const apiPatterns = {
    claude: [
      /claude\.ai\/api\/append_message/,
      /claude\.ai\/api\/messages/,
      /claude\.ai\/api\/projects\/.*\/messages/,
      /claude\.ai\/api\/organizations\/.*\/chat_conversations/,
    ],
    gemini: [
      /gemini\.google\.com\/_\/BardChatUi\/data/,
      /gemini\.google\.com\/_\/BardChatUi\/streamingrpc/,
      /gemini\.googleusercontent\.com\/_\/BardChatUi\/data/,
      /gemini\.google\.com\/_\/assistant/,
      /gemini\.google\.com\/u\/.*\/_\/BardChatUi\/data/,
    ],
  };

  const patterns = apiPatterns[service] || [];
  if (!patterns.length) {
    return;
  }

  function matchesPattern(url) {
    try {
      return patterns.some((pattern) => pattern.test(url));
    } catch (error) {
      return false;
    }
  }

  const originalFetch = window.fetch;
  window.fetch = function patchedFetch(...args) {
    const url = args[0]?.toString() || '';
    if (matchesPattern(url)) {
      log(`[Network] Fetch generating: ${url}`);
      chrome.runtime.sendMessage({ type: 'NETWORK_EVENT', service, status: 'generating' });
    }
    return originalFetch.apply(this, args)
      .then((response) => {
        if (matchesPattern(url)) {
          log(`[Network] Fetch completed: ${url}`);
          chrome.runtime.sendMessage({ type: 'NETWORK_EVENT', service, status: 'completed' });
        }
        return response;
      })
      .catch((error) => {
        if (matchesPattern(url)) {
          chrome.runtime.sendMessage({ type: 'NETWORK_EVENT', service, status: 'idle' });
        }
        throw error;
      });
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function patchedOpen(method, url, ...rest) {
    this._targetUrl = url?.toString() || '';
    return originalXHROpen.apply(this, [method, url, ...rest]);
  };

  XMLHttpRequest.prototype.send = function patchedSend(...args) {
    const url = this._targetUrl || '';
    if (matchesPattern(url)) {
      log(`[Network] XHR generating: ${url}`);
      chrome.runtime.sendMessage({ type: 'NETWORK_EVENT', service, status: 'generating' });
      this.addEventListener('load', () => {
        chrome.runtime.sendMessage({ type: 'NETWORK_EVENT', service, status: 'completed' });
      });
      this.addEventListener('error', () => {
        chrome.runtime.sendMessage({ type: 'NETWORK_EVENT', service, status: 'idle' });
      });
    }
    return originalXHRSend.apply(this, args);
  };

  log(`Network interception enabled for ${service}`);
}

chrome.runtime.onMessage.addListener((message) => {
  if (message.type !== 'FORCE_STATUS' || message.service !== currentService) {
    return;
  }
  // For NotebookLM, ignore external status until real DOM loading observed
  if (currentService === 'notebooklm' && !notebooklmLoadingObserved) {
    return;
  }
  if (message.status === 'generating') {
    isGenerating = true;
    generationStartTime = message.timestamp || Date.now();
    updateFrameStatus('generating');
    completedInBackground = false;
    hasSeenGeneration = true;
  } else if (message.status === 'completed') {
    // Guard for NotebookLM: ignore premature completed before any real generation observed
    if (currentService === 'notebooklm' && !hasSeenGeneration) {
      return;
    }
    if (isGenerating) {
      isGenerating = false;
      if (document.hidden) {
        completedInBackground = true;
      } else {
        updateFrameStatus('completed');
      }
    }
    lastNotificationTime = message.timestamp || Date.now();
  } else if (message.status === 'idle') {
    isGenerating = false;
    updateFrameStatus('idle');
    completedInBackground = false;
  }
});

document.addEventListener('visibilitychange', () => {
  if (!document.hidden && completedInBackground && !isGenerating) {
    updateFrameStatus('completed');
    const timeout = SERVICE_CAPABILITIES[currentService]?.frameTimeout ?? 3000;
    setTimeout(() => {
      if (!isGenerating) {
        updateFrameStatus('idle');
        completedInBackground = false;
      }
    }, timeout);
  }
});

function createBorderFrame() {
  if (!DISPLAY_FRAME) {
    return;
  }
  if (borderFrame) {
    borderFrame.remove();
  }
  borderFrame = document.createElement('div');
  borderFrame.id = 'ai-multi-sidebar-frame';
  borderFrame.style.position = 'fixed';
  borderFrame.style.top = '0';
  borderFrame.style.left = '0';
  borderFrame.style.right = '0';
  borderFrame.style.bottom = '0';
  borderFrame.style.pointerEvents = 'none';
  borderFrame.style.zIndex = '2147483647';
  borderFrame.style.border = '0 solid transparent';
  borderFrame.style.transition = 'border-width 0.25s ease, border-color 0.25s ease';
  document.documentElement.appendChild(borderFrame);
  log('Frame element created');
}

function updateFrameStatus(status) {
  if (!DISPLAY_FRAME) {
    return;
  }
  // Guard: avoid accidental green on NotebookLM before any real generation
  if (currentService === 'notebooklm' && status === 'completed' && !hasSeenGeneration) {
    return;
  }
  if (!borderFrame) {
    createBorderFrame();
  }
  if (completionTimeoutId) {
    clearTimeout(completionTimeoutId);
    completionTimeoutId = null;
  }
  if (status === 'generating') {
    borderFrame.style.borderWidth = '6px';
    borderFrame.style.borderColor = '#ff4d4d';
    isFrameGreen = false;
  } else if (status === 'completed') {
    borderFrame.style.borderWidth = '6px';
    borderFrame.style.borderColor = '#2ecc71';
    isFrameGreen = true;
    frameCompletedAt = Date.now();
    const timeout = SERVICE_CAPABILITIES[currentService]?.frameTimeout ?? 3000;
    completionTimeoutId = setTimeout(() => {
      if (!isGenerating && !completedInBackground) {
        updateFrameStatus('idle');
      }
    }, timeout);
  } else {
    borderFrame.style.borderWidth = '0';
    borderFrame.style.borderColor = 'transparent';
    isFrameGreen = false;
  }
}

function notifyStatus(status) {
  try {
    chrome.runtime.sendMessage({
      type: 'STATUS_UPDATE',
      service: currentService,
      status,
      timestamp: Date.now(),
    });
  } catch (error) {
    log('Failed to send STATUS_UPDATE', error);
  }
}

function notifyCompletion(service, message) {
  const now = Date.now();
  if (now - lastNotificationTime < NOTIFICATION_COOLDOWN) {
    log('Skipping completion notification due to cooldown');
    return;
  }
  lastNotificationTime = now;
  try {
    chrome.runtime.sendMessage({
      type: 'TASK_COMPLETED',
      service,
      message,
      timestamp: now,
    });
  } catch (error) {
    log('Failed to send TASK_COMPLETED', error);
  }
}

window.addEventListener('load', () => {
  log('Content script loaded');
  if (DISPLAY_FRAME) {
    if (!document.getElementById('ai-multi-sidebar-frame')) {
      createBorderFrame();
    }
    // Ensure initial state is idle (no green on first paint)
    updateFrameStatus('idle');
  }
});

window.addEventListener('beforeunload', () => {
  if (!DISPLAY_FRAME) return;
  if (borderFrame) {
    borderFrame.remove();
  }
});

setInterval(() => {
  if (!DISPLAY_FRAME) return;
  if (!document.getElementById('ai-multi-sidebar-frame')) {
    log('Frame element missing, recreating');
    createBorderFrame();
  }
}, 5000);

function initializeCompletionDetection(service) {
  log(`Initializing completion detection for ${service}`);
  switch (service) {
    case 'chatgpt':
      detectChatGPTCompletion();
      break;
    case 'claude':
      detectClaudeCompletion();
      break;
    case 'gemini':
      detectGeminiCompletion();
      break;
    case 'notebooklm':
      detectNotebookLMCompletion();
      break;
    default:
      log(`No detector registered for ${service}`);
  }
}

function detectChatGPTCompletion() {
  const selectors = [
    'button[data-testid="stop-button"]',
    'button[aria-label="ストリーミングの停止"]',
    'button[aria-label*="停止"]',
  ];

  const getStopButton = () => {
    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn) {
        return btn;
      }
    }
    return null;
  };

  function markGenerating() {
    isGenerating = true;
    generationStartTime = Date.now();
    updateFrameStatus('generating');
    notifyStatus('generating');
  }

  function markCompleted() {
    if (!isGenerating) {
      return;
    }
    isGenerating = false;
    if (document.hidden) {
      completedInBackground = true;
    } else {
      updateFrameStatus('completed');
    }
    notifyStatus('completed');
    notifyCompletion('chatgpt', 'ChatGPT response generation completed');
  }

  function scheduleCompletionCheck(delayMs) {
    setTimeout(() => {
      if (!getStopButton()) {
        markCompleted();
      }
    }, delayMs);
  }

  const observer = new MutationObserver(() => {
    const stopButton = getStopButton();
    if (stopButton && !isGenerating) {
      markGenerating();
      return;
    }
    if (!stopButton && isGenerating) {
      const elapsed = Date.now() - generationStartTime;
      if (elapsed > 500) {
        scheduleCompletionCheck(300);
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'disabled', 'data-testid', 'aria-label'],
  });

  setInterval(() => {
    const stopButton = getStopButton();
    if (stopButton && !isGenerating) {
      markGenerating();
    } else if (!stopButton && isGenerating) {
      const elapsed = Date.now() - generationStartTime;
      if (elapsed > 500) {
        scheduleCompletionCheck(300);
      }
    }
  }, 500);
}

function detectClaudeCompletion() {
  const selectors = [
    'button[aria-label*="停止"]',
    'button[aria-label="Stop generating"]',
    'button[aria-label*="Stop"]',
    'button[data-testid="stop-button"]',
  ];

  const getStopButton = () => {
    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn && isElementVisible(btn)) {
        return btn;
      }
    }
    return null;
  };

  // stability thresholds to avoid transient flips
  const presenceStableMs = 200;
  const absenceStableMs = 700;
  let lastSeenAt = 0;
  let lastMissingAt = 0;

  function markGenerating() {
    const debounceMs = SERVICE_CAPABILITIES.claude.restartDebounceMs ?? 0;
    if (frameCompletedAt && Date.now() - frameCompletedAt < debounceMs) {
      return;
    }
    isGenerating = true;
    generationStartTime = Date.now();
    updateFrameStatus('generating');
    notifyStatus('generating');
  }

  function markCompleted() {
    if (!isGenerating) {
      return;
    }
    isGenerating = false;
    if (document.hidden) {
      completedInBackground = true;
    } else {
      updateFrameStatus('completed');
    }
    notifyStatus('completed');
    notifyCompletion('claude', 'Claude response generation completed');
  }

  function scheduleCompletionCheck(delayMs) {
    setTimeout(() => {
      const stopButton = getStopButton();
      if (!stopButton) {
        markCompleted();
      }
    }, delayMs);
  }

  const observer = new MutationObserver(() => {
    const stopButton = getStopButton();
    const now = Date.now();
    if (stopButton) {
      lastSeenAt = now;
      if (!isGenerating && now - (lastMissingAt || 0) >= presenceStableMs) {
        markGenerating();
        return;
      }
    } else {
      if (lastMissingAt === 0) lastMissingAt = now;
      // maintain lastMissingAt as the start of absence window
      if (now - lastSeenAt >= absenceStableMs && isGenerating) {
        const elapsed = now - generationStartTime;
        if (elapsed > SERVICE_CAPABILITIES.claude.minGenerationTime) {
          scheduleCompletionCheck(SERVICE_CAPABILITIES.claude.completionCheckDelay);
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'class', 'data-testid'],
  });

  setInterval(() => {
    const stopButton = getStopButton();
    const now = Date.now();
    if (stopButton) {
      lastSeenAt = now;
      if (!isGenerating && now - (lastMissingAt || 0) >= presenceStableMs) {
        markGenerating();
        return;
      }
    } else {
      if (lastMissingAt === 0) lastMissingAt = now;
      if (now - lastSeenAt >= absenceStableMs && isGenerating) {
        const elapsed = now - generationStartTime;
        if (elapsed > SERVICE_CAPABILITIES.claude.minGenerationTime) {
          scheduleCompletionCheck(SERVICE_CAPABILITIES.claude.completionCheckDelay);
        }
      }
    }
  }, 300);
}

function detectGeminiCompletion() {
  const selectors = [
    '[aria-label="Stop generating"]',
    '[aria-label*="Stop"]',
    'button[aria-label="応答の生成を停止"]',
    'button[aria-label*="停止"]',
    '[data-test-id="stop-button"]',
    '[data-testid="stop-button"]',
  ];

  const getStopButton = () => {
    for (const selector of selectors) {
      const btn = document.querySelector(selector);
      if (btn && isElementVisible(btn)) {
        return btn;
      }
    }
    return null;
  };

  // stability thresholds to avoid transient flips
  const presenceStableMs = 200;
  const absenceStableMs = 800;
  let lastSeenAt = 0;
  let lastMissingAt = 0;

  function markGenerating() {
    const debounceMs = SERVICE_CAPABILITIES.gemini.restartDebounceMs ?? 0;
    if (frameCompletedAt && Date.now() - frameCompletedAt < debounceMs) {
      return;
    }
    isGenerating = true;
    generationStartTime = Date.now();
    updateFrameStatus('generating');
    notifyStatus('generating');
  }

  function markCompleted() {
    if (!isGenerating) {
      return;
    }
    isGenerating = false;
    if (document.hidden) {
      completedInBackground = true;
    } else {
      updateFrameStatus('completed');
    }
    notifyStatus('completed');
    notifyCompletion('gemini', 'Gemini response generation completed');
  }

  function scheduleCompletionCheck(delayMs) {
    setTimeout(() => {
      const stopButton = getStopButton();
      if (!stopButton) {
        markCompleted();
      }
    }, delayMs);
  }

  const observer = new MutationObserver(() => {
    const stopButton = getStopButton();
    const now = Date.now();
    if (stopButton) {
      lastSeenAt = now;
      if (!isGenerating && now - (lastMissingAt || 0) >= presenceStableMs) {
        markGenerating();
        return;
      }
    } else {
      if (lastMissingAt === 0) lastMissingAt = now;
      if (now - lastSeenAt >= absenceStableMs && isGenerating) {
        const elapsed = now - generationStartTime;
        if (elapsed > SERVICE_CAPABILITIES.gemini.minGenerationTime) {
          scheduleCompletionCheck(SERVICE_CAPABILITIES.gemini.completionCheckDelay);
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['aria-label', 'class', 'data-test-id'],
  });

  setInterval(() => {
    const stopButton = getStopButton();
    const now = Date.now();
    if (stopButton) {
      lastSeenAt = now;
      if (!isGenerating && now - (lastMissingAt || 0) >= presenceStableMs) {
        markGenerating();
        return;
      }
    } else {
      if (lastMissingAt === 0) lastMissingAt = now;
      if (now - lastSeenAt >= absenceStableMs && isGenerating) {
        const elapsed = now - generationStartTime;
        if (elapsed > SERVICE_CAPABILITIES.gemini.minGenerationTime) {
          scheduleCompletionCheck(SERVICE_CAPABILITIES.gemini.completionCheckDelay);
        }
      }
    }
  }, 300);
}

function detectNotebookLMCompletion() {
  // Merge broader selectors seen in current NotebookLM UIs
  const loadingSelectors = [
    // '[role="progressbar"]',
    // '[data-loading="true"]',
    '.llm-streaming-indicator',
    '.loading-dots',
    // '[role="progressbar"]',
    // '[data-loading="true"]',
    '.llm-streaming-indicator',
    '.loading-dots',
    // 'mat-card.is-loading',
    '.to-user-message-card-content.is-loading',
    '.thinking-message',
    // Studio Panel selectors
    '.artifact-icon.rotate',
    '.shimmer-yellow',
  ];

  // Stability thresholds to avoid flicker
  const presenceStableMs = 150;
  const absenceStableMs = 600;
  let lastLoadingSeenAt = 0;
  let lastLoadingMissingAt = 0;

  const isLoading = () => {
    return loadingSelectors.some((selector) => {
      const el = document.querySelector(selector);
      if (!el) return false;
      const style = window.getComputedStyle(el);
      return style.display !== 'none' && style.visibility !== 'hidden' && style.opacity !== '0';
    });
  };

  const observer = new MutationObserver(() => {
    const loading = isLoading();
    const now = Date.now();
    if (loading) {
      notebooklmLoadingObserved = true;
      lastLoadingSeenAt = now;
      if (!isGenerating && now - (lastLoadingMissingAt || 0) >= presenceStableMs) {
        isGenerating = true;
        hasSeenGeneration = true;
        generationStartTime = now;
        updateFrameStatus('generating');
        notifyStatus('generating');
        return;
      }
    } else {
      if (lastLoadingMissingAt === 0) lastLoadingMissingAt = now;
      if (isGenerating && now - lastLoadingSeenAt >= absenceStableMs) {
        const elapsed = now - generationStartTime;
        if (elapsed > SERVICE_CAPABILITIES.notebooklm.minGenerationTime) {
          setTimeout(() => {
            if (!isLoading()) {
              isGenerating = false;
              if (document.hidden) {
                completedInBackground = true;
              } else {
                updateFrameStatus('completed');
              }
              notifyStatus('completed');
              notifyCompletion('notebooklm', 'NotebookLM response generation completed');
            }
          }, SERVICE_CAPABILITIES.notebooklm.completionCheckDelay);
        }
      }
    }
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ['class', 'style', 'aria-hidden'],
  });
}
