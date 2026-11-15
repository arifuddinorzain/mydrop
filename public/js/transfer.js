(function (global) {
  const CHUNK_SIZE = 64 * 1024; // 64 KB chunks
  const HIGH_WATER_MARK = 1024 * 1024; // 1 MB
  const LOW_WATER_MARK = 256 * 1024; // 256 KB
  const P2P_TIMEOUT_MS = 4500;
  const PEERJS_CONNECT_TIMEOUT_MS = 12000;
  const PEER_PREFIX = 'mydrop-v1-';
  const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

  const RTC_CONFIG = {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
    ],
  };

  function randomCode(length = 6) {
    const bytes = new Uint8Array(length);
    crypto.getRandomValues(bytes);
    let out = '';
    for (let i = 0; i < length; i++) {
      out += CODE_CHARS[bytes[i] % CODE_CHARS.length];
    }
    return out;
  }

  async function hasLocalSignalingServer() {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 1200);
    try {
      const res = await fetch('/health', { cache: 'no-store', signal: controller.signal });
      if (!res.ok) return false;
      const json = await res.json().catch(() => null);
      return Boolean(json && json.ok === true);
    } catch {
      return false;
    } finally {
      clearTimeout(timer);
    }
  }

  class MyDropSession {
    constructor(callbacks = {}) {
      this.cb = callbacks;
      this.backend = 'ws'; // 'ws' (local server) or 'peerjs' (static/Vercel)
      this.ws = null;
      this.pc = null;
      this.dc = null;
      this.peer = null;
      this.peerConn = null;
      this.role = null;
      this.code = null;
      this.activePeerId = null;
      this.pendingCandidates = [];
      this.remoteDescSet = false;
      this.closed = false;
      this.connected = false;
      this.mode = 'p2p'; // 'p2p' or 'relay'
      this.p2pTimer = null;
      this.peerConnectTimer = null;
      this.rxChain = Promise.resolve();

      // Receiver-side active incoming file state (RAM only)
      this.incoming = null;
      this.receivedUrls = [];
    }

    // ---------------- LOCAL WS BACKEND ----------------

    connectWebSocket() {
      return new Promise((resolve, reject) => {
        const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
        const ws = new WebSocket(`${proto}//${location.host}/ws`);
        ws.binaryType = 'arraybuffer';
        this.ws = ws;

        let settled = false;
        ws.onopen = () => {
          settled = true;
          resolve(ws);
        };
        ws.onerror = () => {
          if (!settled) {
            settled = true;
            reject(new Error('Gagal menyambung ke pelayan isyarat.'));
          }
        };
        ws.onmessage = (evt) => {
          this.handleSignalOrBinary(evt.data);
        };
        ws.onclose = () => {
          if (!this.closed) {
            this.clearTimers();
            this.cb.onDisconnected?.('Sambungan ke pelayan terputus.');
          }
        };
      });
    }

    sendSignal(payload) {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        this.ws.send(JSON.stringify(payload));
      }
    }

    clearTimers() {
      if (this.p2pTimer) {
        clearTimeout(this.p2pTimer);
        this.p2pTimer = null;
      }
      if (this.peerConnectTimer) {
        clearTimeout(this.peerConnectTimer);
        this.peerConnectTimer = null;
      }
    }

    markConnected(mode) {
      if (this.connected || this.closed) return;
      this.clearTimers();
      this.connected = true;
      this.mode = mode;
      this.cb.onConnected?.(mode);
    }

    activateRelayFallback() {
      if (this.closed || this.connected || this.backend !== 'ws') return;
      this.clearTimers();
      this.closePeer();
      this.mode = 'relay';
      if (this.role === 'sender') {
        this.sendSignal({ type: 'relay-ready' });
        this.markConnected('relay');
      }
    }

    // ---------------- PUBLIC ENTRYPOINTS ----------------

    async startReceiver() {
      this.role = 'receiver';
      const useLocal = await hasLocalSignalingServer();
      if (this.closed) return;

      if (useLocal) {
        this.backend = 'ws';
        await this.connectWebSocket();
        this.sendSignal({ type: 'create-room' });
      } else {
        this.backend = 'peerjs';
        await this.startPeerJsReceiver();
      }
    }

    async startSender(code) {
      this.role = 'sender';
      this.code = String(code || '').trim().toUpperCase();
      if (!this.code) {
        throw new Error('Kod sesi tidak sah.');
      }

      const useLocal = await hasLocalSignalingServer();
      if (this.closed) return;

      if (useLocal) {
        this.backend = 'ws';
        await this.connectWebSocket();
        this.sendSignal({ type: 'join-room', code: this.code });
      } else {
        this.backend = 'peerjs';
        await this.startPeerJsSender(this.code);
      }
    }

    // ---------------- PEERJS SERVERLESS BACKEND (VERCEL) ----------------

    startPeerJsReceiver(attempt = 0) {
      return new Promise((resolve, reject) => {
        if (typeof global.Peer !== 'function') {
          reject(new Error('Pustaka sambungan P2P tidak dimuatkan.'));
          return;
        }

        const code = randomCode(6);
        const peer = new global.Peer(`${PEER_PREFIX}${code}`, {
          debug: 0,
          config: RTC_CONFIG,
        });
        this.peer = peer;
        let opened = false;

        peer.on('open', () => {
          if (this.closed) return;
          opened = true;
          this.code = code;
          this.cb.onRoomCreated?.(code, location.origin);
          resolve();
        });

        peer.on('connection', (conn) => {
          if (this.closed) {
            try { conn.close(); } catch {}
            return;
          }
          this.attachPeerJsConnection(conn);
        });

        peer.on('error', (err) => {
          if (this.closed) return;
          if (!opened && err?.type === 'unavailable-id' && attempt < 3) {
            try { peer.destroy(); } catch {}
            this.startPeerJsReceiver(attempt + 1).then(resolve, reject);
            return;
          }
          const msg = err?.message || 'Ralat pelayan sambungan P2P.';
          if (!opened) {
            reject(new Error(msg));
          } else {
            this.cb.onError?.(msg);
          }
        });

        peer.on('disconnected', () => {
          if (!this.closed && !this.connected) {
            try { peer.reconnect(); } catch {}
          }
        });
      });
    }

    startPeerJsSender(code) {
      return new Promise((resolve, reject) => {
        if (typeof global.Peer !== 'function') {
          reject(new Error('Pustaka sambungan P2P tidak dimuatkan.'));
          return;
        }

        const peer = new global.Peer(undefined, {
          debug: 0,
          config: RTC_CONFIG,
        });
        this.peer = peer;
        let opened = false;

        peer.on('open', () => {
          if (this.closed) return;
          opened = true;
          const conn = peer.connect(`${PEER_PREFIX}${code}`, {
            reliable: true,
            serialization: 'raw',
          });
          this.attachPeerJsConnection(conn);

          this.peerConnectTimer = setTimeout(() => {
            if (!this.connected && !this.closed) {
              this.cb.onError?.('Sambungan P2P tamat masa. Pastikan kedua-dua peranti boleh guna WebRTC.');
            }
          }, PEERJS_CONNECT_TIMEOUT_MS);

          resolve();
        });

        peer.on('error', (err) => {
          if (this.closed) return;
          this.clearTimers();
          let msg = err?.message || 'Gagal menyambung P2P.';
          if (err?.type === 'peer-unavailable') {
            msg = `Kod sesi "${code}" tidak dijumpai atau sudah tamat.`;
          }
          if (!opened) {
            reject(new Error(msg));
          } else {
            this.cb.onError?.(msg);
          }
        });
      });
    }

    attachPeerJsConnection(conn) {
      this.peerConn = conn;

      conn.on('open', () => {
        if (this.closed) return;
        this.dc = conn.dataChannel || null;
        if (this.dc) {
          this.dc.binaryType = 'arraybuffer';
          this.dc.bufferedAmountLowThreshold = LOW_WATER_MARK;
        }
        this.markConnected('p2p');
      });

      conn.on('data', (data) => {
        this.rxChain = this.rxChain.then(() => this.handlePeerData(data)).catch(() => {});
      });

      conn.on('close', () => {
        if (!this.closed) {
          this.clearTimers();
          this.incoming = null;
          this.cb.onDisconnected?.('Sambungan P2P ditutup.');
        }
      });

      conn.on('error', (err) => {
        if (!this.closed) {
          this.clearTimers();
          this.cb.onError?.(err?.message || 'Ralat saluran pemindahan.');
        }
      });
    }

    async handlePeerData(data) {
      if (typeof data === 'string') {
        this.handleDataMessage(data);
        return;
      }
      if (data instanceof ArrayBuffer) {
        this.handleDataMessage(data);
        return;
      }
      if (ArrayBuffer.isView(data)) {
        const copy = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
        this.handleDataMessage(copy);
        return;
      }
      if (typeof Blob !== 'undefined' && data instanceof Blob) {
        const buf = await data.arrayBuffer();
        this.handleDataMessage(buf);
      }
    }

    // ---------------- LOCAL WEBRTC PEERCONNECTION ----------------

    createPeerConnection(peerId) {
      this.closePeer();
      this.activePeerId = peerId || null;
      this.pendingCandidates = [];
      this.remoteDescSet = false;

      if (typeof RTCPeerConnection === 'undefined') {
        return null;
      }

      const pc = new RTCPeerConnection(RTC_CONFIG);
      this.pc = pc;

      pc.onicecandidate = (event) => {
        if (event.candidate) {
          this.sendSignal({
            type: 'ice-candidate',
            candidate: event.candidate,
            peerId: this.activePeerId,
          });
        }
      };

      pc.onconnectionstatechange = () => {
        if (this.closed || this.mode === 'relay') return;
        const st = pc.connectionState;
        if (st === 'failed') {
          if (!this.connected && this.role === 'sender') {
            this.activateRelayFallback();
          } else if (this.connected) {
            this.cb.onDisconnected?.('Sambungan P2P terputus.');
          }
        } else if ((st === 'disconnected' || st === 'closed') && this.connected) {
          this.cb.onDisconnected?.('Sambungan P2P terputus.');
        }
      };

      if (this.role === 'receiver') {
        pc.ondatachannel = (event) => {
          this.setupDataChannel(event.channel);
        };
      }

      return pc;
    }

    setupDataChannel(dc) {
      this.dc = dc;
      dc.binaryType = 'arraybuffer';
      dc.bufferedAmountLowThreshold = LOW_WATER_MARK;

      dc.onopen = () => {
        this.markConnected('p2p');
      };

      dc.onclose = () => {
        if (!this.closed && this.mode === 'p2p' && this.connected) {
          this.incoming = null;
          this.cb.onDisconnected?.('Sesi pemindahan tamat.');
        }
      };

      dc.onerror = () => {
        if (this.closed || this.mode === 'relay') return;
        if (!this.connected && this.role === 'sender') {
          this.activateRelayFallback();
        } else if (this.connected) {
          this.cb.onError?.('Ralat saluran pemindahan.');
        }
      };

      dc.onmessage = (event) => {
        this.rxChain = this.rxChain.then(() => this.handlePeerData(event.data)).catch(() => {});
      };
    }

    async handleSignalOrBinary(data) {
      if (data instanceof ArrayBuffer) {
        if (this.mode === 'relay') {
          this.handleDataMessage(data);
        }
        return;
      }

      let msg;
      try {
        msg = JSON.parse(data);
      } catch {
        return;
      }

      try {
        switch (msg.type) {
          case 'room-created': {
            this.code = msg.code;
            this.cb.onRoomCreated?.(msg.code, msg.shareOrigin || '');
            break;
          }

          case 'room-joined': {
            this.code = msg.code;
            const pc = this.createPeerConnection(msg.peerId);
            if (!pc) {
              this.activateRelayFallback();
              return;
            }
            this.p2pTimer = setTimeout(() => {
              if (!this.connected && !this.closed) {
                this.activateRelayFallback();
              }
            }, P2P_TIMEOUT_MS);

            const dc = pc.createDataChannel('mydrop', { ordered: true });
            this.setupDataChannel(dc);
            const offer = await pc.createOffer();
            await pc.setLocalDescription(offer);
            this.sendSignal({ type: 'offer', sdp: pc.localDescription });
            break;
          }

          case 'peer-joined': {
            this.activePeerId = msg.peerId;
            break;
          }

          case 'offer': {
            if (this.role !== 'receiver') return;
            const pc = this.createPeerConnection(msg.peerId);
            if (!pc) return;
            await pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            this.remoteDescSet = true;
            await this.flushCandidates();
            const answer = await pc.createAnswer();
            await pc.setLocalDescription(answer);
            this.sendSignal({
              type: 'answer',
              sdp: pc.localDescription,
              peerId: msg.peerId,
            });
            break;
          }

          case 'answer': {
            if (this.role !== 'sender' || !this.pc || this.mode === 'relay') return;
            await this.pc.setRemoteDescription(new RTCSessionDescription(msg.sdp));
            this.remoteDescSet = true;
            await this.flushCandidates();
            break;
          }

          case 'ice-candidate': {
            if (!this.pc || !msg.candidate || this.mode === 'relay') return;
            const candidate = new RTCIceCandidate(msg.candidate);
            if (this.remoteDescSet) {
              await this.pc.addIceCandidate(candidate).catch(() => {});
            } else {
              this.pendingCandidates.push(candidate);
            }
            break;
          }

          case 'relay-ready': {
            if (this.role === 'receiver') {
              this.closePeer();
              this.markConnected('relay');
            }
            break;
          }

          case 'relay-ctrl': {
            if (this.mode === 'relay' && msg.ctrl) {
              this.handleControlMessage(msg.ctrl);
            }
            break;
          }

          case 'peer-left': {
            if (msg.peerId === this.activePeerId) {
              this.incoming = null;
              this.cb.onDisconnected?.('Penghantar telah memutuskan sambungan.');
            }
            break;
          }

          case 'room-closed': {
            this.cb.onDisconnected?.('Penerima telah menutup sesi.');
            break;
          }

          case 'error': {
            this.clearTimers();
            this.cb.onError?.(msg.message || 'Ralat sesi.');
            break;
          }
        }
      } catch (err) {
        if (!this.connected && this.role === 'sender') {
          this.activateRelayFallback();
        } else {
          this.cb.onError?.(err?.message || 'Ralat sambungan.');
        }
      }
    }

    async flushCandidates() {
      if (!this.pc) return;
      while (this.pendingCandidates.length > 0) {
        const candidate = this.pendingCandidates.shift();
        await this.pc.addIceCandidate(candidate).catch(() => {});
      }
    }

    // ---------------- SHARED DATA TRANSFER PROTOCOL ----------------

    handleControlMessage(ctrl) {
      if (ctrl.type === 'file-start') {
        this.incoming = {
          id: ctrl.id,
          name: ctrl.name || 'fail',
          size: Number(ctrl.size) || 0,
          mime: ctrl.mime || 'application/octet-stream',
          received: 0,
          chunks: [],
        };
        this.cb.onReceiveStart?.({
          id: this.incoming.id,
          name: this.incoming.name,
          size: this.incoming.size,
          mime: this.incoming.mime,
        });
      } else if (ctrl.type === 'file-end' && this.incoming && this.incoming.id === ctrl.id) {
        const item = this.incoming;
        this.incoming = null;
        const blob = new Blob(item.chunks, { type: item.mime });
        item.chunks = [];
        const blobUrl = URL.createObjectURL(blob);
        this.receivedUrls.push(blobUrl);
        this.cb.onReceiveComplete?.(
          { id: item.id, name: item.name, size: item.size, mime: item.mime },
          blobUrl
        );
      }
    }

    handleDataMessage(data) {
      if (typeof data === 'string') {
        let ctrl;
        try {
          ctrl = JSON.parse(data);
        } catch {
          return;
        }
        this.handleControlMessage(ctrl);
        return;
      }

      if (data instanceof ArrayBuffer && this.incoming) {
        this.incoming.chunks.push(data);
        this.incoming.received += data.byteLength;
        this.cb.onReceiveProgress?.(
          this.incoming.id,
          this.incoming.received,
          this.incoming.size
        );
      }
    }

    waitForDrain() {
      if (this.mode === 'relay') {
        return new Promise((resolve) => {
          if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount <= HIGH_WATER_MARK) {
            resolve();
            return;
          }
          const timer = setInterval(() => {
            if (!this.ws || this.ws.readyState !== WebSocket.OPEN || this.ws.bufferedAmount <= LOW_WATER_MARK) {
              clearInterval(timer);
              resolve();
            }
          }, 30);
        });
      }

      return new Promise((resolve) => {
        if (!this.dc || this.dc.readyState !== 'open' || this.dc.bufferedAmount <= HIGH_WATER_MARK) {
          resolve();
          return;
        }
        const onLow = () => {
          cleanup();
          resolve();
        };
        const timer = setInterval(() => {
          if (!this.dc || this.dc.readyState !== 'open' || this.dc.bufferedAmount <= LOW_WATER_MARK) {
            cleanup();
            resolve();
          }
        }, 50);
        const cleanup = () => {
          clearInterval(timer);
          this.dc?.removeEventListener('bufferedamountlow', onLow);
        };
        this.dc.addEventListener('bufferedamountlow', onLow, { once: true });
      });
    }

    isTransportOpen() {
      if (this.mode === 'relay') {
        return Boolean(this.ws && this.ws.readyState === WebSocket.OPEN);
      }
      if (this.backend === 'peerjs') {
        return Boolean(this.peerConn && this.peerConn.open);
      }
      return Boolean(this.dc && this.dc.readyState === 'open');
    }

    getBufferedAmount() {
      if (this.mode === 'relay') {
        return this.ws ? this.ws.bufferedAmount : 0;
      }
      return this.dc ? this.dc.bufferedAmount : 0;
    }

    sendControl(ctrl) {
      if (this.mode === 'relay') {
        this.sendSignal({ type: 'relay-ctrl', ctrl });
      } else if (this.dc && this.dc.readyState === 'open') {
        this.dc.send(JSON.stringify(ctrl));
      } else if (this.peerConn && this.peerConn.open) {
        this.peerConn.send(JSON.stringify(ctrl));
      }
    }

    sendBinary(buffer) {
      if (this.mode === 'relay') {
        this.ws.send(buffer);
      } else if (this.dc && this.dc.readyState === 'open') {
        this.dc.send(buffer);
      } else if (this.peerConn && this.peerConn.open) {
        this.peerConn.send(buffer);
      }
    }

    async sendFiles(items) {
      if (!this.isTransportOpen()) {
        throw new Error('Sambungan belum bersedia.');
      }

      for (const item of items) {
        if (this.closed || !this.isTransportOpen()) {
          throw new Error('Sambungan terputus semasa menghantar.');
        }

        const file = item.file;
        this.sendControl({
          type: 'file-start',
          id: item.id,
          name: file.name,
          size: file.size,
          mime: file.type || 'application/octet-stream',
        });

        let offset = 0;
        while (offset < file.size) {
          if (this.closed || !this.isTransportOpen()) {
            throw new Error('Sambungan terputus.');
          }
          if (this.getBufferedAmount() > HIGH_WATER_MARK) {
            await this.waitForDrain();
          }
          const slice = file.slice(offset, offset + CHUNK_SIZE);
          const buffer = await slice.arrayBuffer();
          this.sendBinary(buffer);
          offset += buffer.byteLength;
          this.cb.onSendProgress?.(item.id, offset, file.size);
        }

        if (file.size === 0) {
          this.cb.onSendProgress?.(item.id, 0, 0);
        }

        this.sendControl({ type: 'file-end', id: item.id });
        this.cb.onSendComplete?.(item.id);
      }
    }

    closePeer() {
      if (this.dc) {
        try { this.dc.close(); } catch {}
        this.dc = null;
      }
      if (this.pc) {
        try { this.pc.close(); } catch {}
        this.pc = null;
      }
    }

    close() {
      this.closed = true;
      this.clearTimers();
      this.incoming = null;
      this.sendSignal({ type: 'leave' });
      this.closePeer();
      if (this.peerConn) {
        try { this.peerConn.close(); } catch {}
        this.peerConn = null;
      }
      if (this.peer) {
        try { this.peer.destroy(); } catch {}
        this.peer = null;
      }
      if (this.ws) {
        try { this.ws.close(); } catch {}
        this.ws = null;
      }
      for (const url of this.receivedUrls) {
        try { URL.revokeObjectURL(url); } catch {}
      }
      this.receivedUrls = [];
    }
  }

  global.MyDropSession = MyDropSession;
})(window);
