/* MoodLens: live facial emotion detection.
   face-api.js finds faces, landmarks, age and gender; emotions come from the Pro model
   (emotion-pro.js) or face-api's built-in Lite expression model. */
(() => {
  'use strict';

  const MODEL_URL = 'https://cdn.jsdelivr.net/npm/@vladmandic/face-api@1.7.15/model/';
  const HISTORY_MS = 30000;
  const SAMPLE_MS = 200;
  const SMOOTHING = 0.35; // EMA weight for new frames (camera only)
  const MAX_PRO_FACES = 6; // the Pro model runs once per face, so cap the work per frame

  // Valence (negative..positive) and arousal (calm..excited) for each emotion. The Pro model
  // predicts these directly; the Lite model estimates them from its emotion scores.
  const EMOTIONS = {
    happy:     { label: 'Happy',     emoji: '😄', color: '#f5b700', valence: 1,    arousal: 0.4 },
    surprised: { label: 'Surprised', emoji: '😲', color: '#f97316', valence: 0.3,  arousal: 0.8 },
    neutral:   { label: 'Neutral',   emoji: '😐', color: '#94a3b8', valence: 0,    arousal: -0.2 },
    sad:       { label: 'Sad',       emoji: '😢', color: '#3b82f6', valence: -1,   arousal: -0.5 },
    angry:     { label: 'Angry',     emoji: '😠', color: '#ef4444', valence: -1,   arousal: 0.7 },
    fearful:   { label: 'Fearful',   emoji: '😨', color: '#8b5cf6', valence: -0.8, arousal: 0.7 },
    disgusted: { label: 'Disgusted', emoji: '🤢', color: '#22a06b', valence: -0.8, arousal: 0.3 },
    contempt:  { label: 'Contempt',  emoji: '😒', color: '#db2777', valence: -0.6, arousal: 0.1 },
  };
  const KEYS = Object.keys(EMOTIONS);

  // Blends of the two strongest emotions, keyed alphabetically.
  const NUANCES = {
    'happy+surprised': 'Delighted', 'angry+sad': 'Frustrated', 'fearful+surprised': 'Shocked',
    'angry+disgusted': 'Contemptuous', 'fearful+sad': 'Anxious', 'happy+neutral': 'Content',
    'neutral+sad': 'Down', 'angry+neutral': 'Annoyed', 'neutral+surprised': 'Curious',
    'disgusted+sad': 'Hurt', 'angry+surprised': 'Outraged', 'fearful+neutral': 'Uneasy',
    'disgusted+neutral': 'Displeased', 'happy+sad': 'Bittersweet', 'disgusted+surprised': 'Appalled',
    'angry+fearful': 'Threatened', 'disgusted+fearful': 'Repulsed',
    'contempt+happy': 'Smug', 'contempt+neutral': 'Unimpressed', 'angry+contempt': 'Scornful',
    'contempt+disgusted': 'Disdainful', 'contempt+sad': 'Resentful',
  };

  const $ = (id) => document.getElementById(id);
  const el = {
    stage: $('stage'), video: $('video'), photo: $('photo'), overlay: $('overlay'),
    placeholder: $('placeholder'), startBtn: $('startBtn'), stopBtn: $('stopBtn'), snapBtn: $('snapBtn'),
    fileInput: $('fileInput'), cameraSelect: $('cameraSelect'), modeSelect: $('modeSelect'), emotionSelect: $('emotionSelect'),
    mirrorChk: $('mirrorChk'), landmarksChk: $('landmarksChk'), ageChk: $('ageChk'),
    errorMsg: $('errorMsg'), statusPill: $('statusPill'), statusText: $('statusText'),
    fpsBadge: $('fpsBadge'), facesBadge: $('facesBadge'), aiBadge: $('aiBadge'),
    heroCard: $('heroCard'), heroEmoji: $('heroEmoji'), heroLabel: $('heroLabel'), heroConf: $('heroConf'),
    bars: $('bars'), moodDot: $('moodDot'), moodTrail: $('moodTrail'), moodValue: $('moodValue'), modelVal: $('modelVal'),
    ageVal: $('ageVal'), genderVal: $('genderVal'), facesVal: $('facesVal'), detVal: $('detVal'),
    sessionBar: $('sessionBar'), sessionList: $('sessionList'), sessionEmpty: $('sessionEmpty'), resetBtn: $('resetBtn'),
    timeline: $('timeline'), legend: $('legend'), themeBtn: $('themeBtn'),
  };
  const ctx = el.overlay.getContext('2d');

  const state = {
    source: null,          // 'camera' | 'photo' | null
    stream: null,
    running: false,
    ssdLoaded: false,
    modelsReady: false,
    proLoading: false,
    tracks: [],
    nextId: 1,
    history: [],           // [{t, expr|null}]
    lastSample: 0,
    session: Object.fromEntries(KEYS.map((k) => [k, 0])),
    lastSessionRender: 0,
    lastFrame: 0,
    fps: 0,
    lastHeroKey: null,
  };

  // ---------------------------------------------------------------- UI helpers
  function setStatus(kind, text) {
    el.statusPill.className = `pill pill-${kind}`;
    el.statusText.textContent = text;
  }

  function showError(msg) {
    el.errorMsg.textContent = msg;
    el.errorMsg.hidden = !msg;
  }

  function topEmotion(expr) {
    let best = 'neutral';
    for (const k of KEYS) if (expr[k] > expr[best]) best = k;
    return best;
  }

  function nuance(expr) {
    const sorted = KEYS.map((k) => [k, expr[k]]).sort((a, b) => b[1] - a[1]);
    const [[k1, v1], [k2, v2]] = sorted;
    if (v2 >= 0.18) {
      const name = NUANCES[[k1, k2].sort().join('+')];
      if (name) return name;
    }
    if (k1 !== 'neutral') {
      if (v1 > 0.9) return 'strong expression';
      if (v1 < 0.5) return 'subtle expression';
    }
    return null;
  }

  function buildStaticUI() {
    el.bars.innerHTML = KEYS.map((k) => `
      <div class="bar-row" data-k="${k}">
        <span aria-hidden="true">${EMOTIONS[k].emoji}</span>
        <span class="name">${EMOTIONS[k].label}</span>
        <div class="bar-track"><div class="bar-fill" style="background:${EMOTIONS[k].color}"></div></div>
        <span class="val">0%</span>
      </div>`).join('');
    el.legend.innerHTML = KEYS.map((k) =>
      `<span><i style="background:${EMOTIONS[k].color}"></i>${EMOTIONS[k].label}</span>`).join('');
  }

  // Valence runs left (negative) to right (positive); arousal runs bottom (calm) to top (excited).
  function placeMoodDot(dot, valence, arousal) {
    dot.hidden = false;
    dot.style.left = `${((valence + 1) / 2) * 100}%`;
    dot.style.top = `${(1 - (arousal + 1) / 2) * 100}%`;
  }

  function addMoodTrail(valence, arousal) {
    const trail = el.moodTrail;
    const dot = document.createElement('span');
    placeMoodDot(dot, valence, arousal);
    trail.appendChild(dot);
    while (trail.children.length > 24) trail.firstChild.remove();
    [...trail.children].forEach((d, i, all) => { d.style.opacity = ((i + 1) / all.length) * 0.5; });
  }

  function renderModelInfo() {
    el.modelVal.textContent = usingPro()
      ? `Pro · ${EmotionPro.backend === 'webgpu' ? 'GPU' : 'CPU'}`
      : el.emotionSelect.value === 'pro' ? 'Lite (Pro loading…)' : 'Lite';
  }

  function renderPanel(main, faceCount) {
    renderModelInfo();
    el.facesVal.textContent = faceCount;
    if (!main) {
      el.heroEmoji.textContent = state.source ? '🫥' : '😶';
      el.heroLabel.textContent = state.source ? 'No face' : 'Waiting…';
      el.heroConf.textContent = state.source === 'photo'
        ? 'No face found in this photo. Try a clearer, front-facing shot.'
        : state.source ? 'Look at the camera with good lighting' : 'No face detected yet';
      el.heroCard.style.setProperty('--accent', '#94a3b8');
      el.ageVal.textContent = '-';
      el.genderVal.textContent = '-';
      for (const row of el.bars.children) {
        row.classList.remove('top');
        row.querySelector('.bar-fill').style.width = '0%';
        row.querySelector('.val').textContent = '0%';
      }
      el.moodDot.hidden = true;
      el.moodValue.textContent = '-';
      state.lastHeroKey = null;
      return;
    }

    const expr = main.expr;
    const key = topEmotion(expr);
    const info = EMOTIONS[key];
    if (key !== state.lastHeroKey) {
      el.heroEmoji.textContent = info.emoji;
      el.heroEmoji.classList.remove('bump');
      void el.heroEmoji.offsetWidth;
      el.heroEmoji.classList.add('bump');
      setTimeout(() => el.heroEmoji.classList.remove('bump'), 250);
      state.lastHeroKey = key;
    }
    el.heroLabel.textContent = info.label;
    const n = nuance(expr);
    el.heroConf.textContent = `${Math.round(expr[key] * 100)}% confident${n ? ` · ${n.includes(' ') ? n : `feels ${n.toLowerCase()}`}` : ''}`;
    el.heroCard.style.setProperty('--accent', info.color);

    for (const row of el.bars.children) {
      const k = row.dataset.k;
      const pct = Math.round(expr[k] * 100);
      row.classList.toggle('top', k === key);
      row.querySelector('.bar-fill').style.width = `${pct}%`;
      row.querySelector('.val').textContent = `${pct}%`;
    }

    placeMoodDot(el.moodDot, main.valence, main.arousal);
    const signed = (n) => `${n > 0 ? '+' : ''}${Math.round(n * 100)}`;
    el.moodValue.textContent = `mood ${signed(main.valence)} · energy ${signed(main.arousal)}`;

    if (el.ageChk.checked && main.age != null) {
      el.ageVal.textContent = `~${Math.round(main.age)} yrs`;
      el.genderVal.textContent = `${main.gender[0].toUpperCase()}${main.gender.slice(1)} ${Math.round(main.genderProb * 100)}%`;
    } else {
      el.ageVal.textContent = '-';
      el.genderVal.textContent = '-';
    }
  }

  function renderSession() {
    const total = KEYS.reduce((s, k) => s + state.session[k], 0);
    el.sessionEmpty.hidden = total > 0;
    if (total <= 0) {
      el.sessionBar.innerHTML = '';
      el.sessionList.innerHTML = '';
      return;
    }
    const sorted = KEYS.filter((k) => state.session[k] > 0).sort((a, b) => state.session[b] - state.session[a]);
    el.sessionBar.innerHTML = sorted.map((k) =>
      `<span title="${EMOTIONS[k].label}" style="width:${(state.session[k] / total) * 100}%;background:${EMOTIONS[k].color}"></span>`).join('');
    el.sessionList.innerHTML = sorted.map((k) => {
      const secs = state.session[k] / 1000;
      const time = secs >= 60 ? `${Math.floor(secs / 60)}m ${Math.round(secs % 60)}s` : `${secs.toFixed(1)}s`;
      return `<li><span class="sw" style="background:${EMOTIONS[k].color}"></span>${EMOTIONS[k].emoji} ${EMOTIONS[k].label}
              <span class="pct" title="${time}">${Math.round((state.session[k] / total) * 100)}%</span></li>`;
    }).join('');
  }

  // ---------------------------------------------------------------- Timeline chart
  function drawTimeline() {
    const c = el.timeline;
    const dpr = window.devicePixelRatio || 1;
    const w = c.clientWidth, h = c.clientHeight;
    if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
      c.width = Math.round(w * dpr);
      c.height = Math.round(h * dpr);
    }
    const g = c.getContext('2d');
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, w, h);

    const css = getComputedStyle(document.documentElement);
    const grid = css.getPropertyValue('--border').trim();
    const muted = css.getPropertyValue('--muted').trim();
    const padL = 34, padR = 6, padT = 6, padB = 18;
    const cw = w - padL - padR, ch = h - padT - padB;

    g.font = '11px Inter, system-ui, sans-serif';
    g.fillStyle = muted;
    g.strokeStyle = grid;
    g.lineWidth = 1;
    g.textAlign = 'right';
    g.textBaseline = 'middle';
    for (const p of [0, 0.5, 1]) {
      const y = padT + ch - p * ch;
      g.beginPath(); g.moveTo(padL, Math.round(y) + 0.5); g.lineTo(w - padR, Math.round(y) + 0.5); g.stroke();
      g.fillText(`${p * 100}%`, padL - 6, y);
    }
    g.textBaseline = 'alphabetic';
    for (const s of [30, 20, 10, 0]) {
      g.textAlign = s === 30 ? 'left' : s === 0 ? 'right' : 'center';
      g.fillText(s === 0 ? 'now' : `-${s}s`, padL + cw * (1 - s / 30), h - 4);
    }

    const now = performance.now();
    const x = (t) => padL + ((t - (now - HISTORY_MS)) / HISTORY_MS) * cw;
    const y = (v) => padT + ch - v * ch;
    g.lineWidth = 2;
    g.lineJoin = 'round';
    for (const k of KEYS) {
      g.strokeStyle = EMOTIONS[k].color;
      g.beginPath();
      let pen = false;
      for (const s of state.history) {
        if (!s.expr) { pen = false; continue; }
        const px = Math.max(padL, x(s.t)), py = y(s.expr[k]);
        if (pen) g.lineTo(px, py); else { g.moveTo(px, py); pen = true; }
      }
      g.stroke();
    }

    if (!state.history.length) {
      g.fillStyle = muted;
      g.font = '13px Inter, system-ui, sans-serif';
      g.fillText('Start the camera to see your emotions over time', padL + cw / 2, padT + ch / 2);
    }
  }

  // ---------------------------------------------------------------- Models
  async function loadModels() {
    try {
      try { await faceapi.tf.setBackend('webgl'); } catch { /* falls back to default backend */ }
      await faceapi.tf.ready();
      await Promise.all([
        faceapi.nets.tinyFaceDetector.loadFromUri(MODEL_URL),
        faceapi.nets.faceLandmark68Net.loadFromUri(MODEL_URL),
        faceapi.nets.faceExpressionNet.loadFromUri(MODEL_URL),
        faceapi.nets.ageGenderNet.loadFromUri(MODEL_URL),
      ]);
      // Run each network once so the GPU compiles its shaders now, not on the first camera frame.
      const blank = document.createElement('canvas');
      blank.width = blank.height = 112;
      await faceapi.detectAllFaces(blank, new faceapi.TinyFaceDetectorOptions({ inputSize: 160 }));
      await faceapi.nets.faceLandmark68Net.detectLandmarks(blank);
      await faceapi.nets.faceExpressionNet.predictExpressions(blank);
      await faceapi.nets.ageGenderNet.predictAgeAndGender(blank);
      state.modelsReady = true;
    } catch (err) {
      console.error(err);
      setStatus('error', 'Model load failed');
      showError('Could not load the AI models. Check your internet connection and reload the page.');
      return;
    }
    refreshStatus();
    analyzePhoto();
  }

  // The Pro emotion model is larger (~16 MB), so it loads alongside everything else and takes
  // over from Lite once it is warmed up. The camera never waits for it.
  async function loadProModel() {
    state.proLoading = true;
    refreshStatus();
    try {
      await EmotionPro.load();
    } catch (err) {
      console.error(err);
      el.emotionSelect.value = 'lite';
      el.emotionSelect.querySelector('option[value="pro"]').disabled = true;
    }
    state.proLoading = false;
    refreshStatus();
    renderModelInfo();
    analyzePhoto();
  }

  function refreshStatus() {
    el.aiBadge.hidden = !(state.running && !state.modelsReady);
    if (state.running) setStatus('live', 'Live');
    else if (!state.modelsReady) setStatus('loading', 'Loading AI models…');
    else if (state.proLoading) setStatus('loading', 'Loading Pro emotion AI…');
    else setStatus('ready', 'Ready');
  }

  async function ensureSsd() {
    if (state.ssdLoaded) return;
    setStatus('loading', 'Loading accurate model…');
    await faceapi.nets.ssdMobilenetv1.loadFromUri(MODEL_URL);
    state.ssdLoaded = true;
    refreshStatus();
  }

  function detectorOptions() {
    return el.modeSelect.value === 'accurate' && state.ssdLoaded
      ? new faceapi.SsdMobilenetv1Options({ minConfidence: 0.5 })
      : new faceapi.TinyFaceDetectorOptions({ inputSize: 416, scoreThreshold: 0.45 });
  }

  function usingPro() {
    return el.emotionSelect.value === 'pro' && EmotionPro.ready;
  }

  // Detect faces, then attach { expr, valence, arousal } to each result from the chosen emotion model.
  async function detect(input, W, H) {
    const pro = usingPro();
    let task = faceapi.detectAllFaces(input, detectorOptions()).withFaceLandmarks();
    if (!pro) task = task.withFaceExpressions();
    if (el.ageChk.checked) task = task.withAgeAndGender();
    let results = await task;

    if (pro) {
      results = results.sort((a, b) => b.detection.box.area - a.detection.box.area).slice(0, MAX_PRO_FACES);
      for (const r of results) {
        const out = await EmotionPro.classify(input, r.landmarks.positions, W, H);
        r.emo = { expr: out.expressions, valence: out.valence, arousal: out.arousal };
      }
    } else {
      for (const r of results) {
        const expr = Object.fromEntries(KEYS.map((k) => [k, r.expressions[k] || 0]));
        r.emo = {
          expr,
          valence: KEYS.reduce((s, k) => s + expr[k] * EMOTIONS[k].valence, 0),
          arousal: KEYS.reduce((s, k) => s + expr[k] * EMOTIONS[k].arousal, 0),
        };
      }
    }
    return results;
  }

  // ---------------------------------------------------------------- Tracking (keeps per-face smoothing stable)
  function updateTracks(results, now, alpha) {
    const used = new Set();
    const visible = [];
    for (const r of results) {
      const b = r.detection.box;
      const cx = b.x + b.width / 2, cy = b.y + b.height / 2;
      let best = null, bestD = Infinity;
      for (const t of state.tracks) {
        if (used.has(t)) continue;
        const d = Math.hypot(t.cx - cx, t.cy - cy);
        if (d < bestD && d < Math.max(b.width, t.box.width) * 0.8) { best = t; bestD = d; }
      }
      const { expr, valence, arousal } = r.emo;
      if (!best) {
        best = { id: state.nextId++, expr: { ...expr }, valence, arousal, age: r.age, gender: r.gender, genderProb: r.genderProbability };
        state.tracks.push(best);
      } else {
        for (const k of KEYS) best.expr[k] = best.expr[k] * (1 - alpha) + expr[k] * alpha;
        best.valence = best.valence * (1 - alpha) + valence * alpha;
        best.arousal = best.arousal * (1 - alpha) + arousal * alpha;
        if (r.age != null) {
          best.age = best.age == null ? r.age : best.age * (1 - alpha * 0.5) + r.age * alpha * 0.5;
          best.gender = r.gender;
          best.genderProb = r.genderProbability;
        }
      }
      if (r.age == null) best.age = null;
      Object.assign(best, { cx, cy, box: b, landmarks: r.landmarks, lastSeen: now });
      used.add(best);
      visible.push(best);
    }
    state.tracks = state.tracks.filter((t) => now - t.lastSeen < 800);
    return visible;
  }

  // ---------------------------------------------------------------- Overlay drawing
  function roundRect(g, x, y, w, h, r) {
    g.beginPath();
    g.moveTo(x + r, y);
    g.arcTo(x + w, y, x + w, y + h, r);
    g.arcTo(x + w, y + h, x, y + h, r);
    g.arcTo(x, y + h, x, y, r);
    g.arcTo(x, y, x + w, y, r);
    g.closePath();
  }

  function drawOverlay(faces, W, H, mirror) {
    ctx.clearRect(0, 0, W, H);
    const unit = Math.max(W, H) / 640;
    for (const f of faces) {
      let { x, y, width: w, height: h } = f.box;
      if (mirror) x = W - x - w;
      const key = topEmotion(f.expr);
      const info = EMOTIONS[key];

      ctx.lineWidth = Math.max(2, 2.5 * unit);
      ctx.strokeStyle = info.color;
      ctx.shadowColor = 'rgba(0,0,0,.35)';
      ctx.shadowBlur = 6 * unit;
      roundRect(ctx, x, y, w, h, 10 * unit);
      ctx.stroke();
      ctx.shadowBlur = 0;

      if (el.landmarksChk.checked && f.landmarks) {
        ctx.fillStyle = 'rgba(255,255,255,.85)';
        const rad = Math.max(1.2, 1.4 * unit);
        for (const p of f.landmarks.positions) {
          ctx.beginPath();
          ctx.arc(mirror ? W - p.x : p.x, p.y, rad, 0, Math.PI * 2);
          ctx.fill();
        }
      }

      const fs = Math.max(13, Math.round(14 * unit));
      const line1 = `${info.emoji} ${info.label} ${Math.round(f.expr[key] * 100)}%`;
      const line2 = el.ageChk.checked && f.age != null ? `~${Math.round(f.age)} yrs · ${f.gender}` : null;
      ctx.font = `700 ${fs}px Inter, system-ui, "Segoe UI Emoji", sans-serif`;
      const w1 = ctx.measureText(line1).width;
      ctx.font = `500 ${Math.round(fs * 0.8)}px Inter, system-ui, sans-serif`;
      const w2 = line2 ? ctx.measureText(line2).width : 0;
      const padX = fs * 0.6, padY = fs * 0.4;
      const boxW = Math.max(w1, w2) + padX * 2;
      const boxH = fs * (line2 ? 2.2 : 1.25) + padY * 2;
      let bx = Math.min(Math.max(0, x + w / 2 - boxW / 2), W - boxW);
      let by = y - boxH - 6 * unit;
      if (by < 0) by = Math.min(H - boxH, y + h + 6 * unit);

      ctx.fillStyle = info.color;
      roundRect(ctx, bx, by, boxW, boxH, 8 * unit);
      ctx.fill();
      ctx.fillStyle = key === 'happy' || key === 'neutral' ? '#141625' : '#ffffff';
      ctx.textBaseline = 'top';
      ctx.textAlign = 'left';
      ctx.font = `700 ${fs}px Inter, system-ui, "Segoe UI Emoji", sans-serif`;
      ctx.fillText(line1, bx + padX, by + padY);
      if (line2) {
        ctx.globalAlpha = 0.85;
        ctx.font = `500 ${Math.round(fs * 0.8)}px Inter, system-ui, sans-serif`;
        ctx.fillText(line2, bx + padX, by + padY + fs * 1.3);
        ctx.globalAlpha = 1;
      }
    }
  }

  // ---------------------------------------------------------------- Frame handling
  function handleResults(results, inferMs, W, H) {
    const now = performance.now();
    const isCamera = state.source === 'camera';
    const faces = updateTracks(results, now, isCamera ? SMOOTHING : 1);
    const mirror = isCamera && el.mirrorChk.checked;

    if (el.overlay.width !== W || el.overlay.height !== H) {
      el.overlay.width = W;
      el.overlay.height = H;
    }
    drawOverlay(faces, W, H, mirror);

    const main = faces.reduce((a, f) => (!a || f.box.area > a.box.area ? f : a), null);
    renderPanel(main, faces.length);
    el.detVal.textContent = `${Math.round(inferMs)} ms`;
    el.facesBadge.hidden = false;
    el.facesBadge.textContent = `${faces.length} face${faces.length === 1 ? '' : 's'}`;

    if (!isCamera) return;

    const dt = state.lastFrame ? now - state.lastFrame : 0;
    state.lastFrame = now;
    if (dt > 0) {
      state.fps = state.fps ? state.fps * 0.85 + (1000 / dt) * 0.15 : 1000 / dt;
      el.fpsBadge.textContent = `${state.fps.toFixed(0)} FPS`;
    }
    if (main && dt > 0) state.session[topEmotion(main.expr)] += Math.min(dt, 500);
    if (now - state.lastSessionRender > 500) {
      renderSession();
      state.lastSessionRender = now;
    }

    if (now - state.lastSample >= SAMPLE_MS) {
      state.history.push({ t: now, expr: main ? { ...main.expr } : null });
      if (main) addMoodTrail(main.valence, main.arousal);
      while (state.history.length && state.history[0].t < now - HISTORY_MS - 1000) state.history.shift();
      state.lastSample = now;
      drawTimeline();
    }
  }

  async function loop() {
    if (!state.running) return;
    const v = el.video;
    if (state.modelsReady && v.readyState >= 2 && v.videoWidth) {
      try {
        const t0 = performance.now();
        const results = await detect(v, v.videoWidth, v.videoHeight);
        if (state.running) handleResults(results, performance.now() - t0, v.videoWidth, v.videoHeight);
      } catch (err) {
        console.error(err);
      }
    }
    requestAnimationFrame(loop);
  }

  // ---------------------------------------------------------------- Sources
  function showMedia(kind) {
    el.video.hidden = kind !== 'camera';
    el.photo.hidden = kind !== 'photo';
    el.placeholder.hidden = !!kind;
    el.stage.classList.toggle('has-media', !!kind);
    el.video.classList.toggle('mirrored', kind === 'camera' && el.mirrorChk.checked);
    el.snapBtn.disabled = !kind;
    el.stopBtn.disabled = !kind;
    el.fpsBadge.hidden = kind !== 'camera';
    el.facesBadge.hidden = !kind;
  }

  function stopStream() {
    state.running = false;
    if (state.stream) state.stream.getTracks().forEach((t) => t.stop());
    state.stream = null;
    el.video.srcObject = null;
    el.aiBadge.hidden = true;
  }

  async function populateCameras(activeId) {
    try {
      const cams = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'videoinput');
      el.cameraSelect.innerHTML = cams.map((c, i) =>
        `<option value="${c.deviceId}">${(c.label || `Camera ${i + 1}`).replace(/</g, '&lt;')}</option>`).join('');
      if (activeId) el.cameraSelect.value = activeId;
      el.cameraSelect.hidden = cams.length < 2;
    } catch { el.cameraSelect.hidden = true; }
  }

  async function startCamera(deviceId) {
    showError('');
    if (!window.isSecureContext || !navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      showError('Browsers only allow the camera on secure pages. Open this site over https:// (or http://localhost on this computer).');
      return;
    }
    stopStream();
    el.startBtn.disabled = true;
    el.startBtn.textContent = 'Starting…';
    try {
      const video = { width: { ideal: 1280 }, height: { ideal: 720 } };
      if (deviceId) video.deviceId = { exact: deviceId }; else video.facingMode = 'user';
      state.stream = await navigator.mediaDevices.getUserMedia({ video, audio: false });
      el.video.srcObject = state.stream;
      await el.video.play();
      state.source = 'camera';
      state.tracks = [];
      state.lastFrame = 0;
      state.fps = 0;
      state.running = true;
      showMedia('camera');
      refreshStatus();
      const activeId = state.stream.getVideoTracks()[0]?.getSettings().deviceId;
      populateCameras(activeId);
      loop();
    } catch (err) {
      console.error(err);
      stopStream();
      const messages = {
        NotAllowedError: 'Camera permission was blocked. Allow camera access from the icon in your address bar, then try again.',
        NotFoundError: 'No camera was found on this device. You can still analyze a photo.',
        NotReadableError: 'Your camera is busy in another app. Close it and try again.',
        OverconstrainedError: 'That camera could not be opened. Try another one.',
      };
      showError(messages[err.name] || `Could not start the camera (${err.name || err.message}).`);
      refreshStatus();
    } finally {
      el.startBtn.disabled = false;
      el.startBtn.textContent = '▶ Start camera';
    }
  }

  function stopAll() {
    stopStream();
    state.source = null;
    state.tracks = [];
    if (el.photo.src) URL.revokeObjectURL(el.photo.src);
    el.photo.removeAttribute('src');
    ctx.clearRect(0, 0, el.overlay.width, el.overlay.height);
    showMedia(null);
    renderPanel(null, 0);
    el.detVal.textContent = '-';
    refreshStatus();
  }

  async function analyzePhoto() {
    if (!state.modelsReady || state.source !== 'photo' || !el.photo.complete || !el.photo.naturalWidth) return;
    setStatus('loading', 'Analyzing photo…');
    try {
      const t0 = performance.now();
      const results = await detect(el.photo, el.photo.naturalWidth, el.photo.naturalHeight);
      state.tracks = [];
      handleResults(results, performance.now() - t0, el.photo.naturalWidth, el.photo.naturalHeight);
      setStatus('ready', results.length ? `Found ${results.length} face${results.length === 1 ? '' : 's'}` : 'No faces found');
    } catch (err) {
      console.error(err);
      setStatus('error', 'Analysis failed');
    }
  }

  async function loadPhoto(file) {
    if (!file || !file.type.startsWith('image/')) return;
    stopStream();
    if (el.photo.src) URL.revokeObjectURL(el.photo.src);
    el.photo.src = URL.createObjectURL(file);
    try { await el.photo.decode(); } catch {
      showError('That file could not be opened as an image.');
      return;
    }
    state.source = 'photo';
    showMedia('photo');
    await analyzePhoto();
  }

  function snapshot() {
    const media = state.source === 'camera' ? el.video : el.photo;
    const W = el.overlay.width, H = el.overlay.height;
    if (!W || !H) return;
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    const g = c.getContext('2d');
    if (state.source === 'camera' && el.mirrorChk.checked) {
      g.save(); g.translate(W, 0); g.scale(-1, 1); g.drawImage(media, 0, 0, W, H); g.restore();
    } else {
      g.drawImage(media, 0, 0, W, H);
    }
    g.drawImage(el.overlay, 0, 0);
    const a = document.createElement('a');
    a.download = `moodlens-${new Date().toISOString().replace(/[:.]/g, '-')}.png`;
    a.href = c.toDataURL('image/png');
    a.click();
  }

  // ---------------------------------------------------------------- Theme
  function initTheme() {
    let saved = null;
    try { saved = localStorage.getItem('moodlens-theme'); } catch { /* storage unavailable */ }
    if (saved) document.documentElement.dataset.theme = saved;
    el.themeBtn.addEventListener('click', () => {
      const current = document.documentElement.dataset.theme
        || (matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light');
      const next = current === 'dark' ? 'light' : 'dark';
      document.documentElement.dataset.theme = next;
      try { localStorage.setItem('moodlens-theme', next); } catch { /* storage unavailable */ }
      drawTimeline();
    });
  }

  // ---------------------------------------------------------------- Wire up
  function init() {
    buildStaticUI();
    initTheme();
    showMedia(null);
    renderPanel(null, 0);
    drawTimeline();

    el.startBtn.addEventListener('click', () => startCamera(el.cameraSelect.value || undefined));
    el.stopBtn.addEventListener('click', stopAll);
    el.snapBtn.addEventListener('click', snapshot);
    el.fileInput.addEventListener('change', (e) => { loadPhoto(e.target.files[0]); e.target.value = ''; });
    el.cameraSelect.addEventListener('change', () => startCamera(el.cameraSelect.value));
    el.mirrorChk.addEventListener('change', () => el.video.classList.toggle('mirrored', state.source === 'camera' && el.mirrorChk.checked));
    el.landmarksChk.addEventListener('change', analyzePhoto);
    el.ageChk.addEventListener('change', analyzePhoto);
    el.modeSelect.addEventListener('change', async () => {
      if (el.modeSelect.value === 'accurate') {
        try { await ensureSsd(); } catch (err) {
          console.error(err);
          el.modeSelect.value = 'fast';
          setStatus('error', 'Accurate model failed to load');
        }
      }
      analyzePhoto();
    });
    el.emotionSelect.addEventListener('change', () => { renderModelInfo(); analyzePhoto(); });
    el.resetBtn.addEventListener('click', () => {
      for (const k of KEYS) state.session[k] = 0;
      state.history = [];
      el.moodTrail.innerHTML = '';
      renderSession();
      drawTimeline();
    });
    window.addEventListener('resize', drawTimeline);

    // Drag & drop a photo onto the stage
    el.stage.addEventListener('dragover', (e) => e.preventDefault());
    el.stage.addEventListener('drop', (e) => { e.preventDefault(); loadPhoto(e.dataTransfer.files[0]); });

    if (typeof faceapi === 'undefined') {
      setStatus('error', 'Library failed to load');
      showError('The face-api library could not be downloaded. Check your internet connection and reload.');
      return;
    }
    loadModels();
    loadProModel();
  }

  init();
})();
