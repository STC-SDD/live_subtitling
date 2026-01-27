/**
 * ROLE — Central config + global runtime state
 *
 * Single source of truth for:
 * - Immutable configuration (ports, directories, FFmpeg/HLS params)
 * - Mutable runtime state (FFmpeg process, live start time, delay, fragment session)
 *
 * Other backend modules import `config` and `state` from here to avoid circular deps.
 *
 * ✅ Multi-pool extension (non-breaking):
 * - Keeps existing exports: config, state, resetFragment(), clearTimers(), isLiveRunning(), getLiveTimestamp(), log
 * - Adds: sessions, getSession(poolId), createSession(poolId), deleteSession(poolId), listSessions()
 *
 * IMPORTANT:
 * - Existing code that uses `state` continues to work (default pool).
 * - New multi-pool code can start using sessions via getSession(poolId).
 */

import path from 'path';
import { fileURLToPath } from 'url';

// Base paths (ES Modules do not have a native __dirname)
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

// ═══════════════════════════════════════════════════════════════════════════════
// CONFIGURATION (constants - do not change at runtime)
// ═══════════════════════════════════════════════════════════════════════════════

export const config = {
  // ─── Server ─────────────────────────────────────────────────────────────────
  port: parseInt(process.env.PORT, 10) || 3000,
  host: '0.0.0.0',

  // ─── Directories ────────────────────────────────────────────────────────────
  baseDir: ROOT,
  mediaDir: path.join(ROOT, 'media'),       // Uploaded videos
  hlsDir: path.join(ROOT, 'public', 'hls'), // Generated HLS segments
  publicDir: path.join(ROOT, 'public'),     // Static files

  // Alias courts (utilisés par services.js)
  root: ROOT,
  media: path.join(ROOT, 'media'),
  hls: path.join(ROOT, 'public', 'hls'),

  // ─── HLS (HTTP Live Streaming) ───────────────────────────────────────────────
  hlsSegmentDuration: 2,      // Segment duration in seconds
  segmentDuration: 2,         // (alias)
  hlsListSize: 10,            // Number of segments in the playlist
  sourcePlaylist: 'stream.m3u8',      // Playlist filename
  segmentPattern: 'seg%05d.ts',       // Segment filename pattern

  // ─── Timing ──────────────────────────────────────────────────────────────────
  defaultDelay: 20,           // Default spectator delay (seconds)
  maxDelay: 300,              // Maximum allowed delay (5 minutes)
  ffmpegTimeout: 30000,       // FFmpeg startup timeout (ms)
  ffmpegCheckInterval: 500,   // Segment check interval (ms)
  minSegmentsForStart: 3,     // Minimum segments before signaling "ready"

  // ─── Fragment mode (collaborative subtitling) ────────────────────────────────
  defaultSlotDuration: 30,    // Default slot duration (seconds)
  defaultOverlapDuration: 5,  // Default overlap duration (seconds)
  defaultNotifyBefore: 5,     // Notify before slot end (seconds)
  minSubtitlers: 2,           // Minimum number of subtitlers

  // ─── FFmpeg (video transcoding) ─────────────────────────────────────────────
  ffmpeg: {
    videoCodec: 'libx264',      // H.264 video codec
    videoPreset: 'veryfast',    // Preset (speed/quality trade-off)
    videoProfile: 'main',       // H.264 profile
    videoLevel: '3.1',          // H.264 level (compatibility)
    pixelFormat: 'yuv420p',     // Pixel format (maximum compatibility)
    videoBitrate: '2500k',      // Target video bitrate
    videoMaxrate: '3000k',      // Max bitrate
    videoBufferSize: '6000k',   // VBV buffer size
    audioCodec: 'aac',          // AAC audio codec
    audioBitrate: '128k',       // Audio bitrate
    audioSampleRate: 44100,     // Sampling rate
  },

  // ─── Auth / Data ────────────────────────────────────────────────────────────
  dataDir: path.join(ROOT, 'data'),
  usersCsvPath: path.join(ROOT, 'data', 'users.csv'),
  jwtSecret: process.env.JWT_SECRET || 'CHANGE_ME_IN_ENV',
};

// ═══════════════════════════════════════════════════════════════════════════════
// MUTABLE STATE (changes during runtime) — DEFAULT (legacy single-pool state)
// ═══════════════════════════════════════════════════════════════════════════════

export const state = {
  // ─── Live streaming ──────────────────────────────────────────────────────────
  ffmpegProc: null,       // Active FFmpeg process (null if stopped)
  liveStartedAt: null,    // Live start timestamp (ms)

  // ─── Captions ────────────────────────────────────────────────────────────────
  captions: [],           // Global captions history

  // ─── Current mode ────────────────────────────────────────────────────────────
  currentMode: null,              // 'fragmentation' or null
  delaySec: config.defaultDelay,  // Current spectator delay
  minSubtitlersRequired: config.minSubtitlers,  // Required subtitlers

  // ─── Fragment session ────────────────────────────────────────────────────────
  // Contains all state for collaborative subtitling mode
  fragment: {
    active: false,                          // Is fragment mode active?
    slotDuration: config.defaultSlotDuration,       // Slot duration (s)
    overlapDuration: config.defaultOverlapDuration, // Overlap duration (s)
    notifyBefore: config.defaultNotifyBefore,       // Notify before end (s)
    gracePeriodPercent: 20,                 // % extra time
    requiredSubtitlers: 2,                  // Required subtitlers
    subtitlers: new Map(),                  // Map<odId, { id, name, ws, joinedAt }>
    currentSlotIndex: 0,                    // Current slot index
    slotStartTime: null,                    // Current slot start timestamp

    // Legacy single-slot timers (kept for compatibility; unused in overlapping scheduler)
    slotTimer: null,                        // Slot end timer
    notifyTimer: null,                      // Notification timer
    graceTimer: null,                       // Grace period timer

    // Overlapping scheduler
    schedulerTimer: null,                   // Interval that starts new slots every (slotDuration - overlap)
    slotTimers: new Set(),                  // Set<Timeout> for per-slot timers (ending/grace/auto-send)
    openSlotBySubtitlerId: new Map(),       // Map<subtitlerId, slotIndex> currently open for submissions
    captionsBySlot: [],                     // Array of slots with raw captions
    fusedCaptions: [],                      // Captions after fusion
  },
};

// ═══════════════════════════════════════════════════════════════════════════════
// MULTI-POOL EXTENSION (non-breaking)
// Each pool/session has its own state. Default pool mirrors `state`.
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * sessions: Map<poolId, sessionState>
 * - "default" pool points to the legacy `state` object for compatibility.
 */
export const sessions = new Map();
sessions.set('default', state);

/**
 * Create a fresh session state (new pool) with the same shape as `state`.
 * IMPORTANT: Keep properties identical to avoid breaking services/websocket when migrated.
 */
export function createSession(poolId, overrides = {}) {
  const s = {
    ffmpegProc: null,
    liveStartedAt: null,

    captions: [],

    currentMode: null,
    delaySec: overrides.delaySec ?? config.defaultDelay,
    minSubtitlersRequired: overrides.minSubtitlersRequired ?? config.minSubtitlers,

    fragment: {
      active: false,
      slotDuration: overrides.slotDuration ?? config.defaultSlotDuration,
      overlapDuration: overrides.overlapDuration ?? config.defaultOverlapDuration,
      notifyBefore: overrides.notifyBefore ?? config.defaultNotifyBefore,
      gracePeriodPercent: overrides.gracePeriodPercent ?? 20,
      requiredSubtitlers: overrides.requiredSubtitlers ?? 2,

      subtitlers: new Map(),
      currentSlotIndex: 0,
      slotStartTime: null,

      slotTimer: null,
      notifyTimer: null,
      graceTimer: null,

      schedulerTimer: null,
      slotTimers: new Set(),
      openSlotBySubtitlerId: new Map(),
      captionsBySlot: [],
      fusedCaptions: [],
    },
  };

  // helpful metadata (optional, not used by old code)
  s.poolId = poolId;

  return s;
}

/**
 * Get a session state by poolId (creates it if missing).
 * Existing code can keep using `state` (default pool).
 */
export function getSession(poolId = 'default') {
  if (!poolId) poolId = 'default';
  if (!sessions.has(poolId)) {
    sessions.set(poolId, createSession(poolId));
  }
  return sessions.get(poolId);
}

/**
 * List current pools (for debug / admin)
 */
export function listSessions() {
  return Array.from(sessions.keys());
}

/**
 * Delete a session (pool) with safe timer cleanup.
 * Does not delete the default pool.
 */
export function deleteSession(poolId) {
  if (!poolId || poolId === 'default') return false;
  const s = sessions.get(poolId);
  if (!s) return false;

  // Clean all fragment timers for that session
  clearTimers(s);

  // Stop ffmpeg if still running (only if your services stop logic isn't called)
  // NOTE: We do NOT kill here to avoid side-effects; services.js should handle stop.
  sessions.delete(poolId);
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// STATE UTILITIES (default: legacy `state`, but can work with a given session)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Check if live streaming is running
 * @returns {boolean} true if FFmpeg is active
 */
export const isLiveRunning = (s = state) => s.ffmpegProc !== null;

/**
 * Get current video timestamp (milliseconds since live start)
 * @returns {number|null} Timestamp in ms, or null if no live
 */
export const getLiveTimestamp = (s = state) =>
  s.liveStartedAt ? Date.now() - s.liveStartedAt : null;

/**
 * Fully reset fragment mode state
 * Called when stopping live or fragment mode
 * Non-breaking: default resetFragment() still targets legacy `state`.
 *
 * @param {object} s session state (optional)
 */
export function resetFragment(s = state) {
  if (!s?.fragment) return;

  if (s.fragment.slotTimer) clearTimeout(s.fragment.slotTimer);
  if (s.fragment.notifyTimer) clearTimeout(s.fragment.notifyTimer);
  if (s.fragment.graceTimer) clearTimeout(s.fragment.graceTimer);
  if (s.fragment.schedulerTimer) clearInterval(s.fragment.schedulerTimer);

  if (s.fragment.slotTimers && s.fragment.slotTimers.size) {
    for (const t of s.fragment.slotTimers) clearTimeout(t);
  }

  const prevGrace = s.fragment.gracePeriodPercent;
  const prevRequired = s.fragment.requiredSubtitlers;

  s.fragment = {
    active: false,
    slotDuration: config.defaultSlotDuration,
    overlapDuration: config.defaultOverlapDuration,
    notifyBefore: config.defaultNotifyBefore,
    gracePeriodPercent: prevGrace || 20,
    requiredSubtitlers: prevRequired || 2,
    subtitlers: new Map(),
    currentSlotIndex: 0,
    slotStartTime: null,
    slotTimer: null,
    notifyTimer: null,
    graceTimer: null,

    schedulerTimer: null,
    slotTimers: new Set(),
    openSlotBySubtitlerId: new Map(),
    captionsBySlot: [],
    fusedCaptions: [],
  };
}

/**
 * Clear all active timers for fragment mode
 * Used before restarting a slot or stopping the mode
 *
 * @param {object} s session state (optional)
 */
export function clearTimers(s = state) {
  if (!s?.fragment) return;

  if (s.fragment.slotTimer) {
    clearTimeout(s.fragment.slotTimer);
    s.fragment.slotTimer = null;
  }
  if (s.fragment.notifyTimer) {
    clearTimeout(s.fragment.notifyTimer);
    s.fragment.notifyTimer = null;
  }
  if (s.fragment.graceTimer) {
    clearTimeout(s.fragment.graceTimer);
    s.fragment.graceTimer = null;
  }

  if (s.fragment.schedulerTimer) {
    clearInterval(s.fragment.schedulerTimer);
    s.fragment.schedulerTimer = null;
  }

  if (s.fragment.slotTimers && s.fragment.slotTimers.size) {
    for (const t of s.fragment.slotTimers) clearTimeout(t);
    s.fragment.slotTimers.clear();
  }
}

// ═══════════════════════════════════════════════════════════════════════════════
// LOGGING - Timestamped logging utilities
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * Generate a HH:MM:SS timestamp for logs
 */
const timestamp = () => new Date().toISOString().slice(11, 19);

/**
 * Logging object with levels
 *
 * @example
 * log.info('MODULE', 'Normal message');
 * log.warn('MODULE', 'Warning!');
 * log.error('MODULE', 'Error!', error);
 * log.debug('MODULE', 'Debug (visible if DEBUG=1)');
 */
export const log = {
  info: (module, ...args) => console.log(`[${timestamp()}] [${module}]`, ...args),
  warn: (module, ...args) => console.warn(`[${timestamp()}] [${module}] WARN:`, ...args),
  error: (module, ...args) => console.error(`[${timestamp()}] [${module}] ERROR:`, ...args),
  debug: (module, ...args) => {
    if (process.env.DEBUG) console.log(`[${timestamp()}] [${module}] DEBUG:`, ...args);
  },
};
