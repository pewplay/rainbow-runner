/*
 * Rainbow Runner
 * An endless runner: a little green square double-jumps over unicorn horns,
 * leaving a double rainbow behind it.
 *
 * Based on "F1NA113VE1" (Final Level) by Lee Reilly, made for js13kGames 2026.
 * MIT License, Copyright (c) 2026 rainbow-runner contributors (see LICENSE).
 *
 * Rebuilt for PewPlay: readable source, fluid full-window layout (the view gets
 * wider on wide screens, is letterboxed on tall ones), crisp high-DPI canvas,
 * whole-screen tap controls, pause on hidden page, saved best score and mute.
 */
(() => {
  'use strict';

  // ---------------------------------------------------------------------------
  // Constants
  // ---------------------------------------------------------------------------
  const GAME_ID = 'rainbow-runner';
  const TITLE = 'RAINBOW RUNNER';

  const H = 540;          // logical height of the world (fixed)
  const MIN_W = 800;      // narrowest logical width (tall screens are letterboxed)
  const MAX_W = 1280;     // widest logical width (ultra-wide screens are letterboxed)
  const G = 448;          // ground line
  const WT = 48;          // ceiling line used while running upside down
  const PX = 170;         // player's fixed x position
  const WIN = 106496;     // 13 KB worth of bits: reach it to win

  const RAINBOW = ['#ff4d6d', '#ff9f1c', '#ffe45e', '#38d973', '#3fa7ff', '#8e5cff'];
  const MILESTONES = [
    [100, 'STILL ALIVE'],
    [256, 'NICE RUN'],
    [404, 'DEATH NOT FOUND'],
    [512, 'TOO GREEN'],
    [1337, 'LEET MODE'],
    [8192, '1 KB'],
    [65536, '8 KB'],
  ];

  // ---------------------------------------------------------------------------
  // DOM
  // ---------------------------------------------------------------------------
  const stage = document.getElementById('stage');
  const canvas = document.getElementById('game');
  const X = canvas.getContext('2d');
  const overlay = document.getElementById('overlay');
  const muteBtn = document.getElementById('mute');
  const rotateHint = document.getElementById('rotate-hint');

  // ---------------------------------------------------------------------------
  // Storage (all keys prefixed with the game id)
  // ---------------------------------------------------------------------------
  function load(key, fallback) {
    try {
      const v = localStorage.getItem(GAME_ID + ':' + key);
      return v === null ? fallback : v;
    } catch (e) {
      return fallback;
    }
  }
  function save(key, value) {
    try {
      localStorage.setItem(GAME_ID + ':' + key, String(value));
    } catch (e) { /* storage unavailable: ignore */ }
  }

  // ---------------------------------------------------------------------------
  // State
  // ---------------------------------------------------------------------------
  let W = 960;            // current logical width (depends on the screen shape)
  let viewScale = 1;      // CSS pixels per logical pixel
  let uiK = 1;            // extra text scale so HUD text stays readable when small
  let hudInsetR = 24;     // right HUD margin (keeps clear of the mute button)

  let audioCtx = null;
  let muted = load('muted', '0') === '1';
  let mode = 'ready';     // 'ready' | 'play' | 'end'
  let frozen = false;     // paused because the page is hidden / unfocused
  let needResume = false; // waiting for a tap to continue after a pause
  let won = false;
  let pageOn = true;
  let activeId = null;    // pointer currently holding a jump
  let touchUI = matchMedia('(pointer: coarse)').matches;
  let endT = 0;           // time since the run ended (prevents instant restarts)

  let dist = 0;
  let best = +load('best', 0) || 0;
  let speed = 330;
  let next = 1000;        // x position where the next pattern will be emitted
  let obs = [], trail = [], bits = [], fx = [], coins = [];
  let plats = [], ups = [], winds = [], springs = [], solids = [], pits = [];
  let boostT = 0, revT = 0;
  let bonus = 0, combo = 0, maxCombo = 0;
  let msg = '', msgT = 0, shake = 0, beat = 0, seen = {}, t = 0, last = 0;

  const motionQuery = matchMedia('(prefers-reduced-motion: reduce)');
  let rm = motionQuery.matches;

  const p = {
    x: PX, y: G - 24, w: 24, h: 24, vy: 0,
    on: 1, j: 0, coy: 0.1, buf: 0, hold: 0,
    ang: 0, sx: 1, sy: 1, tAng: 0, rolling: 0, ox: 0,
    spr: 0, inv: 0, fall: 0,
  };

  // ---------------------------------------------------------------------------
  // Audio (tiny WebAudio synth; created on the first user gesture)
  // ---------------------------------------------------------------------------
  function initAudio() {
    try {
      if (!audioCtx) {
        const AC = window.AudioContext || window.webkitAudioContext;
        if (!AC) return;
        audioCtx = new AC();
      }
      if (audioCtx.state === 'suspended') audioCtx.resume();
    } catch (e) {
      audioCtx = null;
    }
  }

  function beep(f = 440, d = 0.05, v = 0.03, type = 'square', delay = 0) {
    if (!audioCtx || muted) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const q = audioCtx.currentTime + delay;
    o.type = type;
    o.frequency.setValueAtTime(f, q);
    g.gain.setValueAtTime(v, q);
    g.gain.exponentialRampToValueAtTime(0.0001, q + d);
    o.connect(g).connect(audioCtx.destination);
    o.start(q);
    o.stop(q + d);
  }

  function swoop(a, b, d = 0.1, v = 0.04, type = 'square') {
    if (!audioCtx || muted) return;
    const o = audioCtx.createOscillator();
    const g = audioCtx.createGain();
    const q = audioCtx.currentTime;
    o.type = type;
    o.frequency.setValueAtTime(a, q);
    o.frequency.exponentialRampToValueAtTime(b, q + d);
    g.gain.setValueAtTime(v, q);
    g.gain.exponentialRampToValueAtTime(0.0001, q + d);
    o.connect(g).connect(audioCtx.destination);
    o.start(q);
    o.stop(q + d);
  }

  // Background pulse: a four-note arpeggio ticking along with the run.
  function note() {
    beep(180 + [0, 7, 12, 15][beat++ & 3] * 9, 0.045, 0.012, 'triangle');
  }

  function say(s, d = 1) {
    msg = s;
    msgT = d;
  }

  function clearFx() {
    trail.length = fx.length = bits.length = 0;
    shake = 0;
    p.ang = 0;
    p.rolling = 0;
    p.ox = 0;
    p.sx = p.sy = 1;
  }

  const onMotionChange = (e) => {
    rm = e.matches;
    if (rm) clearFx();
  };
  if (motionQuery.addEventListener) motionQuery.addEventListener('change', onMotionChange);
  else if (motionQuery.addListener) motionQuery.addListener(onMotionChange);

  // ---------------------------------------------------------------------------
  // Layout: fill the window, keep the world 540 units tall
  // ---------------------------------------------------------------------------
  function layout() {
    const vw = Math.max(1, stage.clientWidth || innerWidth);
    const vh = Math.max(1, stage.clientHeight || innerHeight);

    W = Math.round(Math.min(MAX_W, Math.max(MIN_W, (vw / vh) * H)));
    viewScale = Math.min(vw / W, vh / H);

    const cssW = Math.floor(W * viewScale);
    const cssH = Math.floor(H * viewScale);
    canvas.style.width = cssW + 'px';
    canvas.style.height = cssH + 'px';

    const dpr = Math.min(window.devicePixelRatio || 1, 3);
    canvas.width = Math.max(1, Math.round(cssW * dpr));
    canvas.height = Math.max(1, Math.round(cssH * dpr));

    // Text gets a little bigger when the whole view is drawn small.
    uiK = Math.min(1.9, Math.max(1, 0.9 / viewScale));

    // If the canvas reaches the top of the screen, keep the HUD clear of the mute button.
    const canvasTop = (vh - cssH) / 2;
    const canvasRightGap = (vw - cssW) / 2;
    hudInsetR = canvasTop < 60 && canvasRightGap < 60 ? Math.max(24, 64 / viewScale) : 24;

    // Tall (portrait) screens: suggest rotating, just below the game.
    const portrait = vh > vw * 1.05;
    rotateHint.hidden = !portrait;
    if (portrait) rotateHint.style.top = Math.round(canvasTop + cssH + 24) + 'px';
  }

  // ---------------------------------------------------------------------------
  // HTML overlay (title and pause screens)
  // ---------------------------------------------------------------------------
  let overlayKey = '';

  function paint() {
    let key;
    if (needResume) key = 'pause';
    else if (mode === 'ready') key = touchUI ? 'ready-touch' : 'ready-keys';
    else key = '';
    if (key === overlayKey) return;
    overlayKey = key;

    if (!key) {
      overlay.hidden = true;
      overlay.innerHTML = '';
      return;
    }
    overlay.hidden = false;

    if (key === 'pause') {
      overlay.innerHTML =
        '<h2>PAUSED</h2>' +
        '<p>' + (touchUI ? 'Tap' : 'Press any jump key or click') +
        ' to resume &mdash; your run continues from here. Resuming will not make you jump.</p>';
      return;
    }

    const press = touchUI ? 'Tap' : 'Press';
    overlay.innerHTML =
      '<h1>' + TITLE + '</h1>' +
      '<p>Leap the unicorn horns and leave a double rainbow behind you. ' +
      '<span class="k">' + press + '</span> to jump, <span class="k">hold</span> to jump higher, ' +
      '<span class="k">' + press.toLowerCase() + ' again in the air</span> to double&#8209;jump. ' +
      'Grab golden bits for a combo bonus.' +
      (touchUI ? '' : ' <span class="k">M</span> toggles sound.') + '</p>' +
      '<p class="extra">Later on, not everything out there wants to help you: shy platforms, ' +
      'sneaky gusts, half&#8209;hearted springs and very suspicious pick&#8209;ups.</p>' +
      '<p class="cta">' + (touchUI ? 'Tap to start' : 'Press Space or click to start') + '</p>';
  }

  // ---------------------------------------------------------------------------
  // Pause handling
  // ---------------------------------------------------------------------------
  function checkState() {
    const ok = pageOn && !document.hidden;
    if (!ok) {
      if (mode === 'play' && !frozen) {
        frozen = true;
        cancelInput();
      }
    } else if (frozen) {
      needResume = true;
    }
    paint();
  }

  function onResize() {
    layout();
    draw();
  }

  addEventListener('resize', onResize);
  addEventListener('orientationchange', () => setTimeout(onResize, 100));
  if (window.visualViewport) visualViewport.addEventListener('resize', onResize);
  document.addEventListener('visibilitychange', () => {
    pageOn = !document.hidden;
    checkState();
  });
  addEventListener('blur', () => {
    pageOn = false;
    checkState();
  });
  addEventListener('focus', () => {
    pageOn = true;
    checkState();
  });

  // ---------------------------------------------------------------------------
  // Input
  // ---------------------------------------------------------------------------
  function toggleMute() {
    muted = !muted;
    save('muted', muted ? 1 : 0);
    muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
    say(muted ? 'MUTED' : 'SOUND ON', 0.7);
  }

  function startRun() {
    mode = 'play';
    won = false;
    frozen = false;
    needResume = false;
    t = dist = 0;
    speed = 330;
    next = 980;
    obs.length = trail.length = bits.length = fx.length = coins.length = 0;
    plats.length = ups.length = winds.length = springs.length = solids.length = pits.length = 0;
    shake = beat = boostT = revT = 0;
    seen = {};
    bonus = combo = maxCombo = 0;
    Object.assign(p, {
      y: G - p.h, vy: 0, on: 1, j: 0, coy: 0.1, buf: 0, hold: 0,
      ang: 0, sx: 1, sy: 1, tAng: 0, rolling: 0, ox: 0, spr: 0, inv: 0, fall: 0,
    });
    say(TITLE + '  •  GO!', 1.2);
  }

  function cancelInput() {
    p.hold = 0;
    p.buf = 0;
    activeId = null;
  }

  function press() {
    initAudio();
    try { canvas.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
    pageOn = true;
    if (document.hidden) return;
    if (needResume) {
      needResume = false;
      frozen = false;
      last = performance.now();
      paint();
      return;
    }
    if (mode === 'ready' || mode === 'end') {
      if (mode === 'end' && endT < 0.45) return; // don't restart by accident
      startRun();
      p.buf = 0.11;
      p.hold = 1;
      paint();
      return;
    }
    p.buf = 0.11;
    p.hold = 1;
  }

  // Letting go early cuts the jump short ("hold to jump higher").
  function release() {
    const held = p.hold;
    p.hold = 0;
    if (mode === 'play' && !frozen && held && (p.inv ? p.vy > 0 : p.vy < 0)) p.vy *= 0.58;
  }

  const JUMP_KEYS = ['Space', 'ArrowUp', 'KeyW'];

  addEventListener('keydown', (e) => {
    if (e.code === 'KeyM') {
      if (!e.repeat) toggleMute();
      return;
    }
    if (JUMP_KEYS.includes(e.code)) {
      e.preventDefault();
      if (touchUI) {
        touchUI = false;
        paint();
      }
      if (e.target === muteBtn) return;
      if (!e.repeat) press();
    }
  });
  addEventListener('keyup', (e) => {
    if (JUMP_KEYS.includes(e.code)) release();
  });

  stage.addEventListener('pointerdown', (e) => {
    e.preventDefault();
    const isTouch = e.pointerType !== 'mouse';
    if (isTouch !== touchUI) {
      touchUI = isTouch;
      paint();
    }
    if (activeId !== null) return;
    activeId = e.pointerId;
    try { stage.setPointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    press();
  });
  stage.addEventListener('pointerup', (e) => {
    if (e.pointerId !== activeId) return;
    activeId = null;
    try { stage.releasePointerCapture(e.pointerId); } catch (x) { /* ignore */ }
    release();
  });
  stage.addEventListener('pointercancel', (e) => {
    if (e.pointerId === activeId) cancelInput();
  });
  stage.addEventListener('lostpointercapture', (e) => {
    if (e.pointerId === activeId) cancelInput();
  });
  document.addEventListener('contextmenu', (e) => e.preventDefault());

  muteBtn.addEventListener('pointerdown', (e) => {
    e.stopPropagation();
    e.preventDefault();
    toggleMute();
  });
  muteBtn.addEventListener('click', (e) => {
    // Keyboard activation (Enter) only; pointer presses are handled above.
    if (e.detail === 0) toggleMute();
  });

  // ---------------------------------------------------------------------------
  // Player
  // ---------------------------------------------------------------------------
  function burst(x, y, n, spreadX, spreadY, hue, life, upOnly) {
    for (let i = 0; i < n; i++) {
      bits.push([
        x, y,
        (Math.random() - 0.5) * spreadX,
        upOnly ? -Math.random() * spreadY : (Math.random() - 0.5) * spreadY,
        hue === null ? Math.random() * 360 : hue,
        life,
      ]);
    }
  }

  function jump() {
    if (p.fall) return;
    const d = p.inv ? -1 : 1;
    if (p.on || p.coy > 0) {
      p.vy = -520 * d;
      p.on = 0;
      p.coy = 0;
      p.j = 1;
      p.sx = 0.78;
      p.sy = 1.28;
      swoop(280, 680, 0.09, 0.045);
      beep(920, 0.035, 0.018, 'sine', 0.045);
    } else if (p.j < 2) {
      p.vy = -500 * d;
      p.j = 2;
      p.sx = 0.68;
      p.sy = 1.42;
      swoop(440, 1200, 0.12, 0.055);
      beep(1550, 0.045, 0.022, 'sine', 0.055);
      if (!rm) burst(PX + 12, p.y + 12, 14, 220, 220, null, 0.5);
    }
  }

  // ---------------------------------------------------------------------------
  // Level generation
  // ---------------------------------------------------------------------------
  // Obstacle types: 'g' horn on the ground, 'c' horn hanging from the ceiling,
  // 'f' falling horn, 's' spinning horn that flies at you.
  function ob(x, w, h, type, warn, mark) {
    obs.push({
      x, w, h, type,
      y: type === 'c' ? 0 : type === 'f' ? -h : G - h,
      vy: 0,
      warn: warn || 0,
      mark: mark || 0,
      vx: type === 's' ? -(speed + 140) : 0,
    });
  }

  function addCoin(cx) {
    coins.push({ x: cx, y: 343, got: 0, miss: 0 });
  }

  // Emits one pattern starting at x = base and returns where it ends.
  function emit(id, base) {
    const inv = p.inv;
    const gc = inv ? 'c' : 'g';
    switch (id) {
      case 'single': {
        const h = ((inv ? 70 : 46) + Math.random() * 46) | 0;
        ob(base, 26, h, gc);
        if (!inv) addCoin(base + 13);
        return base + 26;
      }
      case 'double': {
        const h1 = ((inv ? 70 : 46) + Math.random() * 26) | 0;
        const h2 = ((inv ? 76 : 52) + Math.random() * 26) | 0;
        ob(base, 24, h1, gc);
        ob(base + 34, 26, h2, gc);
        if (!inv) addCoin(base + 30);
        return base + 60;
      }
      case 'triple': {
        const hs = inv ? [72, 88, 104] : [40, 56, 72];
        for (let i = 0; i < 3; i++) ob(base + i * 32, 22, hs[i], gc);
        return base + 76;
      }
      case 'tall': {
        ob(base, 30, (150 + Math.random() * 30) | 0, gc, 0.7, 1);
        return base + 30;
      }
      case 'ceil': {
        ob(base, 44, (150 + Math.random() * 70) | 0, 'c', 0.6, 1);
        return base + 44;
      }
      case 'fall': {
        ob(base, 28, 58, 'f', 0.7, 1);
        return base + 28;
      }
      case 'bash': {
        plats.push({ x: base, y: G - 78, w: 70, h: 12, dy: 0, shy: 0 });
        return base + 70;
      }
      case 'spring': {
        springs.push({ x: base, y: G - 26, w: 44, h: 26, c: 0 });
        return base + 44;
      }
      case 'wind': {
        winds.push({ x: base, w: 170, warn: 0.95, hit: 0 });
        return base + 170;
      }
      case 'plat': {
        const h = (44 + Math.random() * 40) | 0;
        const w = (64 + Math.random() * 36) | 0;
        solids.push(inv ? { x: base, y: WT, w, h, top: 1 } : { x: base, y: G - h, w, h });
        return base + w;
      }
      case 'stairs': {
        const w = 46;
        for (let i = 0; i < 3; i++) {
          const h = (i + 1) * 30;
          solids.push(inv ? { x: base + i * w, y: WT, w, h, top: 1 } : { x: base + i * w, y: G - h, w, h });
        }
        return base + 3 * w;
      }
      case 'gap': {
        const w = (120 + Math.random() * 40) | 0;
        pits.push(inv ? { x: base, w, top: 1 } : { x: base, w });
        return base + w;
      }
      case 'step': {
        const w = 46;
        const hs = [48, 72];
        if (inv) {
          for (let i = 0; i < 2; i++) solids.push({ x: base + i * w, y: WT, w, h: hs[i], top: 1 });
          solids.push({ x: base + 2 * w, y: WT, w: w + 140, h: 90, top: 1 });
          ob(base + 3 * w + 140, 26, 225, 'c', 0.7, 1);
        } else {
          for (let i = 0; i < 2; i++) solids.push({ x: base + i * w, y: G - hs[i], w, h: hs[i] });
          solids.push({ x: base + 2 * w, y: G - 90, w: w + 140, h: 90 });
          ob(base + 3 * w + 140, 26, 225, 'g', 0.7, 1);
        }
        return base + 3 * w + 170;
      }
      case 'gate': {
        const fh = 90, gh = 96, rh = G - fh - gh;
        ob(base, 42, fh, 'g', 0.6, 1);
        ob(base, 42, rh, 'c', 0.6, 1);
        obs[obs.length - 1].gate = obs[obs.length - 2].gate = 1;
        return base + 42;
      }
      case 'lure':
      case 'rev': {
        ups.push({ x: base + 20, y: 343, k: id === 'lure' ? 1 : 0, got: 0 });
        return base + 40;
      }
      default: { // 'saw'
        ob(base, 74, 22, 's', 0.6, 1);
        return base + 74;
      }
    }
  }

  const GAPS = {
    single: 150, double: 165, triple: 185, tall: 225, ceil: 200, fall: 225, saw: 250,
    bash: 210, spring: 200, wind: 230, lure: 190, rev: 190, plat: 190, stairs: 205,
    gap: 210, step: 235, gate: 210,
  };
  function gapFor(id) {
    return GAPS[id] + speed * 0.55;
  }

  // Picks the next pattern; nastier ones unlock as the run goes on.
  function pattern() {
    const d = Math.min(1, dist / 900);
    const r = Math.random();
    let id;
    if (r < 0.16) id = 'single';
    else if (r < 0.29) id = 'double';
    else if (r < 0.38) id = 'triple';
    else if (r < 0.46 && d > 0.15) id = 'tall';
    else if (r < 0.53 && d > 0.22) id = 'ceil';
    else if (r < 0.59 && d > 0.35) id = 'fall';
    else if (r < 0.63 && d > 0.45) id = 'saw';
    else if (r < 0.67 && d > 0.4) id = 'gate';
    else if (r < 0.7 && d > 0.45) id = 'step';
    else if (r < 0.75 && d > 0.2) id = 'plat';
    else if (r < 0.79 && d > 0.3) id = 'stairs';
    else if (r < 0.84 && d > 0.35) id = 'gap';
    else if (r < 0.88 && d > 0.28) id = 'bash';
    else if (r < 0.92 && d > 0.4) id = 'spring';
    else if (r < 0.95 && d > 0.5) id = 'wind';
    else if (r < 0.98 && d > 0.6) id = 'lure';
    else if (d > 0.7) id = 'rev';
    else id = 'single';
    next = emit(id, next) + gapFor(id);
  }

  // ---------------------------------------------------------------------------
  // Collision helpers
  // ---------------------------------------------------------------------------
  function onTop(o, py) {
    return p.x + p.w > o.x && p.x < o.x + o.w && py + p.h <= o.y + 6 && p.y + p.h >= o.y;
  }
  function onBottom(o, py) {
    return p.x + p.w > o.x && p.x < o.x + o.w && py >= o.y + o.h - 6 && p.y <= o.y + o.h;
  }
  // Forgiving hitboxes: shrunken player box, and only the middle of each horn.
  function collide(o) {
    const ax = p.x + 4, ay = p.y + 4, aw = p.w - 8, ah = p.h - 8;
    if (o.type === 's') return ax < o.x + o.w && ax + aw > o.x && ay < o.y + o.h && ay + ah > o.y;
    const ox = o.x + o.w * 0.24, ow = o.w * 0.52;
    if (o.type === 'c') return ax < ox + ow && ax + aw > ox && ay < o.h * 0.76 && ay + ah > 0;
    const top = o.y + o.h * 0.2;
    return ax < ox + ow && ax + aw > ox && ay < o.y + o.h && ay + ah > top;
  }

  function stepBits(dt) {
    for (const b of bits) {
      b[0] += b[2] * dt;
      b[1] += b[3] * dt;
      b[3] += 500 * dt;
      b[5] -= dt;
    }
    bits = bits.filter((b) => b[5] > 0);
  }

  // ---------------------------------------------------------------------------
  // End of run
  // ---------------------------------------------------------------------------
  function die() {
    mode = 'end';
    endT = 0;
    best = Math.max(best, dist | 0);
    save('best', best);
    swoop(190, 42, 0.26, 0.09, 'sawtooth');
    beep(62, 0.32, 0.05, 'square', 0.025);
    beep(38, 0.38, 0.035, 'sine', 0.05);
    if (!rm) {
      shake = 14;
      burst(PX + 12, p.y + 12, 28, 460, 460, null, 0.8);
      for (let i = bits.length - 28; i < bits.length; i++) bits[i][4] = 110 + Math.random() * 40;
    }
    cancelInput();
    msgT = 0;
    paint();
  }

  function win() {
    mode = 'end';
    endT = 0;
    won = true;
    dist = WIN;
    best = Math.max(best, WIN);
    save('best', best);
    beep(523, 0.18, 0.05);
    beep(659, 0.18, 0.05, 'square', 0.16);
    beep(784, 0.24, 0.05, 'square', 0.32);
    beep(1047, 0.45, 0.06, 'sine', 0.5);
    if (!rm) {
      shake = 18;
      burst(W / 2, H / 2, 120, 800, 600, null, 1.5);
    }
    cancelInput();
    msgT = 0;
    paint();
  }

  // ---------------------------------------------------------------------------
  // Update
  // ---------------------------------------------------------------------------
  function update(dt) {
    if (frozen) return;
    t += dt;
    if (mode !== 'play') {
      endT += dt;
      stepBits(dt);
      return;
    }

    dist += (speed * dt) / 20;
    if (dist >= WIN) {
      win();
      return;
    }
    speed = Math.min(590, 330 + dist * 0.19);
    if (boostT > 0) boostT -= dt;
    if (revT > 0) revT -= dt;
    const kf = (revT > 0 ? -0.6 : 1) * (boostT > 0 ? 1.5 : 1);
    const ws = speed * kf; // world scroll speed

    // Buffered jump + coyote time.
    p.buf -= dt;
    p.coy = p.on ? 0.1 : p.coy - dt;
    if (p.buf > 0 && (p.on || p.coy > 0 || p.j < 2)) {
      p.buf = 0;
      jump();
    }
    p.ox += ((rm || revT <= 0 ? 0 : -78) - p.ox) * Math.min(1, dt * 7);

    // Wind tunnels flip gravity.
    let liveW = null;
    for (const q of winds) {
      q.x -= ws * dt;
      if (q.warn > 0) q.warn -= dt;
      else if (p.x + p.w > q.x + 8 && p.x < q.x + q.w - 8) liveW = q;
    }
    winds = winds.filter((q) => q.x + q.w > -60);
    if (liveW && !liveW.hit && !p.fall) {
      liveW.hit = 1;
      p.inv ^= 1;
      p.y = p.inv ? WT : G - p.h;
      p.vy = 0;
      p.on = 1;
      p.j = 0;
      p.coy = 0.1;
      say(p.inv ? 'CEILING RUN  •  STAY UP' : 'FLOOR AGAIN  •  DOWN YOU GO', 0.9);
      swoop(180, 760, 0.22, 0.045, 'triangle');
    }

    // Springs give up halfway.
    if (p.spr > 0) {
      p.spr -= dt;
      if (p.spr <= 0 && p.vy < 0) {
        p.vy *= 0.72;
        beep(240, 0.05, 0.014, 'triangle');
      }
    }

    // Gravity and landing.
    p.vy += 1450 * dt * (p.inv ? -1 : 1);
    const py = p.y;
    p.y += p.vy * dt;
    let pit = 0, cpit = 0;
    for (const s of pits) {
      if (s.x < PX + 12 && s.x + s.w > PX + 12) {
        if (s.top) cpit = 1;
        else pit = 1;
      }
    }

    if (p.fall) {
      p.on = 0;
    } else if (p.inv) {
      let ct = null;
      if (p.vy < 0) {
        for (const q of solids) {
          if (q.top && onBottom(q, py)) {
            const b = q.y + q.h;
            if (ct === null || b > ct) ct = b;
          }
        }
      }
      if (ct !== null) {
        p.y = ct; p.vy = 0; p.on = 1; p.j = 0; p.coy = 0.1;
      } else if (!cpit && p.y <= WT) {
        p.y = WT; p.vy = 0; p.on = 1; p.j = 0; p.coy = 0.1;
      } else {
        p.on = 0;
      }
    } else if (!pit && p.y >= G - p.h) {
      if (!p.on) {
        // Landing: roll to the next quarter turn and squash.
        const q = Math.PI / 2;
        const k = p.ang / q;
        const fk = Math.round(k);
        p.tAng = Math.abs(k - fk) < 1e-6 ? fk * q : (Math.floor(k) + 1) * q;
        p.rolling = 1;
        if (p.vy > 260) {
          p.sx = 1.25;
          p.sy = 0.72;
          swoop(210, 105, 0.06, 0.026, 'triangle');
          beep(120, 0.035, 0.014, 'sine', 0.025);
          if (!rm) {
            shake = Math.min(5, p.vy / 120);
            for (let i = 0; i < 4; i++) bits.push([PX + 12, G, (Math.random() - 0.5) * 90, -Math.random() * 90, 110, 0.28]);
          }
        }
      }
      p.y = G - p.h; p.vy = 0; p.on = 1; p.j = 0;
    } else {
      p.on = 0;
      if (p.vy > 0) {
        for (const q of solids) if (onTop(q, py)) { p.y = q.y - p.h; p.vy = 0; p.on = 1; p.j = 0; p.coy = 0.1; }
        for (const q of plats) if (onTop(q, py)) { p.y = q.y - p.h; p.vy = 0; p.on = 1; p.j = 0; p.coy = 0.1; }
        for (const q of springs) {
          if (onTop(q, py)) {
            p.y = q.y - p.h;
            p.vy = -360;
            p.j = 1;
            p.spr = 0.17;
            q.c = 0.18;
            p.sx = 1.18;
            p.sy = 0.82;
            swoop(300, 540, 0.1, 0.032, 'triangle');
            say('BOING… ISH', 0.6);
          }
        }
      }
    }

    // Once through a surface, keep falling even after the pit scrolls away.
    if (!p.on && (p.inv ? p.y < WT : p.y > G - p.h)) p.fall = 1;
    if (p.inv ? p.y < -40 : p.y > H + 40) {
      die();
      return;
    }

    // Step up onto low blocks instead of bumping into them.
    if (p.on && !p.inv) {
      const ft = p.y + p.h;
      let to = null;
      for (const q of solids) {
        if (!q.top && p.x + p.w > q.x && p.x < q.x + q.w) {
          const up = ft - q.y;
          if (up > 0 && up <= 34 && (to === null || q.y < to)) to = q.y;
        }
      }
      if (to !== null) { p.y = to - p.h; p.vy = 0; p.j = 0; p.coy = 0.1; }
    }
    if (p.on && p.inv) {
      let to = null;
      for (const q of solids) {
        if (q.top && p.x + p.w > q.x && p.x < q.x + q.w) {
          const b = q.y + q.h;
          const d = b - p.y;
          if (d > 0 && d <= 34 && (to === null || b > to)) to = b;
        }
      }
      if (to !== null) { p.y = to; p.vy = 0; p.j = 0; p.coy = 0.1; }
    }

    // Squash & stretch, spin.
    p.sx += (1 - p.sx) * dt * 18;
    p.sy += (1 - p.sy) * dt * 18;
    if (rm) {
      p.ang = 0;
      p.rolling = 0;
    } else if (p.on) {
      if (p.rolling) {
        p.ang += dt * 9;
        if (p.ang >= p.tAng) {
          p.ang = p.tAng % (Math.PI * 2);
          p.rolling = 0;
        }
      }
    } else {
      p.ang += dt * (p.j === 2 ? 5 : 3);
    }

    // Rainbow trail, particles and background sparkles.
    if (rm) {
      trail.length = fx.length = bits.length = 0;
    } else {
      if (!p.on) trail.push([PX - 2, p.y + 12, 1, 18 + (p.j > 1) * 7]);
      for (const q of trail) {
        q[0] -= ws * dt;
        q[2] -= dt * 1.6;
      }
      trail = trail.filter((q) => q[2] > 0 && q[0] > -40);
      stepBits(dt);
      for (const e of fx) e[3] -= dt;
      fx = fx.filter((e) => e[3] > 0);
      if (Math.random() < dt * 1.7) {
        fx.push([Math.random() * W, 40 + Math.random() * (G - 130), 50 + Math.random() * 160, 0.08 + Math.random() * 0.25, Math.random() * 360]);
      }
    }

    // Scroll the world and spawn new patterns just off-screen.
    next -= ws * dt;
    while (next < W + 180) pattern();

    for (const o of obs) {
      if (o.warn > 0) o.warn -= dt;
      if (o.type === 's') {
        if (o.warn <= 0) o.x += o.vx * kf * dt;
      } else {
        o.x -= ws * dt;
        if (o.type === 'f' && o.warn <= 0) {
          o.vy += 1150 * dt;
          o.y += o.vy * dt;
          if (o.y + o.h > G) {
            o.y = G - o.h;
            o.vy = 0;
          }
        }
      }
    }

    // Shy platforms run away when you get close.
    for (const q of plats) {
      q.x -= ws * dt;
      if (!q.shy && q.x - p.x < 150) {
        q.shy = 1;
        say('THE PLATFORM IS SHY', 0.7);
        beep(430, 0.06, 0.016, 'sine');
        beep(300, 0.07, 0.014, 'sine', 0.06);
      }
      if (q.shy) {
        q.dy += 620 * dt;
        q.y += q.dy * dt;
        q.x += 95 * dt;
      }
    }
    plats = plats.filter((q) => q.x > -140 && q.y < H + 40);

    for (const q of springs) {
      q.x -= ws * dt;
      if (q.c > 0) q.c -= dt;
    }
    springs = springs.filter((q) => q.x > -80);
    for (const s of solids) s.x -= ws * dt;
    solids = solids.filter((s) => s.x + s.w > -60);
    for (const s of pits) s.x -= ws * dt;
    pits = pits.filter((s) => s.x + s.w > -60);

    // Suspicious pick-ups: a speed boost and a reverse.
    for (const u of ups) {
      u.x -= ws * dt;
      if (!u.got && p.x < u.x + 11 && p.x + p.w > u.x - 11 && p.y < u.y + 11 && p.y + p.h > u.y - 11) {
        u.got = 1;
        if (u.k) {
          boostT = 1.3;
          say('FREE SPEED  •  NO REFUNDS', 1.3);
          swoop(880, 170, 0.2, 0.05, 'sawtooth');
          beep(90, 0.16, 0.03, 'square', 0.06);
        } else {
          revT = 0.6;
          say('REVERSE  •  YOU ASKED FOR THIS', 1.1);
          swoop(220, 780, 0.2, 0.045, 'triangle');
        }
        if (!rm) burst(u.x, u.y, 8, 180, 180, u.k ? 0 : 220, 0.4);
      }
    }
    ups = ups.filter((u) => !u.got && u.x > -60);

    // Golden bits: chain them for a combo bonus.
    for (const c of coins) {
      c.x -= ws * dt;
      if (!c.got && !c.miss) {
        if (p.x < c.x + 9 && p.x + p.w > c.x - 9 && p.y < c.y + 9 && p.y + p.h > c.y - 9) {
          c.got = 1;
          combo++;
          if (combo > maxCombo) maxCombo = combo;
          const v = Math.min(combo, 10) * 10;
          bonus += v;
          say('+' + v + ' BONUS  •  COMBO x' + combo, 0.8);
          beep(760 + combo * 45, 0.05, 0.02, 'triangle');
          beep(1240, 0.05, 0.014, 'sine', 0.045);
          if (!rm) burst(c.x, c.y, 6, 140, 140, null, 0.4, true);
        } else if (c.x + 9 < p.x) {
          c.miss = 1;
          combo = 0;
        }
      }
    }
    coins = coins.filter((c) => c.x > -40);

    for (const o of obs) {
      if (o.warn <= 0 && collide(o)) {
        die();
        return;
      }
    }
    obs = obs.filter((o) => o.x > -120 && o.y < H + 100);

    if (msgT > 0) msgT -= dt;

    for (const [m, s] of MILESTONES) {
      if (dist >= m && !seen[m]) {
        seen[m] = 1;
        say(m.toLocaleString('en-US') + ' BITS  •  ' + s, 1.5);
        beep(620, 0.12, 0.035);
        beep(930, 0.12, 0.03, 'square', 0.11);
        if (m === 1337 && !rm) {
          shake = 9;
          burst(W / 2, H / 2, 50, 650, 480, null, 1);
        }
      }
    }
    if (t > beat * 0.24) note();
  }

  // ---------------------------------------------------------------------------
  // Drawing
  // ---------------------------------------------------------------------------
  function hornPath(x, y, w, h, down) {
    X.beginPath();
    if (down) {
      X.moveTo(x, 0);
      X.lineTo(x + w, 0);
      X.lineTo(x + w / 2, h);
    } else {
      X.moveTo(x, y + h);
      X.lineTo(x + w, y + h);
      X.lineTo(x + w / 2, y);
    }
    X.closePath();
  }

  // Rainbow-striped fill used inside a clipped horn shape.
  function hornStripes(x, y, w, h) {
    X.fillStyle = '#fffdf8';
    X.fillRect(x - 2, y, w + 4, h);
    for (let k = 0; k < h + 9; k += 8) {
      X.fillStyle = RAINBOW[((k / 8) | 0) % 6];
      X.fillRect(x - 2, y + h - k - 6, w + 4, 5);
    }
    X.strokeStyle = '#fff9';
    X.lineWidth = 2;
    X.stroke();
    X.beginPath();
    X.moveTo(x + w * 0.65, y + h * 0.1);
    X.lineTo(x + w * 0.45, y + h * 0.88);
    X.strokeStyle = '#ffffff66';
    X.stroke();
  }

  function drawHorn(o) {
    X.save();
    if (o.type === 's') {
      const { x, y, w, h } = o;
      X.translate(x + w / 2, y + h / 2);
      X.rotate(rm ? 0 : -t * 9);
      X.beginPath();
      X.moveTo(0, -w / 2);
      X.lineTo(-h / 2, w / 2);
      X.lineTo(h / 2, w / 2);
      X.closePath();
      X.clip();
      hornStripes(-h / 2, -w / 2, h, w);
      X.restore();
    } else {
      const { x, w, h } = o;
      const down = o.type === 'c';
      const y = down ? 0 : o.y;
      hornPath(x, y, w, h, down);
      X.clip();
      hornStripes(x, y, w, h);
      X.restore();
      hornPath(x, y, w, h, down);
      X.strokeStyle = '#fff9';
      X.lineWidth = 2;
      X.stroke();
    }
    // Blinking "!" warning over dangerous horns.
    if (o.mark) {
      const down = o.type === 'c';
      X.fillStyle = '#fff';
      X.globalAlpha = rm ? 1 : 0.35 + 0.65 * Math.abs(Math.sin(t * 12));
      X.font = 'bold 30px monospace';
      X.fillText('!', o.x + o.w / 2 - 9, down ? o.h + 35 : Math.max(35, o.y - 12));
      X.globalAlpha = 1;
    }
  }

  function drawCoin(c) {
    X.save();
    X.translate(c.x, c.y);
    if (!rm) X.rotate(t * 3);
    const g = X.createLinearGradient(-8, 0, 8, 0);
    g.addColorStop(0, '#ffe45e');
    g.addColorStop(1, '#ff9f1c');
    X.fillStyle = g;
    X.strokeStyle = '#fff';
    X.lineWidth = 2;
    X.beginPath();
    X.moveTo(0, -8);
    X.lineTo(8, 0);
    X.lineTo(0, 8);
    X.lineTo(-8, 0);
    X.closePath();
    X.fill();
    X.stroke();
    X.restore();
  }

  function drawPlat(q) {
    X.save();
    X.translate(q.x, q.y + (rm || q.shy ? 0 : Math.sin(t * 7 + q.x * 0.05) * 2));
    X.fillStyle = '#161b22';
    X.fillRect(0, 0, q.w, q.h);
    for (let i = 0; i < 6; i++) {
      X.fillStyle = RAINBOW[i];
      X.fillRect((i * q.w) / 6, 0, q.w / 6, 4);
    }
    X.strokeStyle = q.shy ? '#ff4d6d' : '#fff9';
    X.lineWidth = 2;
    X.strokeRect(0, 0, q.w, q.h);
    X.fillStyle = q.shy ? '#ff4d6d' : '#7ee787';
    X.font = 'bold 13px monospace';
    X.fillText(q.shy ? '>_<' : '^_^', q.w / 2 - 13, -5);
    X.restore();
  }

  function drawSolid(s) {
    X.fillStyle = '#161b22';
    X.fillRect(s.x, s.y, s.w, s.h);
    X.fillStyle = '#39d353';
    X.fillRect(s.x, s.top ? s.y + s.h - 4 : s.y, s.w, 4);
    X.strokeStyle = '#30363d';
    X.lineWidth = 2;
    X.strokeRect(s.x, s.y, s.w, s.h);
  }

  function drawPit(s) {
    X.fillStyle = '#07090d';
    X.strokeStyle = '#ff4d6d';
    X.lineWidth = 2;
    X.beginPath();
    if (s.top) {
      X.fillRect(s.x, 0, s.w, WT + 1);
      X.moveTo(s.x, WT + 10);
      X.lineTo(s.x, WT - 44);
      X.moveTo(s.x + s.w, WT + 10);
      X.lineTo(s.x + s.w, WT - 44);
    } else {
      X.fillRect(s.x, G - 1, s.w, H - G + 2);
      X.moveTo(s.x, G - 10);
      X.lineTo(s.x, G + 44);
      X.moveTo(s.x + s.w, G - 10);
      X.lineTo(s.x + s.w, G + 44);
    }
    X.stroke();
  }

  function drawSpring(q) {
    X.save();
    X.translate(q.x, q.y);
    const d = q.c > 0 ? (q.h * 0.5 * q.c) / 0.18 : 0;
    X.strokeStyle = '#8e5cff';
    X.lineWidth = 3;
    X.beginPath();
    X.moveTo(5, q.h);
    for (let i = 1; i <= 5; i++) X.lineTo(i & 1 ? q.w - 5 : 5, q.h - (i * (q.h - d - 6)) / 5);
    X.stroke();
    X.fillStyle = '#ffe45e';
    X.fillRect(0, d, q.w, 6);
    X.strokeStyle = '#fff9';
    X.lineWidth = 2;
    X.strokeRect(0, d, q.w, 6);
    X.restore();
  }

  function drawPickup(u) {
    const col = u.k ? '#ff4d6d' : '#3fa7ff';
    X.save();
    X.translate(u.x, u.y);
    if (!rm) X.rotate(t * (u.k ? 4 : 2));
    X.fillStyle = col;
    X.strokeStyle = '#fff';
    X.lineWidth = 2;
    X.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i * Math.PI) / 4;
      const r = i & 1 ? 5 : 13;
      if (i) X.lineTo(Math.cos(a) * r, Math.sin(a) * r);
      else X.moveTo(Math.cos(a) * r, Math.sin(a) * r);
    }
    X.closePath();
    X.fill();
    X.stroke();
    X.restore();
    X.fillStyle = col;
    X.globalAlpha = rm ? 1 : 0.35 + 0.65 * Math.abs(Math.sin(t * 12));
    X.font = 'bold 22px monospace';
    X.textAlign = 'center';
    X.fillText(u.k ? '!' : '⇄', u.x, u.y - 20);
    X.textAlign = 'left';
    X.globalAlpha = 1;
  }

  function drawWind(q) {
    const on = q.warn <= 0;
    const sp = G - 130;
    const col = on ? '#8e5cff' : '#ff9f1c';
    X.save();
    X.fillStyle = col;
    X.globalAlpha = on ? 0.1 : 0.05 + (rm ? 0 : 0.05 * Math.abs(Math.sin(t * 12)));
    X.fillRect(q.x, 40, q.w, G - 40);
    X.globalAlpha = on ? 0.6 : 0.4;
    X.strokeStyle = col;
    X.lineWidth = 2;
    X.strokeRect(q.x, 40, q.w, G - 40);
    X.beginPath();
    for (let i = 0; i < 5; i++) {
      const xx = q.x + 14 + (i * (q.w - 28)) / 4;
      const yy = on ? 60 + ((((rm ? 0 : -t * 260) + i * 74) % sp) + sp) % sp : 96 + i * 14;
      if (on) {
        X.moveTo(xx, yy + 22); X.lineTo(xx, yy);
        X.moveTo(xx - 5, yy + 7); X.lineTo(xx, yy); X.lineTo(xx + 5, yy + 7);
      } else {
        X.moveTo(xx, yy); X.lineTo(xx, yy + 22);
        X.moveTo(xx - 5, yy + 15); X.lineTo(xx, yy + 22); X.lineTo(xx + 5, yy + 15);
      }
    }
    X.stroke();
    X.restore();
    if (!on) {
      X.fillStyle = '#ff9f1c';
      X.globalAlpha = rm ? 1 : 0.35 + 0.65 * Math.abs(Math.sin(t * 12));
      X.font = 'bold 26px monospace';
      X.textAlign = 'center';
      X.fillText('!', q.x + q.w / 2, 74);
      X.textAlign = 'left';
      X.globalAlpha = 1;
    }
  }

  function drawPlayer() {
    X.save();
    X.translate(PX + 12 + p.ox, p.y + 12);
    X.rotate(p.ang + (p.inv ? Math.PI : 0));
    X.scale(p.sx, p.sy);
    if (!rm) {
      X.shadowColor = '#39d353';
      X.shadowBlur = 16;
    }
    X.fillStyle = '#39d353';
    X.fillRect(-12, -12, 24, 24);
    X.shadowBlur = 0;
    X.fillStyle = '#7ee787';
    X.fillRect(-8, -8, 7, 7);
    X.restore();
  }

  // Sets a font no larger than `size` that fits `text` inside `maxW`.
  function fitFont(text, size, maxW, weight) {
    X.font = (weight ? weight + ' ' : '') + size + 'px monospace';
    const w = X.measureText(text).width;
    if (w > maxW) X.font = (weight ? weight + ' ' : '') + Math.floor((size * maxW) / w) + 'px monospace';
  }

  function drawHud() {
    const s14 = Math.round(14 * uiK);
    const s20 = Math.round(20 * uiK);
    const top = Math.round(34 * uiK);

    // Title with a rainbow gradient.
    X.font = 'bold ' + s20 + 'px monospace';
    const tw = X.measureText(TITLE).width;
    const grad = X.createLinearGradient(24, 0, 24 + tw, 0);
    RAINBOW.forEach((c, i) => grad.addColorStop(i / 5, c));
    X.fillStyle = grad;
    X.textAlign = 'left';
    X.fillText(TITLE, 24, top);

    const R = W - hudInsetR;
    X.textAlign = 'right';
    X.fillStyle = '#fff';
    X.fillText((dist | 0).toLocaleString('en-US') + ' bits', R, top);
    X.font = s14 + 'px monospace';
    X.fillStyle = '#8b949e';
    X.fillText('BEST ' + best.toLocaleString('en-US'), R, top + s14 + 8);
    if (bonus || combo) {
      X.fillStyle = '#ffe45e';
      X.fillText('BONUS ' + bonus + (combo > 1 ? '  x' + combo : ''), R, top + 2 * (s14 + 6) + 2);
    }

    X.textAlign = 'left';
    X.fillStyle = '#8b949e';
    const help = touchUI
      ? 'TAP = JUMP  •  HOLD = HIGHER  •  TAP AGAIN IN THE AIR = DOUBLE JUMP'
      : 'SPACE / CLICK = JUMP  •  HOLD = HIGHER  •  AGAIN IN THE AIR = DOUBLE JUMP  •  M = MUTE';
    fitFont(help, s14, W - 48);
    X.fillText(help, 24, H - 18);

    if (msgT > 0) {
      X.textAlign = 'center';
      X.fillStyle = '#fff';
      fitFont(msg, Math.round(24 * uiK), W - 2 * hudInsetR - 40, 'bold');
      X.fillText(msg, W / 2, top + Math.round(58 * uiK));
      X.textAlign = 'left';
    }
  }

  function drawEnd() {
    const k = Math.min(uiK, 1.5);
    const line = (text, size, color, y, bold = true) => {
      X.fillStyle = color;
      fitFont(text, Math.round(size * k), W - 48, bold ? 'bold' : '');
      X.fillText(text, W / 2, H / 2 + y * k);
    };
    X.fillStyle = 'rgba(7,9,13,.6)';
    X.fillRect(0, 0, W, H);
    X.textAlign = 'center';
    line(won ? 'FINAL LEVEL CLEARED' : 'COMMIT REJECTED', 34, won ? '#39d353' : '#fff', -36);
    line((dist | 0).toLocaleString('en-US') + ' BITS', 22, '#fff', 4);
    if (bonus) line('+ ' + bonus + ' BONUS' + (maxCombo > 1 ? '  (COMBO x' + maxCombo + ')' : ''), 22, '#ffe45e', 34);
    const newBest = !won && (dist | 0) >= best && best > 0;
    line(won ? 'YOU WIN!' : newBest ? 'NEW BEST!' : 'BEST ' + best.toLocaleString('en-US') + ' bits', 16, won || newBest ? '#fff' : '#39d353', 64);
    if (endT >= 0.45) {
      const again = (touchUI ? 'TAP' : 'PRESS SPACE / CLICK') + (won ? ' TO RUN IT AGAIN' : ' TO TRY AGAIN');
      X.globalAlpha = rm ? 1 : 0.6 + 0.4 * Math.abs(Math.sin(t * 3));
      line(again, 17, '#fff', 100, false);
      X.globalAlpha = 1;
    }
    X.textAlign = 'left';
  }

  function draw() {
    const k = canvas.width / W;
    X.setTransform(k, 0, 0, k, 0, 0);
    X.save();
    if (shake) {
      if (!rm) X.translate((Math.random() - 0.5) * shake, (Math.random() - 0.5) * shake);
      shake *= 0.82;
      if (shake < 0.05) shake = 0;
    }

    X.fillStyle = '#07090d';
    X.fillRect(-20, -20, W + 40, H + 40);

    // Parallax "contribution grid" squares.
    for (let L = 0; L < 3; L++) {
      const s = [16, 24, 32][L];
      const off = rm ? 0 : (t * speed * [0.08, 0.15, 0.25][L]) % s;
      X.globalAlpha = [0.08, 0.07, 0.05][L];
      X.fillStyle = L === 2 ? '#39d353' : '#8b949e';
      for (let x = -s; x < W + s; x += s) {
        for (let y = 45 + L * 22; y < G - 40; y += s * 2) {
          const n = (((x / s) * 17 + (y / s) * 13 + L * 7) | 0) % 9;
          if (!n) X.fillRect(x - off, y, s * 0.45, s * 0.45);
        }
      }
    }
    X.globalAlpha = 1;

    // Faint rainbow sparkles.
    if (!rm) {
      for (const e of fx) {
        X.globalAlpha = e[3] * 1.7;
        X.strokeStyle = 'hsl(' + e[4] + ' 95% 65%)';
        X.lineWidth = 1.3;
        X.beginPath();
        X.moveTo(e[0], e[1]);
        for (let i = 1; i < 5; i++) X.lineTo(e[0] + (e[2] * i) / 4, e[1] + (Math.random() - 0.5) * 18);
        X.stroke();
      }
      X.globalAlpha = 1;
    }

    // Ground line.
    X.strokeStyle = '#1d2630';
    X.lineWidth = 2;
    X.beginPath();
    X.moveTo(0, G);
    X.lineTo(W, G);
    X.stroke();

    for (const s of pits) drawPit(s);
    for (const s of solids) drawSolid(s);
    for (const q of winds) drawWind(q);

    // Double rainbow trail.
    if (!rm) {
      for (const q of trail) {
        X.globalAlpha = Math.max(0, q[2]) * 0.85;
        for (let i = 0; i < 6; i++) {
          X.fillStyle = RAINBOW[i];
          X.fillRect(q[0], q[1] - 6 + i * 2, q[3], 2);
        }
      }
      X.globalAlpha = 1;
    }

    for (const q of plats) drawPlat(q);
    for (const q of springs) drawSpring(q);
    for (const o of obs) drawHorn(o);
    for (const c of coins) if (!c.got) drawCoin(c);
    for (const u of ups) drawPickup(u);

    for (const b of bits) {
      X.globalAlpha = Math.max(0, b[5]);
      X.fillStyle = 'hsl(' + b[4] + ' 90% 60%)';
      X.fillRect(b[0], b[1], 5, 5);
    }
    X.globalAlpha = 1;

    drawPlayer();
    drawHud();
    if (mode === 'end') drawEnd();
    X.restore();
  }

  // ---------------------------------------------------------------------------
  // Main loop
  // ---------------------------------------------------------------------------
  function loop(now) {
    const dt = Math.min(0.032, (now - last) / 1000 || 0);
    last = now;
    update(dt);
    draw();
    requestAnimationFrame(loop);
  }

  muteBtn.setAttribute('aria-pressed', muted ? 'true' : 'false');
  layout();
  checkState();
  requestAnimationFrame(loop);

  // Small read-only hook used to capture store screenshots (?shots in the URL).
  if (/[?&]shots\b/.test(location.search)) {
    window.__rr = {
      get state() { return { mode, dist, p, obs, solids, pits, plats, springs, winds, speed, W, t }; },
      set dist(v) { dist = v; },
    };
  }
})();
