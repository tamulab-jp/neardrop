/*
 * NearDrop β  アプリ内カメラ（camera.js）
 *
 * 伝票のお届け先欄を「枠」に合わせて撮影し、枠の部分だけを切り抜いて返します。
 * index.html からは次の1行で読み込み、NearDropCamera.open(...) を呼ぶだけで使えます。
 *   <script src="camera.js"></script>
 *
 * 使い方：
 *   NearDropCamera.open({
 *     frameSize: 'm',                 // 's' | 'm' | 'l'（前回選んだ大きさ）
 *     pkgMode: 'always',              // 'always'＝荷物写真も撮る / 'never'＝伝票だけ
 *     onFrameSize: size => {...},     // 枠の大きさを変えたとき（保存用）
 *     onShot: item => {...},          // 1個ぶん撮れるたびに呼ばれる
 *                                     //   item = { crop, full, pkg, at }（どれも Blob。pkg は null のことあり）
 *     onClose: () => {...}            // カメラを閉じたとき
 *   });
 *   NearDropCamera.setRead(n);        // 「読み取り済み n件」の表示を更新
 *
 * 動画やカメラ映像は、どこにも保存・送信しません。
 */
(function (root) {
  'use strict';

  var FRAMES = { s: { w: 0.62, h: 0.16 }, m: { w: 0.82, h: 0.24 }, l: { w: 0.94, h: 0.36 } };
  var MARGIN = 0.08;               // 枠の外側に付ける余白（枠の幅・高さに対する割合）
  var CROP_MAX = 1568, CROP_Q = 0.88;   // 住所写真（切り抜き）
  var FULL_MAX = 1280, FULL_Q = 0.75;   // 伝票全体・荷物写真
  var PHOTO_WIDTH_TARGET = 4032;   // takePhoto で狙う横幅（大きすぎると遅いので上限を決める）

  /* ---------- 切り抜き位置の計算（画面の枠 → 撮影画像の座標） ----------
   * cw, ch   : プレビュー（video要素）の画面上の大きさ
   * vw, vh   : カメラ映像そのものの大きさ（videoWidth / videoHeight）
   * f        : 画面上の枠 { x, y, w, h }（video要素の左上が原点）
   * margin   : 枠の外側に付ける余白の割合
   * srcW/srcH: 切り抜き元の画像の大きさ（takePhoto の静止画、または映像のコマ）
   * プレビューは object-fit: cover なので、拡大とはみ出し分を計算に入れる。
   * 静止画の縦横比が映像と違うときは、映像が静止画の中央部分だと考えて換算する。 */
  function cropRect(cw, ch, vw, vh, f, margin, srcW, srcH) {
    var s = Math.max(cw / vw, ch / vh);
    var ox = (cw - vw * s) / 2, oy = (ch - vh * s) / 2;
    var x0 = f.x - f.w * margin, y0 = f.y - f.h * margin;
    var x1 = f.x + f.w * (1 + margin), y1 = f.y + f.h * (1 + margin);
    // 画面 → 映像の座標
    var vx0 = (x0 - ox) / s, vy0 = (y0 - oy) / s, vx1 = (x1 - ox) / s, vy1 = (y1 - oy) / s;
    // 映像に対応する静止画の範囲（中央）
    var rw, rh;
    if (srcW / srcH > vw / vh) { rh = srcH; rw = srcH * vw / vh; }
    else { rw = srcW; rh = srcW * vh / vw; }
    var rx = (srcW - rw) / 2, ry = (srcH - rh) / 2;
    var k = rw / vw;
    var sx0 = rx + vx0 * k, sy0 = ry + vy0 * k, sx1 = rx + vx1 * k, sy1 = ry + vy1 * k;
    sx0 = Math.max(0, Math.min(srcW, sx0)); sx1 = Math.max(0, Math.min(srcW, sx1));
    sy0 = Math.max(0, Math.min(srcH, sy0)); sy1 = Math.max(0, Math.min(srcH, sy1));
    return {
      sx: Math.round(sx0), sy: Math.round(sy0),
      sw: Math.max(1, Math.round(sx1 - sx0)), sh: Math.max(1, Math.round(sy1 - sy0))
    };
  }

  // 画像（またはその一部）を縮小して JPEG の Blob にする
  function renderBlob(src, sx, sy, sw, sh, maxLong, quality) {
    return new Promise(function (res, rej) {
      var s = Math.min(1, maxLong / Math.max(sw, sh));
      var c = document.createElement('canvas');
      c.width = Math.max(1, Math.round(sw * s));
      c.height = Math.max(1, Math.round(sh * s));
      var g = c.getContext('2d');
      g.imageSmoothingQuality = 'high';
      g.drawImage(src, sx, sy, sw, sh, 0, 0, c.width, c.height);
      c.toBlob(function (b) { b ? res(b) : rej(new Error('画像を作れませんでした')); }, 'image/jpeg', quality);
    });
  }

  /* ---------- 画面（初回だけ CSS を入れる） ---------- */
  var cssDone = false;
  function injectCss() {
    if (cssDone) return; cssDone = true;
    var st = document.createElement('style');
    st.textContent = [
      '#ndcam{position:fixed;inset:0;z-index:3000;background:#000;color:#fff;overflow:hidden;font-family:inherit;touch-action:manipulation;user-select:none;-webkit-user-select:none}',
      '#ndcam video{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;background:#000}',
      '#ndcam .frame{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);border:3px solid #fff;border-radius:10px;box-shadow:0 0 0 100vmax rgba(0,0,0,.55);pointer-events:none}',
      '#ndcam .frame .hint{position:absolute;left:50%;bottom:calc(100% + 14px);transform:translateX(-50%);width:max-content;max-width:92vw;text-align:center;font-weight:800;font-size:15px;text-shadow:0 1px 4px #000,0 0 8px #000}',
      '#ndcam.pkg .frame{border-color:transparent;box-shadow:none}',
      '#ndcam.pkg .frame .hint{bottom:auto;top:50%;transform:translate(-50%,-50%)}',
      '#ndcam .top{position:absolute;left:0;right:0;top:0;display:flex;justify-content:space-between;align-items:flex-start;gap:8px;padding:calc(10px + env(safe-area-inset-top,0px)) 12px 0}',
      '#ndcam .sizes{display:flex;border:2px solid rgba(255,255,255,.85);border-radius:10px;overflow:hidden;background:rgba(0,0,0,.45)}',
      '#ndcam.pkg .sizes{visibility:hidden}',
      '#ndcam .sizes button{border:0;background:none;color:#fff;font-weight:800;font-size:15px;padding:8px 14px;min-width:44px;min-height:44px}',
      '#ndcam .sizes button.on{background:#FFC93C;color:#1C2430}',
      '#ndcam .torch{border:2px solid rgba(255,255,255,.85);border-radius:10px;background:rgba(0,0,0,.45);color:#fff;font-weight:800;font-size:15px;padding:8px 12px;min-height:44px}',
      '#ndcam .torch.on{background:#FFC93C;color:#1C2430;border-color:#FFC93C}',
      '#ndcam .stats{position:absolute;left:0;right:0;bottom:calc(128px + env(safe-area-inset-bottom,0px));text-align:center;font-weight:800;font-size:15px;font-variant-numeric:tabular-nums;text-shadow:0 1px 4px #000,0 0 8px #000}',
      '#ndcam .bar{position:absolute;left:0;right:0;bottom:0;display:grid;grid-template-columns:1fr auto 1fr;align-items:center;padding:14px 16px calc(24px + env(safe-area-inset-bottom,0px));background:linear-gradient(transparent,rgba(0,0,0,.6))}',
      '#ndcam .bar .side{display:flex;align-items:center}',
      '#ndcam .bar .side.r{justify-content:flex-end}',
      '#ndcam .bar button.txt{border:2px solid rgba(255,255,255,.85);background:rgba(0,0,0,.45);color:#fff;border-radius:10px;font-weight:800;font-size:16px;padding:12px 16px;min-height:48px}',
      '#ndcam .shutter{width:80px;height:80px;border-radius:50%;border:5px solid #fff;background:rgba(255,255,255,.25);padding:0;position:relative}',
      '#ndcam .shutter::after{content:"";position:absolute;inset:6px;border-radius:50%;background:#fff}',
      '#ndcam .shutter:active::after{inset:10px}',
      '#ndcam.busy .shutter{opacity:.5}',
      '#ndcam .skip{visibility:hidden}',
      '#ndcam.pkg .skip{visibility:visible}',
      '#ndcam .flash{position:absolute;inset:0;background:#fff;opacity:0;pointer-events:none}',
      '#ndcam .flash.on{animation:ndflash .16s ease-out}',
      '@keyframes ndflash{from{opacity:.75}to{opacity:0}}',
      '#ndcam .msg{position:absolute;left:12px;right:12px;top:calc(70px + env(safe-area-inset-top,0px));background:rgba(200,55,45,.92);border-radius:10px;padding:10px 12px;font-weight:700;font-size:14px;display:none}',
      '#ndcam .msg.on{display:block}',
      '#ndcam.err video,#ndcam.err .frame,#ndcam.err .stats,#ndcam.err .sizes,#ndcam.err .torch,#ndcam.err .shutter,#ndcam.err .skip{display:none}',
      '#ndcam.err .msg{top:40%;font-size:16px;padding:16px}'
    ].join('\n');
    document.head.appendChild(st);
  }

  /* ---------- 状態 ---------- */
  var S = null; // 開いている間だけ入る

  function supported() {
    return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia);
  }

  function say(text, ms) {
    if (!S) return;
    var m = S.el.querySelector('.msg');
    m.textContent = text; m.classList.add('on');
    clearTimeout(S.msgTimer);
    if (ms) S.msgTimer = setTimeout(function () { m.classList.remove('on'); }, ms);
  }

  function updateStats() {
    if (!S) return;
    S.el.querySelector('.stats').textContent = '撮影 ' + S.shots + '件 ／ 読み取り済み ' + S.read + '件';
  }

  function setMode(mode) {
    S.mode = mode;
    S.el.classList.toggle('pkg', mode === 'pkg');
    S.el.querySelector('.hint').textContent = mode === 'pkg'
      ? '荷物全体を撮影してください（スキップもできます）'
      : 'お届け先の住所をこの枠に合わせてください';
  }

  function setFrameSize(size, notify) {
    if (!FRAMES[size]) size = 'm';
    S.frameSize = size;
    var f = S.el.querySelector('.frame');
    f.style.width = (FRAMES[size].w * 100) + '%';
    f.style.height = (FRAMES[size].h * 100) + '%';
    S.el.querySelectorAll('.sizes button').forEach(function (b) { b.classList.toggle('on', b.dataset.size === size); });
    if (notify && S.opts.onFrameSize) { try { S.opts.onFrameSize(size); } catch (e) {} }
  }

  function feedback() {
    try { if (navigator.vibrate) navigator.vibrate(40); } catch (e) {}
    var fl = S.el.querySelector('.flash');
    fl.classList.remove('on'); void fl.offsetWidth; fl.classList.add('on');
    try { // 小さなシャッター音
      var AC = root.AudioContext || root.webkitAudioContext;
      if (AC) {
        if (!S.audio) S.audio = new AC();
        var o = S.audio.createOscillator(), g = S.audio.createGain();
        o.frequency.value = 1400; g.gain.value = 0.08;
        o.connect(g); g.connect(S.audio.destination);
        o.start(); o.stop(S.audio.currentTime + 0.05);
      }
    } catch (e) {}
  }

  /* ---------- 静止画の取得 ----------
   * Chrome（Android）は ImageCapture.takePhoto() で高解像度の静止画を取る。
   * 使えない端末や失敗したときは、カメラ映像の現在のコマを canvas に描いて使う。 */
  async function grabStill() {
    var v = S.video, vw = v.videoWidth, vh = v.videoHeight;
    if (S.ic && S.icFails < 2 && S.track && S.track.readyState === 'live') {
      try {
        var blob = await S.ic.takePhoto(S.photoSettings || undefined);
        var bmp;
        try { bmp = await createImageBitmap(blob, { imageOrientation: 'from-image' }); }
        catch (e1) { bmp = await createImageBitmap(blob); }
        // 縦横の向きが映像と合わないときは使わない
        if ((bmp.width > bmp.height) === (vw > vh)) {
          return { src: bmp, w: bmp.width, h: bmp.height, close: function () { if (bmp.close) bmp.close(); } };
        }
        if (bmp.close) bmp.close();
        S.icFails++;
      } catch (e) { S.icFails++; }
    }
    var c = document.createElement('canvas');
    c.width = vw; c.height = vh;
    c.getContext('2d').drawImage(v, 0, 0, vw, vh);
    return { src: c, w: vw, h: vh, close: function () { c.width = c.height = 1; } };
  }

  function frameRect() {
    var vr = S.video.getBoundingClientRect();
    var fr = S.el.querySelector('.frame').getBoundingClientRect();
    return { cw: vr.width, ch: vr.height, frame: { x: fr.left - vr.left, y: fr.top - vr.top, w: fr.width, h: fr.height } };
  }

  function emit(pkg) {
    var p = S.pending; S.pending = null;
    if (!p) return;
    S.shots++; updateStats(); setMode('addr');
    var item = { crop: p.crop, full: p.full, pkg: pkg || null, at: Date.now() };
    try { if (S.opts.onShot) S.opts.onShot(item); } catch (e) {}
  }

  async function shoot() {
    if (!S || S.busy || !S.video.videoWidth) return;
    S.busy = true; S.el.classList.add('busy');
    var st = null;
    try {
      feedback();
      st = await grabStill();
      if (S.mode === 'addr') {
        var fr = frameRect();
        var r = cropRect(fr.cw, fr.ch, S.video.videoWidth, S.video.videoHeight, fr.frame, MARGIN, st.w, st.h);
        var crop = await renderBlob(st.src, r.sx, r.sy, r.sw, r.sh, CROP_MAX, CROP_Q);
        var full = await renderBlob(st.src, 0, 0, st.w, st.h, FULL_MAX, FULL_Q);
        S.pending = { crop: crop, full: full };
        if (S.opts.pkgMode === 'never') emit(null); else setMode('pkg');
      } else {
        var pkg = await renderBlob(st.src, 0, 0, st.w, st.h, FULL_MAX, FULL_Q);
        emit(pkg);
      }
    } catch (e) {
      say('撮影に失敗しました。もう一度撮ってください', 2500);
    } finally {
      if (st) st.close();
      if (S) { S.busy = false; S.el.classList.remove('busy'); }
    }
  }

  async function takeWakeLock() {
    try {
      if ('wakeLock' in navigator && S && !S.wake) {
        S.wake = await navigator.wakeLock.request('screen');
        S.wake.addEventListener('release', function () { if (S) S.wake = null; });
      }
    } catch (e) {}
  }
  function onVisible() { if (document.visibilityState === 'visible' && S) takeWakeLock(); }

  function errText(e) {
    var n = e && e.name;
    if (n === 'NotAllowedError' || n === 'SecurityError') return 'カメラの使用が許可されていません。ブラウザの設定でカメラを許可してから、もう一度開いてください。';
    if (n === 'NotFoundError' || n === 'OverconstrainedError') return 'カメラが見つかりません。';
    if (n === 'NotReadableError') return 'カメラを使えません。ほかのアプリがカメラを使っていないか確認してください。';
    return 'カメラを開けませんでした。';
  }

  function close() {
    if (!S) return;
    var s = S;
    if (s.pending) emit(null); // 荷物写真を待っている途中なら、伝票だけで保存する
    S = null;
    clearTimeout(s.msgTimer);
    document.removeEventListener('visibilitychange', onVisible);
    try { if (s.stream) s.stream.getTracks().forEach(function (t) { t.stop(); }); } catch (e) {}
    try { if (s.wake) s.wake.release(); } catch (e) {}
    try { if (s.audio) s.audio.close(); } catch (e) {}
    s.el.remove();
    try { if (s.opts.onClose) s.opts.onClose(); } catch (e) {}
  }

  async function open(opts) {
    if (S) return;
    opts = opts || {};
    injectCss();
    var el = document.createElement('div');
    el.id = 'ndcam';
    el.innerHTML =
      '<video playsinline muted autoplay></video>' +
      '<div class="frame"><div class="hint"></div></div>' +
      '<div class="top"><div class="sizes" role="group" aria-label="枠の大きさ">' +
        '<button type="button" data-size="s">小</button><button type="button" data-size="m">中</button><button type="button" data-size="l">大</button></div>' +
        '<button type="button" class="torch" hidden>ライト</button></div>' +
      '<div class="stats"></div>' +
      '<div class="bar"><div class="side"><button type="button" class="txt close">終了</button></div>' +
        '<button type="button" class="shutter" aria-label="撮影"></button>' +
        '<div class="side r"><button type="button" class="txt skip">スキップ</button></div></div>' +
      '<div class="flash"></div><div class="msg"></div>';
    document.body.appendChild(el);

    S = {
      el: el, video: el.querySelector('video'), opts: opts, mode: 'addr', pending: null, busy: false,
      shots: 0, read: 0, stream: null, track: null, ic: null, icFails: 0, photoSettings: null,
      wake: null, audio: null, torchOn: false, frameSize: 'm', msgTimer: 0
    };
    var cur = S;
    setFrameSize(opts.frameSize, false);
    setMode('addr');
    updateStats();

    el.querySelector('.sizes').addEventListener('click', function (e) {
      var b = e.target.closest('button[data-size]'); if (b) setFrameSize(b.dataset.size, true);
    });
    el.querySelector('.shutter').addEventListener('click', shoot);
    el.querySelector('.close').addEventListener('click', close);
    el.querySelector('.skip').addEventListener('click', function () { if (S && S.mode === 'pkg') emit(null); });

    if (!supported()) {
      el.classList.add('err');
      say('この端末・ブラウザではカメラを使えません（https でひらいているか確認してください）');
      return;
    }
    try {
      var stream = await navigator.mediaDevices.getUserMedia({
        audio: false,
        video: { facingMode: { ideal: 'environment' }, width: { ideal: 3840 }, height: { ideal: 2160 } }
      });
      if (S !== cur) { stream.getTracks().forEach(function (t) { t.stop(); }); return; } // 開く途中で閉じられた
      S.stream = stream;
      S.track = stream.getVideoTracks()[0];
      S.video.srcObject = stream;
      try { await S.video.play(); } catch (e) {}

      // ピント（対応していれば連続オートフォーカス）
      try { await S.track.applyConstraints({ advanced: [{ focusMode: 'continuous' }] }); } catch (e) {}

      // ライト（対応していない端末ではボタンを隠したまま）
      var caps = (S.track.getCapabilities && S.track.getCapabilities()) || {};
      if (caps.torch) {
        var tb = el.querySelector('.torch');
        tb.hidden = false;
        tb.addEventListener('click', async function () {
          if (!S) return;
          var want = !S.torchOn;
          try {
            await S.track.applyConstraints({ advanced: [{ torch: want }] });
            S.torchOn = want; tb.classList.toggle('on', want);
            tb.textContent = want ? 'ライト ON' : 'ライト';
          } catch (e) { tb.hidden = true; }
        });
      }

      // 高解像度の静止画（Chrome）
      if (root.ImageCapture) {
        try {
          S.ic = new root.ImageCapture(S.track);
          try {
            var pc = await S.ic.getPhotoCapabilities();
            if (pc && pc.imageWidth && pc.imageWidth.max) {
              var w = Math.max(pc.imageWidth.min || 0, Math.min(pc.imageWidth.max, PHOTO_WIDTH_TARGET));
              S.photoSettings = { imageWidth: w };
            }
          } catch (e) {}
        } catch (e) { S.ic = null; }
      }

      document.addEventListener('visibilitychange', onVisible);
      takeWakeLock();
    } catch (e) {
      if (S === cur) { el.classList.add('err'); say(errText(e) + '（「終了」で閉じます）'); }
    }
  }

  var api = {
    open: open,
    close: close,
    supported: supported,
    isOpen: function () { return !!S; },
    setRead: function (n) { if (S) { S.read = n; updateStats(); } },
    notify: function (text, ms) { say(text, ms || 3000); },
    _cropRect: cropRect // テスト用
  };
  root.NearDropCamera = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
