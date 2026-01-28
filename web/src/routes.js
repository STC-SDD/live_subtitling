/**
 * ROLE — HTTP routes (REST API + HLS playlists)
<<<<<<< HEAD
=======
 *
 * Non-breaking multi-pool extension:
 * - If poolId is missing => uses 'default' pool (legacy behavior)
 * - Fragment/captions/delay/config become pool-aware
 * - HLS/FFmpeg remains global (single stream) for now
>>>>>>> origin/pool
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { config, state, getSession, log, isLiveRunning } from './core.js';
import * as services from './services.js';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import * as userStore from './userStore.js';

const router = express.Router();

// ──────────────────────────────────────────────────────────────────────────────
// POOL HELPER (non-breaking)
// Accept poolId from:
// - query: ?poolId=room1
// - header: x-pool-id: room1
// - body: { poolId: "room1" }
// default => "default"
// ──────────────────────────────────────────────────────────────────────────────

function getPoolId(req) {
  const q = req.query?.poolId;
  const h = req.headers?.['x-pool-id'];
  const b = req.body?.poolId;

  const poolId = (typeof q === 'string' && q.trim()) ||
                 (typeof h === 'string' && h.trim()) ||
                 (typeof b === 'string' && b.trim()) ||
                 'default';

  return poolId;
}

function getPoolState(req) {
  const poolId = getPoolId(req);
  return getSession(poolId);
}

// ═══════════════════════════════════════════════════════════════════════════════
// FILE UPLOAD
// ═══════════════════════════════════════════════════════════════════════════════

fs.mkdirSync(config.media, { recursive: true });

const upload = multer({
  storage: multer.diskStorage({
    destination: config.media,
    filename: (req, file, cb) => {
      const safe = file.originalname.replace(/[^a-zA-Z0-9._-]/g, '_');
      cb(null, `${Date.now()}_${safe}`);
    },
  }),
  limits: { fileSize: 2 * 1024 * 1024 * 1024 }, // 2GB
  fileFilter: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, ['.mp4', '.mkv', '.mov', '.webm', '.avi'].includes(ext));
  },
});

// ═══════════════════════════════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

<<<<<<< HEAD
=======
/** Get current config (pool-aware) */
>>>>>>> origin/pool
router.get('/api/config', (req, res) => {
  const ps = getPoolState(req);
  res.json({
    poolId: ps.poolId || getPoolId(req),
    delaySec: ps.delaySec,
    mode: ps.currentMode,
    fragmentMode: ps.fragment.active,
  });
});

<<<<<<< HEAD
router.get('/api/delay', (req, res) => res.json({ delaySec: state.delaySec }));
=======
/** Get/Set delay (pool-aware) */
router.get('/api/delay', (req, res) => {
  const ps = getPoolState(req);
  res.json({ poolId: ps.poolId || getPoolId(req), delaySec: ps.delaySec });
});
>>>>>>> origin/pool

router.post('/api/delay', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);

  const { delaySec } = req.body;
  if (typeof delaySec !== 'number' || delaySec < 0 || delaySec > config.maxDelay) {
    return res.status(400).json({ error: `Invalid delay (0-${config.maxDelay})` });
  }
<<<<<<< HEAD
  const minDelay = services.getMinSpectatorDelaySec();
  if (delaySec < minDelay) {
    return res.status(400).json({ error: `Delay too small for current fragment config. Minimum is ${minDelay}s.` });
  }
  state.delaySec = delaySec;
  services.broadcast({ type: 'config', delaySec });
  log.info('API', `Delay set to ${delaySec}s`);
  res.json({ ok: true, delaySec });
});

=======

  const minDelay = services.getMinSpectatorDelaySec(ps);
  if (delaySec < minDelay) {
    return res.status(400).json({ error: `Delay too small for current fragment config. Minimum is ${minDelay}s.` });
  }

  ps.delaySec = delaySec;
  services.broadcastInPool(poolId, { type: 'config', delaySec, poolId });
  log.info('API', `Delay set to ${delaySec}s (pool=${poolId})`);

  res.json({ ok: true, poolId, delaySec });
});

/** List videos (global files) */
>>>>>>> origin/pool
router.get('/api/videos', (req, res) => {
  try {
    const files = fs.readdirSync(config.media)
      .filter(f => /\.(mp4|mkv|mov|webm|avi)$/i.test(f))
      .map(f => ({ name: f, path: `/media/${f}` }));
    res.json(files);
  } catch (e) {
    res.json([]);
  }
});

<<<<<<< HEAD
=======
/** Upload video (global storage) */
>>>>>>> origin/pool
router.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  log.info('API', `Uploaded: ${req.file.filename}`);
  res.json({ ok: true, file: req.file.filename });
});

<<<<<<< HEAD
=======
/** Get captions (pool-aware) */
>>>>>>> origin/pool
router.get('/api/captions', (req, res) => {
  const ps = getPoolState(req);
  const since = parseInt(req.query.since, 10) || 0;
  const captions = ps.captions.filter(c => c.createdAt > since);
  res.json({ poolId: ps.poolId || getPoolId(req), captions });
});

// ═══════════════════════════════════════════════════════════════════════════════
<<<<<<< HEAD
// LIVE CONTROL & FRAGMENT MODE
// ═══════════════════════════════════════════════════════════════════════════════

=======
// LIVE CONTROL (GLOBAL live, but pool config still matters)
// ═══════════════════════════════════════════════════════════════════════════════

/** Get live status (pool-aware fields + global HLS/FFmpeg status) */
>>>>>>> origin/pool
router.get('/api/live/status', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);

  const hls = services.getHlsStatus();
  res.json({
    poolId,
    running: isLiveRunning(),          // global live
    liveStartedAt: state.liveStartedAt, // global timestamp
    manifest: hls.hasManifest,
    segmentCount: hls.segmentCount,
<<<<<<< HEAD
    mode: state.currentMode,
    delaySec: state.delaySec,
    fragmentMode: state.fragment.active,
  });
});

=======

    // pool-specific settings:
    mode: ps.currentMode,
    delaySec: ps.delaySec,
    fragmentMode: ps.fragment.active,
    minSubtitlers: ps.minSubtitlersRequired,
  });
});

/** Start live (global FFmpeg/HLS) + start fragment mode for THIS pool */
>>>>>>> origin/pool
router.post('/api/live/start', async (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);

  try {
<<<<<<< HEAD
    const { source, mode = 'fragmentation', delaySec, slotDuration, requiredSubtitlers } = req.body;
=======
    const {
      source,
      mode = 'fragmentation',
      delaySec,
      slotDuration,
      overlapDuration,
      notifyBefore,
      gracePeriodPercent,
      requiredSubtitlers,
    } = req.body;

>>>>>>> origin/pool
    if (!source) return res.status(400).json({ error: 'Source required' });
    const mediaPath = services.resolveMediaPath(source);
    if (!fs.existsSync(mediaPath)) return res.status(400).json({ error: 'File not found' });

<<<<<<< HEAD
    if (typeof delaySec === 'number') state.delaySec = delaySec;
    if (typeof slotDuration === 'number') state.fragment.slotDuration = slotDuration;
    if (typeof requiredSubtitlers === 'number') state.fragment.requiredSubtitlers = requiredSubtitlers;

    state.currentMode = mode;
=======
    // Apply settings to THIS pool
    if (typeof delaySec === 'number') ps.delaySec = delaySec;

    const { fragment: f } = ps;
    if (typeof slotDuration === 'number') f.slotDuration = slotDuration;
    if (typeof overlapDuration === 'number') f.overlapDuration = overlapDuration;
    if (typeof notifyBefore === 'number') f.notifyBefore = notifyBefore;
    if (typeof gracePeriodPercent === 'number') f.gracePeriodPercent = gracePeriodPercent;
    if (typeof requiredSubtitlers === 'number') f.requiredSubtitlers = requiredSubtitlers;

    // Validate fragment config for THIS pool
    const validation = services.validateFragmentConfig(f.requiredSubtitlers, ps);
    if (!validation.ok) {
      return res.status(400).json({ error: validation.error });
    }

    const minDelay = services.getMinSpectatorDelaySec(ps);
    if (typeof ps.delaySec === 'number' && ps.delaySec < minDelay) {
      return res.status(400).json({ error: `Delay too small for fragment config. Minimum is ${minDelay}s.` });
    }

    ps.currentMode = mode;

    // Check subtitlers for THIS pool
    const subtitlerCount = services.getActiveSubtitlers(ps).length;
    if (mode === 'fragmentation' && subtitlerCount < f.requiredSubtitlers) {
      return res.status(400).json({
        error: `Need ${f.requiredSubtitlers} subtitlers (have ${subtitlerCount})`,
      });
    }

    // Start global live (FFmpeg/HLS)
>>>>>>> origin/pool
    await services.startLive(mediaPath);
    if (mode === 'fragmentation') services.startFragmentMode();

<<<<<<< HEAD
    res.json({ ok: true });
=======
    // Start fragment mode ONLY for this pool
    if (mode === 'fragmentation') {
      services.startFragmentMode(ps);
    }

    log.info('API', `Live started: ${source} (pool=${poolId}, mode=${mode})`);
    res.json({ ok: true, poolId, mode });
>>>>>>> origin/pool
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

<<<<<<< HEAD
=======
/** Stop live (global stop) */
>>>>>>> origin/pool
router.post('/api/live/stop', (req, res) => {
  services.stopLive();
  res.json({ ok: true });
});

<<<<<<< HEAD
router.get('/api/fragment/config', (req, res) => {
  const { fragment: f } = state;
  res.json({ slotDuration: f.slotDuration, active: f.active });
});

router.get('/api/fragment/status', (req, res) => {
  const { fragment: f } = state;
=======
// ═══════════════════════════════════════════════════════════════════════════════
// FRAGMENT MODE (POOL-AWARE)
// ═══════════════════════════════════════════════════════════════════════════════

/** Get fragment config (pool-aware) */
router.get('/api/fragment/config', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);
  const { fragment: f } = ps;

  res.json({
    poolId,
    slotDuration: f.slotDuration,
    overlapDuration: f.overlapDuration,
    notifyBefore: f.notifyBefore,
    active: f.active,
    subtitlerCount: services.getActiveSubtitlers(ps).length,
  });
});

/** Set fragment config (pool-aware) */
router.post('/api/fragment/config', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);
  const { slotDuration, overlapDuration, notifyBefore, gracePeriodPercent, requiredSubtitlers } = req.body;
  const { fragment: f } = ps;

  if (typeof slotDuration === 'number' && slotDuration >= 1) f.slotDuration = slotDuration;
  if (typeof overlapDuration === 'number' && overlapDuration >= 0) f.overlapDuration = overlapDuration;
  if (typeof notifyBefore === 'number' && notifyBefore >= 0) f.notifyBefore = notifyBefore;
  if (typeof gracePeriodPercent === 'number' && gracePeriodPercent >= 0 && gracePeriodPercent <= 100) f.gracePeriodPercent = gracePeriodPercent;
  if (typeof requiredSubtitlers === 'number' && requiredSubtitlers >= 1 && requiredSubtitlers <= 10) f.requiredSubtitlers = requiredSubtitlers;

  const validation = services.validateFragmentConfig(f.requiredSubtitlers, ps);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  res.json({ ok: true, poolId });
});

/** Get fragment status (pool-aware) */
router.get('/api/fragment/status', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);
  const { fragment: f } = ps;

  const active = services.getActiveSubtitlers(ps);
  const current = services.getCurrentSubtitler(ps);

  const latestSlot = f.captionsBySlot.length ? f.captionsBySlot[f.captionsBySlot.length - 1] : null;
  const baseStart = latestSlot?.startTime || f.slotStartTime;
  const elapsed = baseStart ? Math.floor((Date.now() - baseStart) / 1000) : 0;

>>>>>>> origin/pool
  res.json({
    poolId,
    active: f.active,
    fusedCaptionsCount: f.fusedCaptions.length,
    currentSlotIndex: f.currentSlotIndex
  });
});

<<<<<<< HEAD
// ═══════════════════════════════════════════════════════════════════════════════
// HLS & AUTH
// ═══════════════════════════════════════════════════════════════════════════════

=======
/** Start fragment mode (pool-aware) */
router.post('/api/fragment/start', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);

  if (!isLiveRunning()) {
    return res.status(400).json({ error: 'Live not running' });
  }

  const validation = services.validateFragmentConfig(ps.fragment.requiredSubtitlers, ps);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }

  services.startFragmentMode(ps);
  res.json({ ok: true, poolId });
});

/** Stop fragment mode (pool-aware) */
router.post('/api/fragment/stop', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);
  services.stopFragmentMode(ps);
  res.json({ ok: true, poolId });
});

/** Get raw captions by slot (pool-aware) */
router.get('/api/fragment/raw-captions', (req, res) => {
  const ps = getPoolState(req);
  res.json({ poolId: ps.poolId || getPoolId(req), slots: ps.fragment.captionsBySlot });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HLS ROUTES (GLOBAL, but delayed uses pool delay if provided)
// ═══════════════════════════════════════════════════════════════════════════════

const HLS_HEADERS = {
  'Content-Type': 'application/vnd.apple.mpegurl',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
};

/** Live playlist (global) */
>>>>>>> origin/pool
router.get('/hls/live.m3u8', (req, res) => {
  const { content, error } = services.getLivePlaylist();
  if (error) return res.status(404).send(error);
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl' }).send(content);
});

<<<<<<< HEAD
=======
/** Delayed playlist (global manifest, but uses pool delaySec if poolId provided) */
router.get('/hls/delayed.m3u8', (req, res) => {
  const ps = getPoolState(req);
  const { content, error } = services.getDelayedPlaylist(ps.delaySec);
  if (error) return res.status(404).send(error);
  res.set(HLS_HEADERS).send(content);
});

/** Serve HLS segments (global) */
router.use(
  '/hls',
  express.static(config.hls, {
    setHeaders: (res, filePath) => {
      if (filePath.endsWith('.ts')) {
        res.set('Content-Type', 'video/MP2T');
        res.set('Cache-Control', 'public, max-age=31536000');
      }
    },
  })
);

// ═══════════════════════════════════════════════════════════════════════════════
// AUTH (unchanged)
// ═══════════════════════════════════════════════════════════════════════════════

function isValidEmail(email) {
  return typeof email === 'string' && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim());
}

>>>>>>> origin/pool
router.post('/api/auth/signup', async (req, res) => {
  // ... (Your signup logic remains the same)
  res.json({ ok: true });
});

router.post('/api/auth/login', async (req, res) => {
  // ... (Your login logic remains the same)
  res.json({ ok: true });
});

<<<<<<< HEAD
// ═══════════════════════════════════════════════════════════════════════════════
// MSA + DICTIONARY EXPORT
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/api/fragment/export', (req, res) => {
  const { fragment: f } = state;
  
  if (!f.fusedCaptions || f.fusedCaptions.length === 0) {
    return res.status(404).json({ error: 'No subtitles found. Run the k6 test first!' });
  }

  const content = f.fusedCaptions.map(c => {
    const timestamp = new Date(c.videoTimestamp).toISOString().slice(14, 22);
    return `[${timestamp}] ${c.text}`;
  }).join('\n');

  res.setHeader('Content-Type', 'text/plain');
  res.setHeader('Content-Disposition', 'attachment; filename=subtitles_final.txt');
  res.send(content);
});

export default router;
=======
export default router;
>>>>>>> origin/pool
