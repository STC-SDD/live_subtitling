/**
 * ROLE — Session storage (CSV-based)
 * 
 * Manages subtitling sessions:
 * - Create session with ID, title, video, config
 * - List active/past sessions
 * - Join session with ID
 */

import fs from 'fs';
import path from 'path';
import { config } from './core.js';

const HEADERS = ['id', 'title', 'videoPath', 'status', 'createdAt', 'startedAt', 'endedAt', 'createdBy', 'config'];

function csvEscape(value) {
  const s = String(value ?? '');
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function csvParseLine(line) {
  const out = [];
  let cur = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const c = line[i];
    if (inQuotes) {
      if (c === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += c;
      }
    } else {
      if (c === ',') {
        out.push(cur);
        cur = '';
      } else if (c === '"') {
        inQuotes = true;
      } else {
        cur += c;
      }
    }
  }
  out.push(cur);
  return out;
}

function ensureFile() {
  fs.mkdirSync(path.dirname(config.sessionsCsvPath), { recursive: true });
  if (!fs.existsSync(config.sessionsCsvPath)) {
    fs.writeFileSync(config.sessionsCsvPath, HEADERS.join(',') + '\n', 'utf8');
  }
}

export function readSessions() {
  ensureFile();
  const txt = fs.readFileSync(config.sessionsCsvPath, 'utf8');
  const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);
  if (lines.length === 0) return [];

  const header = csvParseLine(lines[0]).map(h => h.trim());
  const idx = Object.fromEntries(header.map((h, i) => [h, i]));

  return lines.slice(1).map(line => {
    const cols = csvParseLine(line);
    let configObj = {};
    try {
      configObj = JSON.parse(cols[idx.config] || '{}');
    } catch (e) {
      configObj = {};
    }

    return {
      id: String(cols[idx.id] ?? ''),
      title: String(cols[idx.title] ?? ''),
      videoPath: String(cols[idx.videoPath] ?? ''),
      status: String(cols[idx.status] ?? 'pending'), // pending, active, ended
      createdAt: Number(cols[idx.createdAt] ?? 0),
      startedAt: Number(cols[idx.startedAt] ?? 0),
      endedAt: Number(cols[idx.endedAt] ?? 0),
      createdBy: String(cols[idx.createdBy] ?? ''),
      config: configObj,
    };
  }).filter(s => s.id);
}

function writeSessions(sessions) {
  ensureFile();
  const rows = [HEADERS.join(',')];
  for (const s of sessions) {
    rows.push([
      csvEscape(s.id),
      csvEscape(s.title),
      csvEscape(s.videoPath),
      csvEscape(s.status),
      csvEscape(s.createdAt),
      csvEscape(s.startedAt || 0),
      csvEscape(s.endedAt || 0),
      csvEscape(s.createdBy),
      csvEscape(JSON.stringify(s.config || {})),
    ].join(','));
  }
  fs.writeFileSync(config.sessionsCsvPath, rows.join('\n') + '\n', 'utf8');
}

export function findSessionById(id) {
  return readSessions().find(s => s.id === id) || null;
}

export function createSession({ id, title, videoPath, createdBy, config }) {
  const sessions = readSessions();
  
  if (sessions.some(s => s.id === id)) {
    const err = new Error('SESSION_ID_EXISTS');
    err.code = 'SESSION_ID_EXISTS';
    throw err;
  }

  const session = {
    id: String(id),
    title: String(title || '').trim(),
    videoPath: String(videoPath || ''),
    status: 'pending',
    createdAt: Date.now(),
    startedAt: 0,
    endedAt: 0,
    createdBy: String(createdBy || ''),
    config: config || {},
  };

  sessions.push(session);
  writeSessions(sessions);
  return session;
}

export function updateSessionStatus(id, status, timestamp = Date.now()) {
  const sessions = readSessions();
  const session = sessions.find(s => s.id === id);
  
  if (!session) {
    throw new Error('SESSION_NOT_FOUND');
  }

  session.status = status;
  
  if (status === 'active') {
    session.startedAt = timestamp;
  } else if (status === 'ended') {
    session.endedAt = timestamp;
  }

  writeSessions(sessions);
  return session;
}

export function deleteSession(id) {
  const sessions = readSessions();
  const filtered = sessions.filter(s => s.id !== id);
  
  if (filtered.length === sessions.length) {
    throw new Error('SESSION_NOT_FOUND');
  }

  writeSessions(filtered);
  return true;
}

export function getActiveSessions() {
  return readSessions().filter(s => s.status === 'active');
}

export function getPendingSessions() {
  return readSessions().filter(s => s.status === 'pending');
}