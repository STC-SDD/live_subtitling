
// /**
//  * ROLE — Admin UI controller (browser)
//  *
//  * Runs inside `admin.html`.
//  * Responsibilities:
//  * - Connect to the WebSocket and identify as `admin`
//  * - Poll `/api/live/status` to display HLS segment count and duration
//  * - Start/stop the live (calls `/api/live/start` and `/api/live/stop`)
//  * - Configure fragment mode parameters (delay/slots/overlap/grace/subtitlers)
//  * - Upload videos via `/api/upload`
//  */

// const state = {
//   ws: null,
//   isLive: false,
//   liveStartedAt: null,
//   subtitlers: [],
// };

// const el = {};

// // Initialize
// document.addEventListener('DOMContentLoaded', () => {
//   // Cache elements
//   el.liveStatus = document.getElementById('liveStatus');
//   el.segmentCount = document.getElementById('segmentCount');
//   el.duration = document.getElementById('duration');
//   el.delay = document.getElementById('delay');
//   el.videoSelect = document.getElementById('videoSelect');
//   el.requiredSubtitlers = document.getElementById('requiredSubtitlers');
//   el.delayInput = document.getElementById('delayInput');
//   el.slotDuration = document.getElementById('slotDuration');
//   el.overlapDuration = document.getElementById('overlapDuration');
//   el.gracePeriod = document.getElementById('gracePeriod');
//   el.restingTime = document.getElementById('restingTime');
//   el.cycleTime = document.getElementById('cycleTime');
//   el.strideTime = document.getElementById('strideTime');
//   el.minSubtitlers = document.getElementById('minSubtitlers');
//   el.startBtn = document.getElementById('startBtn');
//   el.stopBtn = document.getElementById('stopBtn');
//   el.controlMessage = document.getElementById('controlMessage');
//   el.subtitlerCount = document.getElementById('subtitlerCount');
//   el.subtitlerList = document.getElementById('subtitlerList');
//   el.currentTurnSection = document.getElementById('currentTurnSection');
//   el.currentTurnName = document.getElementById('currentTurnName');
//   el.currentTurnTimer = document.getElementById('currentTurnTimer');
//   el.progressFill = document.getElementById('progressFill');
//   el.uploadArea = document.getElementById('uploadArea');
//   el.fileInput = document.getElementById('fileInput');
//   el.uploadMessage = document.getElementById('uploadMessage');

//   // Setup
//   initWebSocket();
//   loadVideos();
//   setupEvents();
//   updateRestInfoFromInputs();
//   startStatusPolling();
// });

// // WebSocket
// function initWebSocket() {
//   state.ws = new STC.WebSocketManager(handleMessage, onConnected, onDisconnected);
//   state.ws.connect();
// }

// function onConnected() {
//   state.ws.identify(STC.CLIENT_TYPES.ADMIN);
// }

// function onDisconnected() {
//   setTimeout(() => state.ws?.connect(), 2000);
// }

// function handleMessage(msg) {
//   switch (msg.type) {
//     case 'init':
//       state.isLive = msg.running;
//       updateLiveUI();
//       break;
//     case 'live':
//       state.isLive = msg.status === 'started';
//       if (msg.liveStartedAt) state.liveStartedAt = msg.liveStartedAt;
//       if (msg.status === 'stopped') state.liveStartedAt = null;
//       updateLiveUI();
//       break;
//     case 'fragment:admin-status':
//       updateSubtitlers(msg);
//       break;
//   }
// }

// // UI Updates
// function updateLiveUI() {
//   if (state.isLive) {
//     el.liveStatus.className = 'status-badge live';
//     el.liveStatus.querySelector('.text').textContent = 'En direct';
//     el.startBtn.disabled = true;
//     el.stopBtn.disabled = false;
//   } else {
//     el.liveStatus.className = 'status-badge offline';
//     el.liveStatus.querySelector('.text').textContent = 'Hors ligne';
//     el.startBtn.disabled = false;
//     el.stopBtn.disabled = true;
//     el.currentTurnSection.style.display = 'none';
//   }
// }

// function updateSubtitlers(msg) {
//   state.subtitlers = msg.subtitlers || [];
//   const required = msg.requiredSubtitlers || 2;
//   el.subtitlerCount.textContent = `${state.subtitlers.length}/${required}`;

//   // Keep the "repos estimé" info fresh even when config is set via WS/start
//   updateRestInfoFromInputs();

//   if (state.subtitlers.length === 0) {
//     el.subtitlerList.innerHTML = '<span style="color:#444;font-size:0.85em;">Aucun connecté</span>';
//     el.currentTurnSection.style.display = 'none';
//     return;
//   }

//   el.subtitlerList.innerHTML = state.subtitlers.map(s => 
//     `<span class="subtitler-chip ${s.id === msg.currentSubtitlerId ? 'active' : ''}">${STC.escapeHtml(s.name)}</span>`
//   ).join('');

//   // Show turn info if fragment active
//   if (msg.active && msg.currentSubtitlerName) {
//     el.currentTurnSection.style.display = 'block';
//     el.currentTurnName.textContent = msg.currentSubtitlerName + (msg.inGracePeriod ? ' (bonus)' : '');
//     el.currentTurnTimer.textContent = formatTime(msg.secondsRemaining);
//     const totalTime = msg.slotDuration + Math.floor(msg.slotDuration * msg.gracePeriodPercent / 100);
//     el.progressFill.style.width = `${(msg.secondsRemaining / totalTime) * 100}%`;
//     el.progressFill.style.background = msg.inGracePeriod ? '#e67e22' : '#2ecc71';
//   } else {
//     el.currentTurnSection.style.display = 'none';
//   }
// }

// function formatTime(sec) {
//   const m = Math.floor(sec / 60);
//   const s = sec % 60;
//   return `${m}:${s.toString().padStart(2, '0')}`;
// }

// function readNumber(inputEl, fallback) {
//   const value = parseFloat(inputEl?.value);
//   return Number.isFinite(value) ? value : fallback;
// }

// function computeFragmentInfo({ requiredSubtitlers, slotDuration, overlapDuration, gracePeriodPercent }) {
//   const stride = slotDuration - overlapDuration;
//   const graceSec = (slotDuration * gracePeriodPercent) / 100;
//   const minSubtitlers = stride > 0 ? Math.ceil((slotDuration + graceSec) / stride) : Infinity;
//   const cycle = requiredSubtitlers * stride;
//   const rest = cycle - slotDuration;

//   return { stride, graceSec, minSubtitlers, cycle, rest };
// }

// function updateRestInfoFromInputs() {
//   if (!el.restingTime || !el.cycleTime || !el.strideTime || !el.minSubtitlers) return;

//   const requiredSubtitlers = Math.max(1, Math.floor(readNumber(el.requiredSubtitlers, 2)));
//   const slotDuration = Math.max(1, readNumber(el.slotDuration, 30));
//   const overlapDuration = Math.max(0, readNumber(el.overlapDuration, 0));
//   const gracePeriodPercent = Math.max(0, readNumber(el.gracePeriod, 0));

//   const { stride, minSubtitlers, cycle, rest } = computeFragmentInfo({
//     requiredSubtitlers,
//     slotDuration,
//     overlapDuration,
//     gracePeriodPercent,
//   });

//   if (!(stride > 0)) {
//     el.restingTime.textContent = 'Config invalide (chevauchement >= durée slot)';
//     el.cycleTime.textContent = '-';
//     el.strideTime.textContent = '-';
//     el.minSubtitlers.textContent = '-';
//     return;
//   }

//   const restSec = Math.max(0, Math.round(rest));
//   const cycleSec = Math.max(0, Math.round(cycle));
//   const strideSec = Math.max(0, Math.round(stride));

//   el.restingTime.textContent = formatTime(restSec);
//   el.cycleTime.textContent = formatTime(cycleSec);
//   el.strideTime.textContent = `${strideSec}`;
//   el.minSubtitlers.textContent = Number.isFinite(minSubtitlers) ? `${minSubtitlers}` : '-';
// }

// // Status polling
// function startStatusPolling() {
//   setInterval(async () => {
//     try {
//       const data = await STC.apiRequest(STC.API.LIVE_STATUS);
//       el.segmentCount.textContent = data.segmentCount || 0;
//       el.delay.textContent = `${data.delaySec || 20}s`;

//       if (data.liveStartedAt) {
//         const duration = Math.floor((Date.now() - data.liveStartedAt) / 1000);
//         el.duration.textContent = formatTime(duration);
//       } else {
//         el.duration.textContent = '00:00';
//       }
//     } catch (e) { /* ignore */ }
//   }, 2000);
// }

// // Load videos
// async function loadVideos() {
//   try {
//     const videos = await STC.apiRequest(STC.API.VIDEOS);
//     el.videoSelect.innerHTML = '<option value="">Sélectionner une vidéo</option>';
//     videos.forEach(v => {
//       const opt = document.createElement('option');
//       opt.value = v.path;
//       opt.textContent = v.name;
//       el.videoSelect.appendChild(opt);
//     });
//   } catch (e) {
//     console.error('Failed to load videos:', e);
//   }
// }

// // Events
// function setupEvents() {
//   el.startBtn.addEventListener('click', startLive);
//   el.stopBtn.addEventListener('click', stopLive);

//   // Update config info live
//   [el.requiredSubtitlers, el.slotDuration, el.overlapDuration, el.gracePeriod].forEach(input => {
//     input?.addEventListener('input', updateRestInfoFromInputs);
//     input?.addEventListener('change', updateRestInfoFromInputs);
//   });

//   el.uploadArea.addEventListener('click', () => el.fileInput.click());
//   el.fileInput.addEventListener('change', handleUpload);

//   // Drag & drop
//   el.uploadArea.addEventListener('dragover', e => {
//     e.preventDefault();
//     el.uploadArea.style.borderColor = '#555';
//   });
//   el.uploadArea.addEventListener('dragleave', () => {
//     el.uploadArea.style.borderColor = '#333';
//   });
//   el.uploadArea.addEventListener('drop', e => {
//     e.preventDefault();
//     el.uploadArea.style.borderColor = '#333';
//     if (e.dataTransfer.files.length) {
//       el.fileInput.files = e.dataTransfer.files;
//       handleUpload();
//     }
//   });
// }

// async function startLive() {
//   const video = el.videoSelect.value;
//   if (!video) {
//     showMessage(el.controlMessage, 'Sélectionnez une vidéo', 'error');
//     return;
//   }

//   const requiredSubtitlers = parseInt(el.requiredSubtitlers.value) || 2;
//   if (state.subtitlers.length < requiredSubtitlers) {
//     showMessage(el.controlMessage, `Il faut ${requiredSubtitlers} sous-titreurs (${state.subtitlers.length} connectés)`, 'error');
//     return;
//   }

//   el.startBtn.disabled = true;
//   showMessage(el.controlMessage, 'Démarrage...', '');

//   try {
//     // Start live with all config
//     await STC.apiRequest(STC.API.LIVE_START, {
//       method: 'POST',
//       body: JSON.stringify({
//         source: video,
//         delaySec: parseInt(el.delayInput.value) || 20,
//         slotDuration: parseInt(el.slotDuration.value) || 30,
//         overlapDuration: parseInt(el.overlapDuration.value) || 5,
//         gracePeriodPercent: parseInt(el.gracePeriod.value) || 20,
//         requiredSubtitlers: requiredSubtitlers,
//         notifyBefore: 5,
//       }),
//     });

//     showMessage(el.controlMessage, 'Live démarré', 'success');
//   } catch (e) {
//     showMessage(el.controlMessage, e.message || 'Erreur', 'error');
//     el.startBtn.disabled = false;
//   }
// }

// async function stopLive() {
//   el.stopBtn.disabled = true;

//   try {
//     await STC.apiRequest(STC.API.LIVE_STOP, { method: 'POST' });
//     showMessage(el.controlMessage, 'Live arrêté', 'success');
//   } catch (e) {
//     showMessage(el.controlMessage, e.message || 'Erreur', 'error');
//     el.stopBtn.disabled = false;
//   }
// }

// async function handleUpload() {
//   const file = el.fileInput.files[0];
//   if (!file) return;

//   const formData = new FormData();
//   formData.append('video', file);

//   showMessage(el.uploadMessage, 'Upload en cours...', '');

//   try {
//     await fetch(STC.API.UPLOAD, { method: 'POST', body: formData });
//     showMessage(el.uploadMessage, 'Vidéo ajoutée', 'success');
//     loadVideos();
//     el.fileInput.value = '';
//   } catch (e) {
//     showMessage(el.uploadMessage, 'Erreur upload', 'error');
//   }
// }

// function showMessage(container, text, type) {
//   if (type) {
//     container.innerHTML = `<div class="message ${type}">${text}</div>`;
//   } else {
//     container.innerHTML = `<div style="margin-top:12px;color:#888;font-size:0.85em;">${text}</div>`;
//   }

//   if (type) {
//     setTimeout(() => {
//       if (container.querySelector('.message')?.textContent === text) {
//         container.innerHTML = '';
//       }
//     }, 4000);
//   }
// }


/**
 * ROLE — Admin UI controller (browser) with session support
 */

const state = {
  ws: null,
  isLive: false,
  liveStartedAt: null,
  subtitlers: [],
  currentSessionId: null,
};

const el = {};

document.addEventListener('DOMContentLoaded', () => {
  el.nbPoolsInput = document.getElementById('nbPoolsInput'); // AJOUT
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
  el.sessionInfo = document.getElementById('sessionInfo');

  // Check if starting with a session
  const urlParams = new URLSearchParams(window.location.search);
  const sessionId = urlParams.get('session');

  if (sessionId) {
    loadSession(sessionId);
  }

  // Setup
  initWebSocket();
  loadVideos();
  setupEvents();
  updateRestInfoFromInputs();
  startStatusPolling();
});

// Load session
async function loadSession(sessionId) {
  try {
    // const data = await STC.apiRequest(`/api/sessions/${sessionId}`);
    const data = await adminApi(`/api/sessions/${sessionId}`);
    const session = data.session;

    state.currentSessionId = sessionId;

    // Display session info
    if (el.sessionInfo) {
      el.sessionInfo.innerHTML = `
        <div style="background:rgba(46,204,113,0.1);border:1px solid rgba(46,204,113,0.2);border-radius:4px;padding:12px;margin-bottom:16px;">
          <div style="font-size:0.85em;color:#888;margin-bottom:4px;">Session en cours</div>
          <div style="font-weight:600;">${STC.escapeHtml(session.id)}</div>
          <div style="font-size:0.9em;color:#aaa;">${STC.escapeHtml(session.title)}</div>
        </div>
      `;
    }

    // Pre-fill configuration
    const cfg = session.config || {};
    if (el.videoSelect) el.videoSelect.value = session.videoPath;
    if (cfg.requiredSubtitlers) el.requiredSubtitlers.value = cfg.requiredSubtitlers;
    if (cfg.delaySec) el.delayInput.value = cfg.delaySec;
    if (cfg.slotDuration) el.slotDuration.value = cfg.slotDuration;
    if (cfg.overlapDuration) el.overlapDuration.value = cfg.overlapDuration;
    if (cfg.gracePeriodPercent) el.gracePeriod.value = cfg.gracePeriodPercent;

    updateRestInfoFromInputs();

    // Auto-start if session is active
    if (session.status === 'active') {
      // Check if already running
      const status = await STC.apiRequest(STC.API.LIVE_STATUS);
      if (!status.running) {
        showMessage(el.controlMessage, 'Session active - cliquez sur Démarrer', '');
      }
    }
  } catch (e) {
    console.error('Failed to load session:', e);
    showMessage(el.controlMessage, 'Erreur de chargement de la session', 'error');
  }
}

// WebSocket
function initWebSocket() {
  state.ws = new STC.WebSocketManager(handleMessage, onConnected, onDisconnected);
  state.ws.connect();
}

function onConnected() {
  state.ws.identify(STC.CLIENT_TYPES.ADMIN);
  const ADMIN_TOKEN = localStorage.getItem('stc_admin_token');
  if (!ADMIN_TOKEN) {
    location.replace('/admin-login.html');
    return;
  }

  const payload = { token: ADMIN_TOKEN };
  // keep session binding if you use ?session=...
  if (state.currentSessionId) payload.sessionId = state.currentSessionId;

  state.ws.identify(STC.CLIENT_TYPES.ADMIN, payload);
}

const ADMIN_TOKEN = localStorage.getItem('stc_admin_token');
if (!ADMIN_TOKEN) location.replace('/admin-login.html');

function adminApi(url, options = {}) {
  return STC.apiRequest(url, {
    ...options,
    headers: {
      ...(options.headers || {}),
      Authorization: `Bearer ${ADMIN_TOKEN}`,
    },
  });
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

  updateRestInfoFromInputs();

  if (state.subtitlers.length === 0) {
    el.subtitlerList.innerHTML = '<span style="color:#444;font-size:0.85em;">Aucun connecté</span>';
    el.currentTurnSection.style.display = 'none';
    return;
  }

  el.subtitlerList.innerHTML = state.subtitlers.map(s =>
    `<span class="subtitler-chip ${s.id === msg.currentSubtitlerId ? 'active' : ''}">${STC.escapeHtml(s.name)}</span>`
  ).join('');

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
  el.nbPoolsInput?.addEventListener('change', () => {
    const count = parseInt(el.nbPoolsInput.value) || 1;
    if (state.ws && state.ws.isOpen()) { // Vérifiez la méthode d'ouverture de votre STC.WebSocketManager
      state.ws.send({
        type: 'admin:set-pools',
        nbPools: count
      });
    }
  });
  el.startBtn.addEventListener('click', startLive);
  el.stopBtn.addEventListener('click', stopLive);

  [el.requiredSubtitlers, el.slotDuration, el.overlapDuration, el.gracePeriod].forEach(input => {
    input?.addEventListener('input', updateRestInfoFromInputs);
    input?.addEventListener('change', updateRestInfoFromInputs);
  });

  el.uploadArea.addEventListener('click', () => el.fileInput.click());
  el.fileInput.addEventListener('change', handleUpload);

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
  const requiredSubtitlers = parseInt(el.requiredSubtitlers.value) || 2;
  const nbPools = parseInt(el.nbPoolsInput.value) || 1; // Récupération du nombre de pools

  // --- Préparation de l'objet de configuration commun ---
  const liveConfig = {
    source: video,
    delaySec: parseInt(el.delayInput.value) || 20,
    slotDuration: parseInt(el.slotDuration.value) || 30,
    overlapDuration: parseInt(el.overlapDuration.value) || 5,
    gracePeriodPercent: parseInt(el.gracePeriod.value) || 20,
    requiredSubtitlers: requiredSubtitlers,
    nbPools: nbPools, // Ajout du paramètre pour le Back
    notifyBefore: 5,
  };

  // Validation commune : nombre de sous-titreurs minimum
  if (state.subtitlers.length < requiredSubtitlers) {
    showMessage(el.controlMessage, `Il faut ${requiredSubtitlers} sous-titreurs (${state.subtitlers.length} connectés)`, 'error');
    return;
  }

  // --- CAS A : AVEC SESSION ---
  if (state.currentSessionId) {
    el.startBtn.disabled = true;
    showMessage(el.controlMessage, 'Démarrage de la session...', '');

    try {
      // On envoie TOUTE la config + le sessionId en un seul appel
      await adminApi(STC.API.LIVE_START, {
        method: 'POST',
        body: JSON.stringify({
          ...liveConfig, // On inclut les réglages UI (pools, slots, etc.)
          sessionId: state.currentSessionId,
        }),
      });

      showMessage(el.controlMessage, 'Session démarrée', 'success');
    } catch (e) {
      showMessage(el.controlMessage, e.message || 'Erreur', 'error');
      el.startBtn.disabled = false;
    }
    return;
  }

  // --- CAS B : START STANDARD (SANS SESSION) ---
  if (!video) {
    showMessage(el.controlMessage, 'Sélectionnez une vidéo', 'error');
    return;
  }

  el.startBtn.disabled = true;
  showMessage(el.controlMessage, 'Démarrage...', '');

  try {
    await STC.apiRequest(STC.API.LIVE_START, {
      method: 'POST',
      body: JSON.stringify(liveConfig), // Utilisation de l'objet commun avec nbPools
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
    // await STC.apiRequest(STC.API.LIVE_STOP, { method: 'POST' });
    await adminApi(STC.API.LIVE_STOP, { method: 'POST' });
    showMessage(el.controlMessage, 'Live arrêté', 'success');

    // Clear session info if present
    state.currentSessionId = null;
    if (el.sessionInfo) {
      el.sessionInfo.innerHTML = '';
    }
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

// const ADMIN_TOKEN = localStorage.getItem("stc_admin_token");
// if (!ADMIN_TOKEN) location.href = "/admin-login.html";

// function adminApi(url, options = {}) {
//   return STC.apiRequest(url, {
//     ...options,
//     headers: { ...(options.headers || {}), Authorization: `Bearer ${ADMIN_TOKEN}` }
//   });
// }
