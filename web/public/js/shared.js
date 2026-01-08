/**
 * ROLE — Frontend shared utilities (browser)
 *
 * Loaded by `admin.html`, `subtitler.html`, and `spectator.html`.
 * Centralizes:
 * - Endpoint constants (API + HLS)
 * - WebSocketManager (connect/reconnect + identify)
 * - HlsPlayerManager (wrapper around hls.js)
 * - Small UI helpers (formatting, escaping, messages)
 */

// ═══════════════════════════════════════════════════════════════════════════════
// API ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * API endpoints configuration
 * @constant {Object}
 */
const API = {
  CONFIG: '/api/config',
  DELAY: '/api/delay',
  VIDEOS: '/api/videos',
  UPLOAD: '/api/upload',
  CAPTIONS: '/api/captions',
  LIVE_STATUS: '/api/live/status',
  LIVE_START: '/api/live/start',
  LIVE_STOP: '/api/live/stop',
  FRAGMENT_CONFIG: '/api/fragment/config',
  FRAGMENT_STATUS: '/api/fragment/status',
  FRAGMENT_START: '/api/fragment/start',
  FRAGMENT_STOP: '/api/fragment/stop',
  FRAGMENT_RAW: '/api/fragment/raw-captions',
};

// ═══════════════════════════════════════════════════════════════════════════════
// HLS ENDPOINTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * HLS streaming endpoints
 * @constant {Object}
 */
const HLS = {
  LIVE: '/hls/live.m3u8',
  DELAYED: '/hls/delayed.m3u8',
};

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET MESSAGE TYPES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * WebSocket message types
 * @constant {Object}
 */
const WS_TYPES = {
  // Server -> Client
  INIT: 'init',
  LIVE: 'live',
  CONFIG: 'config',
  CAPTION: 'caption',
  SYNC: 'sync',  // Time synchronization
  FRAGMENT_STARTED: 'fragment:started',
  FRAGMENT_STOPPED: 'fragment:stopped',
  FRAGMENT_STATUS: 'fragment:status',
  FRAGMENT_ADMIN_STATUS: 'fragment:admin-status',
  FRAGMENT_JOINED: 'fragment:joined',
  FRAGMENT_PREPARE: 'fragment:prepare',
  FRAGMENT_ENDING: 'fragment:ending',
  FRAGMENT_RAW_CAPTION: 'fragment:raw-caption',
  FRAGMENT_FUSED_CAPTION: 'fragment:fused-caption',
  
  // Client -> Server
  IDENTIFY: 'identify',
  FRAGMENT_JOIN: 'fragment:join',
  FRAGMENT_LEAVE: 'fragment:leave',
};

/**
 * Client types for identification
 * @constant {Object}
 */
const CLIENT_TYPES = {
  ADMIN: 'admin',
  SUBTITLER: 'subtitler',
  SPECTATOR: 'spectator',
};

// ═══════════════════════════════════════════════════════════════════════════════
// TIMING CONSTANTS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Timing configuration
 * @constant {Object}
 */
const TIMING = {
  /** WebSocket reconnection delay in ms */
  WS_RECONNECT_DELAY: 2000,
  
  /** Status polling interval in ms */
  STATUS_POLL_INTERVAL: 2000,
  
  /** Caption display duration in ms */
  CAPTION_DISPLAY_DURATION: 5000,
  
  /** Caption queue processing interval in ms */
  CAPTION_PROCESS_INTERVAL: 100,
  
  /** Video manifest check interval in ms */
  MANIFEST_CHECK_INTERVAL: 1000,
  
  /** Maximum retries for video loading */
  MAX_VIDEO_RETRIES: 30,
  
  /** Message display duration in ms */
  MESSAGE_DURATION: 5000,
};

// ═══════════════════════════════════════════════════════════════════════════════
// DEFAULT VALUES
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Default configuration values
 * @constant {Object}
 */
const DEFAULTS = {
  DELAY_SEC: 20,
  SLOT_DURATION: 30,
  OVERLAP_DURATION: 5,
  NOTIFY_BEFORE: 5,
  MIN_SUBTITLERS: 2,
  MAX_CAPTION_LENGTH: 200,
};

// ═══════════════════════════════════════════════════════════════════════════════
// UTILITY FUNCTIONS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Formats duration in seconds to MM:SS format
 * @param {number} seconds - Duration in seconds
 * @returns {string} Formatted string
 */
function formatDuration(seconds) {
  const min = Math.floor(seconds / 60);
  const sec = seconds % 60;
  return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}`;
}

/**
 * Formats milliseconds timestamp to MM:SS format
 * @param {number|null} ms - Timestamp in milliseconds
 * @returns {string} Formatted string or '--:--' if null
 */
function formatTimestamp(ms) {
  if (ms === null || ms === undefined) return '--:--';
  return formatDuration(Math.floor(ms / 1000));
}

/**
 * Escapes HTML characters to prevent XSS
 * @param {string} text - Text to escape
 * @returns {string} Escaped text
 */
function escapeHtml(text) {
  const div = document.createElement('div');
  div.textContent = text;
  return div.innerHTML;
}

/**
 * Generates WebSocket URL based on current location
 * @returns {string} WebSocket URL
 */
function getWebSocketUrl() {
  const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
  return `${protocol}//${location.host}/ws`;
}

/**
 * Shows a temporary message in an element
 * @param {HTMLElement} container - Container element
 * @param {string} text - Message text
 * @param {string} type - Message type ('success', 'error', 'purple')
 */
function showMessage(container, text, type) {
  container.innerHTML = `<div class="message ${type}">${escapeHtml(text)}</div>`;
  
  setTimeout(() => {
    const msg = container.querySelector('.message');
    if (msg && msg.textContent === text) {
      container.innerHTML = '';
    }
  }, TIMING.MESSAGE_DURATION);
}

/**
 * Makes an API request with error handling
 * @param {string} url - API endpoint
 * @param {Object} [options] - Fetch options
 * @returns {Promise<any>} Response data
 */
async function apiRequest(url, options = {}) {
  const response = await fetch(url, {
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    ...options,
  });
  
  const data = await response.json();
  
  if (!response.ok) {
    throw new Error(data.error || 'Request failed');
  }
  
  return data;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages WebSocket connection with auto-reconnection
 */
class WebSocketManager {
  /**
   * @param {Function} onMessage - Message handler callback
   * @param {Function} [onOpen] - Connection opened callback
   * @param {Function} [onClose] - Connection closed callback
   */
  constructor(onMessage, onOpen = null, onClose = null) {
    this.onMessage = onMessage;
    this.onOpen = onOpen;
    this.onClose = onClose;
    this.ws = null;
    this.reconnectTimeout = null;
  }
  
  /**
   * Establishes WebSocket connection
   */
  connect() {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      return;
    }
    
    this.ws = new WebSocket(getWebSocketUrl());
    
    this.ws.onopen = () => {
      console.log('[WS] Connected');
      if (this.onOpen) this.onOpen();
    };
    
    this.ws.onmessage = (event) => {
      try {
        const data = JSON.parse(event.data);
        this.onMessage(data);
      } catch (e) {
        console.error('[WS] Parse error:', e);
      }
    };
    
    this.ws.onclose = () => {
      console.log('[WS] Disconnected');
      if (this.onClose) this.onClose();
      this.scheduleReconnect();
    };
    
    this.ws.onerror = (error) => {
      console.error('[WS] Error:', error);
    };
  }
  
  /**
   * Schedules a reconnection attempt
   */
  scheduleReconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    this.reconnectTimeout = setTimeout(() => {
      console.log('[WS] Reconnecting...');
      this.connect();
    }, TIMING.WS_RECONNECT_DELAY);
  }
  
  /**
   * Sends a message through the WebSocket
   * @param {Object} data - Data to send
   * @returns {boolean} Whether the message was sent
   */
  send(data) {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
      return true;
    }
    return false;
  }
  
  /**
   * Sends identification message
   * @param {string} clientType - Client type
   * @param {string} [name] - Optional name
   */
  identify(clientType, name = null) {
    const message = {
      type: WS_TYPES.IDENTIFY,
      clientType,
    };
    
    if (name) {
      message.name = name;
    }
    
    this.send(message);
  }
  
  /**
   * Closes the WebSocket connection
   */
  disconnect() {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout);
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// HLS PLAYER MANAGER CLASS
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Manages HLS video playback
 */
class HlsPlayerManager {
  /**
   * @param {HTMLVideoElement} videoElement - Video element to use
   * @param {Object} [options] - HLS.js options
   */
  constructor(videoElement, options = {}) {
    this.video = videoElement;
    this.hls = null;
    // Configuration simple pour live streaming
    this.options = {
      liveSyncDurationCount: 3,        // Reste 3 segments derrière le live edge
      liveMaxLatencyDurationCount: 6,  // Max 6 segments de retard avant rattrapage
      maxBufferLength: 30,             // Buffer max 30s
      maxMaxBufferLength: 60,
      manifestLoadingMaxRetry: 10,
      levelLoadingMaxRetry: 10,
      fragLoadingMaxRetry: 10,
      ...options,
    };
    this.onReady = null;
    this.onError = null;
  }
  
  /**
   * Loads and plays an HLS stream
   * @param {string} url - HLS playlist URL
   * @param {Function} [onReady] - Called when playback starts
   * @param {Function} [onError] - Called on error
   */
  load(url, onReady = null, onError = null) {
    this.onReady = onReady;
    this.onError = onError;
    
    // Destroy existing instance
    this.destroy();
    
    // Add cache busting
    const cacheBustedUrl = `${url}?t=${Date.now()}`;
    
    // Check for native HLS support (Safari)
    if (!window.Hls?.isSupported()) {
      this.video.src = cacheBustedUrl;
      this.video.addEventListener('loadedmetadata', () => this.startPlayback(), { once: true });
      this.video.addEventListener('error', (e) => this.handleError(e));
      return;
    }
    
    // Use HLS.js
    this.hls = new window.Hls(this.options);
    
    this.hls.loadSource(cacheBustedUrl);
    this.hls.attachMedia(this.video);
    
    this.hls.on(window.Hls.Events.MANIFEST_PARSED, () => {
      console.log('[HLS] Manifest parsed');
      this.startPlayback();
    });
    
    this.hls.on(window.Hls.Events.ERROR, (event, data) => {
      console.error('[HLS] Error:', data.type, data.details);
      
      if (data.fatal) {
        this.handleFatalError(data);
      }
    });
    
    this.hls.on(window.Hls.Events.FRAG_LOADED, () => {
      // Ensure playback has started
      if (this.video.paused) {
        this.startPlayback();
      }
    });
  }
  
  /**
   * Attempts to start video playback
   */
  startPlayback() {
    const playPromise = this.video.play();
    
    if (playPromise !== undefined) {
      playPromise
        .then(() => {
          console.log('[HLS] Playback started');
          if (this.onReady) this.onReady();
        })
        .catch((err) => {
          console.warn('[HLS] Autoplay blocked, trying muted:', err);
          this.video.muted = true;
          
          this.video.play()
            .then(() => {
              console.log('[HLS] Muted playback started');
              if (this.onReady) this.onReady();
            })
            .catch((err2) => {
              console.error('[HLS] Playback failed:', err2);
              if (this.onError) this.onError(err2);
            });
        });
    }
  }
  
  /**
   * Handles fatal HLS errors with recovery attempts
   * @param {Object} data - Error data
   */
  handleFatalError(data) {
    if (data.type === window.Hls.ErrorTypes.NETWORK_ERROR) {
      console.log('[HLS] Network error, retrying...');
      setTimeout(() => {
        if (this.hls) this.hls.startLoad();
      }, 1000);
    } else if (data.type === window.Hls.ErrorTypes.MEDIA_ERROR) {
      console.log('[HLS] Media error, recovering...');
      this.hls.recoverMediaError();
    } else {
      console.error('[HLS] Fatal error, cannot recover');
      if (this.onError) this.onError(data);
    }
  }
  
  /**
   * Handles native video errors
   * @param {Event} e - Error event
   */
  handleError(e) {
    console.error('[Video] Error:', e);
    if (this.onError) this.onError(e);
  }
  
  /**
   * Destroys the HLS instance
   */
  destroy() {
    if (this.hls) {
      this.hls.destroy();
      this.hls = null;
    }
    this.video.src = '';
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// EXPORTS (for module usage)
// ═══════════════════════════════════════════════════════════════════════════════

// These would be exports if using ES modules
// For now, they're available as globals via script tag
window.STC = {
  API,
  HLS,
  WS_TYPES,
  CLIENT_TYPES,
  TIMING,
  DEFAULTS,
  formatDuration,
  formatTimestamp,
  escapeHtml,
  getWebSocketUrl,
  showMessage,
  apiRequest,
  WebSocketManager,
  HlsPlayerManager,
};
