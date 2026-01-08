/**
 * ROLE — Backend service layer (FFmpeg/HLS + fragmentation/fusion + broadcasting)
 *
 * This is the main “business logic” module.
 * - Starts/stops FFmpeg and manages HLS output in `public/hls/`
 * - Parses the HLS manifest and builds the live vs delayed playlists
 * - Runs the fragment scheduler (slots + overlap + grace)
 * - Fuses consecutive slot texts (de-duplication) and schedules spectator captions
 * - Provides helper functions used by HTTP routes and WebSocket handlers
 */

import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';
import { config, state, log, isLiveRunning, getLiveTimestamp, resetFragment, clearTimers } from './core.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Format timestamp as MM:SS.mmm */
function formatTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const millis = ms % 1000;
  return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${millis.toString().padStart(3, '0')}`;
}

// ═══════════════════════════════════════════════════════════════════════════════
// WEBSOCKET CLIENTS
// ═══════════════════════════════════════════════════════════════════════════════

const clients = new Set();

export const addClient = (ws) => clients.add(ws);
export const removeClient = (ws) => clients.delete(ws);
export const getClientCount = () => clients.size;

/** Send JSON to a single client */
export function send(ws, payload) {
  try {
    if (ws?.readyState === 1) {
      ws.send(JSON.stringify(payload));
      return true;
    }
  } catch (e) { /* ignore */ }
  return false;
}

/** Broadcast to all clients matching filter */
export function broadcast(payload, filter = null) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1 && (!filter || filter(ws))) {
      try { ws.send(data); } catch (e) { /* ignore */ }
    }
  }
}

/** Broadcast to specific client types */
export const broadcastToAdmins = (payload) => broadcast(payload, ws => ws.clientType === 'admin');
export const broadcastToSubtitlers = (payload) => broadcast(payload, ws => ws.clientType === 'subtitler');
export const broadcastToSpectators = (payload) => broadcast(payload, ws => ws.clientType === 'spectator');

/** Broadcast live status change */
export function broadcastLiveStatus(status, extra = {}) {
  broadcast({ type: 'live', status, delaySec: state.delaySec, ...extra });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HLS MANAGEMENT
// ═══════════════════════════════════════════════════════════════════════════════

/** Ensure HLS directory exists */
export function ensureHlsDir() {
  fs.mkdirSync(config.hls, { recursive: true });
}

/** Clean HLS files */
export function cleanHlsDir() {
  try {
    const files = fs.readdirSync(config.hls);
    for (const file of files) {
      fs.rmSync(path.join(config.hls, file), { force: true });
    }
  } catch (e) { /* directory may not exist */ }
}

/** Read raw playlist file */
function readPlaylist() {
  try {
    return fs.readFileSync(path.join(config.hls, config.sourcePlaylist), 'utf8');
  } catch (e) {
    return null;
  }
}

/** Parse M3U8 playlist */
function parsePlaylist(content) {
  if (!content) return null;
  
  const lines = content.split(/\r?\n/);
  let targetDuration = config.segmentDuration;
  let mediaSequence = 0;
  const segments = [];
  let currentInf = null;
  
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith('#EXT-X-TARGETDURATION:')) {
      targetDuration = parseInt(t.split(':')[1], 10) || targetDuration;
    } else if (t.startsWith('#EXT-X-MEDIA-SEQUENCE:')) {
      mediaSequence = parseInt(t.split(':')[1], 10) || 0;
    } else if (t.startsWith('#EXTINF:')) {
      currentInf = t;
    } else if (t.endsWith('.ts') && currentInf) {
      segments.push({ inf: currentInf, uri: t });
      currentInf = null;
    }
  }
  
  return { targetDuration, mediaSequence, segments };
}

/** Build M3U8 playlist string */
function buildPlaylist(parsed, startSeq, segments) {
  return [
    '#EXTM3U',
    '#EXT-X-VERSION:3',
    `#EXT-X-TARGETDURATION:${parsed.targetDuration}`,
    `#EXT-X-MEDIA-SEQUENCE:${startSeq}`,
    ...segments.flatMap(s => [s.inf, s.uri]),
  ].join('\n') + '\n';
}

/** Get HLS status */
export function getHlsStatus() {
  const content = readPlaylist();
  const parsed = content ? parsePlaylist(content) : null;
  return {
    hasManifest: content !== null,
    segmentCount: parsed?.segments?.length || 0,
  };
}

/** Generate live playlist */
export function getLivePlaylist() {
  const content = readPlaylist();
  if (!content) return { content: null, error: 'No manifest' };
  
  const parsed = parsePlaylist(content);
  if (!parsed?.segments?.length) return { content: null, error: 'No segments' };
  
  const windowSize = Math.min(config.hlsListSize, parsed.segments.length);
  const startIdx = parsed.segments.length - windowSize;
  const segments = parsed.segments.slice(startIdx);
  
  return { content: buildPlaylist(parsed, parsed.mediaSequence + startIdx, segments), error: null };
}

/** Generate delayed playlist */
export function getDelayedPlaylist(delaySec) {
  const content = readPlaylist();
  if (!content) return { content: null, error: 'No manifest' };
  
  const parsed = parsePlaylist(content);
  if (!parsed?.segments?.length) return { content: null, error: 'No segments' };
  
  const delaySegs = Math.floor(delaySec / parsed.targetDuration);
  const endIdx = Math.max(0, parsed.segments.length - delaySegs);
  if (endIdx === 0) return { content: null, error: 'Not enough segments' };
  
  const windowSize = Math.min(config.hlsListSize, endIdx);
  const startIdx = Math.max(0, endIdx - windowSize);
  const segments = parsed.segments.slice(startIdx, endIdx);
  
  return { content: buildPlaylist(parsed, parsed.mediaSequence + startIdx, segments), error: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE STREAMING (FFMPEG)
// ═══════════════════════════════════════════════════════════════════════════════

/** Build FFmpeg arguments */
function buildFfmpegArgs(inputPath) {
  const gopSize = config.segmentDuration * 30;
  const { ffmpeg: ff } = config;
  
  return [
    '-hide_banner', '-loglevel', 'warning',
    '-re', '-fflags', '+genpts+igndts',
    '-i', inputPath,
    '-c:v', ff.videoCodec, '-preset', ff.videoPreset,
    '-profile:v', ff.videoProfile, '-level', ff.videoLevel,
    '-pix_fmt', ff.pixelFormat,
    '-g', String(gopSize), '-keyint_min', String(gopSize), '-sc_threshold', '0',
    '-b:v', ff.videoBitrate, '-maxrate', ff.videoMaxrate, '-bufsize', ff.videoBufferSize,
    '-c:a', ff.audioCodec, '-b:a', ff.audioBitrate, '-ar', String(ff.audioSampleRate),
    '-f', 'hls',
    '-hls_time', String(config.segmentDuration),
    '-hls_list_size', '0',
    '-hls_flags', 'independent_segments+temp_file',
    '-hls_segment_filename', path.join(config.hls, config.segmentPattern),
    '-hls_segment_type', 'mpegts',
    '-y', path.join(config.hls, config.sourcePlaylist),
  ];
}

/** Start live streaming */
export async function startLive(mediaPath) {
  if (!fs.existsSync(mediaPath)) throw new Error('Video file not found');
  if (isLiveRunning()) throw new Error('Already running');
  
  cleanHlsDir();
  ensureHlsDir();
  state.captions = [];
  
  return new Promise((resolve, reject) => {
    const args = buildFfmpegArgs(mediaPath);
    log.info('LIVE', `Starting FFmpeg with: ${mediaPath}`);
    log.debug('FFMPEG', `Args: ${args.join(' ')}`);
    
    const proc = spawn('ffmpeg', args);
    state.ffmpegProc = proc;
    
    let stderrBuffer = '';
    
    proc.on('error', (err) => {
      log.error('LIVE', 'FFmpeg spawn error:', err.message);
      handleLiveExit();
      reject(err);
    });
    
    proc.on('exit', (code) => {
      log.info('LIVE', `FFmpeg exited (code ${code})`);
      if (code !== 0 && stderrBuffer) {
        log.error('FFMPEG', stderrBuffer.slice(-500));
      }
      handleLiveExit();
    });
    
    proc.stderr.on('data', (d) => {
      const msg = d.toString();
      stderrBuffer += msg;
      log.debug('FFMPEG', msg.trim());
    });
    
    broadcastLiveStatus('starting');
    
    const startTime = Date.now();
    const check = setInterval(() => {
      if (!isLiveRunning()) {
        clearInterval(check);
        reject(new Error('FFmpeg terminated'));
        return;
      }
      
      const status = getHlsStatus();
      if (status.segmentCount >= config.minSegmentsForStart) {
        clearInterval(check);
        state.liveStartedAt = Date.now();
        log.info('LIVE', 'Stream ready');
        broadcastLiveStatus('started', { liveStartedAt: state.liveStartedAt });
        resolve();
        return;
      }
      
      if (Date.now() - startTime > config.ffmpegTimeout) {
        clearInterval(check);
        proc.kill('SIGTERM');
        handleLiveExit();
        reject(new Error('Timeout waiting for stream'));
      }
    }, config.ffmpegCheckInterval);
  });
}

/** Handle live exit cleanup */
function handleLiveExit() {
  state.ffmpegProc = null;
  state.liveStartedAt = null;
  state.currentMode = null;
  
  if (state.fragment.active) {
    resetFragment();
    broadcast({ type: 'fragment:stopped' });
  }
  
  broadcastLiveStatus('stopped');
}

/** Stop live streaming */
export function stopLive() {
  if (state.ffmpegProc) {
    try { state.ffmpegProc.kill('SIGTERM'); } catch (e) { /* ignore */ }
  }
  
  state.ffmpegProc = null;
  state.liveStartedAt = null;
  state.currentMode = null;
  
  if (state.fragment.active) resetFragment();
  cleanHlsDir();
  broadcastLiveStatus('stopped');
  log.info('LIVE', 'Stopped');
}

/** Resolve media path */
export function resolveMediaPath(source) {
  const clean = source.startsWith('/media/') ? source.slice(7) : source;
  return path.join(config.media, clean);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FRAGMENT MODE (COLLABORATIVE SUBTITLING)
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * FUSION ARCHITECTURE
 * ═══════════════════
 *
 * CONCEPT:
 * - Subtitlers work in rotation on time "slots"
 * - Each subtitler listens slightly ahead (live stream)
 * - Spectators watch with a configured delay
 * - Consecutive slots are fused to remove repeated words (overlap)
 *
 * DATA FLOW:
 *
 *   Slot N-1 ends
 *        │
 *        ▼
 *   Slot N starts ──► Subtitler N types text
 *        │
 *        ▼
 *   Slot N ends
 *        │
 *        ▼
 *   ┌────────────────────────────────────────┐
 *   │ FUSION: Compare end(N-1) to start(N)  │
 *   │ - Detect overlap                      │
 *   │ - Compute unique text of N-1          │
 *   │ - Send N-1 to spectators               │
 *   └────────────────────────────────────────┘
 *        │
 *        ▼
 *   Slot N+1 starts...
 *
 * EXAMPLE:
 *   Slot 0: "Les grandes villes sont Marseille,"
 *   Slot 1: "sont Marseille, Nice et Toulon"
 *
 *   Detection: "sont Marseille ," (3 words) is repeated
 *
 *   Spectator send Slot 0: full text
 *   Spectator send Slot 1: "Nice et Toulon" (first 3 words removed)
 *
 * IMPORTANT RULE:
 *   Only the subtitler assigned to the current slot can send a caption.
 *   This guarantees at most one text per slot.
 */

/** Get active subtitlers sorted by join time */
export function getActiveSubtitlers() {
  return Array.from(state.fragment.subtitlers.values())
    .filter(s => s.ws?.readyState === 1)
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

/** Get subtitler for a specific slot index */
export function getSubtitlerForSlot(slotIndex) {
  const active = getActiveSubtitlers();
  if (!active.length) return null;
  return active[slotIndex % active.length];
}

/** Get current subtitler (for current slot) */
export function getCurrentSubtitler() {
  // With the overlapping scheduler, currentSlotIndex points to the NEXT slot to start
  // (it is incremented immediately after starting a slot).
  return getSubtitlerForSlot(Math.max(0, state.fragment.currentSlotIndex - 1));
}

/** Get next subtitler */
export function getNextSubtitler() {
  return getSubtitlerForSlot(state.fragment.currentSlotIndex);
}

function getNextAssignedSlotInfo(subtitlerId) {
  const { fragment: f } = state;
  const active = getActiveSubtitlers();
  if (!active.length) return null;

  const latestSlot = f.captionsBySlot.length ? f.captionsBySlot[f.captionsBySlot.length - 1] : null;
  if (!latestSlot) return null;

  const stride = getFragmentStrideSeconds();
  const nextSlotStartMs = latestSlot.startTime + stride * 1000; // start time of slotIndex=f.currentSlotIndex

  // Find the next slot index assigned to this subtitler.
  // Search up to 2 full rotations to be safe if active list changes slightly.
  let targetIndex = null;
  for (let k = f.currentSlotIndex; k < f.currentSlotIndex + active.length * 2; k++) {
    const s = getSubtitlerForSlot(k);
    if (s?.id === subtitlerId) {
      targetIndex = k;
      break;
    }
  }
  if (targetIndex === null) return null;

  const offsetSlots = targetIndex - f.currentSlotIndex;
  const startMs = nextSlotStartMs + offsetSlots * stride * 1000;
  return { slotIndex: targetIndex, startMs };
}

/** Broadcast fragment status to all relevant clients */
export function broadcastFragmentStatus() {
  const { fragment: f } = state;
  const active = getActiveSubtitlers();
  const current = getCurrentSubtitler();

  // Global status (admin-friendly): reflect the most recently started slot
  const latestSlot = f.captionsBySlot.length ? f.captionsBySlot[f.captionsBySlot.length - 1] : null;
  const globalStart = latestSlot?.startTime || f.slotStartTime;
  const elapsed = globalStart ? Math.floor((Date.now() - globalStart) / 1000) : 0;
  const totalSlotTime = f.slotDuration + Math.floor(f.slotDuration * f.gracePeriodPercent / 100);
  const remaining = Math.max(0, totalSlotTime - elapsed);
  const inGracePeriod = elapsed > f.slotDuration;
  
  const status = {
    active: f.active,
    slotDuration: f.slotDuration,
    gracePeriodPercent: f.gracePeriodPercent,
    requiredSubtitlers: f.requiredSubtitlers,
    overlapDuration: f.overlapDuration,
    currentSlotIndex: f.currentSlotIndex,
    currentSubtitlerId: current?.id || null,
    currentSubtitlerName: current?.name || null,
    secondsRemaining: remaining,
    inGracePeriod,
    subtitlerCount: active.length,
    subtitlers: active.map(s => ({ id: s.id, name: s.name })),
  };

  // Subtitler status is individualized:
  // - If they have an open slot: countdown to their own deadline
  // - Otherwise: countdown to their next assigned slot start
  for (const s of active) {
    const slotIndex = f.openSlotBySubtitlerId?.get(s.id);
    const slot = Number.isFinite(slotIndex)
      ? f.captionsBySlot.find(x => x.slotIndex === slotIndex)
      : null;

    if (!slot) {
      const nextInfo = getNextAssignedSlotInfo(s.id);
      const waitSec = nextInfo ? Math.max(0, Math.floor((nextInfo.startMs - Date.now()) / 1000)) : 0;
      send(s.ws, {
        type: 'fragment:status',
        ...status,
        secondsRemaining: waitSec,
        isMyTurn: false,
        inGracePeriod: false,
      });
      continue;
    }

    const graceSec = Math.floor(f.slotDuration * f.gracePeriodPercent / 100);
    const deadlineMs = slot.startTime + (f.slotDuration + graceSec) * 1000;
    const now = Date.now();
    const perElapsed = Math.floor((now - slot.startTime) / 1000);
    const perRemaining = Math.max(0, Math.floor((deadlineMs - now) / 1000));
    const perInGrace = perElapsed > f.slotDuration;
    const perIsMyTurn = now <= deadlineMs;

    send(s.ws, {
      type: 'fragment:status',
      ...status,
      secondsRemaining: perRemaining,
      inGracePeriod: perInGrace,
      isMyTurn: perIsMyTurn,
    });
  }

  broadcastToAdmins({ 
    type: 'fragment:admin-status', 
    ...status, 
    rawCaptionsCount: f.captionsBySlot.reduce((n, s) => n + s.captions.length, 0), 
    fusedCaptionsCount: f.fusedCaptions.length,
    slotsCount: f.captionsBySlot.length,
  });
}

export function getFragmentStrideSeconds() {
  const { fragment: f } = state;
  return f.slotDuration - f.overlapDuration;
}

export function getFragmentGraceSeconds() {
  const { fragment: f } = state;
  return Math.floor(f.slotDuration * f.gracePeriodPercent / 100);
}

export function getFragmentProcessingLatencySeconds() {
  // Captions become "final" only after the slot ends + grace period.
  return state.fragment.slotDuration + getFragmentGraceSeconds();
}

export function getMinSpectatorDelaySec() {
  // Minimum delay required so spectators are still behind the moment being captioned
  // when the fused captions become available.
  // Also ensure the delayed playlist has at least a 1-segment lag.
  const minForHls = config.segmentDuration;
  const minForFragment = getFragmentProcessingLatencySeconds();
  return Math.max(minForHls, minForFragment);
}

export function getFragmentMinRequiredSubtitlers() {
  const { fragment: f } = state;
  const stride = getFragmentStrideSeconds();
  const grace = getFragmentGraceSeconds();
  if (stride <= 0) return Infinity;
  // Ensure a subtitler is not reassigned before their submit deadline
  return Math.ceil((f.slotDuration + grace) / stride);
}

export function validateFragmentConfig(requiredSubtitlers = state.fragment.requiredSubtitlers) {
  const { fragment: f } = state;
  const stride = getFragmentStrideSeconds();
  const grace = getFragmentGraceSeconds();

  if (!Number.isFinite(f.slotDuration) || f.slotDuration <= 0) {
    return { ok: false, error: 'slotDuration must be > 0' };
  }
  if (!Number.isFinite(f.overlapDuration) || f.overlapDuration < 0) {
    return { ok: false, error: 'overlapDuration must be >= 0' };
  }
  if (f.overlapDuration >= f.slotDuration) {
    return { ok: false, error: `overlapDuration must be < slotDuration (got ${f.overlapDuration} >= ${f.slotDuration})` };
  }
  if (!Number.isFinite(f.gracePeriodPercent) || f.gracePeriodPercent < 0 || f.gracePeriodPercent > 100) {
    return { ok: false, error: 'gracePeriodPercent must be between 0 and 100' };
  }

  const minRequired = getFragmentMinRequiredSubtitlers();
  if (requiredSubtitlers < minRequired) {
    return {
      ok: false,
      error: `Invalid config for overlapping slots: need at least ${minRequired} subtitlers to avoid reassignment before submit deadline (stride=${stride}s, slot=${f.slotDuration}s, grace=${grace}s, deadline=${f.slotDuration + grace}s, cycle=${requiredSubtitlers * stride}s)`
    };
  }

  return { ok: true };
}

/** Start the timer for the current slot */
function startNextSlot() {
  const { fragment: f } = state;
  const active = getActiveSubtitlers();
  if (active.length < f.requiredSubtitlers) {
    log.info('FRAGMENT', `En attente de sous-titreurs (${active.length}/${f.requiredSubtitlers})`);
    broadcastFragmentStatus();
    return;
  }

  const stride = getFragmentStrideSeconds();
  const graceSec = getFragmentGraceSeconds();
  const slotIndex = f.currentSlotIndex;
  const current = getSubtitlerForSlot(slotIndex);
  const next = getSubtitlerForSlot(slotIndex + 1);
  const startTime = Date.now();
  const slotStartTimestamp = state.liveStartedAt ? (Date.now() - state.liveStartedAt) : 0;

  f.slotStartTime = startTime;

  const newSlot = {
    slotIndex,
    subtitlerId: current?.id,
    subtitlerName: current?.name,
    startTime,
    startTimestamp: slotStartTimestamp,
    endTime: null,
    endTimestamp: null,
    captions: [],
    finalText: null,
    sent: false,
  };
  f.captionsBySlot.push(newSlot);
  const slotArrayIndex = f.captionsBySlot.length - 1;
  if (current?.id) f.openSlotBySubtitlerId.set(current.id, slotIndex);

  log.info('FRAGMENT', `════════════════════════════════════════`);
  log.info('FRAGMENT', `SLOT ${slotIndex} STARTED`);
  log.info('FRAGMENT', `  Subtitler: ${current?.name || 'N/A'}`);
  log.info('FRAGMENT', `  Video timestamp: ${formatTimestamp(slotStartTimestamp)}`);
  log.info('FRAGMENT', `  Stride: ${stride}s (slot=${f.slotDuration}s overlap=${f.overlapDuration}s)`);
  log.info('FRAGMENT', `  Submit deadline: +${f.slotDuration + graceSec}s (grace=${graceSec}s)`);
  log.info('FRAGMENT', `════════════════════════════════════════`);

  // Notify: current slot is ending soon (relative to its own end)
  const endingNotifyMs = (f.slotDuration - f.notifyBefore) * 1000;
  if (endingNotifyMs > 0) {
    const t = setTimeout(() => {
      if (current) send(current.ws, { type: 'fragment:ending', secondsLeft: f.notifyBefore });
      broadcastFragmentStatus();
    }, endingNotifyMs);
    f.slotTimers.add(t);
  }

  // Notify: next subtitler prepares before THEIR start (stride)
  const prepareNotifyMs = (stride - f.notifyBefore) * 1000;
  if (prepareNotifyMs > 0) {
    const t = setTimeout(() => {
      if (next) send(next.ws, { type: 'fragment:prepare', secondsLeft: f.notifyBefore });
      broadcastFragmentStatus();
    }, prepareNotifyMs);
    f.slotTimers.add(t);
  }

  // Grace starts after main slot duration
  const graceStartT = setTimeout(() => {
    if (current) send(current.ws, { type: 'fragment:grace-start', gracePeriodPercent: f.gracePeriodPercent });
    broadcastFragmentStatus();
  }, f.slotDuration * 1000);
  f.slotTimers.add(graceStartT);

  // Grace ends: auto-send + finalize + fusion
  const graceEndT = setTimeout(() => {
    if (current) send(current.ws, { type: 'fragment:auto-send' });

    newSlot.endTime = Date.now();
    newSlot.endTimestamp = state.liveStartedAt ? (Date.now() - state.liveStartedAt) : 0;

    // Close submission window immediately.
    // Auto captions are now fully tolerant and can still be attached via fallback.
    if (current?.id && f.openSlotBySubtitlerId.get(current.id) === slotIndex) {
      f.openSlotBySubtitlerId.delete(current.id);
    }

    // Give the client a moment to send the auto-caption before fusing/sending.
    const finalizeT = setTimeout(() => {
      processSlotEnd(slotArrayIndex);
      broadcastFragmentStatus();
    }, 800);
    f.slotTimers.add(finalizeT);
  }, (f.slotDuration + graceSec) * 1000);
  f.slotTimers.add(graceEndT);

  // Advance global slot index (next slot starts after stride)
  f.currentSlotIndex++;
  broadcastFragmentStatus();
}

export function startSlotTimer() {
  // Backward-compatible alias (older code calls startSlotTimer)
  return startFragmentScheduler();
}

export function startFragmentScheduler() {
  const { fragment: f } = state;
  clearTimers();

  const validation = validateFragmentConfig(f.requiredSubtitlers);
  if (!validation.ok) {
    log.warn('FRAGMENT', validation.error);
    broadcastToAdmins({ type: 'fragment:error', error: validation.error });
    broadcastFragmentStatus();
    return;
  }

  const active = getActiveSubtitlers();
  if (active.length < f.requiredSubtitlers) {
    log.info('FRAGMENT', `En attente de sous-titreurs (${active.length}/${f.requiredSubtitlers})`);
    broadcastFragmentStatus();
    return;
  }

  const stride = getFragmentStrideSeconds();
  startNextSlot();
  f.schedulerTimer = setInterval(() => {
    startNextSlot();
  }, stride * 1000);
}

/** Start fragment mode */
export function startFragmentMode() {
  if (state.fragment.active) return;
  
  state.fragment.active = true;
  state.fragment.currentSlotIndex = 0;
  state.fragment.captionsBySlot = [];
  state.fragment.fusedCaptions = [];
  state.fragment.openSlotBySubtitlerId = new Map();
  
  broadcast({ type: 'fragment:started' });
  startFragmentScheduler();
  log.info('FRAGMENT', 'Fragment mode started');
}

/** Stop fragment mode */
export function stopFragmentMode() {
  if (!state.fragment.active) return;
  
  // Send any remaining unsent slots
  sendRemainingSlots();
  
  resetFragment();
  broadcast({ type: 'fragment:stopped' });
  log.info('FRAGMENT', 'Fragment mode stopped');
}

/** Add caption to the current slot (only from assigned subtitler) */
export function addCaptionToSlot(caption) {
  const { fragment: f } = state;
  if (!f.active) return false;

  const slotIndex = f.openSlotBySubtitlerId?.get(caption.subtitlerId);
  const graceSec = getFragmentGraceSeconds();
  let currentSlot = Number.isFinite(slotIndex)
    ? f.captionsBySlot.find(s => s.slotIndex === slotIndex)
    : null;

  // Robust fallback: if mapping is missing (race around auto-send),
  // accept into the most recent slot for this subtitler.
  if (!currentSlot) {
    for (let i = f.captionsBySlot.length - 1; i >= 0; i--) {
      const candidate = f.captionsBySlot[i];
      if (!candidate) continue;
      if (candidate.subtitlerId !== caption.subtitlerId) continue;

      // For manual captions, we only accept within deadline.
      // For auto captions, accept even if it arrives late.
      if (caption.autoSent) {
        currentSlot = candidate;
        break;
      }

      const candidateDeadline = candidate.startTime + (f.slotDuration + graceSec) * 1000;
      if (Date.now() <= candidateDeadline) {
        currentSlot = candidate;
        break;
      }
    }
  }

  if (!currentSlot) {
    log.warn('CAPTION', `REJECTED - No open slot for ${caption.subtitlerName} (${caption.subtitlerId})`);
    return false;
  }

  const deadline = currentSlot.startTime + (f.slotDuration + graceSec) * 1000;
  if (!caption.autoSent && Date.now() > deadline) {
    log.warn('CAPTION', `[Slot ${currentSlot.slotIndex}] REJECTED - Deadline passed`);
    return false;
  }

  // Timestamp is based on slot start, capped at slot end (excluding grace)
  const elapsedMs = Date.now() - currentSlot.startTime;
  const cappedMs = Math.min(elapsedMs, f.slotDuration * 1000);
  const videoTimestamp = currentSlot.startTimestamp + cappedMs;
  const captionWithTimestamp = {
    ...caption,
    videoTimestamp,
    slotIndex: currentSlot.slotIndex,
    receivedAt: Date.now(),
  };
  
  currentSlot.captions.push(captionWithTimestamp);
  
  // Log
  log.info('CAPTION', `[Slot ${currentSlot.slotIndex}] [${formatTimestamp(videoTimestamp)}] "${caption.text}" (par ${caption.subtitlerName})`);
  
  // Notify admins immediately
  broadcastToAdmins({
    type: 'fragment:raw-caption',
    caption: captionWithTimestamp,
    slotIndex: currentSlot.slotIndex,
  });
  
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUSION ENGINE - Remove repetitions between consecutive slots
// ═══════════════════════════════════════════════════════════════════════════════

/**
 * ╔══════════════════════════════════════════════════════════════════════════════╗
 * ║                         ALGORITHME DE FUSION                                  ║
 * ╠══════════════════════════════════════════════════════════════════════════════╣
 * ║                                                                              ║
 * ║  BUT: Éliminer automatiquement les répétitions entre slots consécutifs.      ║
 * ║                                                                              ║
 * ║  POURQUOI ?                                                                  ║
 * ║  Les sous-titreurs travaillent en rotation et se chevauchent volontairement: ║
 * ║  chaque sous-titreur commence à écrire quelques mots AVANT la fin du slot    ║
 * ║  précédent pour assurer la continuité du texte. Cela crée des répétitions    ║
 * ║  que nous devons éliminer.                                                   ║
 * ║                                                                              ║
 * ║  EXEMPLE CONCRET:                                                            ║
 * ║  ┌────────────────────────────────────────────────────────────────────────┐  ║
 * ║  │ Slot 0 (Alice): "Paris est la capitale de la France. La France"       │  ║
 * ║  │ Slot 1 (Bob):   "La France est un grand pays européen."               │  ║
 * ║  └────────────────────────────────────────────────────────────────────────┘  ║
 * ║                                                                              ║
 * ║  Chevauchement détecté: "La France" (2 mots)                                 ║
 * ║                                                                              ║
 * ║  Résultat envoyé aux spectateurs:                                            ║
 * ║  ┌────────────────────────────────────────────────────────────────────────┐  ║
 * ║  │ Slot 0: "Paris est la capitale de la France. La France" (COMPLET)     │  ║
 * ║  │ Slot 1: "est un grand pays européen." (2 mots retirés du début)       │  ║
 * ║  └────────────────────────────────────────────────────────────────────────┘  ║
 * ║                                                                              ║
 * ║  FLUX DE TRAITEMENT:                                                         ║
 * ║                                                                              ║
 * ║    Slot N-1 se termine                                                       ║
 * ║          │                                                                   ║
 * ║          ▼                                                                   ║
 * ║    Slot N commence → Le sous-titreur N tape son texte                        ║
 * ║          │                                                                   ║
 * ║          ▼                                                                   ║
 * ║    Slot N se termine                                                         ║
 * ║          │                                                                   ║
 * ║          ▼                                                                   ║
 * ║    ┌─────────────────────────────────────────────────────┐                   ║
 * ║    │ processSlotEnd() est appelé:                        │                   ║
 * ║    │ 1. Compare la FIN du slot N-1 avec le DÉBUT de N    │                   ║
 * ║    │ 2. Détecte le nombre de mots en commun (overlap)    │                   ║
 * ║    │ 3. Stocke cette info sur le slot N                  │                   ║
 * ║    │ 4. Envoie le slot N-1 (complet) aux spectateurs     │                   ║
 * ║    │ 5. Le slot N sera envoyé SANS ses premiers mots     │                   ║
 * ║    │    (ceux déjà présents dans N-1)                    │                   ║
 * ║    └─────────────────────────────────────────────────────┘                   ║
 * ║                                                                              ║
 * ║  RÈGLE CLÉ:                                                                  ║
 * ║    On retire toujours les mots du DÉBUT du slot suivant,                     ║
 * ║    jamais de la fin du slot précédent.                                       ║
 * ║                                                                              ║
 * ╚══════════════════════════════════════════════════════════════════════════════╝
 */

const FRENCH_PUNCTUATION = /([.,!?;:…»«"'])/g;

/**
 * Tokenize - Split text into words and punctuation
 *
 * Punctuation is separated from words for better overlap detection.
 *
 * @example
 * tokenize("Bonjour, monde!") → ["Bonjour", ",", "monde", "!"]
 * tokenize("Il fait beau.")   → ["Il", "fait", "beau", "."]
 * 
 * @param {string} text - Text to split
 * @returns {string[]} Array of tokens (words + punctuation)
 */
function tokenize(text) {
  if (!text) return [];
  return text
    .replace(FRENCH_PUNCTUATION, ' $1 ')  // Add spaces around punctuation
    .split(/\s+/)                         // Split on spaces
    .filter(w => w.length > 0);            // Remove empty entries
}

/**
 * Detokenize - Rebuild readable text from tokens
 *
 * Glue punctuation properly (no extra space before periods, etc.)
 *
 * @example
 * detokenize(["Bonjour", ",", "monde", "!"]) → "Bonjour, monde!"
 * 
 * @param {string[]} words - Array of tokens
 * @returns {string} Reconstructed text
 */
function detokenize(words) {
  if (!words || !words.length) return '';
  return words.join(' ')
    .replace(/ ([.,!?;:…»"'])/g, '$1')  // Remove space before closing punctuation
    .replace(/([«"']) /g, '$1')         // Remove space after opening punctuation
    .trim();
}

/**
 * wordSimilarity - Compute similarity between two words (0..1)
 *
 * Uses Levenshtein distance to tolerate small typos.
 *
 * @example
 * wordSimilarity("Paris", "Paris")     → 1.0   (identique)
 * wordSimilarity("Marsielle", "Marseille") → 0.89 (1 caractère de différence)
 * wordSimilarity("Paris", "Lyon")      → 0.2   (très différent)
 * 
 * @param {string} w1 - First word
 * @param {string} w2 - Second word
 * @returns {number} Similarity score between 0 (different) and 1 (identical)
 */
function wordSimilarity(w1, w2) {
  const a = w1.toLowerCase();
  const b = w2.toLowerCase();
  if (a === b) return 1;
  
  const m = a.length, n = b.length;
  if (m === 0 || n === 0) return 0;
  
  // Levenshtein distance via dynamic programming
  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;
  
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] = a[i - 1] === b[j - 1]
        ? dp[i - 1][j - 1]
        : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }
  
  // Convert distance to similarity score (0-1)
  return 1 - dp[m][n] / Math.max(m, n);
}

/**
 * findOverlap - Detect overlap between two word sequences
 *
 * Checks if the END of seq1 matches the START of seq2.
 * This is the core of the fusion algorithm.
 *
 * EXAMPLE:
 *   seq1: ["grande", "ville", "La", "France"]
 *   seq2: ["La", "France", "est", "belle"]
 *
 *   Test whether seq1 ends with "La France" and seq2 starts with "La France".
 *   → Yes! Overlap = 2 words
 *
 * ERROR TOLERANCE:
 *   - Uses wordSimilarity() to accept small typos
 *   - A word is a match if similarity >= 80%
 *   - At least 70% of words must match to validate overlap
 *
 * @param {string[]} seq1 - First sequence (search at its end)
 * @param {string[]} seq2 - Second sequence (search at its start)
 * @param {number} [similarityThreshold=0.8] - Similarity threshold for a match
 * @returns {{ overlapLength: number, overlapWords: string[] }} Detection result
 */
function findOverlap(seq1, seq2, similarityThreshold = 0.8) {
  if (!seq1?.length || !seq2?.length) {
    return { overlapLength: 0, overlapWords: [] };
  }
  
  const maxOverlap = Math.min(seq1.length, seq2.length, 15); // Maximum 15 words
  let bestLength = 0;
  let bestWords = [];
  
  // Test different overlap lengths
  for (let overlapLen = 1; overlapLen <= maxOverlap; overlapLen++) {
    const startInSeq1 = seq1.length - overlapLen;
    
    // Check if seq1[end-overlapLen...end] matches seq2[0...overlapLen]
    let matches = 0;
    for (let i = 0; i < overlapLen; i++) {
      const similarity = wordSimilarity(seq1[startInSeq1 + i], seq2[i]);
      if (similarity >= similarityThreshold) {
        matches++;
      }
    }
    
    // At least 70% of words must match
    const matchRatio = matches / overlapLen;
    if (matchRatio >= 0.7 && overlapLen > bestLength) {
      bestLength = overlapLen;
      bestWords = seq1.slice(startInSeq1);
    }
  }
  
  return { overlapLength: bestLength, overlapWords: bestWords };
}

/**
 * getSlotRawText - Get raw concatenated text for a slot
 *
 * Concatenate all captions received during the slot.
 *
 * @param {Object} slot - Slot object with captions array
 * @returns {string} Concatenated text
 */
function getSlotRawText(slot) {
  if (!slot || !slot.captions || !slot.captions.length) return '';
  return slot.captions.map(c => c.text).join(' ').trim();
}

/**
 * processSlotEnd - Handle slot end and send to spectators
 *
 * WHEN CALLED: A slot ends (after grace period)
 *
 * LOGIC:
 * 1. Get the slot that just ended (slot N)
 * 2. If N=0, send immediately; store for overlap with slot 1
 * 3. Otherwise, compare END of slot N-1 with START of slot N
 * 4. Detect repeated words (overlap)
 * 5. Send slot N-1 to spectators (full text, adjusted for its own previous overlap)
 * 6. Store overlap info on slot N to remove later from its start
 *
 * IMPORTANT RULE:
 * Repeated words are removed from the START of the following slot, not the end of the previous.
 * This ensures continuous, gap-free final text.
 *
 * SPECIAL CASE - SLOT 0:
 * The first slot (index 0) is sent IMMEDIATELY at its end because it has no predecessor.
 * Its words are stored for overlap detection with slot 1.
 */
function processSlotEnd(endedSlotIndexOverride = null) {
  const { fragment: f } = state;
  const slots = f.captionsBySlot;
  
  if (slots.length === 0) return;
  
  // Get the slot that just ended
  const endedSlotIndex = Number.isFinite(endedSlotIndexOverride)
    ? endedSlotIndexOverride
    : (slots.length - 1);
  const endedSlot = slots[endedSlotIndex];
  if (!endedSlot) return;
  const endedText = getSlotRawText(endedSlot);
  
  log.info('FUSION', `════════════════════════════════════════`);
  log.info('FUSION', `END SLOT ${endedSlot.slotIndex} PROCESSING`);
  log.info('FUSION', `  Raw text: "${endedText || '(empty)'}"`);
  
  // SPECIAL CASE: First slot (index 0) — send immediately (no predecessor)
  if (endedSlotIndex === 0) {
    if (endedText) {
      log.info('FUSION', `  First slot - SEND IMMEDIATELY (no predecessor)`);
      endedSlot.finalText = endedText;
      endedSlot.sent = true;
      sendToSpectators(endedSlot, endedText);
      storeFusedCaption(endedSlot, endedText, null, 0);
    } else {
      log.info('FUSION', `  First slot empty - nothing to send`);
      endedSlot.sent = true;
      endedSlot.finalText = '';
    }
    log.info('FUSION', `════════════════════════════════════════`);
    return;
  }
  
  // Get previous slot (the one we're going to send now)
  const prevSlot = slots[endedSlotIndex - 1];
  const prevText = getSlotRawText(prevSlot);
  
  log.info('FUSION', `  Previous slot ${prevSlot.slotIndex}: "${prevText || '(empty)'}"`);
  log.info('FUSION', `  Current slot ${endedSlot.slotIndex}: "${endedText || '(empty)'}"`);
  
  // Tokenize both texts to compute overlap
  const prevWords = tokenize(prevText);
  const currentWords = tokenize(endedText);
  
  // Detect overlap between END of previous slot and START of current slot
  // (do this even if previous slot was already sent to compute current overlap)
  if (currentWords.length > 0 && prevWords.length > 0) {
    const { overlapLength, overlapWords } = findOverlap(prevWords, currentWords);
    
    if (overlapLength > 0) {
      log.info('FUSION', `  Overlap detected: ${overlapLength} words "${detokenize(overlapWords)}"`);
      endedSlot.overlapFromPrev = overlapLength;
    } else {
      log.info('FUSION', `  No overlap`);
      endedSlot.overlapFromPrev = 0;
    }
  } else {
    endedSlot.overlapFromPrev = 0;
  }
  
  // If previous slot is already sent (slot 0 case), stop here
  // Overlap has been computed for the current slot
  if (prevSlot.sent) {
    log.info('FUSION', `  Slot ${prevSlot.slotIndex} already sent - overlap computed for slot ${endedSlot.slotIndex}`);
    log.info('FUSION', `════════════════════════════════════════`);
    return;
  }
  
  // If previous slot is empty, nothing to send
  if (!prevText) {
    log.info('FUSION', `  Nothing to send (previous slot empty)`);
    prevSlot.sent = true;
    prevSlot.finalText = '';
    log.info('FUSION', `════════════════════════════════════════`);
    return;
  }
  
  // Calculate text to send
  let wordsToSend = prevWords;
  
  // If the previous slot had overlap with its own predecessor,
  // remove those words from its start
  if (prevSlot.overlapFromPrev && prevSlot.overlapFromPrev > 0) {
    log.info('FUSION', `  Slot ${prevSlot.slotIndex} adjusted: removing ${prevSlot.overlapFromPrev} words from beginning`);
    wordsToSend = prevWords.slice(prevSlot.overlapFromPrev);
  }
  
  // Text to send
  const textToSend = detokenize(wordsToSend);
  prevSlot.finalText = textToSend;
  prevSlot.sent = true;
  
  log.info('FUSION', `  ENVOI Slot ${prevSlot.slotIndex}: "${textToSend}"`);
  log.info('FUSION', `════════════════════════════════════════`);
  
  // Send to spectators with delay
  sendToSpectators(prevSlot, textToSend);
  
  // Store fused caption for history/export
  storeFusedCaption(prevSlot, textToSend, endedSlot, endedSlot.overlapFromPrev || 0);
}

/**
 * sendRemainingSlots - Send any unsent slots (when stopping fragment mode)
 *
 * When fragment mode is stopped manually, there may be slots
 * that haven't been processed yet. This sends them to spectators
 * applying the same deduplication rules.
 */
function sendRemainingSlots() {
  const { fragment: f } = state;
  const slots = f.captionsBySlot;
  
  log.info('FUSION', `════════════════════════════════════════`);
  log.info('FUSION', `SENDING REMAINING SLOTS (${slots.length} slots total)`);
  
  // Find all unsent slots and send them
  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];
    
    if (slot.sent) {
      continue;
    }
    
    const rawText = getSlotRawText(slot);
    if (!rawText) {
      slot.sent = true;
      slot.finalText = '';
      continue;
    }
    
    // Calculate final text (remove overlap if any)
    let finalWords = tokenize(rawText);
    if (slot.overlapFromPrev && slot.overlapFromPrev > 0) {
      finalWords = finalWords.slice(slot.overlapFromPrev);
    }
    
    const finalText = detokenize(finalWords);
    
    if (finalText) {
      log.info('FUSION', `  SEND Slot ${slot.slotIndex}: "${finalText}"`);
      slot.finalText = finalText;
      slot.sent = true;
      sendToSpectators(slot, finalText);
    }
  }
  
  log.info('FUSION', `════════════════════════════════════════`);
}

/**
 * sendToSpectators - Send a caption to spectators word-by-word
 *
 * Words are sent progressively over the slot duration to create
 * a smooth display synchronized with speech.
 *
 * FLOW:
 * 1. Split text into words
 * 2. Compute interval between words (slot duration / word count)
 * 3. Send each word with its index for client-side reconstruction
 *
 * @param {Object} slot - Source slot (contains startTimestamp, slotDuration)
 * @param {string} text - Final text to send (after deduplication)
 */
function sendToSpectators(slot, text) {
  // Target: spectators are watching the delayed stream, so the moment "slot.startTime"
  // should be seen at (slot.startTime + delaySec). If we are late producing captions,
  // show immediately (best effort).
  const baseDisplayAtMs = slot.startTime + state.delaySec * 1000;
  const delayMs = Math.max(0, baseDisplayAtMs - Date.now());
  const videoTimestamp = slot.startTimestamp;
  
  // Split into words (keep punctuation attached)
  const words = text.split(/\s+/).filter(w => w.length > 0);
  
  if (words.length === 0) return;
  
  // Slot duration in ms (use current config)
  const slotDurationMs = state.fragment.slotDuration * 1000;
  
  // Interval between each word
  const intervalMs = Math.floor(slotDurationMs / words.length);
  
  // Unique ID for this caption group (so the client can group words)
  const captionId = crypto.randomUUID();
  
  log.info('SPECTATOR', `[${formatTimestamp(videoTimestamp)}] SEND WORD-BY-WORD: ${words.length} words, interval ${intervalMs}ms`);
  
  // Send each word with progressive delay
  words.forEach((word, index) => {
    const wordDelayMs = delayMs + (index * intervalMs);
    
    setTimeout(() => {
      const caption = {
        id: captionId,
        word: word,
        wordIndex: index,
        totalWords: words.length,
        isLast: index === words.length - 1,
        videoTimestamp,
        slotIndex: slot.slotIndex,
        subtitlerName: slot.subtitlerName,
        slotDurationMs,
      };
      
      broadcast({ type: 'caption:word', caption }, ws => ws.clientType === 'spectator');
      
      if (index === 0) {
        log.info('SPECTATOR', `  → Premier mot: "${word}"`);
      } else if (index === words.length - 1) {
        log.info('SPECTATOR', `  → Dernier mot: "${word}"`);
      }
    }, wordDelayMs);
  });
}

/**
 * storeFusedCaption - Save a fused caption in history
 *
 * Used for:
 * - Subtitles export (SRT, VTT, etc.)
 * - Admin monitoring
 * - Fusion statistics
 *
 * @param {Object} slot - Source slot
 * @param {string} text - Final text sent
 * @param {Object} nextSlot - Next slot (for overlap info)
 * @param {number} overlapCount - Number of detected overlapping words
 */
function storeFusedCaption(slot, text, nextSlot, overlapCount) {
  const fusedCaption = {
    id: crypto.randomUUID(),
    text: text,
    type: 'fused',
    createdAt: Date.now(),
    videoTimestamp: slot.startTimestamp,
    slotIndex: slot.slotIndex,
    nextSlotIndex: nextSlot?.slotIndex,
    overlapCount: overlapCount || 0,
  };
  
  state.fragment.fusedCaptions.push(fusedCaption);
  state.captions.push(fusedCaption);
  
  broadcastToAdmins({
    type: 'fragment:fused-caption',
    caption: fusedCaption,
    overlapCount: overlapCount || 0,
  });
}

// ═══════════════════════════════════════════════════════════════════════════════
// UUID HELPER
// ═══════════════════════════════════════════════════════════════════════════════

export const generateUUID = () => crypto.randomUUID();
