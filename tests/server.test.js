const test = require('node:test');
const assert = require('node:assert/strict');
const { WebSocket } = require('ws');
const qrcode = require('qrcode-generator');
const jsQR = require('jsqr');
const { createAppServer } = require('../server');

function nextMessage(ws) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('Timed out waiting for WS message')), 3000);
    ws.once('message', (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

function connectWs(port) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

test('mydrop server serves static assets, vendor libs, and WebSocket signaling', async (t) => {
  const { server, rooms } = createAppServer();
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();

  t.after(() => {
    server.close();
  });

  await t.test('HTTP routes return 200 OK', async () => {
    const paths = [
      '/',
      '/styles.css',
      '/js/transfer.js',
      '/js/app.js',
      '/vendor/qrcode.js',
      '/vendor/jsQR.js',
      '/health',
    ];
    for (const p of paths) {
      const res = await fetch(`http://127.0.0.1:${port}${p}`);
      assert.equal(res.status, 200, `Expected 200 for ${p}`);
    }
  });

  await t.test('Signaling relays offer, answer, ICE and cleans up on receiver close', async () => {
    const receiver = await connectWs(port);
    const sender = await connectWs(port);

    receiver.send(JSON.stringify({ type: 'create-room' }));
    const created = await nextMessage(receiver);
    assert.equal(created.type, 'room-created');
    assert.match(created.code, /^[A-Z0-9]{6}$/);
    assert.ok(typeof created.shareOrigin === 'string' && created.shareOrigin.startsWith('http'));
    assert.equal(rooms.size, 1);

    sender.send(JSON.stringify({ type: 'join-room', code: created.code.toLowerCase() }));
    const [joinedMsg, peerJoinedMsg] = await Promise.all([
      nextMessage(sender),
      nextMessage(receiver),
    ]);
    assert.equal(joinedMsg.type, 'room-joined');
    assert.equal(joinedMsg.code, created.code);
    assert.equal(peerJoinedMsg.type, 'peer-joined');
    assert.equal(peerJoinedMsg.peerId, joinedMsg.peerId);

    sender.send(JSON.stringify({ type: 'offer', sdp: { type: 'offer', sdp: 'dummy-offer' } }));
    const offerMsg = await nextMessage(receiver);
    assert.equal(offerMsg.type, 'offer');
    assert.equal(offerMsg.sdp.sdp, 'dummy-offer');

    receiver.send(
      JSON.stringify({
        type: 'answer',
        peerId: offerMsg.peerId,
        sdp: { type: 'answer', sdp: 'dummy-answer' },
      })
    );
    const answerMsg = await nextMessage(sender);
    assert.equal(answerMsg.type, 'answer');
    assert.equal(answerMsg.sdp.sdp, 'dummy-answer');

    sender.send(JSON.stringify({ type: 'ice-candidate', candidate: { candidate: 'c1' } }));
    const iceMsg = await nextMessage(receiver);
    assert.equal(iceMsg.type, 'ice-candidate');
    assert.equal(iceMsg.candidate.candidate, 'c1');

    // Relay fallback forwards control and binary without storage
    sender.send(JSON.stringify({ type: 'relay-ready' }));
    const relayReady = await nextMessage(receiver);
    assert.equal(relayReady.type, 'relay-ready');

    sender.send(JSON.stringify({ type: 'relay-ctrl', ctrl: { type: 'file-start', id: 'f1', name: 'a.txt', size: 3 } }));
    const relayCtrl = await nextMessage(receiver);
    assert.equal(relayCtrl.type, 'relay-ctrl');
    assert.equal(relayCtrl.ctrl.name, 'a.txt');

    const binaryPromise = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Timed out waiting for binary')), 3000);
      receiver.once('message', (data, isBinary) => {
        clearTimeout(timer);
        resolve({ data: Buffer.from(data), isBinary });
      });
    });
    sender.send(Buffer.from('abc'), { binary: true });
    const bin = await binaryPromise;
    assert.equal(bin.isBinary, true);
    assert.equal(bin.data.toString(), 'abc');

    // Closing receiver deletes ephemeral room immediately
    const closedPromise = nextMessage(sender);
    receiver.close();
    const closedMsg = await closedPromise;
    assert.equal(closedMsg.type, 'room-closed');
    assert.equal(rooms.size, 0);

    sender.close();
  });

  await t.test('Invalid room code returns error', async () => {
    const sender = await connectWs(port);
    sender.send(JSON.stringify({ type: 'join-room', code: 'ZZZZZZ' }));
    const errMsg = await nextMessage(sender);
    assert.equal(errMsg.type, 'error');
    sender.close();
  });

  await t.test('QR encode and jsQR decode roundtrip works for join URLs', () => {
    const targetUrl = 'http://192.168.0.19:3000/?join=A7F92C';
    const qr = qrcode(0, 'M');
    qr.addData(targetUrl);
    qr.make();

    const count = qr.getModuleCount();
    const scale = 6;
    const margin = 12;
    const size = count * scale + margin * 2;
    const rgba = new Uint8ClampedArray(size * size * 4);
    rgba.fill(255); // white background

    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (!qr.isDark(r, c)) continue;
        for (let dy = 0; dy < scale; dy++) {
          for (let dx = 0; dx < scale; dx++) {
            const x = margin + c * scale + dx;
            const y = margin + r * scale + dy;
            const idx = (y * size + x) * 4;
            rgba[idx] = 11;
            rgba[idx + 1] = 12;
            rgba[idx + 2] = 15;
            rgba[idx + 3] = 255;
          }
        }
      }
    }

    const decoded = jsQR(rgba, size, size);
    assert.ok(decoded, 'Expected jsQR to decode generated QR');
    assert.equal(decoded.data, targetUrl);
  });
});

