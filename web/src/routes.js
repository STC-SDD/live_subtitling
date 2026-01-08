/**
 * ROLE — HTTP routes (REST API + HLS playlists)
 *
 * Defines everything served over HTTP:
 * - REST API under `/api/*` (start/stop live, delay, uploads, status...)
 * - HLS playlist endpoints:
 *   - `/hls/live.m3u8` (for subtitlers)
 *   - `/hls/delayed.m3u8` (for spectators)
 * - Static serving of HLS segments under `/hls/*.ts`
 */

import express from 'express';
import path from 'path';
import fs from 'fs';
import multer from 'multer';
import { config, state, log, isLiveRunning, getLiveTimestamp } from './core.js';
import * as services from './services.js';

const router = express.Router();

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

/** Get current config */
router.get('/api/config', (req, res) => {
  res.json({
    delaySec: state.delaySec,
    mode: state.currentMode,
    fragmentMode: state.fragment.active,
  });
});

/** Get/Set delay */
router.get('/api/delay', (req, res) => res.json({ delaySec: state.delaySec }));

router.post('/api/delay', (req, res) => {
  const { delaySec } = req.body;
  if (typeof delaySec !== 'number' || delaySec < 0 || delaySec > config.maxDelay) {
    return res.status(400).json({ error: `Invalid delay (0-${config.maxDelay})` });
  }

  const minDelay = services.getMinSpectatorDelaySec();
  if (delaySec < minDelay) {
    return res.status(400).json({ error: `Delay too small for current fragment config. Minimum is ${minDelay}s.` });
  }
  
  state.delaySec = delaySec;
  services.broadcast({ type: 'config', delaySec });
  log.info('API', `Delay set to ${delaySec}s`);
  res.json({ ok: true, delaySec });
});

/** List videos */
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

/** Upload video */
router.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  log.info('API', `Uploaded: ${req.file.filename}`);
  res.json({ ok: true, file: req.file.filename });
});

/** Get captions */
router.get('/api/captions', (req, res) => {
  const since = parseInt(req.query.since, 10) || 0;
  const captions = state.captions.filter(c => c.createdAt > since);
  res.json({ captions });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE CONTROL
// ═══════════════════════════════════════════════════════════════════════════════

/** Get live status */
router.get('/api/live/status', (req, res) => {
  const hls = services.getHlsStatus();
  res.json({
    running: isLiveRunning(),
    liveStartedAt: state.liveStartedAt,
    manifest: hls.hasManifest,
    segmentCount: hls.segmentCount,
    mode: state.currentMode,
    delaySec: state.delaySec,
    fragmentMode: state.fragment.active,
    minSubtitlers: state.minSubtitlersRequired,
  });
});

/** Start live */
router.post('/api/live/start', async (req, res) => {
  try {
    const { source, mode = 'fragmentation', delaySec, slotDuration, overlapDuration, notifyBefore, gracePeriodPercent, requiredSubtitlers } = req.body;
    
    if (!source) return res.status(400).json({ error: 'Source required' });
    
    const mediaPath = services.resolveMediaPath(source);
    if (!fs.existsSync(mediaPath)) {
      return res.status(400).json({ error: 'File not found' });
    }
    
    // Apply settings
    if (typeof delaySec === 'number') state.delaySec = delaySec;
    
      // Fragment config
    const { fragment: f } = state;
    if (typeof slotDuration === 'number') f.slotDuration = slotDuration;
    if (typeof overlapDuration === 'number') f.overlapDuration = overlapDuration;
    if (typeof notifyBefore === 'number') f.notifyBefore = notifyBefore;
    if (typeof gracePeriodPercent === 'number') f.gracePeriodPercent = gracePeriodPercent;
    if (typeof requiredSubtitlers === 'number') f.requiredSubtitlers = requiredSubtitlers;

      // Validate that the chosen parameters can actually support overlapping slots
      const validation = services.validateFragmentConfig(f.requiredSubtitlers);
      if (!validation.ok) {
        return res.status(400).json({ error: validation.error });
      }

      const minDelay = services.getMinSpectatorDelaySec();
      if (typeof state.delaySec === 'number' && state.delaySec < minDelay) {
        return res.status(400).json({ error: `Delay too small for fragment config. Minimum is ${minDelay}s.` });
      }
    
    state.currentMode = mode;
    
    // Check subtitler count for fragment mode
    const subtitlerCount = services.getActiveSubtitlers().length;
    if (mode === 'fragmentation' && subtitlerCount < f.requiredSubtitlers) {
      return res.status(400).json({ 
        error: `Need ${f.requiredSubtitlers} subtitlers (have ${subtitlerCount})` 
      });
    }
    
    await services.startLive(mediaPath);
    
    // Auto-start fragment mode
    if (mode === 'fragmentation') {
      services.startFragmentMode();
    }
    
    log.info('API', `Live started: ${source}`);
    res.json({ ok: true, mode });
  } catch (e) {
    log.error('API', 'Start failed:', e.message);
    res.status(500).json({ error: e.message });
  }
});

/** Stop live */
router.post('/api/live/stop', (req, res) => {
  services.stopLive();
  res.json({ ok: true });
});

// ═══════════════════════════════════════════════════════════════════════════════
// FRAGMENT MODE
// ═══════════════════════════════════════════════════════════════════════════════

/** Get fragment config */
router.get('/api/fragment/config', (req, res) => {
  const { fragment: f } = state;
  res.json({
    slotDuration: f.slotDuration,
    overlapDuration: f.overlapDuration,
    notifyBefore: f.notifyBefore,
    active: f.active,
    subtitlerCount: services.getActiveSubtitlers().length,
  });
});

/** Set fragment config */
router.post('/api/fragment/config', (req, res) => {
  const { slotDuration, overlapDuration, notifyBefore, gracePeriodPercent, requiredSubtitlers } = req.body;
  const { fragment: f } = state;
  
  // Allow short slots for testing (e.g. 6s)
  if (typeof slotDuration === 'number' && slotDuration >= 1) f.slotDuration = slotDuration;
  if (typeof overlapDuration === 'number' && overlapDuration >= 0) f.overlapDuration = overlapDuration;
  if (typeof notifyBefore === 'number' && notifyBefore >= 0) f.notifyBefore = notifyBefore;
  if (typeof gracePeriodPercent === 'number' && gracePeriodPercent >= 0 && gracePeriodPercent <= 100) f.gracePeriodPercent = gracePeriodPercent;
  if (typeof requiredSubtitlers === 'number' && requiredSubtitlers >= 1 && requiredSubtitlers <= 10) f.requiredSubtitlers = requiredSubtitlers;

  const validation = services.validateFragmentConfig(f.requiredSubtitlers);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  
  res.json({ ok: true });
});

/** Get fragment status */
router.get('/api/fragment/status', (req, res) => {
  const { fragment: f } = state;
  const active = services.getActiveSubtitlers();
  const current = services.getCurrentSubtitler();

  const latestSlot = f.captionsBySlot.length ? f.captionsBySlot[f.captionsBySlot.length - 1] : null;
  const baseStart = latestSlot?.startTime || f.slotStartTime;
  const elapsed = baseStart ? Math.floor((Date.now() - baseStart) / 1000) : 0;
  
  res.json({
    active: f.active,
    slotDuration: f.slotDuration,
    currentSlotIndex: f.currentSlotIndex,
    currentSubtitlerId: current?.id,
    currentSubtitlerName: current?.name,
    secondsRemaining: Math.max(0, f.slotDuration - elapsed),
    subtitlerCount: active.length,
    subtitlers: active.map(s => ({ id: s.id, name: s.name })),
    rawCaptionsCount: f.captionsBySlot.reduce((n, s) => n + s.captions.length, 0),
    fusedCaptionsCount: f.fusedCaptions.length,
  });
});

/** Start fragment mode */
router.post('/api/fragment/start', (req, res) => {
  if (!isLiveRunning()) {
    return res.status(400).json({ error: 'Live not running' });
  }

  const validation = services.validateFragmentConfig(state.fragment.requiredSubtitlers);
  if (!validation.ok) {
    return res.status(400).json({ error: validation.error });
  }
  services.startFragmentMode();
  res.json({ ok: true });
});

/** Stop fragment mode */
router.post('/api/fragment/stop', (req, res) => {
  services.stopFragmentMode();
  res.json({ ok: true });
});

/** Get raw captions by slot */
router.get('/api/fragment/raw-captions', (req, res) => {
  res.json({ slots: state.fragment.captionsBySlot });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HLS ROUTES
// ═══════════════════════════════════════════════════════════════════════════════

const HLS_HEADERS = {
  'Content-Type': 'application/vnd.apple.mpegurl',
  'Cache-Control': 'no-cache, no-store, must-revalidate',
};

/** Live playlist */
router.get('/hls/live.m3u8', (req, res) => {
  const { content, error } = services.getLivePlaylist();
  if (error) return res.status(404).send(error);
  res.set(HLS_HEADERS).send(content);
});

/** Delayed playlist */
router.get('/hls/delayed.m3u8', (req, res) => {
  const { content, error } = services.getDelayedPlaylist(state.delaySec);
  if (error) return res.status(404).send(error);
  res.set(HLS_HEADERS).send(content);
});

/** Serve HLS segments */
router.use('/hls', express.static(config.hls, {
  setHeaders: (res, filePath) => {
    if (filePath.endsWith('.ts')) {
      res.set('Content-Type', 'video/MP2T');
      res.set('Cache-Control', 'public, max-age=31536000');
    }
  },
}));

export default router;
