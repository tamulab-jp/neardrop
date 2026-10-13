/*
 * NearDrop 動画取り込み（試験版）  video-import.js
 *
 * 動画1本（荷物1個）から「伝票のコマ」と「荷物全体のコマ」を切り出す。
 * 動画はこの端末の中だけで処理し、どこにも送らない。
 *
 * 使い方：
 *   VideoImport.isVideo(file)                       … 動画ファイルか
 *   await VideoImport.process(file, onProgress)     … 2コマを切り出す（保存用の画像まで作る）
 *   await VideoImport.thumbs(file, [秒,…], 480)     … 候補コマの小さい画像を作る
 *   await VideoImport.frameAt(file, 秒, 長辺, 品質) … 指定した秒のコマを1枚作る
 *
 * 本番版に取り込むときは、このファイルを読み込む1行（<script src="video-import.js">）と、
 * 取り込みボタンの動画対応だけで済むようにしてある。
 */
(function (global) {
  'use strict';

  var FPS = 10;              // 1秒あたりに調べるコマ数
  var SCORE_W = 480;         // くっきり度を測るときの縮小幅
  var DOC_RANGE = 0.60;      // 伝票のコマ：動画の前半60%から選ぶ
  var PKG_RANGE = 0.30;      // 荷物のコマ：動画の後半30%から選ぶ
  var CAND_PER_ROLE = 4;     // 選び直し用の候補（伝票4枚＋荷物4枚）
  var CAND_MIN_GAP = 0.2;    // 候補どうしの最小間隔（秒）。近いコマばかり並ばないようにする
  var SHOW_MAX = 1280, SHOW_Q = 0.75;   // 表示用（本番版と同じ）
  var OCR_MAX = 1568, OCR_Q = 0.88;     // 読み取り用（伝票のみ。本番版と同じ）
  var SEEK_TIMEOUT = 4000;
  var META_TIMEOUT = 10000;

  function isVideo(file) {
    if (!file) return false;
    if (file.type && file.type.indexOf('video/') === 0) return true;
    return /\.(mp4|m4v|mov|3gp|webm|mkv)$/i.test(file.name || '');
  }

  function makeErr(code, msg) {
    var e = new Error(msg);
    e.code = code;
    return e;
  }

  // 動画を開く。読み込めない形式（HEVCなど）は code='unsupported' で失敗させる
  function openVideo(file) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var v = document.createElement('video');
      v.muted = true;
      v.playsInline = true;
      v.preload = 'auto';
      var done = false;
      var timer = setTimeout(function () {
        fail(makeErr('unsupported', '動画を読み込めませんでした'));
      }, META_TIMEOUT);
      function cleanup() {
        clearTimeout(timer);
        v.onloadeddata = null;
        v.onerror = null;
      }
      function fail(err) {
        if (done) return;
        done = true;
        cleanup();
        URL.revokeObjectURL(url);
        v.removeAttribute('src');
        try { v.load(); } catch (e) {}
        reject(err);
      }
      v.onerror = function () { fail(makeErr('unsupported', '動画を読み込めませんでした')); };
      v.onloadeddata = function () {
        if (done) return;
        if (!v.videoWidth || !v.videoHeight || !isFinite(v.duration) || v.duration <= 0) {
          fail(makeErr('unsupported', '動画の映像を読み込めませんでした'));
          return;
        }
        done = true;
        cleanup();
        resolve({ video: v, url: url });
      };
      v.src = url;
    });
  }

  function closeVideo(h) {
    try { h.video.pause(); } catch (e) {}
    h.video.removeAttribute('src');
    try { h.video.load(); } catch (e) {}
    URL.revokeObjectURL(h.url);
  }

  // 指定した秒へ移動して、映像が用意できるまで待つ
  function seek(v, t) {
    return new Promise(function (resolve) {
      if (Math.abs(v.currentTime - t) < 0.0005 && v.readyState >= 2) { resolve(true); return; }
      var finished = false;
      var timer = setTimeout(function () { finish(false); }, SEEK_TIMEOUT);
      function finish(ok) {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        v.removeEventListener('seeked', onSeeked);
        resolve(ok);
      }
      function onSeeked() { finish(true); }
      v.addEventListener('seeked', onSeeked);
      try { v.currentTime = t; } catch (e) { finish(false); }
    });
  }

  // くっきり度：縮小したグレー画像にラプラシアン（4近傍）をかけた値の分散
  function sharpness(v, canvas, ctx) {
    var w = SCORE_W;
    var h = Math.max(2, Math.round(v.videoHeight * w / v.videoWidth));
    if (canvas.width !== w || canvas.height !== h) { canvas.width = w; canvas.height = h; }
    ctx.drawImage(v, 0, 0, w, h);
    var d = ctx.getImageData(0, 0, w, h).data;
    var g = new Float32Array(w * h);
    for (var i = 0, p = 0; i < g.length; i++, p += 4) {
      g[i] = 0.299 * d[p] + 0.587 * d[p + 1] + 0.114 * d[p + 2];
    }
    var sum = 0, sum2 = 0, n = 0;
    for (var y = 1; y < h - 1; y++) {
      for (var x = 1; x < w - 1; x++) {
        var k = y * w + x;
        var l = g[k - 1] + g[k + 1] + g[k - w] + g[k + w] - 4 * g[k];
        sum += l; sum2 += l * l; n++;
      }
    }
    if (!n) return 0;
    var mean = sum / n;
    return sum2 / n - mean * mean;
  }

  function toBlob(canvas, q) {
    return new Promise(function (resolve, reject) {
      canvas.toBlob(function (b) { b ? resolve(b) : reject(makeErr('encode', '画像の作成に失敗しました')); }, 'image/jpeg', q);
    });
  }

  // 動画の今のコマを、長辺 max のJPEGにする
  async function grab(v, max, q) {
    var s = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
    var c = document.createElement('canvas');
    c.width = Math.max(1, Math.round(v.videoWidth * s));
    c.height = Math.max(1, Math.round(v.videoHeight * s));
    c.getContext('2d').drawImage(v, 0, 0, c.width, c.height);
    try {
      return await toBlob(c, q);
    } finally {
      c.width = 0; c.height = 0;
    }
  }

  // くっきり度の高い順に、間隔をあけて n 個の時刻を選ぶ
  function pickTop(scores, from, to, n) {
    var pool = scores.filter(function (s) { return s.t >= from && s.t <= to; })
      .sort(function (a, b) { return b.s - a.s; });
    var out = [];
    for (var i = 0; i < pool.length && out.length < n; i++) {
      var ok = true;
      for (var j = 0; j < out.length; j++) {
        if (Math.abs(out[j].t - pool[i].t) < CAND_MIN_GAP) { ok = false; break; }
      }
      if (ok) out.push(pool[i]);
    }
    return out;
  }

  /**
   * 動画1本から2コマを切り出す
   * 戻り値：{ docBlob, ocrBlob, pkgBlob, docT, pkgT, duration, candDoc:[秒…], candPkg:[秒…], width, height }
   * onProgress(0〜1) が呼ばれる
   */
  async function process(file, onProgress) {
    var h = await openVideo(file);
    try {
      var v = h.video;
      var dur = v.duration;
      var n = Math.max(3, Math.ceil(dur * FPS) + 1);
      var canvas = document.createElement('canvas');
      var ctx = canvas.getContext('2d', { willReadFrequently: true });
      var scores = [];
      var last = Math.max(0, dur - 0.03);   // ぴったり最後は映像が出ないことがあるので少し手前
      for (var i = 0; i < n; i++) {
        var t = Math.min(last, Math.max(0.01, i * dur / (n - 1)));
        var ok = await seek(v, t);
        if (ok) scores.push({ t: t, s: sharpness(v, canvas, ctx) });
        if (onProgress) onProgress((i + 1) / n * 0.8);
      }
      canvas.width = 0; canvas.height = 0;
      if (scores.length < 2) throw makeErr('unsupported', '動画からコマを取り出せませんでした');

      var docEnd = dur * DOC_RANGE;
      var pkgStart = dur * (1 - PKG_RANGE);
      var docTop = pickTop(scores, 0, docEnd, CAND_PER_ROLE);
      var pkgTop = pickTop(scores, pkgStart, dur, CAND_PER_ROLE);
      // 短すぎる動画などで範囲内にコマがないとき：全体から選ぶ
      if (!docTop.length) docTop = pickTop(scores, 0, dur, CAND_PER_ROLE);
      if (!pkgTop.length) pkgTop = pickTop(scores, 0, dur, CAND_PER_ROLE);
      var docT = docTop[0].t, pkgT = pkgTop[0].t;

      await seek(v, docT);
      var docBlob = await grab(v, SHOW_MAX, SHOW_Q);
      var ocrBlob = await grab(v, OCR_MAX, OCR_Q);
      if (onProgress) onProgress(0.9);
      await seek(v, pkgT);
      var pkgBlob = await grab(v, SHOW_MAX, SHOW_Q);
      if (onProgress) onProgress(1);

      return {
        docBlob: docBlob, ocrBlob: ocrBlob, pkgBlob: pkgBlob,
        docT: docT, pkgT: pkgT, duration: dur,
        candDoc: docTop.map(function (x) { return x.t; }),
        candPkg: pkgTop.map(function (x) { return x.t; }),
        width: v.videoWidth, height: v.videoHeight
      };
    } finally {
      closeVideo(h);
    }
  }

  // 候補コマの小さい画像（選び直し画面用）
  async function thumbs(file, times, max) {
    var h = await openVideo(file);
    try {
      var out = [];
      for (var i = 0; i < times.length; i++) {
        var ok = await seek(h.video, times[i]);
        out.push(ok ? await grab(h.video, max || 480, 0.7) : null);
      }
      return out;
    } finally {
      closeVideo(h);
    }
  }

  // 指定した秒のコマを1枚（または表示用＋読み取り用の2枚）作る
  async function frameAt(file, t, max, q) {
    var h = await openVideo(file);
    try {
      var ok = await seek(h.video, t);
      if (!ok) throw makeErr('seek', 'コマを取り出せませんでした');
      return await grab(h.video, max || SHOW_MAX, q || SHOW_Q);
    } finally {
      closeVideo(h);
    }
  }

  async function docFrames(file, t) {
    var h = await openVideo(file);
    try {
      var ok = await seek(h.video, t);
      if (!ok) throw makeErr('seek', 'コマを取り出せませんでした');
      return {
        docBlob: await grab(h.video, SHOW_MAX, SHOW_Q),
        ocrBlob: await grab(h.video, OCR_MAX, OCR_Q)
      };
    } finally {
      closeVideo(h);
    }
  }

  global.VideoImport = {
    isVideo: isVideo,
    process: process,
    thumbs: thumbs,
    frameAt: frameAt,
    docFrames: docFrames
  };
})(window);
