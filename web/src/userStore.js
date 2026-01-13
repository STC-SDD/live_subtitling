// import fs from 'fs';
// import path from 'path';
// import * as XLSX from "xlsx";
// import { config } from './core.js';

// const SHEET = 'Users';
// const HEADERS = ['id', 'email', 'name', 'passwordHash', 'createdAt'];

// function ensureUsersFile() {
//   fs.mkdirSync(path.dirname(config.usersXlsxPath), { recursive: true });

//   if (fs.existsSync(config.usersXlsxPath)) return;

//   const wb = XLSX.utils.book_new();
//   const ws = XLSX.utils.aoa_to_sheet([HEADERS]);
//   XLSX.utils.book_append_sheet(wb, ws, SHEET);
//   XLSX.writeFile(wb, config.usersXlsxPath);
// }

// export function readUsers() {
//   ensureUsersFile();
//   const wb = XLSX.readFile(config.usersXlsxPath);
//   const ws = wb.Sheets[SHEET] || wb.Sheets[wb.SheetNames[0]];
//   const rows = XLSX.utils.sheet_to_json(ws, { defval: '' });

//   return rows.map(r => ({
//     id: String(r.id || ''),
//     email: String(r.email || '').toLowerCase().trim(),
//     name: String(r.name || '').trim(),
//     passwordHash: String(r.passwordHash || ''),
//     createdAt: Number(r.createdAt || 0),
//   }));
// }

// function writeUsers(users) {
//   ensureUsersFile();
//   const wb = XLSX.utils.book_new();
//   const data = [
//     HEADERS,
//     ...users.map(u => [u.id, u.email, u.name, u.passwordHash, u.createdAt]),
//   ];
//   const ws = XLSX.utils.aoa_to_sheet(data);
//   XLSX.utils.book_append_sheet(wb, ws, SHEET);
//   XLSX.writeFile(wb, config.usersXlsxPath);
// }

// export function findUserByEmail(email) {
//   const e = String(email || '').toLowerCase().trim();
//   return readUsers().find(u => u.email === e) || null;
// }

// export function addUser({ id, email, name, passwordHash }) {
//   const users = readUsers();
//   const e = String(email || '').toLowerCase().trim();

//   if (users.some(u => u.email === e)) {
//     const err = new Error('EMAIL_EXISTS');
//     err.code = 'EMAIL_EXISTS';
//     throw err;
//   }

//   const user = {
//     id,
//     email: e,
//     name: String(name || '').trim(),
//     passwordHash,
//     createdAt: Date.now(),
//   };

//   users.push(user);
//   writeUsers(users);
//   return user;
// }

import fs from 'fs';
import path from 'path';
import { config } from './core.js';

const HEADERS = ['id', 'email', 'name', 'passwordHash', 'createdAt'];

// CSV helpers (simple + safe enough for your use-case)
function csvEscape(value) {
    const s = String(value ?? '');
    if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
    return s;
}

function csvParseLine(line) {
    // Minimal RFC4180 parser (handles quotes)
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
    fs.mkdirSync(path.dirname(config.usersCsvPath), { recursive: true });

    if (!fs.existsSync(config.usersCsvPath)) {
        fs.writeFileSync(config.usersCsvPath, HEADERS.join(',') + '\n', 'utf8');
    }
}

export function readUsers() {
    ensureFile();
    const txt = fs.readFileSync(config.usersCsvPath, 'utf8');
    const lines = txt.split(/\r?\n/).filter(l => l.trim().length > 0);
    if (lines.length === 0) return [];

    const header = csvParseLine(lines[0]).map(h => h.trim());
    const idx = Object.fromEntries(header.map((h, i) => [h, i]));

    return lines.slice(1).map(line => {
        const cols = csvParseLine(line);
        return {
            id: String(cols[idx.id] ?? ''),
            email: String(cols[idx.email] ?? '').toLowerCase().trim(),
            name: String(cols[idx.name] ?? '').trim(),
            passwordHash: String(cols[idx.passwordHash] ?? ''),
            createdAt: Number(cols[idx.createdAt] ?? 0),
        };
    }).filter(u => u.email);
}

function writeUsers(users) {
    ensureFile();
    const rows = [];
    rows.push(HEADERS.join(','));
    for (const u of users) {
        rows.push([
            csvEscape(u.id),
            csvEscape(u.email),
            csvEscape(u.name),
            csvEscape(u.passwordHash),
            csvEscape(u.createdAt),
        ].join(','));
    }
    fs.writeFileSync(config.usersCsvPath, rows.join('\n') + '\n', 'utf8');
}

export function findUserByEmail(email) {
    const e = String(email || '').toLowerCase().trim();
    return readUsers().find(u => u.email === e) || null;
}

export function addUser({ id, email, name, passwordHash }) {
    const users = readUsers();
    const e = String(email || '').toLowerCase().trim();

    if (users.some(u => u.email === e)) {
        const err = new Error('EMAIL_EXISTS');
        err.code = 'EMAIL_EXISTS';
        throw err;
    }

    const user = {
        id: String(id),
        email: e,
        name: String(name || '').trim(),
        passwordHash: String(passwordHash || ''),
        createdAt: Date.now(),
    };

    users.push(user);
    writeUsers(users);
    return user;
}
