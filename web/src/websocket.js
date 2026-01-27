/**
 * ROLE — WebSocket realtime hub (`/ws`)
 *
 * Multi-pool behavior:
 * - Each client is attached to a poolId (default: "default")
 * - Fragment status is broadcast per pool (services.broadcastFragmentStatus(poolId))
 *
 * This file is now fully pool-aware and stops mixing "default" and other pools.
 */

import { WebSocketServer } from 'ws';
import jwt from 'jsonwebtoken';

import { state, log, isLiveRunning, getLiveTimestamp, getSession, config } from './core.js';
import * as services from './services.js';

/**
 * Initialize the WebSocket server on an existing HTTP server
 * @param {http.Server} server - HTTP server instance
 * @returns {WebSocketServer} WebSocket server instance
 */
export function createWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });

  wss.on('connection', (ws) => {
    ws.odId = services.generateUUID();
    ws.clientType = null;
    ws.subtitlerName = null;

    // Default pool until identify() arrives (legacy clients)
    ws.poolId = 'default';

    services.addClient(ws);
    log.info('WS', `Client connected: ${ws.odId}`);

    // Send initial init (legacy-safe) based on default pool
    sendInit(ws);

    ws.on('message', (data) => handleMessage(ws, data));

    ws.on('close', () => {
      services.removeClient(ws);

      // Remove from subtitlers for THIS pool only
      const session = getSession(ws.poolId);
      if (ws.clientType === 'subtitler' && session.fragment.subtitlers.has(ws.odId)) {
        session.fragment.subtitlers.delete(ws.odId);
        services.broadcastFragmentStatus(ws.poolId);
        log.info('WS', `Subtitler left: ${ws.subtitlerName || 'unknown'} (pool=${ws.poolId})`);
      }

      log.info('WS', `Client disconnected: ${ws.odId} (pool=${ws.poolId})`);
    });

    ws.on('error', (err) => {
      log.error('WS', `Error (${ws.odId}): ${err?.message || err}`);
    });
  });

  // Broadcast fragment status periodically for ALL pools.
  // services.broadcastFragmentStatus() with no args => all pools
  setInterval(() => {
    services.broadcastFragmentStatus();
  }, 1000);

  log.info('WS', 'WebSocket server ready');
  return wss;
}

function sendInit(ws) {
  const s = getSession(ws.poolId || 'default');

  services.send(ws, {
    type: 'init',
    odId: ws.odId,
    running: isLiveRunning(),
    delaySec: state.delaySec,
    mode: state.currentMode,
    fragmentMode: !!s.fragment.active,
    poolId: ws.poolId || 'default',
  });
}

/**
 * Handle incoming WebSocket message
 * @param {WebSocket} ws - Client connection
 * @param {Buffer} data - Raw message data
 */
function handleMessage(ws, data) {
  let msg;
  try {
    msg = JSON.parse(data.toString());
  } catch {
    log.error('WS', 'Invalid JSON');
    return;
  }

  switch (msg.type) {
    case 'identify':
      handleIdentify(ws, msg);
      break;

    case 'fragment:join':
      handleFragmentJoin(ws, msg);
      break;

    case 'fragment:leave':
      handleFragmentLeave(ws);
      break;

    case 'caption':
      handleCaption(ws, msg);
      break;

    default:
      log.debug('WS', `Unknown message type: ${msg.type}`);
  }
}

/**
 * Handle client identification
 * msg.poolId optional => 'default'
 */
function handleIdentify(ws, msg) {
  const { clientType, name, token } = msg;

  const poolId =
    msg.poolId && typeof msg.poolId === 'string' && msg.poolId.trim()
      ? msg.poolId.trim()
      : 'default';

  if (!['admin', 'subtitler', 'spectator'].includes(clientType)) {
    log.warn('WS', `رفض identify: clientType غير صالح (${clientType}) odId=${ws.odId}`);
    return;
  }

  // Attach client to pool ASAP
  ws.poolId = poolId;
  getSession(ws.poolId); // ensure session exists

  // Re-send init for the real pool (important for UI consistency)
  sendInit(ws);

  if (clientType === 'subtitler') {
    // Subtitlers MUST be authenticated
    if (!token || typeof token !== 'string') {
      log.warn('AUTH', `AUTH_REQUIRED subtitler odId=${ws.odId} pool=${ws.poolId}`);
      services.send(ws, { type: 'error', error: 'AUTH_REQUIRED', poolId: ws.poolId });
      return;
    }

    try {
      const payload = jwt.verify(token, config.jwtSecret);

      if (payload.role !== 'subtitler') {
        log.warn(
          'AUTH',
          `INVALID_ROLE subtitler odId=${ws.odId} role=${payload.role} pool=${ws.poolId}`
        );
        services.send(ws, { type: 'error', error: 'INVALID_ROLE', poolId: ws.poolId });
        return;
      }

      ws.clientType = 'subtitler';
      ws.user = { id: payload.sub, email: payload.email, name: payload.name };
      ws.subtitlerName = payload.name || name || 'Anonymous';

      log.info('WS', `Identified: subtitler (${ws.subtitlerName}) (pool=${ws.poolId})`);

      // Auto-join fragment membership list for this pool
      handleFragmentJoin(ws, { name: ws.subtitlerName });

      // Immediately push pool status so admin sees them
      services.broadcastFragmentStatus(ws.poolId);
      return;
    } catch (e) {
      log.warn('AUTH', `INVALID_TOKEN subtitler odId=${ws.odId} pool=${ws.poolId} err=${e?.message}`);
      services.send(ws, { type: 'error', error: 'INVALID_TOKEN', poolId: ws.poolId });
      return;
    }
  }

  // Admin / spectator
  ws.clientType = clientType;
  if (name) ws.subtitlerName = name;

  log.info('WS', `Identified: ${clientType}${name ? ` (${name})` : ''} (pool=${ws.poolId})`);

  // If admin connects, push status right now (so admin page fills immediately)
  if (clientType === 'admin') {
    services.broadcastFragmentStatus(ws.poolId);
  }
}

/**
 * Handle a subtitler joining the fragment session (POOL-AWARE)
 */
function handleFragmentJoin(ws, msg) {
  const session = getSession(ws.poolId);

  const name = msg?.name || ws.subtitlerName || 'Anonymous';

  // Skip if already joined in this pool
  if (session.fragment.subtitlers.has(ws.odId)) return;

  session.fragment.subtitlers.set(ws.odId, {
    id: ws.odId,
    name,
    ws,
    joinedAt: Date.now(),
  });

  ws.subtitlerName = name;

  services.send(ws, {
    type: 'fragment:joined',
    odId: ws.odId,
    active: !!session.fragment.active,
    poolId: ws.poolId,
  });

  log.info('FRAGMENT', `Subtitler joined: ${name} (pool=${ws.poolId})`);

  // Broadcast status for THIS pool (admin-status + subtitler status)
  services.broadcastFragmentStatus(ws.poolId);

  // If fragment mode already active, scheduler will start when enough subtitlers.
  // (services.startFragmentScheduler is pool-aware)
  if (session.fragment.active) {
    services.startFragmentScheduler(session);
  }
}

/**
 * Handle a subtitler leaving the fragment session (POOL-AWARE)
 */
function handleFragmentLeave(ws) {
  const session = getSession(ws.poolId);

  if (!session.fragment.subtitlers.has(ws.odId)) return;

  const info = session.fragment.subtitlers.get(ws.odId);
  session.fragment.subtitlers.delete(ws.odId);

  log.info('FRAGMENT', `Subtitler left: ${info?.name || 'unknown'} (pool=${ws.poolId})`);

  services.broadcastFragmentStatus(ws.poolId);

  // Re-evaluate scheduler for this pool
  if (session.fragment.active) {
    services.startFragmentScheduler(session);
  }
}

/**
 * handleCaption - Process a caption sent by a subtitler
 * Fragment mode captions must be routed to the correct pool.
 */
function handleCaption(ws, msg) {
  const { text, subtitlerName, autoSent } = msg;
  if (!text || typeof text !== 'string') return;

  const poolId = ws.poolId || 'default';
  const session = getSession(poolId);

  const caption = {
    id: services.generateUUID(),
    text: text.trim().slice(0, 500),
    subtitlerName: subtitlerName || ws.subtitlerName || 'Anonymous',
    subtitlerId: ws.odId,
    createdAt: Date.now(),
    liveTimestamp: getLiveTimestamp(),
    autoSent: !!autoSent,
    poolId,
  };

  if (session.fragment.active) {
    // Pool-aware addCaptionToSlot (services.js uses caption.poolId / poolOrSession internally)
    const accepted = services.addCaptionToSlot(caption, session);

    if (accepted) {
      // broadcast to subtitlers in same pool, except sender
      services.broadcast(
        { type: 'caption', caption },
        (client) => client.clientType === 'subtitler' && client.poolId === poolId && client.odId !== ws.odId
      );
    }

    services.broadcastFragmentStatus(poolId);
  } else {
    // Non-fragment mode remains global captions history (legacy)
    state.captions.push(caption);

    // spectators in this pool only
    services.broadcast(
      {
        type: 'caption',
        caption,
        displayAt: Date.now() + state.delaySec * 1000,
      },
      (c) => c.clientType === 'spectator' && c.poolId === poolId
    );

    // admins in this pool only
    services.broadcastToAdminsInPool(poolId, { type: 'caption', caption });
  }

  log.debug('CAPTION', `From ${caption.subtitlerName}: "${caption.text.slice(0, 30)}..." (pool=${poolId})`);
}

export default { createWebSocketServer };
