const statusEl = document.getElementById('status');
const wsStateEl = document.getElementById('wsState');
const sourceLangEl = document.getElementById('sourceLang');
const targetLangEl = document.getElementById('targetLang');
const sourceTextEl = document.getElementById('sourceText');
const translatedTextEl = document.getElementById('translatedText');
const logEl = document.getElementById('log');
const toggleMicButton = document.getElementById('toggleMic');
const sendManualButton = document.getElementById('sendManual');
const autoSendEl = document.getElementById('autoSend');
const safeModeEl = document.getElementById('safeMode');
const speakTranslatedEl = document.getElementById('speakTranslated');
const chatPreviewEl = document.getElementById('chatPreview');
const charCountEl = document.getElementById('charCount');
const historyListEl = document.getElementById('historyList');
const toggleVrMuteButton = document.getElementById('toggleVrMute');

const SpeechRecognition =
  window.SpeechRecognition || window.webkitSpeechRecognition;

const MAX_MESSAGE_LENGTH = 144;
const STORAGE_KEY = 'babelTowerSettings';

let socket;
let recognition;
let isListening = false;
let historyItems = [];
let vrMicEnabled = true;

function normalizeMessage(input) {
  return String(input || '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE_LENGTH);
}

function loadSettings() {
  const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}');
  autoSendEl.checked = saved.autoSend ?? false;
  safeModeEl.checked = saved.safeMode ?? true;
  speakTranslatedEl.checked = saved.speakTranslated ?? false;
}

function saveSettings() {
  localStorage.setItem(
    STORAGE_KEY,
    JSON.stringify({
      autoSend: autoSendEl.checked,
      safeMode: safeModeEl.checked,
      speakTranslated: speakTranslatedEl.checked
    })
  );
}

function appendLog(message) {
  const time = new Date().toLocaleTimeString();
  logEl.textContent = `[${time}] ${message}\n${logEl.textContent}`.trim();
}

function setStatus(message) {
  statusEl.textContent = message;
}

function updatePreview() {
  const previewText = normalizeMessage(translatedTextEl.value || sourceTextEl.value);
  chatPreviewEl.textContent = previewText || 'まだ送る文がありません';
  charCountEl.textContent = `${previewText.length} / ${MAX_MESSAGE_LENGTH}`;
}

function renderHistory() {
  historyListEl.innerHTML = '';

  if (historyItems.length === 0) {
    const item = document.createElement('li');
    item.textContent = 'まだありません';
    historyListEl.appendChild(item);
    return;
  }

  historyItems.forEach((entry) => {
    const item = document.createElement('li');
    item.textContent = `${entry.time} ${entry.text}`;
    historyListEl.appendChild(item);
  });
}

function pushHistory(text) {
  historyItems.unshift({
    time: new Date().toLocaleTimeString(),
    text
  });
  historyItems = historyItems.slice(0, 5);
  renderHistory();
}

function speakText(text, lang) {
  if (!window.speechSynthesis || !text) {
    return;
  }

  window.speechSynthesis.cancel();

  const utterance = new SpeechSynthesisUtterance(text);
  utterance.lang = lang;
  utterance.rate = 1;
  utterance.pitch = 1;
  window.speechSynthesis.speak(utterance);
}

async function toggleVrMic(enabled) {
  const response = await fetch('/api/voice-toggle', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ enabled })
  });

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}));
    throw new Error(payload.error || 'VRChatマイク切り替えに失敗しました');
  }

  return response.json();
}

function connectSocket() {
  const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
  socket = new WebSocket(`${protocol}://${window.location.host}`);

  socket.addEventListener('open', () => {
    wsStateEl.textContent = 'WebSocket 接続中';
    appendLog('WebSocket connected');
  });

  socket.addEventListener('message', (event) => {
    const payload = JSON.parse(event.data);
    if (payload.type === 'error') {
      appendLog(`送信エラー: ${payload.error}`);
      return;
    }

    if (payload.type === 'sent') {
      appendLog(`VRChat送信: ${payload.sentText}`);
      pushHistory(payload.sentText);
      return;
    }

    if (payload.type === 'preview') {
      appendLog(`れんしゅうモード: ${payload.sentText}`);
      return;
    }

    if (payload.type === 'status') {
      appendLog(`OSC ${payload.oscHost}:${payload.oscPort}`);
    }
  });

  socket.addEventListener('close', () => {
    wsStateEl.textContent = 'WebSocket 切断';
    appendLog('WebSocket disconnected');
    window.setTimeout(connectSocket, 1500);
  });
}

async function translateText(text, sourceLang, targetLang) {
  const baseSourceLang = sourceLang.split('-')[0];
  const url = new URL('https://api.mymemory.translated.net/get');
  url.searchParams.set('q', text);
  url.searchParams.set('langpair', `${baseSourceLang}|${targetLang}`);

  const response = await fetch(url);
  const data = await response.json();
  return data.responseData?.translatedText || text;
}

async function sendPayload(sourceText, translatedText) {
  const previewText = normalizeMessage(translatedText || sourceText);

  if (!previewText) {
    setStatus('送る文がまだありません');
    return;
  }

  if (!socket || socket.readyState !== WebSocket.OPEN) {
    appendLog('WebSocket 未接続のため送信失敗');
    return;
  }

  socket.send(
    JSON.stringify({
      sourceText,
      translatedText,
      sendToVrchat: !safeModeEl.checked
    })
  );
}

function initRecognition() {
  if (!SpeechRecognition) {
    setStatus('このブラウザは Web Speech API に未対応です。Chrome 系ブラウザを使ってください。');
    toggleMicButton.disabled = true;
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = true;
  recognition.interimResults = true;
  recognition.lang = sourceLangEl.value;

  recognition.onstart = () => {
    isListening = true;
    toggleMicButton.textContent = '音声認識を停止';
    setStatus('音声認識中...');
  };

  recognition.onend = () => {
    isListening = false;
    toggleMicButton.textContent = '音声認識を開始';
    setStatus('待機中');
  };

  recognition.onerror = (event) => {
    appendLog(`音声認識エラー: ${event.error}`);
    setStatus(`音声認識エラー: ${event.error}`);
  };

  recognition.onresult = async (event) => {
    const latestResult = event.results[event.results.length - 1];
    const transcript = latestResult[0].transcript.trim();

    sourceTextEl.value = transcript;

    if (!latestResult.isFinal || !transcript) {
      return;
    }

    setStatus('翻訳中...');

    try {
      const translated = await translateText(
        transcript,
        sourceLangEl.value,
        targetLangEl.value
      );
      translatedTextEl.value = translated;
      updatePreview();

      if (speakTranslatedEl.checked) {
        speakText(translated, targetLangEl.value);
      }

      if (autoSendEl.checked) {
        await sendPayload(transcript, translated);
        setStatus(safeModeEl.checked ? 'れんしゅうだけしました' : '送信完了');
      } else {
        setStatus('下の文を見て、よければ送信');
      }
    } catch (error) {
      appendLog(`翻訳エラー: ${error.message}`);
      setStatus('翻訳エラー');
    }
  };
}

toggleMicButton.addEventListener('click', () => {
  if (!recognition) {
    return;
  }

  recognition.lang = sourceLangEl.value;

  if (isListening) {
    recognition.stop();
    return;
  }

  recognition.start();
});

sendManualButton.addEventListener('click', async () => {
  const sourceText = sourceTextEl.value.trim();
  if (!sourceText) {
    setStatus('送信するテキストを入力してください');
    return;
  }

  try {
    const translated =
      translatedTextEl.value.trim() ||
      (await translateText(sourceText, sourceLangEl.value, targetLangEl.value));
    translatedTextEl.value = translated;
    updatePreview();
    if (speakTranslatedEl.checked) {
      speakText(translated, targetLangEl.value);
    }
    await sendPayload(sourceText, translated);
    setStatus(safeModeEl.checked ? 'れんしゅうだけしました' : '手入力を送信しました');
  } catch (error) {
    appendLog(`手動送信エラー: ${error.message}`);
    setStatus('手動送信エラー');
  }
});

sourceLangEl.addEventListener('change', () => {
  if (recognition) {
    recognition.lang = sourceLangEl.value;
  }
});

sourceTextEl.addEventListener('input', updatePreview);
translatedTextEl.addEventListener('input', updatePreview);
autoSendEl.addEventListener('change', saveSettings);
safeModeEl.addEventListener('change', () => {
  saveSettings();
  setStatus(safeModeEl.checked ? 'れんしゅうモードです。VRChatにはまだ送りません。' : '本番モードです。');
});
speakTranslatedEl.addEventListener('change', saveSettings);

toggleVrMuteButton.addEventListener('click', async () => {
  vrMicEnabled = !vrMicEnabled;

  try {
    await toggleVrMic(vrMicEnabled);
    toggleVrMuteButton.textContent = vrMicEnabled
      ? 'VRChatマイク切り替え'
      : 'VRChatマイクをもどす';
    setStatus(vrMicEnabled ? 'VRChatマイクをONにしました' : 'VRChatマイクをOFFにしました');
    appendLog(vrMicEnabled ? 'VRChat voice input enabled' : 'VRChat voice input disabled');
  } catch (error) {
    vrMicEnabled = !vrMicEnabled;
    appendLog(`VRChatマイク切り替えエラー: ${error.message}`);
    setStatus('VRChatマイク切り替えエラー');
  }
});

loadSettings();
connectSocket();
initRecognition();
renderHistory();
updatePreview();
setStatus('待機中');
