/**
 * ROLE — Subtitler UI controller (browser)
 *
 * Runs inside `subtitler.html`.
 * - Connects to the WebSocket and identifies as `subtitler`
 * - Joins the fragment session (`fragment:join`)
 * - Plays the LIVE HLS stream (`/hls/live.m3u8`) using hls.js
 * - Reacts to fragment status messages (turn/prepare/grace/auto-send)
 * - Sends captions to the server via WebSocket (`type: 'caption'`)
 */

const state = {
  ws: null,
  hls: null,
  name: '',
  odId: null,
  isLive: false,
  fragmentMode: false,
  isMyTurn: false,
  currentSubtitlerId: null,
  secondsRemaining: 0,
  slotDuration: 30,
  gracePeriodPercent: 20,
  inGracePeriod: false,
  history: [],
  notifySound: null,
};

const el = {};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Cache elements
  el.loginOverlay = document.getElementById('loginOverlay');
  el.nameInput = document.getElementById('nameInput');
  el.joinBtn = document.getElementById('joinBtn');
  el.statusDisplay = document.getElementById('statusDisplay');
  el.video = document.getElementById('video');
  el.videoStatus = document.getElementById('videoStatus');
  el.muteBtn = document.getElementById('muteBtn');
  el.turnIndicator = document.getElementById('turnIndicator');
  el.turnLabel = document.getElementById('turnLabel');
  el.turnTimer = document.getElementById('turnTimer');
  el.turnCurrent = document.getElementById('turnCurrent');
  el.turnProgress = document.getElementById('turnProgress');
  el.captionInput = document.getElementById('captionInput');
  el.charCount = document.getElementById('charCount');
  el.sendBtn = document.getElementById('sendBtn');
  el.historyList = document.getElementById('historyList');
  
  setupLoginEvents();
});

function setupLoginEvents() {
  el.joinBtn.addEventListener('click', handleJoin);
  el.nameInput.addEventListener('keypress', e => {
    if (e.key === 'Enter') handleJoin();
  });
  el.nameInput.focus();
}

function handleJoin() {
  const name = el.nameInput.value.trim();
  if (!name) return;
  
  state.name = name;
  el.loginOverlay.classList.add('hidden');
  
  // Create audio context on user interaction
  state.notifySound = createNotifySound();
  
  initApp();
}

function initApp() {
  initWebSocket();
  setupEvents();
}

// Audio notifications
function createNotifySound() {
  const ctx = new (window.AudioContext || window.webkitAudioContext)();
  
  return function play(type) {
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    
    const now = ctx.currentTime;
    
    if (type === 'turn') {
      osc.frequency.setValueAtTime(523, now);
      osc.frequency.setValueAtTime(659, now + 0.1);
      osc.frequency.setValueAtTime(784, now + 0.2);
    } else if (type === 'prepare') {
      osc.frequency.setValueAtTime(440, now);
      osc.frequency.setValueAtTime(523, now + 0.15);
    }
    
    gain.gain.setValueAtTime(0.3, now);
    gain.gain.exponentialRampToValueAtTime(0.01, now + 0.3);
    
    osc.start(now);
    osc.stop(now + 0.3);
  };
}

// WebSocket
function initWebSocket() {
  state.ws = new STC.WebSocketManager(handleMessage, onConnected, onDisconnected);
  state.ws.connect();
}

function onConnected() {
  updateStatus('connected');
  state.ws.identify(STC.CLIENT_TYPES.SUBTITLER, state.name);
  state.ws.send({ type: STC.WS_TYPES.FRAGMENT_JOIN, name: state.name });
}

function onDisconnected() {
  updateStatus('disconnected');
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.odId = msg.odId;
      state.isLive = msg.running;
      state.fragmentMode = msg.fragmentMode;
      if (state.isLive) {
        updateStatus('live');
        checkAndStartVideo();
      }
      updateTurnUI();
      break;
      
    case 'live':
      if (msg.status === 'started') {
        state.isLive = true;
        updateStatus('live');
        setTimeout(checkAndStartVideo, 2000);
      } else if (msg.status === 'stopped') {
        state.isLive = false;
        state.fragmentMode = false;
        updateStatus('connected');
        el.videoStatus.textContent = 'Live arrêté';
        updateTurnUI();
        if (state.hls) { state.hls.destroy(); state.hls = null; }
      }
      break;
      
    case 'fragment:joined':
      state.odId = msg.odId;
      state.fragmentMode = msg.active;
      updateTurnUI();
      break;
      
    case 'fragment:started':
      state.fragmentMode = true;
      updateTurnUI();
      break;
      
    case 'fragment:stopped':
      state.fragmentMode = false;
      state.isMyTurn = false;
      updateTurnUI();
      break;
      
    case 'fragment:status':
      const wasMyTurn = state.isMyTurn;
      state.slotDuration = msg.slotDuration;
      state.gracePeriodPercent = msg.gracePeriodPercent || 20;
      state.secondsRemaining = msg.secondsRemaining;
      state.currentSubtitlerId = msg.currentSubtitlerId;
      state.isMyTurn = (typeof msg.isMyTurn === 'boolean') ? msg.isMyTurn : (msg.currentSubtitlerId === state.odId);
      state.inGracePeriod = (typeof msg.inGracePeriod === 'boolean') ? msg.inGracePeriod : false;
      
      if (!wasMyTurn && state.isMyTurn && state.notifySound) {
        state.notifySound('turn');
      }
      
      updateTurnUI();
      break;
      
    case 'fragment:prepare':
      if (state.notifySound) state.notifySound('prepare');
      break;
      
    case 'fragment:grace-start':
      // Grace period started - visual indicator only (volume stays at 100%)
      state.inGracePeriod = true;
      updateTurnUI();
      break;
      
    case 'fragment:auto-send':
      // Time's up - auto-send current text
      autoSendCaption();
      break;
      
    case 'caption':
      if (state.fragmentMode && msg.caption?.odId !== state.odId) {
        addToHistory(msg.caption.text, msg.caption.subtitlerName, true);
      }
      break;
  }
}

// Status
function updateStatus(status) {
  el.statusDisplay.classList.remove('live');
  
  if (status === 'live') {
    el.statusDisplay.classList.add('live');
    el.statusDisplay.querySelector('.text').textContent = 'En direct';
  } else if (status === 'connected') {
    el.statusDisplay.querySelector('.text').textContent = 'Connecté';
  } else {
    el.statusDisplay.querySelector('.text').textContent = 'Déconnecté';
  }
}

// Turn UI
function updateTurnUI() {
  if (!state.fragmentMode) {
    el.turnIndicator.classList.remove('active', 'your-turn', 'waiting', 'grace');
    // Reset volume when not in fragment mode
    if (el.video) el.video.volume = 1;
    return;
  }
  
  el.turnIndicator.classList.add('active');
  
  // Volume: 100% if it's my turn AND not in grace period
  // Grace period = time to finish, not to transcribe new content
  const shouldHaveFullVolume = state.isMyTurn && !state.inGracePeriod;
  if (el.video) el.video.volume = shouldHaveFullVolume ? 1 : 0.01;
  
  if (state.isMyTurn) {
    el.turnIndicator.classList.add('your-turn');
    el.turnIndicator.classList.remove('waiting');
    
    if (state.inGracePeriod) {
      el.turnIndicator.classList.add('grace');
      el.turnLabel.textContent = 'Finissez !';
    } else {
      el.turnIndicator.classList.remove('grace');
      el.turnLabel.textContent = 'Votre tour';
    }
  } else {
    el.turnIndicator.classList.remove('your-turn', 'grace');
    el.turnIndicator.classList.add('waiting');
    el.turnLabel.textContent = 'En attente';
  }
  
  const m = Math.floor(state.secondsRemaining / 60);
  const s = state.secondsRemaining % 60;
  el.turnTimer.textContent = `${m}:${s.toString().padStart(2, '0')}`;
  
  const totalTime = state.slotDuration + Math.floor(state.slotDuration * state.gracePeriodPercent / 100);
  el.turnProgress.style.width = `${(state.secondsRemaining / totalTime) * 100}%`;
}

// Video
async function checkAndStartVideo() {
  try {
    const data = await STC.apiRequest(STC.API.LIVE_STATUS);
    
    if (data.manifest && data.segmentCount >= 3) {
      createPlayer();
    } else if (data.running) {
      el.videoStatus.textContent = `Buffering... (${data.segmentCount}/3)`;
      setTimeout(checkAndStartVideo, 1000);
    }
  } catch (e) {
    setTimeout(checkAndStartVideo, 2000);
  }
}

function createPlayer() {
  if (state.hls) state.hls.destroy();
  
  // Configuration simple - HLS.js gère le live edge automatiquement
  state.hls = new STC.HlsPlayerManager(el.video, {
    liveSyncDurationCount: 3,      // Reste 3 segments derrière le live
    liveMaxLatencyDurationCount: 6, // Max 6 segments de retard
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
  });
  
  state.hls.load(STC.HLS.LIVE, () => {
    el.videoStatus.textContent = 'En lecture';
  }, () => {
    el.videoStatus.textContent = 'Erreur vidéo';
  });
}

// Events
function setupEvents() {
  el.captionInput.addEventListener('input', updateCharCount);
  el.captionInput.addEventListener('keypress', e => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      sendCaption();
    }
  });
  
  el.sendBtn.addEventListener('click', sendCaption);
  
  el.muteBtn.addEventListener('click', () => {
    el.video.muted = !el.video.muted;
    el.muteBtn.textContent = el.video.muted ? 'Muet' : 'Son';
  });
}

function updateCharCount() {
  el.charCount.textContent = `${el.captionInput.value.length}/200`;
}

function sendCaption() {
  const text = el.captionInput.value.trim();
  if (!text || !state.ws) return;
  
  // Timestamp is computed on the server based on the slot
  state.ws.send({
    type: STC.WS_TYPES.CAPTION,
    text,
    subtitlerName: state.name,
  });
  
  addToHistory(text, state.name, false);
  el.captionInput.value = '';
  updateCharCount();
  el.captionInput.focus();
}

// Auto-send when time expires
function autoSendCaption() {
  const text = el.captionInput.value.trim();
  if (text && state.ws) {
    // Timestamp is computed on the server (capped at slot end)
    state.ws.send({
      type: STC.WS_TYPES.CAPTION,
      text,
      subtitlerName: state.name,
      autoSent: true,
    });
    
    addToHistory(text + ' (auto)', state.name, false);
    el.captionInput.value = '';
    updateCharCount();
  }
}

function addToHistory(text, author, isOther, slotIndex = null) {
  // Éviter les doublons (même texte du même auteur dans les 2 dernières secondes)
  const isDuplicate = state.history.length > 0 && 
    state.history[0].text === text && 
    state.history[0].author === author &&
    (new Date() - state.history[0].time) < 2000;
  
  if (isDuplicate) return;
  
  state.history.unshift({ text, author, isOther, time: new Date(), slotIndex });
  if (state.history.length > 30) state.history.pop();
  renderHistory();
}

function renderHistory() {
  if (state.history.length === 0) {
    el.historyList.innerHTML = '<p class="no-history">Aucun sous-titre</p>';
    return;
  }
  
  el.historyList.innerHTML = state.history.map(h => {
    const timeStr = h.time.toLocaleTimeString('fr-FR', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const authorLabel = h.isOther ? h.author : `${h.author} (vous)`;
    const cssClass = h.isOther ? 'other' : 'mine';
    
    return `
      <div class="history-item ${cssClass}">
        <div class="history-header">
          <span class="history-author">${STC.escapeHtml(authorLabel)}</span>
          <span class="history-time">${timeStr}</span>
        </div>
        <div class="history-text">${STC.escapeHtml(h.text)}</div>
      </div>
    `;
  }).join('');
}
