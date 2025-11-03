// AudioContextの初期化
const audioContext = new (window.AudioContext || window.webkitAudioContext)();

// 通知音の定義
const sounds = {
  bell: {
    name: 'ベル',
    play: () => playBell()
  },
  chime: {
    name: 'チャイム',
    play: () => playChime()
  },
  pop: {
    name: 'ポップ',
    play: () => playPop()
  },
  double: {
    name: 'ダブル',
    play: () => playDouble()
  },
  triple: {
    name: 'トリプル',
    play: () => playTriple()
  }
};

// メッセージリスナー
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'PLAY_SOUND') {
    const sound = message.sound || 'bell';
    if (sounds[sound]) {
      sounds[sound].play();
      sendResponse({ success: true });
    } else {
      sendResponse({ success: false, error: 'Unknown sound' });
    }
  }
  return true;
});

// ベル音
function playBell() {
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.frequency.value = 800;
  oscillator.type = 'sine';

  gainNode.gain.setValueAtTime(0.3, now);
  gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.5);

  oscillator.start(now);
  oscillator.stop(now + 0.5);
}

// チャイム音
function playChime() {
  const now = audioContext.currentTime;
  const frequencies = [523.25, 659.25, 783.99]; // C5, E5, G5

  frequencies.forEach((freq, index) => {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = freq;
    oscillator.type = 'sine';

    const startTime = now + index * 0.15;
    gainNode.gain.setValueAtTime(0.2, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.4);

    oscillator.start(startTime);
    oscillator.stop(startTime + 0.4);
  });
}

// ポップ音
function playPop() {
  const now = audioContext.currentTime;
  const oscillator = audioContext.createOscillator();
  const gainNode = audioContext.createGain();

  oscillator.connect(gainNode);
  gainNode.connect(audioContext.destination);

  oscillator.frequency.setValueAtTime(400, now);
  oscillator.frequency.exponentialRampToValueAtTime(100, now + 0.1);
  oscillator.type = 'sine';

  gainNode.gain.setValueAtTime(0.4, now);
  gainNode.gain.exponentialRampToValueAtTime(0.01, now + 0.1);

  oscillator.start(now);
  oscillator.stop(now + 0.1);
}

// ダブル音
function playDouble() {
  const now = audioContext.currentTime;

  [0, 0.15].forEach((delay) => {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 600;
    oscillator.type = 'sine';

    const startTime = now + delay;
    gainNode.gain.setValueAtTime(0.3, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.15);

    oscillator.start(startTime);
    oscillator.stop(startTime + 0.15);
  });
}

// トリプル音
function playTriple() {
  const now = audioContext.currentTime;

  [0, 0.12, 0.24].forEach((delay) => {
    const oscillator = audioContext.createOscillator();
    const gainNode = audioContext.createGain();

    oscillator.connect(gainNode);
    gainNode.connect(audioContext.destination);

    oscillator.frequency.value = 700;
    oscillator.type = 'sine';

    const startTime = now + delay;
    gainNode.gain.setValueAtTime(0.25, startTime);
    gainNode.gain.exponentialRampToValueAtTime(0.01, startTime + 0.12);

    oscillator.start(startTime);
    oscillator.stop(startTime + 0.12);
  });
}

console.log('Offscreen audio playback ready');
