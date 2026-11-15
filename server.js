const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const express = require('express');
const { WebSocketServer, WebSocket } = require('ws');

const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateCode(length = 6) {
  let code = '';
  const bytes = crypto.randomBytes(length);
  for (let i = 0; i < length; i++) {
    code += CODE_CHARS[bytes[i] % CODE_CHARS.length];
  }
  return code;
}

function getLocalIPs() {
  const interfaces = os.networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}

function createAppServer(options = {}) {
  const app = express();
  app.disable('x-powered-by');

  const publicDir = path.join(__dirname, 'public');
  app.use(express.static(publicDir, { etag: false, maxAge: 0 }));

  app.get('/vendor/qrcode.js', (_req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules/qrcode-generator/dist/qrcode.js'));
  });
  app.get('/vendor/jsQR.js', (_req, res) => {
    res.sendFile(path.join(__dirname, 'node_modules/jsqr/dist/jsQR.js'));
  });

  app.get('/health', (_req, res) => {
    res.json({ ok: true });
  });

  const isHttps = Boolean(options.httpsCert && options.httpsKey);
  const server = isHttps
    ? https.createServer(
        {
          cert: fs.readFileSync(options.httpsCert),
          key: fs.readFileSync(options.httpsKey),
        },
        app
      )
    : http.createServer(app);

  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });

  // Ephemeral in-memory rooms only; zero file storage.
  // Map<code, { receiver: WebSocket, senders: Map<string, WebSocket> }>
  const rooms = new Map();

  function safeSend(ws, payload) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(payload));
    }
  }

  function resolveShareOrigin(requestHost) {
    const proto = isHttps ? 'https' : 'http';
    const host = String(requestHost || '');
    const isLoopback =
      host.startsWith('localhost') ||
      host.startsWith('127.0.0.1') ||
      host.startsWith('[::1]');
    if (isLoopback) {
      const ips = getLocalIPs();
      const addr = server.address();
      const port = addr && typeof addr === 'object' ? addr.port : 3000;
      if (ips.length > 0) {
        return `${proto}://${ips[0]}:${port}`;
      }
    }
    return host ? `${proto}://${host}` : '';
  }

  function cleanupClient(ws) {
    if (ws.role === 'receiver' && ws.roomCode) {
      const room = rooms.get(ws.roomCode);
      if (room && room.receiver === ws) {
        for (const senderWs of room.senders.values()) {
          safeSend(senderWs, { type: 'room-closed' });
          senderWs.roomCode = null;
        }
        rooms.delete(ws.roomCode);
      }
    } else if (ws.role === 'sender' && ws.roomCode && ws.peerId) {
      const room = rooms.get(ws.roomCode);
      if (room && room.senders.has(ws.peerId)) {
        room.senders.delete(ws.peerId);
        safeSend(room.receiver, { type: 'peer-left', peerId: ws.peerId });
      }
    }
    ws.role = null;
    ws.roomCode = null;
  }

  wss.on('connection', (ws, req) => {
    ws.isAlive = true;
    ws.peerId = crypto.randomBytes(4).toString('hex');
    ws.requestHost = req?.headers?.host || '';

    ws.on('pong', () => {
      ws.isAlive = true;
    });

    ws.on('message', (raw, isBinary) => {
      // Pass-through binary chunks only when operating in fallback relay mode (never stored)
      if (isBinary) {
        if (ws.role === 'sender' && ws.roomCode) {
          const room = rooms.get(ws.roomCode);
          if (room && room.receiver.readyState === WebSocket.OPEN) {
            room.receiver.send(raw, { binary: true });
          }
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (!msg || typeof msg.type !== 'string') return;

      switch (msg.type) {
        case 'create-room': {
          cleanupClient(ws);
          let code = generateCode();
          while (rooms.has(code)) {
            code = generateCode();
          }
          rooms.set(code, { receiver: ws, senders: new Map() });
          ws.role = 'receiver';
          ws.roomCode = code;
          const shareOrigin = resolveShareOrigin(ws.requestHost);
          safeSend(ws, { type: 'room-created', code, shareOrigin });
          break;
        }

        case 'join-room': {
          cleanupClient(ws);
          const code = String(msg.code || '').trim().toUpperCase();
          const room = rooms.get(code);
          if (!room || room.receiver.readyState !== WebSocket.OPEN) {
            safeSend(ws, {
              type: 'error',
              message: `Kod sesi "${code}" tidak dijumpai atau sudah tamat.`,
            });
            return;
          }
          ws.role = 'sender';
          ws.roomCode = code;
          room.senders.set(ws.peerId, ws);
          safeSend(ws, { type: 'room-joined', code, peerId: ws.peerId });
          safeSend(room.receiver, { type: 'peer-joined', peerId: ws.peerId });
          break;
        }

        case 'offer': {
          if (ws.role !== 'sender' || !ws.roomCode) return;
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          safeSend(room.receiver, {
            type: 'offer',
            sdp: msg.sdp,
            peerId: ws.peerId,
          });
          break;
        }

        case 'answer': {
          if (ws.role !== 'receiver' || !ws.roomCode || !msg.peerId) return;
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          const senderWs = room.senders.get(msg.peerId);
          safeSend(senderWs, {
            type: 'answer',
            sdp: msg.sdp,
            peerId: msg.peerId,
          });
          break;
        }

        case 'ice-candidate': {
          if (!ws.roomCode || !msg.candidate) return;
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          if (ws.role === 'sender') {
            safeSend(room.receiver, {
              type: 'ice-candidate',
              candidate: msg.candidate,
              peerId: ws.peerId,
            });
          } else if (ws.role === 'receiver' && msg.peerId) {
            const senderWs = room.senders.get(msg.peerId);
            safeSend(senderWs, {
              type: 'ice-candidate',
              candidate: msg.candidate,
              peerId: msg.peerId,
            });
          }
          break;
        }

        case 'relay-ready': {
          if (!ws.roomCode) return;
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          if (ws.role === 'sender') {
            safeSend(room.receiver, { type: 'relay-ready', peerId: ws.peerId });
          } else if (ws.role === 'receiver' && msg.peerId) {
            const senderWs = room.senders.get(msg.peerId);
            safeSend(senderWs, { type: 'relay-ready' });
          }
          break;
        }

        case 'relay-ctrl': {
          if (ws.role !== 'sender' || !ws.roomCode) return;
          const room = rooms.get(ws.roomCode);
          if (!room) return;
          safeSend(room.receiver, { type: 'relay-ctrl', ctrl: msg.ctrl });
          break;
        }

        case 'leave': {
          cleanupClient(ws);
          break;
        }
      }
    });

    ws.on('close', () => {
      cleanupClient(ws);
    });
  });

  const heartbeat = setInterval(() => {
    for (const client of wss.clients) {
      if (!client.isAlive) {
        client.terminate();
        continue;
      }
      client.isAlive = false;
      client.ping();
    }
  }, 25000);
  heartbeat.unref();

  server.on('close', () => {
    clearInterval(heartbeat);
    wss.close();
  });

  wss.on('close', () => {
    clearInterval(heartbeat);
  });

  return { app, server, wss, rooms };
}

if (require.main === module) {
  const port = Number(process.env.PORT) || 3000;
  const httpsCert = process.env.SSL_CERT || '';
  const httpsKey = process.env.SSL_KEY || '';
  const { server } = createAppServer({ httpsCert, httpsKey });
  const proto = httpsCert && httpsKey ? 'https' : 'http';

  server.listen(port, '0.0.0.0', () => {
    console.log(`\nmydrop berjalan di:`);
    console.log(`  Local:   ${proto}://localhost:${port}`);
    for (const ip of getLocalIPs()) {
      console.log(`  Network: ${proto}://${ip}:${port}`);
    }
    console.log(`\nTiada fail disimpan di pelayan. Pemindahan terus antara pelayar.\n`);
  });
}

module.exports = { createAppServer, generateCode };
