/**
 * ROLE — Backend service layer (FFmpeg/HLS + fragmentation/fusion + broadcasting)
 *
 * Non-breaking multi-pool extension:
 * - Default behavior remains single-pool using `state` (poolId = 'default').
 * - Adds pool-aware fragmentation + broadcasting.
 * - FFmpeg/HLS stays global (single live output) for now.
 */
import nspell from 'nspell';


import fs from 'fs';
import path from 'path';
import { spawn } from 'child_process';
import crypto from 'crypto';
import {
  config,
  state,
  sessions,
  getSession,
  log,
  isLiveRunning,
  getLiveTimestamp,
  resetFragment,
  clearTimers
} from './core.js';

// ═══════════════════════════════════════════════════════════════════════════════
// HELPERS
// ═══════════════════════════════════════════════════════════════════════════════

/** Format timestamp as MM:SS.mmm */
function formatTimestamp(ms) {
  const totalSec = Math.floor(ms / 1000);
  const min = Math.floor(totalSec / 60);
  const sec = totalSec % 60;
  const millis = ms % 1000;
  return `${min.toString().padStart(2, '0')}:${sec.toString().padStart(2, '0')}.${millis
    .toString()
    .padStart(3, '0')}`;
}

// ──────────────────────────────────────────────────────────────────────────────
// MULTI-POOL HELPERS (non-breaking)
// ──────────────────────────────────────────────────────────────────────────────

/**
 * resolveSession - returns a session state from:
 * - a session object (already)
 * - a poolId string
 * - null/undefined -> default pool
 */
function resolveSession(poolOrSession = 'default') {
  if (poolOrSession && typeof poolOrSession === 'object' && poolOrSession.fragment) {
    return poolOrSession;
  }
  const poolId =
    typeof poolOrSession === 'string' && poolOrSession.trim() ? poolOrSession.trim() : 'default';
  return getSession(poolId);
}

/** extract poolId from caption/ws/msg (safe defaults) */
function getPoolIdFromAnything(x) {
  if (!x) return 'default';
  if (typeof x === 'string' && x.trim()) return x.trim();
  if (x.poolId && typeof x.poolId === 'string') return x.poolId.trim() || 'default';
  return 'default';
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
  } catch {
    /* ignore */
  }
  return false;
}

/** Broadcast to all clients matching filter */
export function broadcast(payload, filter = null) {
  const data = JSON.stringify(payload);
  for (const ws of clients) {
    if (ws.readyState === 1 && (!filter || filter(ws))) {
      try {
        ws.send(data);
      } catch {
        /* ignore */
      }
    }
  }
}

/** Broadcast to specific client types (legacy) */
export const broadcastToAdmins = (payload) => broadcast(payload, (ws) => ws.clientType === 'admin');
export const broadcastToSubtitlers = (payload) =>
  broadcast(payload, (ws) => ws.clientType === 'subtitler');
export const broadcastToSpectators = (payload) =>
  broadcast(payload, (ws) => ws.clientType === 'spectator');

/** Pool-aware broadcast helpers (non-breaking) */
export function broadcastInPool(poolId, payload, filter = null) {
  const pid = getPoolIdFromAnything(poolId);
  return broadcast(payload, (ws) => {
    const samePool = (ws.poolId || 'default') === pid;
    return samePool && (!filter || filter(ws));
  });
}

export const broadcastToAdminsInPool = (poolId, payload) =>
  broadcastInPool(poolId, payload, (ws) => ws.clientType === 'admin');
export const broadcastToSubtitlersInPool = (poolId, payload) =>
  broadcastInPool(poolId, payload, (ws) => ws.clientType === 'subtitler');
export const broadcastToSpectatorsInPool = (poolId, payload) =>
  broadcastInPool(poolId, payload, (ws) => ws.clientType === 'spectator');

/** Broadcast live status change (legacy global). */
export function broadcastLiveStatus(status, extra = {}) {
  broadcast({ type: 'live', status, delaySec: state.delaySec, ...extra });
}

// ═══════════════════════════════════════════════════════════════════════════════
// HLS MANAGEMENT (GLOBAL - single pool for now)
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
  } catch {
    /* directory may not exist */
  }
}

/** Read raw playlist file */
function readPlaylist() {
  try {
    return fs.readFileSync(path.join(config.hls, config.sourcePlaylist), 'utf8');
  } catch {
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
  return (
    [
      '#EXTM3U',
      '#EXT-X-VERSION:3',
      `#EXT-X-TARGETDURATION:${parsed.targetDuration}`,
      `#EXT-X-MEDIA-SEQUENCE:${startSeq}`,
      ...segments.flatMap((s) => [s.inf, s.uri])
    ].join('\n') + '\n'
  );
}

/** Get HLS status */
export function getHlsStatus() {
  const content = readPlaylist();
  const parsed = content ? parsePlaylist(content) : null;
  return {
    hasManifest: content !== null,
    segmentCount: parsed?.segments?.length || 0
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

  const td = parsed.targetDuration || config.segmentDuration || 2;
  const delaySegs = Math.floor(delaySec / td);
  const endIdx = Math.max(0, parsed.segments.length - delaySegs);
  if (endIdx === 0) return { content: null, error: 'Not enough segments' };

  const windowSize = Math.min(config.hlsListSize, endIdx);
  const startIdx = Math.max(0, endIdx - windowSize);
  const segments = parsed.segments.slice(startIdx, endIdx);

  return { content: buildPlaylist(parsed, parsed.mediaSequence + startIdx, segments), error: null };
}

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE STREAMING (FFMPEG) (GLOBAL - single live for now)
// ═══════════════════════════════════════════════════════════════════════════════

/** Build FFmpeg arguments */
function buildFfmpegArgs(inputPath) {
  const gopSize = config.segmentDuration * 30;
  const { ffmpeg: ff } = config;

  return [
    '-hide_banner',
    '-loglevel',
    'warning',
    '-re',
    '-fflags',
    '+genpts+igndts',
    '-i',
    inputPath,
    '-c:v',
    ff.videoCodec,
    '-preset',
    ff.videoPreset,
    '-profile:v',
    ff.videoProfile,
    '-level',
    ff.videoLevel,
    '-pix_fmt',
    ff.pixelFormat,
    '-g',
    String(gopSize),
    '-keyint_min',
    String(gopSize),
    '-sc_threshold',
    '0',
    '-b:v',
    ff.videoBitrate,
    '-maxrate',
    ff.videoMaxrate,
    '-bufsize',
    ff.videoBufferSize,
    '-c:a',
    ff.audioCodec,
    '-b:a',
    ff.audioBitrate,
    '-ar',
    String(ff.audioSampleRate),
    '-f',
    'hls',
    '-hls_time',
    String(config.segmentDuration),
    '-hls_list_size',
    '0',
    '-hls_flags',
    'independent_segments+temp_file',
    '-hls_segment_filename',
    path.join(config.hls, config.segmentPattern),
    '-hls_segment_type',
    'mpegts',
    '-y',
    path.join(config.hls, config.sourcePlaylist)
  ];
}

/** Start live streaming */
export async function startLive(mediaPath) {
  if (!fs.existsSync(mediaPath)) throw new Error('Video file not found');
  if (isLiveRunning()) throw new Error('Already running');

  cleanHlsDir();
  ensureHlsDir();

  // legacy: clear default pool captions (OK)
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

  // IMPORTANT: stop fragment mode for ALL pools (otherwise non-default pools leak active state)
  for (const [pid, sess] of sessions.entries()) {
    if (sess?.fragment?.active) {
      try {
        sendRemainingSlots(sess);
        resetFragment(sess);
        broadcastInPool(pid, { type: 'fragment:stopped', poolId: pid });
      } catch {
        /* ignore */
      }
    }
  }

  broadcastLiveStatus('stopped');
}

/** Stop live streaming */
export function stopLive() {
  if (state.ffmpegProc) {
    try {
      state.ffmpegProc.kill('SIGTERM');
    } catch {
      /* ignore */
    }
  }

  state.ffmpegProc = null;
  state.liveStartedAt = null;
  state.currentMode = null;

  // stop fragment mode for ALL pools
  for (const [pid, sess] of sessions.entries()) {
    if (sess?.fragment?.active) {
      try {
        sendRemainingSlots(sess);
        resetFragment(sess);
        broadcastInPool(pid, { type: 'fragment:stopped', poolId: pid });
      } catch {
        /* ignore */
      }
    }
  }

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
// FRAGMENT MODE (COLLABORATIVE SUBTITLING) — NOW POOL-AWARE
// ═══════════════════════════════════════════════════════════════════════════════

/** Get active subtitlers sorted by join time (pool-aware) */
export function getActiveSubtitlers(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  return Array.from(s.fragment.subtitlers.values())
    .filter((x) => x.ws?.readyState === 1)
    .sort((a, b) => a.joinedAt - b.joinedAt);
}

/** Get subtitler for a specific slot index (pool-aware) */
export function getSubtitlerForSlot(poolOrSession, slotIndex) {
  const s = resolveSession(poolOrSession);
  const active = getActiveSubtitlers(s);
  if (!active.length) return null;
  return active[slotIndex % active.length];
}

/** Get current subtitler (for current slot) (pool-aware) */
export function getCurrentSubtitler(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  return getSubtitlerForSlot(s, Math.max(0, s.fragment.currentSlotIndex - 1));
}

/** Get next subtitler (pool-aware) */
export function getNextSubtitler(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  return getSubtitlerForSlot(s, s.fragment.currentSlotIndex);
}

function getNextAssignedSlotInfo(subtitlerId, poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;

  const active = getActiveSubtitlers(s);
  if (!active.length) return null;

  const latestSlot = f.captionsBySlot.length ? f.captionsBySlot[f.captionsBySlot.length - 1] : null;
  if (!latestSlot) return null;

  const stride = getFragmentStrideSeconds(s);
  const nextSlotStartMs = latestSlot.startTime + stride * 1000;

  let targetIndex = null;
  for (let k = f.currentSlotIndex; k < f.currentSlotIndex + active.length * 2; k++) {
    const sub = getSubtitlerForSlot(s, k);
    if (sub?.id === subtitlerId) {
      targetIndex = k;
      break;
    }
  }
  if (targetIndex === null) return null;

  const offsetSlots = targetIndex - f.currentSlotIndex;
  const startMs = nextSlotStartMs + offsetSlots * stride * 1000;
  return { slotIndex: targetIndex, startMs };
}

/** Broadcast fragment status (pool-aware).
 * - If poolId omitted: broadcast for ALL pools.
 * - If poolId provided: broadcast only that pool.
 */
export function broadcastFragmentStatus(poolId = null) {
  if (!poolId) {
    for (const [pid] of sessions.entries()) {
      _broadcastFragmentStatusForPool(pid);
    }
    return;
  }
  _broadcastFragmentStatusForPool(poolId);
}

function _broadcastFragmentStatusForPool(poolId) {
  const s = resolveSession(poolId);
  const { fragment: f } = s;

  const active = getActiveSubtitlers(s);
  const current = getCurrentSubtitler(s);

  const latestSlot = f.captionsBySlot.length ? f.captionsBySlot[f.captionsBySlot.length - 1] : null;
  const globalStart = latestSlot?.startTime || f.slotStartTime;
  const elapsed = globalStart ? Math.floor((Date.now() - globalStart) / 1000) : 0;
  const totalSlotTime = f.slotDuration + Math.floor((f.slotDuration * f.gracePeriodPercent) / 100);
  const remaining = Math.max(0, totalSlotTime - elapsed);
  const inGracePeriod = elapsed > f.slotDuration;

  const status = {
    poolId,
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
    subtitlers: active.map((x) => ({ id: x.id, name: x.name }))
  };

  // individualized status per subtitler
  for (const sub of active) {
    const slotIndex = f.openSlotBySubtitlerId?.get(sub.id);
    const slot = Number.isFinite(slotIndex) ? f.captionsBySlot.find((x) => x.slotIndex === slotIndex) : null;

    if (!slot) {
      const nextInfo = getNextAssignedSlotInfo(sub.id, s);
      const waitSec = nextInfo ? Math.max(0, Math.floor((nextInfo.startMs - Date.now()) / 1000)) : 0;
      send(sub.ws, {
        type: 'fragment:status',
        ...status,
        secondsRemaining: waitSec,
        isMyTurn: false,
        inGracePeriod: false
      });
      continue;
    }

    const graceSec = Math.floor((f.slotDuration * f.gracePeriodPercent) / 100);
    const deadlineMs = slot.startTime + (f.slotDuration + graceSec) * 1000;

    const now = Date.now();
    const perElapsed = Math.floor((now - slot.startTime) / 1000);
    const perRemaining = Math.max(0, Math.floor((deadlineMs - now) / 1000));
    const perInGrace = perElapsed > f.slotDuration;
    const perIsMyTurn = now <= deadlineMs;

    send(sub.ws, {
      type: 'fragment:status',
      ...status,
      secondsRemaining: perRemaining,
      inGracePeriod: perInGrace,
      isMyTurn: perIsMyTurn
    });
  }

  broadcastToAdminsInPool(poolId, {
    type: 'fragment:admin-status',
    ...status,
    rawCaptionsCount: f.captionsBySlot.reduce((n, sl) => n + sl.captions.length, 0),
    fusedCaptionsCount: f.fusedCaptions.length,
    slotsCount: f.captionsBySlot.length
  });
}

export function getFragmentStrideSeconds(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;
  return f.slotDuration - f.overlapDuration;
}

export function getFragmentGraceSeconds(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;
  return Math.floor((f.slotDuration * f.gracePeriodPercent) / 100);
}

export function getFragmentProcessingLatencySeconds(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  return s.fragment.slotDuration + getFragmentGraceSeconds(s);
}

export function getMinSpectatorDelaySec(poolOrSession = 'default') {
  const minForHls = config.segmentDuration;
  const minForFragment = getFragmentProcessingLatencySeconds(poolOrSession);
  return Math.max(minForHls, minForFragment);
}

export function getFragmentMinRequiredSubtitlers(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;
  const stride = getFragmentStrideSeconds(s);
  const grace = getFragmentGraceSeconds(s);
  if (stride <= 0) return Infinity;
  return Math.ceil((f.slotDuration + grace) / stride);
}

export function validateFragmentConfig(requiredSubtitlers = null, poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;

  const req = requiredSubtitlers ?? f.requiredSubtitlers;

  const stride = getFragmentStrideSeconds(s);
  const grace = getFragmentGraceSeconds(s);

  if (!Number.isFinite(f.slotDuration) || f.slotDuration <= 0) {
    return { ok: false, error: 'slotDuration must be > 0' };
  }
  if (!Number.isFinite(f.overlapDuration) || f.overlapDuration < 0) {
    return { ok: false, error: 'overlapDuration must be >= 0' };
  }
  if (f.overlapDuration >= f.slotDuration) {
    return {
      ok: false,
      error: `overlapDuration must be < slotDuration (got ${f.overlapDuration} >= ${f.slotDuration})`
    };
  }
  if (!Number.isFinite(f.gracePeriodPercent) || f.gracePeriodPercent < 0 || f.gracePeriodPercent > 100) {
    return { ok: false, error: 'gracePeriodPercent must be between 0 and 100' };
  }

  const minRequired = getFragmentMinRequiredSubtitlers(s);
  if (req < minRequired) {
    return {
      ok: false,
      error: `Invalid config for overlapping slots: need at least ${minRequired} subtitlers to avoid reassignment before submit deadline (stride=${stride}s, slot=${f.slotDuration}s, grace=${grace}s, deadline=${
        f.slotDuration + grace
      }s, cycle=${req * stride}s)`
    };
  }

  return { ok: true };
}

/** Start the next slot (pool-aware internal) */
function startNextSlot(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;
  const poolId = s.poolId || 'default';

  const active = getActiveSubtitlers(s);
  if (active.length < f.requiredSubtitlers) {
    log.info('FRAGMENT', `En attente de sous-titreurs (${active.length}/${f.requiredSubtitlers}) pool=${poolId}`);
    broadcastFragmentStatus(poolId);
    return;
  }

  const stride = getFragmentStrideSeconds(s);
  const graceSec = getFragmentGraceSeconds(s);
  const slotIndex = f.currentSlotIndex;
  const current = getSubtitlerForSlot(s, slotIndex);
  const next = getSubtitlerForSlot(s, slotIndex + 1);
  const startTime = Date.now();

  // Live timestamp is still global (single live). Works for prototype.
  const slotStartTimestamp = state.liveStartedAt ? Date.now() - state.liveStartedAt : 0;

  f.slotStartTime = startTime;

  const newSlot = {
    poolId,
    slotIndex,
    subtitlerId: current?.id,
    subtitlerName: current?.name,
    startTime,
    startTimestamp: slotStartTimestamp,
    endTime: null,
    endTimestamp: null,
    captions: [],
    finalText: null,
    sent: false
  };

  f.captionsBySlot.push(newSlot);
  const slotArrayIndex = f.captionsBySlot.length - 1;
  if (current?.id) f.openSlotBySubtitlerId.set(current.id, slotIndex);

  log.info('FRAGMENT', `════════════════════════════════════════`);
  log.info('FRAGMENT', `SLOT ${slotIndex} STARTED (pool=${poolId})`);
  log.info('FRAGMENT', `  Subtitler: ${current?.name || 'N/A'}`);
  log.info('FRAGMENT', `  Video timestamp: ${formatTimestamp(slotStartTimestamp)}`);
  log.info('FRAGMENT', `  Stride: ${stride}s (slot=${f.slotDuration}s overlap=${f.overlapDuration}s)`);
  log.info('FRAGMENT', `  Submit deadline: +${f.slotDuration + graceSec}s (grace=${graceSec}s)`);
  log.info('FRAGMENT', `════════════════════════════════════════`);

  // Notify: current slot is ending soon
  const endingNotifyMs = (f.slotDuration - f.notifyBefore) * 1000;
  if (endingNotifyMs > 0) {
    const t = setTimeout(() => {
      if (current) send(current.ws, { type: 'fragment:ending', secondsLeft: f.notifyBefore, poolId });
      broadcastFragmentStatus(poolId);
    }, endingNotifyMs);
    f.slotTimers.add(t);
  }

  // Notify: next subtitler prepares
  const prepareNotifyMs = (stride - f.notifyBefore) * 1000;
  if (prepareNotifyMs > 0) {
    const t = setTimeout(() => {
      if (next) send(next.ws, { type: 'fragment:prepare', secondsLeft: f.notifyBefore, poolId });
      broadcastFragmentStatus(poolId);
    }, prepareNotifyMs);
    f.slotTimers.add(t);
  }

  // Grace starts
  const graceStartT = setTimeout(() => {
    if (current) send(current.ws, { type: 'fragment:grace-start', gracePeriodPercent: f.gracePeriodPercent, poolId });
    broadcastFragmentStatus(poolId);
  }, f.slotDuration * 1000);
  f.slotTimers.add(graceStartT);

  // Grace ends: auto-send + finalize + fusion
  const graceEndT = setTimeout(() => {
    if (current) send(current.ws, { type: 'fragment:auto-send', poolId });

    newSlot.endTime = Date.now();
    newSlot.endTimestamp = state.liveStartedAt ? Date.now() - state.liveStartedAt : 0;

    if (current?.id && f.openSlotBySubtitlerId.get(current.id) === slotIndex) {
      f.openSlotBySubtitlerId.delete(current.id);
    }

    const finalizeT = setTimeout(() => {
      processSlotEnd(slotArrayIndex, poolId);
      broadcastFragmentStatus(poolId);
    }, 800);
    f.slotTimers.add(finalizeT);
  }, (f.slotDuration + graceSec) * 1000);
  f.slotTimers.add(graceEndT);

  f.currentSlotIndex++;
  broadcastFragmentStatus(poolId);
}

export function startSlotTimer() {
  // Backward-compatible alias (older code calls startSlotTimer) - default pool
  return startFragmentScheduler('default');
}

export function startFragmentScheduler(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;
  const poolId = s.poolId || 'default';

  clearTimers(s);

  const validation = validateFragmentConfig(f.requiredSubtitlers, s);
  if (!validation.ok) {
    log.warn('FRAGMENT', validation.error);
    broadcastToAdminsInPool(poolId, { type: 'fragment:error', error: validation.error, poolId });
    broadcastFragmentStatus(poolId);
    return;
  }

  const active = getActiveSubtitlers(s);
  if (active.length < f.requiredSubtitlers) {
    log.info('FRAGMENT', `En attente de sous-titreurs (${active.length}/${f.requiredSubtitlers}) pool=${poolId}`);
    broadcastFragmentStatus(poolId);
    return;
  }

  const stride = getFragmentStrideSeconds(s);
  startNextSlot(s);

  f.schedulerTimer = setInterval(() => {
    startNextSlot(s);
  }, stride * 1000);
}

/** Start fragment mode (pool-aware) */
export function startFragmentMode(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const poolId = s.poolId || 'default';
  if (s.fragment.active) return;

  s.fragment.active = true;
  s.fragment.currentSlotIndex = 0;
  s.fragment.captionsBySlot = [];
  s.fragment.fusedCaptions = [];
  s.fragment.openSlotBySubtitlerId = new Map();

  broadcastInPool(poolId, { type: 'fragment:started', poolId });
  startFragmentScheduler(s);
  log.info('FRAGMENT', `Fragment mode started (pool=${poolId})`);
}

/** Stop fragment mode (pool-aware) */
export function stopFragmentMode(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const poolId = s.poolId || 'default';
  if (!s.fragment.active) return;

  sendRemainingSlots(s);

  resetFragment(s);
  broadcastInPool(poolId, { type: 'fragment:stopped', poolId });
  log.info('FRAGMENT', `Fragment mode stopped (pool=${poolId})`);
}

/** Add caption to the current slot (pool-aware) */
export function addCaptionToSlot(caption) {
  const poolId = getPoolIdFromAnything(caption);
  const s = resolveSession(poolId);
  const { fragment: f } = s;
  if (!f.active) return false;

  const slotIndex = f.openSlotBySubtitlerId?.get(caption.subtitlerId);
  const graceSec = getFragmentGraceSeconds(s);

  let currentSlot = Number.isFinite(slotIndex) ? f.captionsBySlot.find((sl) => sl.slotIndex === slotIndex) : null;

  // Robust fallback: accept into most recent slot for this subtitler
  if (!currentSlot) {
    for (let i = f.captionsBySlot.length - 1; i >= 0; i--) {
      const candidate = f.captionsBySlot[i];
      if (!candidate) continue;
      if (candidate.subtitlerId !== caption.subtitlerId) continue;

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
    log.warn('CAPTION', `REJECTED - No open slot for ${caption.subtitlerName} (${caption.subtitlerId}) pool=${poolId}`);
    return false;
  }

  const deadline = currentSlot.startTime + (f.slotDuration + graceSec) * 1000;
  if (!caption.autoSent && Date.now() > deadline) {
    log.warn('CAPTION', `[Slot ${currentSlot.slotIndex}] REJECTED - Deadline passed pool=${poolId}`);
    return false;
  }

  // Timestamp based on slot start, capped at slot end (excluding grace)
  const elapsedMs = Date.now() - currentSlot.startTime;
  const cappedMs = Math.min(elapsedMs, f.slotDuration * 1000);
  const videoTimestamp = currentSlot.startTimestamp + cappedMs;

  const captionWithTimestamp = {
    ...caption,
    poolId,
    videoTimestamp,
    slotIndex: currentSlot.slotIndex,
    receivedAt: Date.now()
  };

  currentSlot.captions.push(captionWithTimestamp);

  log.info(
    'CAPTION',
    `[Slot ${currentSlot.slotIndex}] [${formatTimestamp(videoTimestamp)}] "${caption.text}" (par ${caption.subtitlerName}) pool=${poolId}`
  );

  // Notify admins in pool
  broadcastToAdminsInPool(poolId, {
    type: 'fragment:raw-caption',
    caption: captionWithTimestamp,
    slotIndex: currentSlot.slotIndex,
    poolId
  });

  return true;
}

// ═══════════════════════════════════════════════════════════════════════════════
// FUSION ENGINE - Remove repetitions between consecutive slots (pool-aware)
// ═══════════════════════════════════════════════════════════════════════════════

const FRENCH_PUNCTUATION = /([.,!?;:…»«"'])/g;

function tokenize(text) {
  if (!text) return [];
  return text
    .replace(FRENCH_PUNCTUATION, ' $1 ')
    .split(/\s+/)
    .filter((w) => w.length > 0);
}

function detokenize(words) {
  if (!words || !words.length) return '';
  return words
    .join(' ')
    .replace(/ ([.,!?;:…»"'])/g, '$1')
    .replace(/([«"']) /g, '$1')
    .trim();
}

function wordSimilarity(w1, w2) {
  const a = w1.toLowerCase();
  const b = w2.toLowerCase();
  if (a === b) return 1;

  const m = a.length,
    n = b.length;
  if (m === 0 || n === 0) return 0;

  const dp = Array.from({ length: m + 1 }, (_, i) => [i]);
  for (let j = 1; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      dp[i][j] =
        a[i - 1] === b[j - 1] ? dp[i - 1][j - 1] : 1 + Math.min(dp[i - 1][j], dp[i][j - 1], dp[i - 1][j - 1]);
    }
  }

  return 1 - dp[m][n] / Math.max(m, n);
}

function findOverlap(seq1, seq2, similarityThreshold = 0.8) {
  if (!seq1?.length || !seq2?.length) {
    return { overlapLength: 0, overlapWords: [] };
  }

  const maxOverlap = Math.min(seq1.length, seq2.length, 15);
  let bestLength = 0;
  let bestWords = [];

  for (let overlapLen = 1; overlapLen <= maxOverlap; overlapLen++) {
    const startInSeq1 = seq1.length - overlapLen;

    let matches = 0;
    for (let i = 0; i < overlapLen; i++) {
      const similarity = wordSimilarity(seq1[startInSeq1 + i], seq2[i]);
      if (similarity >= similarityThreshold) matches++;
    }

    const matchRatio = matches / overlapLen;
    if (matchRatio >= 0.7 && overlapLen > bestLength) {
      bestLength = overlapLen;
      bestWords = seq1.slice(startInSeq1);
    }
  }

  return { overlapLength: bestLength, overlapWords: bestWords };
}

function getSlotRawText(slot) {
  if (!slot || !slot.captions || !slot.captions.length) return '';
  return slot.captions.map((c) => c.text).join(' ').trim();
}

function processSlotEnd(endedSlotIndexOverride = null, poolId = 'default') {
  const s = resolveSession(poolId);
  const { fragment: f } = s;
  const slots = f.captionsBySlot;

  if (slots.length === 0) return;

  const endedSlotIndex = Number.isFinite(endedSlotIndexOverride) ? endedSlotIndexOverride : slots.length - 1;
  const endedSlot = slots[endedSlotIndex];
  if (!endedSlot) return;
  const endedText = getSlotRawText(endedSlot);

  log.info('FUSION', `════════════════════════════════════════`);
  log.info('FUSION', `END SLOT ${endedSlot.slotIndex} PROCESSING (pool=${poolId})`);
  log.info('FUSION', `  Raw text: "${endedText || '(empty)'}"`);

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

  const prevSlot = slots[endedSlotIndex - 1];
  const prevText = getSlotRawText(prevSlot);

  log.info('FUSION', `  Previous slot ${prevSlot.slotIndex}: "${prevText || '(empty)'}"`);
  log.info('FUSION', `  Current slot ${endedSlot.slotIndex}: "${endedText || '(empty)'}"`);

  const prevWords = tokenize(prevText);
  const currentWords = tokenize(endedText);

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

  if (prevSlot.sent) {
    log.info('FUSION', `  Slot ${prevSlot.slotIndex} already sent - overlap computed for slot ${endedSlot.slotIndex}`);
    log.info('FUSION', `════════════════════════════════════════`);
    return;
  }

  if (!prevText) {
    log.info('FUSION', `  Nothing to send (previous slot empty)`);
    prevSlot.sent = true;
    prevSlot.finalText = '';
    log.info('FUSION', `════════════════════════════════════════`);
    return;
  }

  let wordsToSend = prevWords;

  if (prevSlot.overlapFromPrev && prevSlot.overlapFromPrev > 0) {
    log.info('FUSION', `  Slot ${prevSlot.slotIndex} adjusted: removing ${prevSlot.overlapFromPrev} words from beginning`);
    wordsToSend = prevWords.slice(prevSlot.overlapFromPrev);
  }

  const textToSend = detokenize(wordsToSend);
  prevSlot.finalText = textToSend;
  prevSlot.sent = true;

  log.info('FUSION', `  ENVOI Slot ${prevSlot.slotIndex}: "${textToSend}"`);
  log.info('FUSION', `════════════════════════════════════════`);

  sendToSpectators(prevSlot, textToSend);
  storeFusedCaption(prevSlot, textToSend, endedSlot, endedSlot.overlapFromPrev || 0);
}

function sendRemainingSlots(poolOrSession = 'default') {
  const s = resolveSession(poolOrSession);
  const { fragment: f } = s;
  const slots = f.captionsBySlot;

  log.info('FUSION', `════════════════════════════════════════`);
  log.info('FUSION', `SENDING REMAINING SLOTS (${slots.length} slots total) (pool=${s.poolId || 'default'})`);

  for (let i = 0; i < slots.length; i++) {
    const slot = slots[i];

    if (slot.sent) continue;

    const rawText = getSlotRawText(slot);
    if (!rawText) {
      slot.sent = true;
      slot.finalText = '';
      continue;
    }

    let finalWords = tokenize(rawText);
    if (slot.overlapFromPrev && slot.overlapFromPrev > 0) {
      finalWords = finalWords.slice(slot.overlapFromPrev);
    }

    const finalText = detokenize(finalWords);

    if (finalText) {
      log.info('FUSION', `  SEND Slot ${slot.slotIndex}: "${finalText}" (pool=${slot.poolId || s.poolId || 'default'})`);
      slot.finalText = finalText;
      slot.sent = true;
      sendToSpectators(slot, finalText);
    }
  }

  log.info('FUSION', `════════════════════════════════════════`);
}

function sendToSpectators(slot, text) {
  const poolId = slot.poolId || 'default';
  const s = resolveSession(poolId);

  const baseDisplayAtMs = slot.startTime + s.delaySec * 1000;
  const delayMs = Math.max(0, baseDisplayAtMs - Date.now());
  const videoTimestamp = slot.startTimestamp;

  const words = text.split(/\s+/).filter((w) => w.length > 0);
  if (words.length === 0) return;

  const slotDurationMs = s.fragment.slotDuration * 1000;
  const intervalMs = Math.max(1, Math.floor(slotDurationMs / words.length));
  const captionId = crypto.randomUUID();

  log.info(
    'SPECTATOR',
    `[${formatTimestamp(videoTimestamp)}] SEND WORD-BY-WORD: ${words.length} words, interval ${intervalMs}ms (pool=${poolId})`
  );

  words.forEach((word, index) => {
    const wordDelayMs = delayMs + index * intervalMs;

    setTimeout(() => {
      const caption = {
        id: captionId,
        word,
        wordIndex: index,
        totalWords: words.length,
        isLast: index === words.length - 1,
        videoTimestamp,
        slotIndex: slot.slotIndex,
        subtitlerName: slot.subtitlerName,
        slotDurationMs,
        poolId
      };

      broadcastToSpectatorsInPool(poolId, { type: 'caption:word', caption });

      if (index === 0) {
        log.info('SPECTATOR', `  → Premier mot: "${word}" (pool=${poolId})`);
      } else if (index === words.length - 1) {
        log.info('SPECTATOR', `  → Dernier mot: "${word}" (pool=${poolId})`);
      }
    }, wordDelayMs);
  });
}

function storeFusedCaption(slot, text, nextSlot, overlapCount) {
  const poolId = slot.poolId || 'default';
  const s = resolveSession(poolId);

  const fusedCaption = {
    id: crypto.randomUUID(),
    text,
    type: 'fused',
    createdAt: Date.now(),
    videoTimestamp: slot.startTimestamp,
    slotIndex: slot.slotIndex,
    nextSlotIndex: nextSlot?.slotIndex,
    overlapCount: overlapCount || 0,
    poolId
  };

  s.fragment.fusedCaptions.push(fusedCaption);
  s.captions.push(fusedCaption);

  broadcastToAdminsInPool(poolId, {
    type: 'fragment:fused-caption',
    caption: fusedCaption,
    overlapCount: overlapCount || 0,
    poolId
  });
  // Load the dictionary files
const aff = fs.readFileSync('././data/index.aff', 'utf-8');
const dic = fs.readFileSync('././data/index.dic', 'utf-8');
const spell = nspell(aff, dic);

/**
 * Real Dictionary Correction
 * Checks if the word exists; if not, takes the top suggestion.
 */
function formalCorrect(tokens) {
  return tokens.map(word => {
    // On nettoie le mot (minuscules) pour augmenter les chances du dictionnaire
    const cleanWord = word.toLowerCase();
    const isCorrect = spell.correct(cleanWord);

    if (!isCorrect) {
      const suggestions = spell.suggest(cleanWord);
      
      if (suggestions.length > 0) {
        // Log pour debug : voir ce que le dictionnaire propose
        // console.log(`Dict suggest for "${word}":`, suggestions.slice(0, 3));
        
        // On prend la première suggestion (souvent celle avec l'accent correct)
        return suggestions[0];
      }
    }
    return word;
  });
}
  
// Assurez-vous que tokenize et detokenize sont définis au-dessus
 function computeMSAConsensus(slot) {
  if (!slot || !slot.captions || !slot.captions.length) return "";
  
  const versions = slot.captions.map(c => tokenize(c.text));
  const maxLength = Math.max(...versions.map(v => v.length));
  const resultTokens = [];

  for (let i = 0; i < maxLength; i++) {
    const frequency = {};
    versions.forEach(tokens => {
      const word = tokens[i];
      if (word) frequency[word] = (frequency[word] || 0) + 1;
    });

    const winner = Object.keys(frequency).reduce((a, b) => 
      (frequency[a] || 0) > (frequency[b] || 0) ? a : b, "");
    
    if (winner) resultTokens.push(winner);
  }

  return detokenize(resultTokens);
}
function processSlotEnd(slotIndex, poolId) {
    const s = resolveSession(poolId);
    const slot = s.fragment.captionsBySlot[slotIndex];
    const consensusText = computeMSAConsensus(slot);
    const cleanText = formalCorrect(tokenize(consensusText));
    const finalText = detokenize(cleanText);
    sendToSpectators(slot, finalText);
}
}

// ═══════════════════════════════════════════════════════════════════════════════
// UUID HELPER
// ═══════════════════════════════════════════════════════════════════════════════

export const generateUUID = () => crypto.randomUUID();
