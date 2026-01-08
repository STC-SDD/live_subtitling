/**
 * ROLE — Spectator UI controller (browser)
 *
 * Runs inside `spectator.html`.
 * - Connects to the WebSocket and identifies as `spectator`
 * - Plays the DELAYED HLS stream (`/hls/delayed.m3u8`) using hls.js
 * - Waits until enough segments exist for the configured delay
 * - Displays subtitles received over WebSocket (word-by-word preferred)
 */

const state = {
  ws: null,
  hls: null,
  isLive: false,
  delaySec: 20,
  
  // Currently displayed captions (word-by-word format)
  // Map<captionId, { words: string[], totalWords: number, displayedAt: number, complete: boolean }>
  activeCaptions: new Map(),
  maxDisplayed: 3,
  captionDuration: 10000, // 10 secondes après le dernier mot
};

const el = {};

// Initialize
document.addEventListener('DOMContentLoaded', () => {
  el.video = document.getElementById('video');
  el.waitingScreen = document.getElementById('waitingScreen');
  el.waitingText = document.getElementById('waitingText');
  el.captionDisplay = document.getElementById('captionDisplay');
  el.statusText = document.getElementById('statusText');
  el.muteBtn = document.getElementById('muteBtn');
  el.fullscreenBtn = document.getElementById('fullscreenBtn');
  
  initApp();
});

function initApp() {
  initWebSocket();
  setupControls();
}

function setupControls() {
  el.muteBtn.addEventListener('click', () => {
    el.video.muted = !el.video.muted;
    el.muteBtn.textContent = el.video.muted ? 'Muet' : 'Son';
  });
  
  el.fullscreenBtn.addEventListener('click', () => {
    const container = el.video.parentElement;
    if (document.fullscreenElement) {
      document.exitFullscreen();
    } else {
      container.requestFullscreen();
    }
  });
}

// WebSocket
function initWebSocket() {
  state.ws = new STC.WebSocketManager(handleMessage, onConnected, onDisconnected);
  state.ws.connect();
}

function onConnected() {
  state.ws.identify(STC.CLIENT_TYPES.SPECTATOR);
}

function onDisconnected() {
  el.waitingText.textContent = 'Connexion perdue...';
  el.waitingScreen.classList.remove('hidden');
  el.statusText.textContent = 'Déconnecté';
  el.statusText.classList.remove('live');
}

function handleMessage(msg) {
  switch (msg.type) {
    case 'init':
      state.isLive = msg.running;
      state.delaySec = msg.delaySec || 20;
      if (state.isLive) {
        el.waitingText.textContent = 'Chargement...';
        el.statusText.textContent = 'En direct';
        el.statusText.classList.add('live');
        checkAndStartVideo();
      } else {
        el.statusText.textContent = 'Hors ligne';
      }
      break;
      
    case 'live':
      if (msg.status === 'started') {
        state.isLive = true;
        state.delaySec = msg.delaySec || state.delaySec;
        el.waitingText.textContent = 'Démarrage...';
        el.waitingScreen.classList.remove('hidden');
        el.statusText.textContent = 'En direct';
        el.statusText.classList.add('live');
        setTimeout(checkAndStartVideo, 2000);
      } else if (msg.status === 'stopped') {
        state.isLive = false;
        el.waitingText.textContent = 'Live terminé';
        el.waitingScreen.classList.remove('hidden');
        el.statusText.textContent = 'Terminé';
        el.statusText.classList.remove('live');
        state.displayedCaptions = [];
        renderCaptions();
        if (state.hls) { state.hls.destroy(); state.hls = null; }
      }
      break;
      
    case 'caption':
      // Ancien format (texte complet) - pour compatibilité
      displayFullCaption(msg.caption.text);
      break;
      
    case 'caption:word':
      // Nouveau format (mot par mot)
      displayWord(msg.caption);
      break;
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// VIDEO PLAYER
// ═══════════════════════════════════════════════════════════════════════════════

async function checkAndStartVideo() {
  try {
    const data = await STC.apiRequest(STC.API.LIVE_STATUS);
    state.delaySec = data.delaySec || 20;
    
    // For the delayed stream, ensure enough segments for getDelayedPlaylist
    // The configured delay INCLUDES HLS buffering (~6s)
    // So minSegments = delaySec/2 + 1 extra segment
    const minSegments = Math.ceil(state.delaySec / 2) + 1;
    
    if (data.manifest && data.segmentCount >= minSegments) {
      createPlayer();
    } else if (data.running) {
      const currentSegments = data.segmentCount || 0;
      const remaining = Math.max(0, (minSegments - currentSegments) * 2);
      el.waitingText.textContent = `Buffering... (~${remaining}s)`;
      setTimeout(checkAndStartVideo, 1000);
    }
  } catch (e) {
    setTimeout(checkAndStartVideo, 2000);
  }
}

function createPlayer() {
  if (state.hls) state.hls.destroy();
  
  state.hls = new STC.HlsPlayerManager(el.video, {
    liveSyncDurationCount: 3,
    liveMaxLatencyDurationCount: 6,
    maxBufferLength: 30,
    maxMaxBufferLength: 60,
  });
  
  state.hls.load(STC.HLS.DELAYED, () => {
    el.waitingScreen.classList.add('hidden');
  }, () => {
    el.waitingText.textContent = 'Chargement du flux...';
    setTimeout(checkAndStartVideo, 2000);
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// CAPTION DISPLAY
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Display a full caption (legacy format, for compatibility)
 */
function displayFullCaption(text) {
  console.log(`[Caption] Full text: "${text.slice(0, 50)}..."`);
  
  const id = 'legacy_' + Date.now();
  state.activeCaptions.set(id, {
    words: text.split(/\s+/),
    totalWords: text.split(/\s+/).length,
    displayedAt: Date.now(),
    complete: true,
  });
  
  cleanupOldCaptions();
  renderCaptions();
}

/**
 * Display a single word of a caption (new word-by-word format)
 *
 * Words arrive one by one and are grouped by captionId.
 * The display builds progressively.
 */
function displayWord(caption) {
  const { id, word, wordIndex, totalWords, isLast, slotDurationMs } = caption;
  
  // Retrieve or create the entry for this caption
  let entry = state.activeCaptions.get(id);
  
  if (!entry) {
    // First word of this caption
    entry = {
      words: new Array(totalWords).fill(''),
      totalWords,
      displayedAt: Date.now(),
      complete: false,
      slotDurationMs,
    };
    state.activeCaptions.set(id, entry);
    console.log(`[Caption] New caption started (${totalWords} words)`);
  }
  
  // Add the word at its position
  entry.words[wordIndex] = word;
  
  // Mark as complete if this is the last word
  if (isLast) {
    entry.complete = true;
    entry.completedAt = Date.now();
    console.log(`[Caption] Caption complete: "${entry.words.join(' ')}"`);
    
    // Schedule removal after captionDuration
    setTimeout(() => {
      state.activeCaptions.delete(id);
      renderCaptions();
    }, state.captionDuration);
  }
  
  // Cleanup old captions if too many
  cleanupOldCaptions();
  
  // Mettre à jour l'affichage
  renderCaptions();
}

/**
 * Remove captions that are expired or exceed the max count
 */
function cleanupOldCaptions() {
  const now = Date.now();
  
  // Remove expired captions
  for (const [id, entry] of state.activeCaptions) {
    if (entry.complete && entry.completedAt && (now - entry.completedAt > state.captionDuration)) {
      state.activeCaptions.delete(id);
    }
  }
  
  // Keep only the last N
  while (state.activeCaptions.size > state.maxDisplayed) {
    const firstKey = state.activeCaptions.keys().next().value;
    state.activeCaptions.delete(firstKey);
  }
}

/**
 * Render captions on screen
 *
 * Display the words received so far for each active caption.
 * Missing words are omitted to keep fluid display.
 */
function renderCaptions() {
  if (state.activeCaptions.size === 0) {
    el.captionDisplay.classList.remove('visible');
    el.captionDisplay.innerHTML = '';
    return;
  }
  
  const lines = [];
  
  for (const [id, entry] of state.activeCaptions) {
    // Construire le texte avec les mots reçus
    const displayWords = entry.words.filter(w => w !== '');
    
    if (displayWords.length > 0) {
      const text = displayWords.join(' ');
      lines.push(`<div class="caption-line">${STC.escapeHtml(text)}</div>`);
    }
  }
  
  if (lines.length === 0) {
    el.captionDisplay.classList.remove('visible');
    el.captionDisplay.innerHTML = '';
    return;
  }
  
  el.captionDisplay.innerHTML = lines.join('');
  el.captionDisplay.classList.add('visible');
}
