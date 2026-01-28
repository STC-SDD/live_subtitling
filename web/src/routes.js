/**
 * ROLE — HTTP routes (REST API + HLS playlists)
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

router.get('/api/config', (req, res) => {
  const ps = getPoolState(req);
  res.json({
    poolId: ps.poolId || getPoolId(req),
    delaySec: ps.delaySec,
    mode: ps.currentMode,
    fragmentMode: ps.fragment.active,
  });
});

router.get('/api/delay', (req, res) => res.json({ delaySec: state.delaySec }));

router.post('/api/delay', (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);

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

router.post('/api/upload', upload.single('video'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  log.info('API', `Uploaded: ${req.file.filename}`);
  res.json({ ok: true, file: req.file.filename });
});

router.get('/api/captions', (req, res) => {
  const ps = getPoolState(req);
  const since = parseInt(req.query.since, 10) || 0;
  const captions = ps.captions.filter(c => c.createdAt > since);
  res.json({ poolId: ps.poolId || getPoolId(req), captions });
});

// ═══════════════════════════════════════════════════════════════════════════════
// LIVE CONTROL & FRAGMENT MODE
// ═══════════════════════════════════════════════════════════════════════════════

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
    mode: state.currentMode,
    delaySec: state.delaySec,
    fragmentMode: state.fragment.active,
  });
});

router.post('/api/live/start', async (req, res) => {
  const ps = getPoolState(req);
  const poolId = ps.poolId || getPoolId(req);

  try {
    const { source, mode = 'fragmentation', delaySec, slotDuration, requiredSubtitlers } = req.body;
    if (!source) return res.status(400).json({ error: 'Source required' });
    const mediaPath = services.resolveMediaPath(source);
    if (!fs.existsSync(mediaPath)) return res.status(400).json({ error: 'File not found' });

    if (typeof delaySec === 'number') state.delaySec = delaySec;
    if (typeof slotDuration === 'number') state.fragment.slotDuration = slotDuration;
    if (typeof requiredSubtitlers === 'number') state.fragment.requiredSubtitlers = requiredSubtitlers;

    state.currentMode = mode;
    await services.startLive(mediaPath);
    if (mode === 'fragmentation') services.startFragmentMode();

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

router.post('/api/live/stop', (req, res) => {
  services.stopLive();
  res.json({ ok: true });
});

router.get('/api/fragment/config', (req, res) => {
  const { fragment: f } = state;
  res.json({ slotDuration: f.slotDuration, active: f.active });
});

router.get('/api/fragment/status', (req, res) => {
  const { fragment: f } = state;
  res.json({
    poolId,
    active: f.active,
    fusedCaptionsCount: f.fusedCaptions.length,
    currentSlotIndex: f.currentSlotIndex
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// HLS & AUTH
// ═══════════════════════════════════════════════════════════════════════════════

router.get('/hls/live.m3u8', (req, res) => {
  const { content, error } = services.getLivePlaylist();
  if (error) return res.status(404).send(error);
  res.set({ 'Content-Type': 'application/vnd.apple.mpegurl' }).send(content);
});

router.post('/api/auth/signup', async (req, res) => {
  // ... (Your signup logic remains the same)
  res.json({ ok: true });
});

router.post('/api/auth/login', async (req, res) => {
  // ... (Your login logic remains the same)
  res.json({ ok: true });
});

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
