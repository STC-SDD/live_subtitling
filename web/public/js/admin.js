
/**
 * ROLE — Admin UI controller (browser)
 *
 * Runs inside `admin.html`.
 * Responsibilities:
 * - Connect to the WebSocket and identify as `admin`
 * - Poll `/api/live/status` to display HLS segment count and duration
 * - Start/stop the live (calls `/api/live/start` and `/api/live/stop`)
 * - Configure fragment mode parameters (delay/slots/overlap/grace/subtitlers)
 * - Upload videos via `/api/upload`
 */

const state = {
  ws: null,
  isLive: false,
  liveStartedAt: null,
  subtitlers: [],
};

const el = {};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  // Cache elements
  el.liveStatus = document.getElementById('liveStatus');
  el.segmentCount = document.getElementById('segmentCount');
  el.duration = document.getElementById('duration');
  el.delay = document.getElementById('delay');
  el.videoSelect = document.getElementById('videoSelect');
  el.requiredSubtitlers = document.getElementById('requiredSubtitlers');
  el.delayInput = document.getElementById('delayInput');
  el.slotDuration = document.getElementById('slotDuration');
  el.overlapDuration = document.getElementById('overlapDuration');
  el.gracePeriod = document.getElementById('gracePeriod');
  el.restingTime = document.getElementById('restingTime');
  el.cycleTime = document.getElementById('cycleTime');
  el.strideTime = document.getElementById('strideTime');
  el.minSubtitlers = document.getElementById('minSubtitlers');
  el.startBtn = document.getElementById('startBtn');
  el.stopBtn = document.getElementById('stopBtn');
  el.controlMessage = document.getElementById('controlMessage');
  el.subtitlerCount = document.getElementById('subtitlerCount');
  el.subtitlerList = document.getElementById('subtitlerList');
  el.currentTurnSection = document.getElementById('currentTurnSection');
  el.currentTurnName = document.getElementById('currentTurnName');
  el.currentTurnTimer = document.getElementById('currentTurnTimer');
  el.progressFill = document.getElementById('progressFill');
  el.uploadArea = document.getElementById('uploadArea');
  el.fileInput = document.getElementById('fileInput');
  el.uploadMessage = document.getElementById('uploadMessage');
  
  // Setup
  initWebSocket();
  loadVideos();
  setupEvents();
  updateRestInfoFromInputs();
  startStatusPolling();
});

// WebSocket
function initWebSocket() {
  state.ws = new STC.WebSocketManager(handleMessage, onConnected, onDisconnected);
  state.ws.connect();
}

function onConnected() {
  state.ws.identify(STC.CLIENT_TYPES.ADMIN);
}

function onDisconnected() {
  setTimeout(() => state.ws?.connect(), 2000);
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.isLive = msg.running;
      updateLiveUI();
      break;
    case 'live':
      state.isLive = msg.status === 'started';
      if (msg.liveStartedAt) state.liveStartedAt = msg.liveStartedAt;
      if (msg.status === 'stopped') state.liveStartedAt = null;
      updateLiveUI();
      break;
    case 'fragment:admin-status':
      updateSubtitlers(msg);
      break;
  }
}

// UI Updates
function updateLiveUI() {
  if (state.isLive) {
    el.liveStatus.className = 'status-badge live';
    el.liveStatus.querySelector('.text').textContent = 'En direct';
    el.startBtn.disabled = true;
    el.stopBtn.disabled = false;
  } else {
    el.liveStatus.className = 'status-badge offline';
    el.liveStatus.querySelector('.text').textContent = 'Hors ligne';
    el.startBtn.disabled = false;
    el.stopBtn.disabled = true;
    el.currentTurnSection.style.display = 'none';
  }
}

function updateSubtitlers(msg) {
  state.subtitlers = msg.subtitlers || [];
  const required = msg.requiredSubtitlers || 2;
  el.subtitlerCount.textContent = `${state.subtitlers.length}/${required}`;

  // Keep the "repos estimé" info fresh even when config is set via WS/start
  updateRestInfoFromInputs();
  
  if (state.subtitlers.length === 0) {
    el.subtitlerList.innerHTML = '<span style="color:#444;font-size:0.85em;">Aucun connecté</span>';
    el.currentTurnSection.style.display = 'none';
    return;
  }
  
  el.subtitlerList.innerHTML = state.subtitlers.map(s => 
    `<span class="subtitler-chip ${s.id === msg.currentSubtitlerId ? 'active' : ''}">${STC.escapeHtml(s.name)}</span>`
  ).join('');
  
  // Show turn info if fragment active
  if (msg.active && msg.currentSubtitlerName) {
    el.currentTurnSection.style.display = 'block';
    el.currentTurnName.textContent = msg.currentSubtitlerName + (msg.inGracePeriod ? ' (bonus)' : '');
    el.currentTurnTimer.textContent = formatTime(msg.secondsRemaining);
    const totalTime = msg.slotDuration + Math.floor(msg.slotDuration * msg.gracePeriodPercent / 100);
    el.progressFill.style.width = `${(msg.secondsRemaining / totalTime) * 100}%`;
    el.progressFill.style.background = msg.inGracePeriod ? '#e67e22' : '#2ecc71';
  } else {
    el.currentTurnSection.style.display = 'none';
  }
}

function formatTime(sec) {
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${s.toString().padStart(2, '0')}`;
}

function readNumber(inputEl, fallback) {
  const value = parseFloat(inputEl?.value);
  return Number.isFinite(value) ? value : fallback;
}

function computeFragmentInfo({ requiredSubtitlers, slotDuration, overlapDuration, gracePeriodPercent }) {
  const stride = slotDuration - overlapDuration;
  const graceSec = (slotDuration * gracePeriodPercent) / 100;
  const minSubtitlers = stride > 0 ? Math.ceil((slotDuration + graceSec) / stride) : Infinity;
  const cycle = requiredSubtitlers * stride;
  const rest = cycle - slotDuration;

  return { stride, graceSec, minSubtitlers, cycle, rest };
}

function updateRestInfoFromInputs() {
  if (!el.restingTime || !el.cycleTime || !el.strideTime || !el.minSubtitlers) return;

  const requiredSubtitlers = Math.max(1, Math.floor(readNumber(el.requiredSubtitlers, 2)));
  const slotDuration = Math.max(1, readNumber(el.slotDuration, 30));
  const overlapDuration = Math.max(0, readNumber(el.overlapDuration, 0));
  const gracePeriodPercent = Math.max(0, readNumber(el.gracePeriod, 0));

  const { stride, minSubtitlers, cycle, rest } = computeFragmentInfo({
    requiredSubtitlers,
    slotDuration,
    overlapDuration,
    gracePeriodPercent,
  });

  if (!(stride > 0)) {
    el.restingTime.textContent = 'Config invalide (chevauchement >= durée slot)';
    el.cycleTime.textContent = '-';
    el.strideTime.textContent = '-';
    el.minSubtitlers.textContent = '-';
    return;
  }

  const restSec = Math.max(0, Math.round(rest));
  const cycleSec = Math.max(0, Math.round(cycle));
  const strideSec = Math.max(0, Math.round(stride));

  el.restingTime.textContent = formatTime(restSec);
  el.cycleTime.textContent = formatTime(cycleSec);
  el.strideTime.textContent = `${strideSec}`;
  el.minSubtitlers.textContent = Number.isFinite(minSubtitlers) ? `${minSubtitlers}` : '-';
}

// Status polling
function startStatusPolling() {
  setInterval(async () => {
    try {
      const data = await STC.apiRequest(STC.API.LIVE_STATUS);
      el.segmentCount.textContent = data.segmentCount || 0;
      el.delay.textContent = `${data.delaySec || 20}s`;
      
      if (data.liveStartedAt) {
        const duration = Math.floor((Date.now() - data.liveStartedAt) / 1000);
        el.duration.textContent = formatTime(duration);
      } else {
        el.duration.textContent = '00:00';
      }
    } catch (e) { /* ignore */ }
  }, 2000);
}

// Load videos
async function loadVideos() {
  try {
    const videos = await STC.apiRequest(STC.API.VIDEOS);
    el.videoSelect.innerHTML = '<option value="">Sélectionner une vidéo</option>';
    videos.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v.path;
      opt.textContent = v.name;
      el.videoSelect.appendChild(opt);
    });
  } catch (e) {
    console.error('Failed to load videos:', e);
  }
}

// Events
function setupEvents() {
  el.startBtn.addEventListener('click', startLive);
  el.stopBtn.addEventListener('click', stopLive);

  // Update config info live
  [el.requiredSubtitlers, el.slotDuration, el.overlapDuration, el.gracePeriod].forEach(input => {
    input?.addEventListener('input', updateRestInfoFromInputs);
    input?.addEventListener('change', updateRestInfoFromInputs);
  });
  
  el.uploadArea.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', handleUpload);
  
  // Drag & drop
  el.uploadArea.addEventListener('dragover', e => {
    e.preventDefault();
    el.uploadArea.style.borderColor = '#555';
  });
  el.uploadArea.addEventListener('dragleave', () => {
    el.uploadArea.style.borderColor = '#333';
  });
  el.uploadArea.addEventListener('drop', e => {
    e.preventDefault();
    el.uploadArea.style.borderColor = '#333';
    if (e.dataTransfer.files.length) {
      el.fileInput.files = e.dataTransfer.files;
      handleUpload();
    }
  });
}

async function startLive() {
  const video = el.videoSelect.value;
  if (!video) {
    showMessage(el.controlMessage, 'Sélectionnez une vidéo', 'error');
    return;
  }
  
  const requiredSubtitlers = parseInt(el.requiredSubtitlers.value) || 2;
  if (state.subtitlers.length < requiredSubtitlers) {
    showMessage(el.controlMessage, `Il faut ${requiredSubtitlers} sous-titreurs (${state.subtitlers.length} connectés)`, 'error');
    return;
  }
  
  el.startBtn.disabled = true;
  showMessage(el.controlMessage, 'Démarrage...', '');
  
  try {
    // Start live with all config
    await STC.apiRequest(STC.API.LIVE_START, {
      method: 'POST',
      body: JSON.stringify({
        source: video,
        delaySec: parseInt(el.delayInput.value) || 20,
        slotDuration: parseInt(el.slotDuration.value) || 30,
        overlapDuration: parseInt(el.overlapDuration.value) || 5,
        gracePeriodPercent: parseInt(el.gracePeriod.value) || 20,
        requiredSubtitlers: requiredSubtitlers,
        notifyBefore: 5,
      }),
    });
    
    showMessage(el.controlMessage, 'Live démarré', 'success');
  } catch (e) {
    showMessage(el.controlMessage, e.message || 'Erreur', 'error');
    el.startBtn.disabled = false;
  }
}

async function stopLive() {
  el.stopBtn.disabled = true;
  
  try {
    await STC.apiRequest(STC.API.LIVE_STOP, { method: 'POST' });
    showMessage(el.controlMessage, 'Live arrêté', 'success');
  } catch (e) {
    showMessage(el.controlMessage, e.message || 'Erreur', 'error');
    el.stopBtn.disabled = false;
  }
}

async function handleUpload() {
  const file = el.fileInput.files[0];
  if (!file) return;
  
  const formData = new FormData();
  formData.append('video', file);
  
  showMessage(el.uploadMessage, 'Upload en cours...', '');
  
  try {
    await fetch(STC.API.UPLOAD, { method: 'POST', body: formData });
    showMessage(el.uploadMessage, 'Vidéo ajoutée', 'success');
    loadVideos();
    el.fileInput.value = '';
  } catch (e) {
    showMessage(el.uploadMessage, 'Erreur upload', 'error');
  }
}

function showMessage(container, text, type) {
  if (type) {
    container.innerHTML = `<div class="message ${type}">${text}</div>`;
  } else {
    container.innerHTML = `<div style="margin-top:12px;color:#888;font-size:0.85em;">${text}</div>`;
  }
  
  if (type) {
    setTimeout(() => {
      if (container.querySelector('.message')?.textContent === text) {
        container.innerHTML = '';
      }
    }, 4000);
  }
}
