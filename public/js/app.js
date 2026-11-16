(function () {
  const $ = (id) => document.getElementById(id);

  // Views
  const views = {
    home: $('view-home'),
    receive: $('view-receive'),
    send: $('view-send'),
  };

  // Home elements
  const btnGoSend = $('btn-go-send');
  const btnGoReceive = $('btn-go-receive');
  const airdropTopWave = $('airdrop-top-wave');
  let airdropDoneTimer = null;

  // Receive elements
  const btnReceiveBack = $('btn-receive-back');
  const receiveStatus = $('receive-status');
  const receiveErrorEl = $('receive-error');
  const receiveQrBox = $('receive-qr-box');
  const qrCanvas = $('qr-canvas');
  const receiveCodeEl = $('receive-code');
  const btnCopyLink = $('btn-copy-link');
  const btnShareQr = $('btn-share-qr');
  const receiveFilesBox = $('receive-files-box');
  const receiveTransferAnim = $('receive-transfer-anim');
  const receiveOverallLabel = $('receive-overall-label');
  const receiveOverallPct = $('receive-overall-pct');
  const receiveOverallBar = $('receive-overall-bar');
  const receiveEmpty = $('receive-empty');
  const receiveList = $('receive-list');
  const btnDownloadAll = $('btn-download-all');

  // Send elements
  const btnSendBack = $('btn-send-back');
  const sendStatus = $('send-status');
  const sendErrorEl = $('send-error');
  const sendScanStage = $('send-scan-stage');
  const btnScanBack = $('btn-scan-back');
  const scanStatus = $('scan-status');
  const scanErrorEl = $('scan-error');
  const qrVideo = $('qr-video');
  const qrScanCanvas = $('qr-scan-canvas');
  const cameraFallbackMsg = $('camera-fallback-msg');
  const cameraFallbackText = $('camera-fallback-text');
  const btnRetryCamera = $('btn-retry-camera');
  const manualCodeForm = $('manual-code-form');
  const manualCodeInput = $('manual-code-input');
  const qrImageInput = $('qr-image-input');
  const sendFilesStage = $('send-files-stage');
  const sendTransferAnim = $('send-transfer-anim');
  const sendOverallLabel = $('send-overall-label');
  const sendOverallPct = $('send-overall-pct');
  const sendOverallBar = $('send-overall-bar');
  const dropZone = $('drop-zone');
  const fileInput = $('file-input');
  const sendList = $('send-list');
  const btnSendFiles = $('btn-send-files');

  const toastEl = $('toast');

  let currentSession = null;
  let currentShareOrigin = location.origin;
  let scannerStream = null;
  let scannerRaf = null;
  let toastTimer = null;

  // Ephemeral in-memory state (wiped on refresh/reset)
  let sendQueue = [];
  let receivedFiles = [];
  let isSending = false;

  function showInlineError(el, msg) {
    el.textContent = msg;
    el.classList.remove('hidden');
    if (el === sendErrorEl) {
      scanErrorEl.textContent = msg;
      scanErrorEl.classList.remove('hidden');
    }
  }

  function clearInlineErrors() {
    receiveErrorEl.textContent = '';
    receiveErrorEl.classList.add('hidden');
    sendErrorEl.textContent = '';
    sendErrorEl.classList.add('hidden');
    scanErrorEl.textContent = '';
    scanErrorEl.classList.add('hidden');
  }

  function showToast(text) {
    toastEl.textContent = text;
    toastEl.classList.remove('hidden');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => {
      toastEl.classList.add('hidden');
    }, 2600);
  }

  function showView(name) {
    for (const [key, el] of Object.entries(views)) {
      el.classList.toggle('active', key === name);
    }
  }

  function setStatus(pillEl, state, text) {
    pillEl.classList.remove('waiting', 'connected', 'error');
    pillEl.classList.add(state);
    pillEl.querySelector('.status-text').textContent = text;
    if (pillEl === sendStatus) {
      scanStatus.classList.remove('waiting', 'connected', 'error');
      scanStatus.classList.add(state);
      scanStatus.querySelector('.status-text').textContent = text;
    }
  }

  function formatBytes(bytes) {
    if (bytes === 0) return '0 B';
    const units = ['B', 'KB', 'MB', 'GB'];
    const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
    const value = bytes / Math.pow(1024, i);
    return `${value.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
  }

  function getFileBadge(mime, name) {
    if (mime.startsWith('image/')) return 'IMG';
    if (mime.startsWith('video/')) return 'VID';
    if (mime.startsWith('audio/')) return 'AUD';
    const ext = (name.split('.').pop() || '').toUpperCase().slice(0, 4);
    return ext || 'FAIL';
  }

  function extractSessionCode(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    try {
      const url = new URL(text);
      const join = url.searchParams.get('join');
      if (join) return join.trim().toUpperCase();
    } catch {
      // Not a full URL, check raw code
    }
    const match = text.match(/^[A-Z0-9]{4,10}$/i);
    return match ? match[0].toUpperCase() : '';
  }

  function renderQRCode(text) {
    const qr = qrcode(0, 'M');
    qr.addData(text);
    qr.make();

    const count = qr.getModuleCount();
    const dpr = window.devicePixelRatio || 1;
    const cssSize = 210;
    const pixelSize = cssSize * dpr;
    const margin = Math.floor(pixelSize * 0.06);
    const cellSize = (pixelSize - margin * 2) / count;

    qrCanvas.width = pixelSize;
    qrCanvas.height = pixelSize;

    const ctx = qrCanvas.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, pixelSize, pixelSize);
    ctx.fillStyle = '#0b0c0f';

    for (let r = 0; r < count; r++) {
      for (let c = 0; c < count; c++) {
        if (qr.isDark(r, c)) {
          const x = Math.floor(margin + c * cellSize);
          const y = Math.floor(margin + r * cellSize);
          const w = Math.ceil(cellSize);
          ctx.fillRect(x, y, w, w);
        }
      }
    }
  }

  function setAirdropWave(mode) {
    if (!airdropTopWave) return;
    clearTimeout(airdropDoneTimer);
    airdropDoneTimer = null;

    if (mode === 'idle') {
      airdropTopWave.classList.remove('is-active', 'is-sending', 'is-receiving', 'is-done');
      return;
    }

    airdropTopWave.classList.add('is-active');
    if (mode === 'sending' || mode === 'receiving') {
      airdropTopWave.classList.toggle('is-sending', mode === 'sending');
      airdropTopWave.classList.toggle('is-receiving', mode === 'receiving');
      airdropTopWave.classList.remove('is-done');
      return;
    }

    if (mode === 'done') {
      airdropTopWave.classList.add('is-done');
      airdropDoneTimer = setTimeout(() => {
        setAirdropWave('idle');
      }, 1800);
    }
  }

  function setHeroProgress(heroEl, labelEl, pctEl, barEl, pct, labelText, completed) {
    heroEl.classList.remove('hidden');
    heroEl.classList.toggle('completed', Boolean(completed));
    labelEl.textContent = labelText;
    pctEl.textContent = `${pct}%`;
    barEl.style.width = `${pct}%`;
    barEl.classList.toggle('done', Boolean(completed));
    const mode = completed ? 'done' : (heroEl === sendTransferAnim ? 'sending' : 'receiving');
    setAirdropWave(mode);
  }

  function resetHero(heroEl, pctEl, barEl) {
    heroEl.classList.add('hidden');
    heroEl.classList.remove('completed');
    pctEl.textContent = '0%';
    barEl.style.width = '0%';
    barEl.classList.remove('done');
    setAirdropWave('idle');
  }

  function resetAll() {
    stopScanner();
    if (currentSession) {
      currentSession.close();
      currentSession = null;
    }

    // Revoke any ephemeral blob URLs
    for (const item of receivedFiles) {
      if (item.blobUrl) {
        try { URL.revokeObjectURL(item.blobUrl); } catch {}
      }
    }
    receivedFiles = [];
    sendQueue = [];
    isSending = false;

    receiveList.innerHTML = '';
    sendList.innerHTML = '';
    receiveEmpty.classList.remove('hidden');
    sendScanStage.classList.add('hidden');
    sendScanStage.classList.remove('camera-blocked');
    btnDownloadAll.classList.add('hidden');
    btnSendFiles.classList.add('hidden');
    btnSendFiles.disabled = false;
    manualCodeInput.value = '';
    fileInput.value = '';
    qrImageInput.value = '';
    currentShareOrigin = location.origin;
    resetHero(receiveTransferAnim, receiveOverallPct, receiveOverallBar);
    resetHero(sendTransferAnim, sendOverallPct, sendOverallBar);
    clearInlineErrors();
  }

  function goHome() {
    resetAll();
    if (location.search) {
      history.replaceState(null, '', '/');
    }
    showView('home');
  }

  // ---------------- RECEIVE FLOW ----------------

  async function startReceiveFlow() {
    resetAll();
    showView('receive');
    receiveQrBox.classList.remove('hidden');
    receiveFilesBox.classList.add('hidden');
    receiveCodeEl.textContent = '------';
    setStatus(receiveStatus, 'waiting', 'Menyediakan QR...');

    currentSession = new MyDropSession({
      onRoomCreated(code, shareOrigin) {
        currentShareOrigin = shareOrigin || location.origin;
        receiveCodeEl.textContent = code;
        const shareUrl = `${currentShareOrigin}/?join=${code}`;
        renderQRCode(shareUrl);
        setStatus(receiveStatus, 'waiting', 'Menunggu...');
      },
      onConnected() {
        clearInlineErrors();
        setStatus(receiveStatus, 'connected', 'Bersambung');
        receiveQrBox.classList.add('hidden');
        receiveFilesBox.classList.remove('hidden');
      },
      onReceiveStart(fileInfo) {
        receiveEmpty.classList.add('hidden');
        const item = {
          id: fileInfo.id,
          name: fileInfo.name,
          size: fileInfo.size,
          mime: fileInfo.mime,
          receivedBytes: 0,
          blobUrl: null,
          done: false,
        };
        receivedFiles.push(item);
        appendReceiveItem(item);
        setHeroProgress(
          receiveTransferAnim,
          receiveOverallLabel,
          receiveOverallPct,
          receiveOverallBar,
          0,
          `Menerima ${fileInfo.name}...`,
          false
        );
      },
      onReceiveProgress(fileId, receivedBytes, totalBytes) {
        const entry = receivedFiles.find((f) => f.id === fileId);
        if (entry) entry.receivedBytes = receivedBytes;
        const el = document.getElementById(`rx-${fileId}`);
        if (!el) return;
        const pct = totalBytes > 0 ? Math.min(100, Math.round((receivedBytes / totalBytes) * 100)) : 100;
        el.querySelector('.progress-fill').style.width = `${pct}%`;
        el.querySelector('.file-sub').textContent = `${formatBytes(receivedBytes)} / ${formatBytes(totalBytes)} (${pct}%)`;
        setHeroProgress(
          receiveTransferAnim,
          receiveOverallLabel,
          receiveOverallPct,
          receiveOverallBar,
          pct,
          `Sedang menerima ${entry?.name || 'fail'}...`,
          false
        );
      },
      onReceiveComplete(fileInfo, blobUrl) {
        const entry = receivedFiles.find((f) => f.id === fileInfo.id);
        if (entry) {
          entry.blobUrl = blobUrl;
          entry.receivedBytes = fileInfo.size;
          entry.done = true;
        }
        const el = document.getElementById(`rx-${fileInfo.id}`);
        if (el) {
          el.querySelector('.progress-fill').style.width = '100%';
          el.querySelector('.progress-fill').classList.add('done');
          el.querySelector('.file-sub').textContent = `${formatBytes(fileInfo.size)} • Selesai`;

          if (fileInfo.mime.startsWith('image/')) {
            const thumb = el.querySelector('.file-thumb');
            const img = document.createElement('img');
            img.src = blobUrl;
            img.alt = fileInfo.name;
            thumb.innerHTML = '';
            thumb.appendChild(img);
          }

          const actionWrap = el.querySelector('.file-action');
          const link = document.createElement('a');
          link.className = 'btn-dl';
          link.href = blobUrl;
          link.download = fileInfo.name;
          link.textContent = 'Download';
          actionWrap.innerHTML = '';
          actionWrap.appendChild(link);
        }

        const completedCount = receivedFiles.filter((f) => f.done).length;
        const allDone = receivedFiles.every((f) => f.done);
        if (allDone) {
          setHeroProgress(
            receiveTransferAnim,
            receiveOverallLabel,
            receiveOverallPct,
            receiveOverallBar,
            100,
            `${completedCount} fail diterima ✓`,
            true
          );
        }
        if (completedCount >= 2) {
          btnDownloadAll.classList.remove('hidden');
        }
      },
      onDisconnected(reason) {
        setAirdropWave('idle');
        setStatus(receiveStatus, 'error', 'Terputus');
        showInlineError(receiveErrorEl, reason || 'Sambungan terputus.');
      },
      onError(msg) {
        setStatus(receiveStatus, 'error', 'Ralat');
        showInlineError(receiveErrorEl, msg || 'Ralat berlaku.');
      },
    });

    try {
      await currentSession.startReceiver();
    } catch (err) {
      setStatus(receiveStatus, 'error', 'Ralat');
      showInlineError(receiveErrorEl, err.message || 'Gagal memulakan sesi.');
    }
  }

  function appendReceiveItem(item) {
    const li = document.createElement('li');
    li.className = 'file-item';
    li.id = `rx-${item.id}`;
    li.innerHTML = `
      <div class="file-row">
        <div class="file-thumb">${getFileBadge(item.mime, item.name)}</div>
        <div class="file-meta">
          <div class="file-name"></div>
          <div class="file-sub">${formatBytes(item.size)} • Menerima...</div>
        </div>
        <div class="file-action"></div>
      </div>
      <div class="progress-track"><div class="progress-fill"></div></div>
    `;
    li.querySelector('.file-name').textContent = item.name;
    receiveList.appendChild(li);
  }

  btnCopyLink.addEventListener('click', async () => {
    const code = receiveCodeEl.textContent.trim();
    if (!code || code === '------') return;
    const url = `${currentShareOrigin}/?join=${code}`;
    try {
      await navigator.clipboard.writeText(url);
      showToast('Pautan disalin');
    } catch {
      showToast(`Kod: ${code}`);
    }
  });

  function canvasToPngBlob(canvas) {
    return new Promise((resolve) => {
      canvas.toBlob((blob) => resolve(blob), 'image/png');
    });
  }

  btnShareQr?.addEventListener('click', async () => {
    const code = receiveCodeEl.textContent.trim();
    if (!code || code === '------') return;

    const url = `${currentShareOrigin}/?join=${code}`;
    const filename = `fastdrop-qr-${code}.png`;
    const blob = await canvasToPngBlob(qrCanvas);

    if (navigator.share) {
      try {
        if (blob) {
          const qrFile = new File([blob], filename, { type: 'image/png' });
          if (navigator.canShare && navigator.canShare({ files: [qrFile] })) {
            await navigator.share({
              title: 'fastdrop',
              text: `Imbas QR atau guna kod ${code} di ${url}`,
              files: [qrFile],
            });
            return;
          }
        }
        await navigator.share({
          title: 'fastdrop',
          text: `Guna kod ${code} atau imbas QR untuk hantar fail:`,
          url,
        });
        return;
      } catch (err) {
        if (err && err.name === 'AbortError') return;
      }
    }

    if (blob) {
      const blobUrl = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = blobUrl;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => {
        try { URL.revokeObjectURL(blobUrl); } catch {}
      }, 1000);
    }

    let copied = false;
    try {
      await navigator.clipboard.writeText(url);
      copied = true;
    } catch {}

    if (blob && copied) {
      showToast('Gambar QR dimuat turun & pautan disalin');
    } else if (blob) {
      showToast('Gambar QR dimuat turun untuk dikongsi');
    } else if (copied) {
      showToast('Pautan disalin');
    } else {
      showToast(`Kod: ${code}`);
    }
  });

  btnDownloadAll.addEventListener('click', () => {
    const doneFiles = receivedFiles.filter((f) => f.done && f.blobUrl);
    doneFiles.forEach((f, idx) => {
      setTimeout(() => {
        const a = document.createElement('a');
        a.href = f.blobUrl;
        a.download = f.name;
        document.body.appendChild(a);
        a.click();
        a.remove();
      }, idx * 180);
    });
  });

  // ---------------- SEND FLOW ----------------

  function startSendFlow(prefilledCode) {
    resetAll();
    showView('send');
    sendFilesStage.classList.add('hidden');

    if (prefilledCode) {
      sendScanStage.classList.add('hidden');
      connectAsSender(prefilledCode);
    } else {
      sendScanStage.classList.remove('hidden');
      setStatus(sendStatus, 'waiting', 'Imbas QR');
      startScanner();
    }
  }

  async function startScanner() {
    cameraFallbackMsg.classList.add('hidden');
    sendScanStage.classList.remove('camera-blocked');

    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      cameraFallbackText.textContent = 'Kamera perlukan HTTPS. Masukkan kod di bawah atau pilih gambar QR.';
      cameraFallbackMsg.classList.remove('hidden');
      sendScanStage.classList.add('camera-blocked');
      return;
    }

    try {
      scannerStream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false,
      });
      qrVideo.srcObject = scannerStream;
      await qrVideo.play();
      scanFrameLoop();
    } catch {
      cameraFallbackText.textContent = 'Kamera dimatikan atau akses ditolak. Masukkan kod di bawah atau pilih gambar QR.';
      cameraFallbackMsg.classList.remove('hidden');
      sendScanStage.classList.add('camera-blocked');
    }
  }

  function scanFrameLoop() {
    if (!scannerStream) return;

    if (qrVideo.readyState === qrVideo.HAVE_ENOUGH_DATA) {
      const w = qrVideo.videoWidth;
      const h = qrVideo.videoHeight;
      if (w > 0 && h > 0) {
        qrScanCanvas.width = w;
        qrScanCanvas.height = h;
        const ctx = qrScanCanvas.getContext('2d', { willReadFrequently: true });
        ctx.drawImage(qrVideo, 0, 0, w, h);
        const imgData = ctx.getImageData(0, 0, w, h);
        const result = jsQR(imgData.data, w, h, { inversionAttempts: 'attemptBoth' });
        if (result && result.data) {
          const code = extractSessionCode(result.data);
          if (code) {
            stopScanner();
            connectAsSender(code);
            return;
          }
        }
      }
    }

    scannerRaf = requestAnimationFrame(scanFrameLoop);
  }

  function stopScanner() {
    if (scannerRaf) {
      cancelAnimationFrame(scannerRaf);
      scannerRaf = null;
    }
    if (scannerStream) {
      for (const track of scannerStream.getTracks()) {
        track.stop();
      }
      scannerStream = null;
    }
    qrVideo.srcObject = null;
  }

  async function connectAsSender(code) {
    stopScanner();
    clearInlineErrors();
    if (currentSession) {
      currentSession.close();
      currentSession = null;
    }

    setStatus(sendStatus, 'waiting', 'Menyambung...');

    currentSession = new MyDropSession({
      onConnected() {
        clearInlineErrors();
        setStatus(sendStatus, 'connected', 'Bersambung');
        sendScanStage.classList.add('hidden');
        sendFilesStage.classList.remove('hidden');
      },
      onSendProgress(fileId, sentBytes, totalBytes) {
        const entry = sendQueue.find((f) => f.id === fileId);
        if (entry) entry.sentBytes = sentBytes;
        const el = document.getElementById(`tx-${fileId}`);
        if (!el) return;
        const pct = totalBytes > 0 ? Math.min(100, Math.round((sentBytes / totalBytes) * 100)) : 100;
        el.querySelector('.progress-fill').style.width = `${pct}%`;
        el.querySelector('.file-sub').textContent = `${formatBytes(sentBytes)} / ${formatBytes(totalBytes)} (${pct}%)`;

        const activeBatch = sendQueue.filter((f) => f.status === 'sending' || f.status === 'done');
        const batchTotal = activeBatch.reduce((acc, f) => acc + f.file.size, 0);
        const batchSent = activeBatch.reduce((acc, f) => acc + (f.status === 'done' ? f.file.size : (f.sentBytes || 0)), 0);
        const overallPct = batchTotal > 0 ? Math.min(100, Math.round((batchSent / batchTotal) * 100)) : 100;
        setHeroProgress(
          sendTransferAnim,
          sendOverallLabel,
          sendOverallPct,
          sendOverallBar,
          overallPct,
          `Sedang menghantar ${entry?.file.name || 'fail'}...`,
          false
        );
      },
      onSendComplete(fileId) {
        const entry = sendQueue.find((f) => f.id === fileId);
        if (entry) {
          entry.status = 'done';
          entry.sentBytes = entry.file.size;
        }
        const el = document.getElementById(`tx-${fileId}`);
        if (el) {
          el.querySelector('.progress-fill').style.width = '100%';
          el.querySelector('.progress-fill').classList.add('done');
          el.querySelector('.file-sub').textContent = `${formatBytes(entry?.file.size || 0)} • Dihantar`;
        }
      },
      onDisconnected(reason) {
        setAirdropWave('idle');
        setStatus(sendStatus, 'error', 'Terputus');
        showInlineError(sendErrorEl, reason || 'Sambungan terputus.');
      },
      onError(msg) {
        setStatus(sendStatus, 'error', 'Ralat');
        showInlineError(sendErrorEl, msg || 'Ralat berlaku.');
        if (!sendFilesStage.classList.contains('hidden')) return;
        sendScanStage.classList.remove('hidden');
        startScanner();
      },
    });

    try {
      await currentSession.startSender(code);
    } catch (err) {
      setStatus(sendStatus, 'error', 'Ralat');
      showInlineError(sendErrorEl, err.message || 'Gagal menyambung.');
    }
  }

  manualCodeForm.addEventListener('submit', (e) => {
    e.preventDefault();
    const code = extractSessionCode(manualCodeInput.value);
    if (!code) {
      showInlineError(sendErrorEl, 'Masukkan kod sesi yang sah (cth: A7F92C).');
      return;
    }
    connectAsSender(code);
  });

  qrImageInput.addEventListener('change', (e) => {
    const file = e.target.files?.[0];
    if (!file) return;
    const img = new Image();
    const url = URL.createObjectURL(file);
    img.onload = () => {
      URL.revokeObjectURL(url);
      const maxDim = 1024;
      const scale = Math.min(1, maxDim / Math.max(img.width, img.height));
      const w = Math.max(1, Math.round(img.width * scale));
      const h = Math.max(1, Math.round(img.height * scale));
      qrScanCanvas.width = w;
      qrScanCanvas.height = h;
      const ctx = qrScanCanvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(img, 0, 0, w, h);
      const data = ctx.getImageData(0, 0, w, h);
      const result = jsQR(data.data, w, h, { inversionAttempts: 'attemptBoth' });
      const code = result ? extractSessionCode(result.data) : '';
      if (code) {
        connectAsSender(code);
      } else {
        showInlineError(sendErrorEl, 'QR tidak dapat dikesan dalam gambar. Cuba masukkan kod 6 aksara.');
      }
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      showToast('Gambar tidak sah');
    };
    img.src = url;
  });

  function addFilesToQueue(fileList) {
    const files = Array.from(fileList || []);
    if (files.length === 0) return;

    for (const file of files) {
      const id = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
      const entry = { id, file, status: 'pending' };
      sendQueue.push(entry);
      appendSendItem(entry);
    }

    updateSendButton();
  }

  function appendSendItem(entry) {
    const { id, file } = entry;
    const li = document.createElement('li');
    li.className = 'file-item';
    li.id = `tx-${id}`;
    li.innerHTML = `
      <div class="file-row">
        <div class="file-thumb">${getFileBadge(file.type || '', file.name)}</div>
        <div class="file-meta">
          <div class="file-name"></div>
          <div class="file-sub">${formatBytes(file.size)} • Sedia</div>
        </div>
        <div class="file-action">
          <button class="btn-remove" type="button" title="Buang">✕</button>
        </div>
      </div>
      <div class="progress-track"><div class="progress-fill"></div></div>
    `;
    li.querySelector('.file-name').textContent = file.name;

    if ((file.type || '').startsWith('image/')) {
      const thumbUrl = URL.createObjectURL(file);
      const img = document.createElement('img');
      img.src = thumbUrl;
      img.onload = () => URL.revokeObjectURL(thumbUrl);
      const thumb = li.querySelector('.file-thumb');
      thumb.innerHTML = '';
      thumb.appendChild(img);
    }

    li.querySelector('.btn-remove').addEventListener('click', () => {
      if (entry.status === 'sending') return;
      sendQueue = sendQueue.filter((item) => item.id !== id);
      li.remove();
      updateSendButton();
    });

    sendList.appendChild(li);
  }

  function updateSendButton() {
    const pendingCount = sendQueue.filter((item) => item.status === 'pending').length;
    if (pendingCount > 0) {
      btnSendFiles.classList.remove('hidden');
      btnSendFiles.disabled = isSending;
      btnSendFiles.textContent = isSending ? 'Menghantar...' : `Hantar (${pendingCount} fail)`;
    } else if (sendQueue.length > 0 && isSending) {
      btnSendFiles.classList.remove('hidden');
      btnSendFiles.disabled = true;
      btnSendFiles.textContent = 'Menghantar...';
    } else {
      btnSendFiles.classList.add('hidden');
    }
  }

  fileInput.addEventListener('change', (e) => {
    addFilesToQueue(e.target.files);
    fileInput.value = '';
  });

  dropZone.addEventListener('dragover', (e) => {
    e.preventDefault();
    dropZone.classList.add('dragover');
  });

  dropZone.addEventListener('dragleave', () => {
    dropZone.classList.remove('dragover');
  });

  dropZone.addEventListener('drop', (e) => {
    e.preventDefault();
    dropZone.classList.remove('dragover');
    addFilesToQueue(e.dataTransfer?.files);
  });

  btnSendFiles.addEventListener('click', async () => {
    if (isSending || !currentSession) return;
    const pending = sendQueue.filter((item) => item.status === 'pending');
    if (pending.length === 0) return;

    isSending = true;
    for (const item of pending) {
      item.status = 'sending';
      item.sentBytes = 0;
      const el = document.getElementById(`tx-${item.id}`);
      el?.querySelector('.btn-remove')?.remove();
    }
    updateSendButton();
    setHeroProgress(
      sendTransferAnim,
      sendOverallLabel,
      sendOverallPct,
      sendOverallBar,
      0,
      `Memulakan penghantaran (${pending.length} fail)...`,
      false
    );

    try {
      await currentSession.sendFiles(pending);
      const totalSentCount = sendQueue.filter((f) => f.status === 'done').length;
      setHeroProgress(
        sendTransferAnim,
        sendOverallLabel,
        sendOverallPct,
        sendOverallBar,
        100,
        `${totalSentCount} fail selesai dihantar ✓`,
        true
      );
      showToast('Semua fail berjaya dihantar');
    } catch (err) {
      setAirdropWave('idle');
      showInlineError(sendErrorEl, err.message || 'Gagal menghantar fail');
    } finally {
      isSending = false;
      updateSendButton();
    }
  });

  // Navigation events
  btnGoReceive.addEventListener('click', () => startReceiveFlow());
  btnGoSend.addEventListener('click', () => startSendFlow());
  btnReceiveBack.addEventListener('click', goHome);
  btnSendBack.addEventListener('click', goHome);
  btnScanBack.addEventListener('click', goHome);
  btnRetryCamera.addEventListener('click', () => startScanner());

  window.addEventListener('beforeunload', () => {
    resetAll();
  });

  // Auto-join when QR opened via phone camera (?join=CODE)
  const params = new URLSearchParams(location.search);
  const joinCode = extractSessionCode(params.get('join'));
  if (joinCode) {
    startSendFlow(joinCode);
  }
})();

