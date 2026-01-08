/**
 * ROLE — WebSocket realtime hub (`/ws`)
 *
 * Manages realtime communications between browser clients and the server:
 * - Clients identify as: admin | subtitler | spectator
 * - Subtitlers join/leave the fragment session
 * - Subtitlers send captions; server validates and routes them
 * - Server periodically broadcasts fragment status to keep UIs in sync
 */

import { WebSocketServer } from 'ws';
import { state, log, isLiveRunning, getLiveTimestamp } from './core.js';
import * as services from './services.js';

/**
 * Initialize the WebSocket server on an existing HTTP server
 * @param {http.Server} server - HTTP server instance
 * @returns {WebSocketServer} WebSocket server instance
 */
export function createWebSocketServer(server) {
  const wss = new WebSocketServer({ server, path: '/ws' });
  
  wss.on('connection', (ws) => {
    // Assign unique ID
    ws.odId = services.generateUUID();
    ws.clientType = null;
    ws.subtitlerName = null;
    
    services.addClient(ws);
    log.info('WS', `Client connected: ${ws.odId}`);
    
    // Send initial state
    services.send(ws, {
      type: 'init',
      odId: ws.odId,
      running: isLiveRunning(),
      delaySec: state.delaySec,
      mode: state.currentMode,
      fragmentMode: state.fragment.active,
    });
    
    ws.on('message', (data) => handleMessage(ws, data));
    
    ws.on('close', () => {
      services.removeClient(ws);
      
      // Remove from subtitlers if applicable
      if (ws.clientType === 'subtitler' && state.fragment.subtitlers.has(ws.odId)) {
        state.fragment.subtitlers.delete(ws.odId);
        services.broadcastFragmentStatus();
        log.info('WS', `Subtitler left: ${ws.subtitlerName}`);
      }
      
      log.info('WS', `Client disconnected: ${ws.odId}`);
    });
    
    ws.on('error', (err) => {
      log.error('WS', `Error (${ws.odId}):`, err.message);
    });
  });
  
  // Fragment status broadcast (every second)
  setInterval(() => {
    if (state.fragment.active) {
      services.broadcastFragmentStatus();
    }
  }, 1000);
  
  log.info('WS', 'WebSocket server ready');
  return wss;
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
  } catch (e) {
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
 */
function handleIdentify(ws, msg) {
  const { clientType, name } = msg;
  
  if (!['admin', 'subtitler', 'spectator'].includes(clientType)) {
    return;
  }
  
  ws.clientType = clientType;
  if (name) ws.subtitlerName = name;
  
  log.info('WS', `Identified: ${clientType}${name ? ` (${name})` : ''}`);
  
  // Auto-join fragment session for subtitlers (if not already joined)
  if (clientType === 'subtitler' && name && !state.fragment.subtitlers.has(ws.odId)) {
    handleFragmentJoin(ws, { name });
  }
}

/**
 * Handle a subtitler joining the fragment session
 */
function handleFragmentJoin(ws, msg) {
  const name = msg.name || ws.subtitlerName || 'Anonymous';
  
  // Skip if already joined
  if (state.fragment.subtitlers.has(ws.odId)) {
    return;
  }
  
  // Add to subtitlers map
  state.fragment.subtitlers.set(ws.odId, {
    id: ws.odId,
    name,
    ws,
    joinedAt: Date.now(),
  });
  
  ws.subtitlerName = name;
  
  // Confirm join
  services.send(ws, {
    type: 'fragment:joined',
    odId: ws.odId,
    active: state.fragment.active,
  });
  
  log.info('FRAGMENT', `Subtitler joined: ${name}`);
  services.broadcastFragmentStatus();
  
  // Check if we can start fragment mode
  const activeCount = services.getActiveSubtitlers().length;
  if (state.fragment.active && activeCount >= state.fragment.requiredSubtitlers && !state.fragment.slotTimer) {
    services.startSlotTimer();
  }
}

/**
 * Handle a subtitler leaving the fragment session
 */
function handleFragmentLeave(ws) {
  if (state.fragment.subtitlers.has(ws.odId)) {
    const name = state.fragment.subtitlers.get(ws.odId).name;
    state.fragment.subtitlers.delete(ws.odId);
    log.info('FRAGMENT', `Subtitler left: ${name}`);
    services.broadcastFragmentStatus();
  }
}

/**
 * handleCaption - Process a caption sent by a subtitler
 *
 * IMPORTANT VALIDATION:
 * In fragment mode, a subtitler can submit only for their currently open slot
 * (their assigned slot, including its grace period). The server maps the sender
 * to the correct slot and rejects submissions outside the allowed window.
 *
 * FLOW:
 * 1. Validate text
 * 2. Build the caption object with subtitlerId (key for validation)
 * 3. Fragment mode: call addCaptionToSlot() which validates the turn
 * 4. Non-fragment mode: broadcast directly to spectators
 *
 * @param {WebSocket} ws - Subtitler connection
 * @param {Object} msg - Message containing { text, subtitlerName, autoSent }
 */
function handleCaption(ws, msg) {
  const { text, subtitlerName, autoSent } = msg;
  
  if (!text || typeof text !== 'string') return;
  
  const caption = {
    id: services.generateUUID(),
    text: text.trim().slice(0, 500),
    subtitlerName: subtitlerName || ws.subtitlerName || 'Anonymous',
    subtitlerId: ws.odId,  // Unique subtitler ID for validation
    createdAt: Date.now(),
    liveTimestamp: getLiveTimestamp(),
    autoSent: autoSent || false,
  };
  
  // Fragment mode: add to current slot (timestamp calculated by addCaptionToSlot)
  if (state.fragment.active) {
    const accepted = services.addCaptionToSlot(caption);
    
    if (accepted) {
      // Broadcast to OTHER subtitlers (exclude sender to avoid duplication)
      services.broadcast(
        { type: 'caption', caption },
        (client) => client.clientType === 'subtitler' && client.odId !== ws.odId
      );
    }
  } else {
    // Non-fragment mode: direct broadcast to spectators
    state.captions.push(caption);
    
    services.broadcast({
      type: 'caption',
      caption,
      displayAt: Date.now() + state.delaySec * 1000,
    }, (c) => c.clientType === 'spectator');
    
    services.broadcastToAdmins({
      type: 'caption',
      caption,
    });
  }
  
  log.debug('CAPTION', `From ${caption.subtitlerName}: "${caption.text.slice(0, 30)}..."`);
}

export default { createWebSocketServer };
