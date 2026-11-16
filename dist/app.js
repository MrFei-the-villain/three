/* ============================================================
   THREE — Tiny Task Queue
   Tauri desktop app. Talks to Rust via window.__TAURI__.core.invoke.
   Falls back to localStorage when opened in a plain browser.
   ============================================================ */

(() => {
  'use strict';

  /* ---------- Constants ---------- */
  const ENERGY_EMOJIS = { 1: '😴', 2: '🥱', 3: '🙂', 4: '😊', 5: '💪' };
  const ENERGY_LABELS = { 1: 'Very low', 2: 'Low', 3: 'Okay', 4: 'Good', 5: 'Strong' };
  const RING_CIRCUMFERENCE = 2 * Math.PI * 28; // r=28 in SVG → ~176

  const STORAGE_KEY_FALLBACK = 'three.state.v1';

  /* ---------- Tauri bridge ---------- */
  // Tauri 2 exposes `window.__TAURI__` and its IPC under `core.invoke`.
  // When we run in a plain browser (e.g. for quick UI testing) we fall back
  // to localStorage. The Rust side is the source of truth in production.
  const tauri = (typeof window !== 'undefined' && window.__TAURI__) ? window.__TAURI__ : null;
  const isTauri = !!tauri;

  const api = {
    async loadData() {
      if (isTauri) {
        try {
          const data = await tauri.core.invoke('load_data');
          if (data) return data;
          // First run on the encrypted Rust backend: migrate anything the
          // localStorage fallback of older builds left behind.
          try {
            const raw = localStorage.getItem(STORAGE_KEY_FALLBACK);
            return raw ? JSON.parse(raw) : null;
          } catch { return null; }
        } catch (e) {
          console.warn('load_data failed, falling back to localStorage:', e);
        }
      }
      try {
        const raw = localStorage.getItem(STORAGE_KEY_FALLBACK);
        return raw ? JSON.parse(raw) : null;
      } catch { return null; }
    },
    async saveData(payload) {
      if (isTauri) {
        try {
          await tauri.core.invoke('save_data', { data: payload });
          return;
        } catch (e) {
          console.warn('save_data failed, falling back to localStorage:', e);
        }
      }
      try {
        localStorage.setItem(STORAGE_KEY_FALLBACK, JSON.stringify(payload));
      } catch {}
    },
    async revealSave() {
      if (isTauri) {
        try { await tauri.core.invoke('reveal_save'); return; } catch (e) { console.warn('reveal_save failed:', e); }
      }
      alert('Save file location: ' + (localStorage.getItem(STORAGE_KEY_FALLBACK) ? 'browser localStorage' : 'unknown'));
    },
    async confirm(message) {
      if (isTauri) {
        try {
          return !!(await tauri.core.invoke('confirm', { message }));
        } catch (e) { console.warn('confirm failed:', e); }
      }
      return confirm(message);
    },
  };

  /* ---------- State ---------- */
  const defaultState = () => ({
    version: 2,
    onboarded: false,
    settings: {
      theme: 'auto',
      energyCheckIn: false,
      slotSize: 3,
      dailyMode: false,
    },
    today: todayKey(),
    tasks: [],
    archive: [],
    energy: {},
    plannedDay: null,  // last day the editor was completed/skipped
    editorSeen: false, // one-time intro of the day editor for existing saves
  });

  let state = null;
  let currentFilter = 'active';
  let editingId = null;
  let showOnboardingSlide = null; // set by bindOnboarding, used to reset slides
  let activeDeadlineInput = null; // which datetime input to wire presets to
  let saveTimer = null;
  let tickInterval = null;

  /* ---------- Persistence ---------- */
  // (api shim is defined at the top of this file)

  /* ---------- DOM helpers ---------- */
  const $ = (s, root) => (root || document).querySelector(s);
  const $$ = (s, root) => Array.from((root || document).querySelectorAll(s));
  function el(tag, attrs, children) {
    const node = document.createElement(tag);
    if (attrs) {
      for (const k in attrs) {
        if (k === 'class') node.className = attrs[k];
        else if (k === 'dataset') Object.assign(node.dataset, attrs[k]);
        else if (k.startsWith('on') && typeof attrs[k] === 'function') node.addEventListener(k.slice(2), attrs[k]);
        else if (k === 'html') node.innerHTML = attrs[k];
        else if (attrs[k] != null) node.setAttribute(k, attrs[k]);
      }
    }
    if (children) {
      (Array.isArray(children) ? children : [children]).forEach((c) => {
        if (c == null) return;
        node.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
      });
    }
    return node;
  }
  function svg(d, opts = {}) {
    const ns = 'http://www.w3.org/2000/svg';
    const s = document.createElementNS(ns, 'svg');
    s.setAttribute('viewBox', '0 0 24 24');
    s.setAttribute('width', String(opts.size || 16));
    s.setAttribute('height', String(opts.size || 16));
    s.setAttribute('fill', 'none');
    s.setAttribute('stroke', 'currentColor');
    s.setAttribute('stroke-width', String(opts.strokeWidth ?? 1.6));
    s.setAttribute('stroke-linecap', 'round');
    s.setAttribute('stroke-linejoin', 'round');
    const p = document.createElementNS(ns, 'path');
    p.setAttribute('d', d);
    s.appendChild(p);
    return s;
  }

  function showFatal(err) {
    document.body.innerHTML = '';
    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:fixed;inset:0;display:flex;align-items:center;justify-content:center;flex-direction:column;background:#f3ede5;color:#211c17;font-family:system-ui;padding:24px;text-align:center;';
    const h = document.createElement('h1');
    h.textContent = 'Something went wrong starting Three.';
    h.style.fontSize = '20px';
    h.style.marginBottom = '12px';
    const p = document.createElement('pre');
    p.textContent = String(err && err.stack || err || 'Unknown error');
    p.style.cssText = 'background:#fbf7f1;border:1px solid #e5dccb;padding:12px;border-radius:8px;max-width:90%;overflow:auto;font-size:12px;text-align:left;color:#211c17;';
    wrap.appendChild(h); wrap.appendChild(p);
    document.body.appendChild(wrap);
  }

  async function init() {
    let loaded;
    if (api) {
      try {
        loaded = await Promise.race([
          api.loadData(),
          new Promise((_, reject) => setTimeout(() => reject(new Error('loadData timeout')), 2500)),
        ]);
      } catch (e) {
        console.warn('loadData failed, starting fresh:', e);
        loaded = defaultState();
      }
    } else {
      try {
        const raw = localStorage.getItem(STORAGE_KEY_FALLBACK);
        loaded = raw ? JSON.parse(raw) : defaultState();
      } catch {
        loaded = defaultState();
      }
    }
    state = { ...defaultState(), ...(loaded || {}), settings: { ...defaultState().settings, ...((loaded || {}).settings || {}) } };
    if (!state.tasks) state.tasks = [];
    if (!state.archive) state.archive = [];
    if (!state.energy) state.energy = {};
    if (!state.today) state.today = todayKey();
    // Backfill new fields on tasks saved by an older build.
    state.tasks.forEach((t) => {
      if (t.minTime == null) t.minTime = 30;
      if (t.priority == null) t.priority = 3;
    });

    rolloverIfNeeded();
    applyTheme();
    bindGlobalEvents();
    bindOnboarding();

    if (!state.onboarded) {
      showOnboarding();
    } else if (!state.editorSeen || shouldOpenEditor(state.today)) {
      openEditor();
    } else {
      $('#onboarding').hidden = true;
      $('#editor').hidden = true;
      $('#app').hidden = false;
      renderAll();
      checkFirstEnergyPrompt();
    }

    setDateLabel();
    startTicker();
  }

  function persist() {
    if (api) {
      // Debounce slightly to avoid blocking on rapid edits
      clearTimeout(saveTimer);
      saveTimer = setTimeout(() => {
        api.saveData(state).catch((e) => console.error('save error', e));
      }, 80);
    } else {
      try {
        localStorage.setItem(STORAGE_KEY_FALLBACK, JSON.stringify(state));
      } catch {}
    }
  }

  // Best-effort immediate save when the window closes or is hidden, so a
  // pending debounced write is not lost.
  function flushSave() {
    if (saveTimer) { clearTimeout(saveTimer); saveTimer = null; }
    if (state) api.saveData(state).catch(() => {});
  }
  window.addEventListener('beforeunload', flushSave);
  document.addEventListener('visibilitychange', () => { if (document.hidden) flushSave(); });

  /* ---------- Date / time helpers ---------- */
  function todayKey(d = new Date()) {
    const y = d.getFullYear();
    const m = String(d.getMonth() + 1).padStart(2, '0');
    const day = String(d.getDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  function prettyDate(d = new Date()) {
    return d.toLocaleDateString(undefined, { weekday: 'long', month: 'long', day: 'numeric' });
  }

  function toLocalInputValue(iso) {
    if (!iso) return '';
    const d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    const off = d.getTimezoneOffset() * 60000;
    return new Date(d.getTime() - off).toISOString().slice(0, 16);
  }

  function fromLocalInputValue(value) {
    if (!value) return null;
    const d = new Date(value);
    if (isNaN(d.getTime())) return null;
    return d.toISOString();
  }

  function presetToIso(preset) {
    const now = new Date();
    if (preset === 'today') {
      const d = new Date(now);
      d.setHours(18, 0, 0, 0);
      if (d.getTime() < now.getTime()) d.setDate(d.getDate() + 1); // if past 6pm, push to tomorrow
      return d.toISOString();
    }
    if (preset === 'tomorrow') {
      const d = new Date(now);
      d.setDate(d.getDate() + 1);
      d.setHours(18, 0, 0, 0);
      return d.toISOString();
    }
    if (preset === '3d') {
      const d = new Date(now);
      d.setDate(d.getDate() + 3);
      d.setHours(18, 0, 0, 0);
      return d.toISOString();
    }
    if (preset === 'week') {
      const d = new Date(now);
      d.setDate(d.getDate() + 7);
      d.setHours(18, 0, 0, 0);
      return d.toISOString();
    }
    return null;
  }

  /* ---------- Long holidays (> 3 days) ---------- */
  // Short 1–3 day breaks (New Year, Qingming, Dragon Boat, Mid-Autumn) are
  // excluded by design. Statutory dates follow the official calendar;
  // school breaks are close approximations (schools vary).
  const CNY_BY_YEAR = {
    2026: '2026-02-17', 2027: '2027-02-06', 2028: '2028-01-26',
    2029: '2029-02-13', 2030: '2030-02-03',
  };

  function addDaysKey(key, days) {
    const d = new Date(`${key}T00:00:00`);
    d.setDate(d.getDate() + days);
    return todayKey(d);
  }

  function prettyDayKey(key) {
    const d = new Date(`${key}T00:00:00`);
    return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
  }

  function longHolidaysForYear(y) {
    const list = [];
    const cny = CNY_BY_YEAR[y];
    if (cny) {
      // Spring Festival statutory break: 8 days from CNY eve.
      list.push({ name: 'Spring Festival', start: addDaysKey(cny, -1), end: addDaysKey(cny, 6) });
      // Winter break (school): ~2 weeks before to ~3 weeks after CNY.
      list.push({ name: 'Winter Break', start: addDaysKey(cny, -14), end: addDaysKey(cny, 21) });
    }
    list.push({ name: 'May Day', start: `${y}-05-01`, end: `${y}-05-05` });
    list.push({ name: 'Summer Break', start: `${y}-07-15`, end: `${y}-08-31` });
    list.push({ name: 'National Day', start: `${y}-10-01`, end: `${y}-10-07` });
    return list;
  }

  function holidayInfoFor(dayKey) {
    if (!dayKey) return null;
    const y = new Date().getFullYear();
    const all = [
      ...longHolidaysForYear(y - 1),
      ...longHolidaysForYear(y),
      ...longHolidaysForYear(y + 1),
    ];
    return all.find((h) => dayKey >= h.start && dayKey <= h.end) || null;
  }

  function shouldOpenEditor(dayKey) {
    if (state.plannedDay === dayKey) return false;
    const hol = holidayInfoFor(dayKey);
    if (hol) {
      // Long holiday: plan the break's homework once — the first day the
      // app is opened during the break. No daily prompts after that.
      const plannedThisBreak = state.plannedDay && state.plannedDay >= hol.start && state.plannedDay <= hol.end;
      return !plannedThisBreak;
    }
    return !!state.settings.dailyMode;
  }

  function urgencyOf(task, now = Date.now()) {
    if (task.completed) return Number.POSITIVE_INFINITY;
    // Priority: 1 (urgent) → 5 (long-term). Lower number = more urgent.
    const priority = clampPriority(task.priority);
    // Min time in minutes. Smaller = surfaces first.
    const minTime = Math.max(1, Number(task.minTime) || 30);
    // Deadline distance in minutes. Tasks without a deadline sort last
    // *within the same priority* — never across priorities.
    const deadlineMin = task.deadline
      ? Math.min(999999, Math.max(0, (new Date(task.deadline).getTime() - now) / 60000))
      : 999999;
    // Strictly ordered: priority dominates, then min time, then deadline.
    // Each term stays below the weight of the term before it.
    return priority * 1e9 + minTime * 1e6 + deadlineMin;
  }

  function clampPriority(p) {
    const n = Math.round(Number(p) || 3);
    if (n < 1) return 1;
    if (n > 5) return 5;
    return n;
  }

  function priorityLabel(p) {
    return ['Urgent', 'High', 'Medium', 'Low', 'Long-term'][clampPriority(p) - 1] || 'Medium';
  }

  function formatMinTime(min) {
    const m = Math.max(1, Math.round(Number(min) || 0));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    if (rem === 0) return `${h} hr`;
    return `${h} hr ${rem} min`;
  }

  function getTopUrgent(tasks, n) {
    return [...tasks]
      .filter((t) => !t.completed)
      .sort((a, b) => urgencyOf(a) - urgencyOf(b))
      .slice(0, n);
  }

  function uuid() {
    if (window.crypto && window.crypto.randomUUID) return window.crypto.randomUUID();
    return 'xxxxxxxxxxxx4xxxyxxxxxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      const v = c === 'x' ? r : (r & 0x3) | 0x8;
      return v.toString(16);
    });
  }

  function deadlineMeta(deadline) {
    if (!deadline) return null;
    const now = Date.now();
    const t = new Date(deadline).getTime();
    if (isNaN(t)) return null;
    const diff = t - now;
    const past = diff < 0;
    const abs = Math.abs(diff);
    const days = Math.floor(abs / 86400000);
    const hours = Math.floor((abs % 86400000) / 3600000);
    const mins = Math.floor((abs % 3600000) / 60000);
    let label;
    if (abs < 60000) label = past ? 'Just now' : 'Moments left';
    else if (abs < 3600000) label = past ? `${mins}m overdue` : `${mins}m left`;
    else if (abs < 86400000) label = past ? `${hours}h overdue` : `${hours}h left`;
    else label = past ? `${days}d overdue` : `${days}d left`;
    let urgency = 'later';
    if (past) urgency = 'over';
    else if (abs < 24 * 3600000) urgency = 'near';
    return { label, urgency, ts: t, past };
  }

  function formatShortDuration(s) {
    s = Math.max(0, Math.floor(s || 0));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const sec = s % 60;
    if (h > 0) return `${h}h ${m}m`;
    if (m > 0) return `${m}m ${sec}s`;
    return `${sec}s`;
  }

  function activeTask() {
    if (!state) return null;
    return state.tasks.find((t) => t.activeSince) || null;
  }

  /* ---------- Theme ---------- */
  function applyTheme() {
    const t = state.settings.theme;
    document.documentElement.dataset.theme = t === 'auto'
      ? (window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
      : t;
  }
  function watchSystemTheme() {
    if (window.matchMedia) {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      const handler = () => { if (state && state.settings.theme === 'auto') applyTheme(); };
      mq.addEventListener ? mq.addEventListener('change', handler) : mq.addListener(handler);
    }
  }

  /* ---------- Rollover ---------- */
  function rolloverIfNeeded() {
    const today = todayKey();
    if (state.today === today) return;
    // Long holiday in progress: keep the holiday plan for the whole break.
    // Only advance the day marker — nothing is archived until the break ends.
    if (holidayInfoFor(state.today) && holidayInfoFor(today)) {
      state.today = today;
      persist();
      return;
    }
    const oldToday = state.today;
    state.archive.push({
      day: oldToday,
      closedAt: Date.now(),
      tasks: state.tasks.map((t) => ({ ...t, activeSince: null })),
    });
    // Cap archive length
    if (state.archive.length > 30) state.archive = state.archive.slice(-30);
    state.tasks = [];
    state.today = today;
    persist();
  }

  /* ---------- Onboarding ---------- */
  function bindOnboarding() {
    const slides = $$('.onboarding-slide', $('#onboarding'));
    const dots = $$('.dot', $('#onboarding'));
    const finish = $('#onboarding-finish');
    let idx = 0;
    showOnboardingSlide = show; // let showOnboarding() reset to slide 0
    function show(i) {
      if (!slides.length) return;
      idx = Math.max(0, Math.min(slides.length - 1, i));
      slides.forEach((s, j) => s.classList.toggle('active', j === idx));
      dots.forEach((d, j) => d.classList.toggle('active', j === idx));
      if (finish) finish.hidden = idx !== slides.length - 1;
    }
    show(0);
    if (finish) {
      finish.addEventListener('click', () => {
        state.onboarded = true;
        persist();
        $('#onboarding').hidden = true;
        // Welcome → plan the day → main "3" screen.
        openEditor();
      });
    }
    slides.forEach((slide) => {
      slide.addEventListener('click', (e) => {
        if (e.target.closest('button')) return;
        if (idx < slides.length - 1) show(idx + 1);
      });
    });
    dots.forEach((d, j) => d.addEventListener('click', () => show(j)));
  }
  function showOnboarding() {
    $('#onboarding').hidden = false;
    $('#app').hidden = true;
    $('#editor').hidden = true;
    if (showOnboardingSlide) showOnboardingSlide(0);
  }

  /* ---------- Energy check-in ---------- */
  function setEnergy(value) {
    state.energy[state.today] = {
      value,
      label: ENERGY_LABELS[value] || 'Okay',
      emoji: ENERGY_EMOJIS[value] || '🙂',
      ts: Date.now(),
    };
    persist();
    renderEnergyButtonState();
  }

  function checkFirstEnergyPrompt() {
    if (!state.settings.energyCheckIn) return;
    if (state.energy[state.today]) return;
    setTimeout(openEnergy, 600);
  }

  function openEnergy() {
    const today = state.energy[state.today];
    const cont = $('#energy-continue');
    if (cont) cont.hidden = !today;
    openOverlay('energy');
  }

  function renderEnergyButtonState() {
    const btn = $('#energy-btn');
    if (!btn) return;
    if (!btn.dataset.origHtml) btn.dataset.origHtml = btn.innerHTML;
    const today = state.energy[state.today];
    if (today) {
      btn.classList.add('logged');
      btn.title = `Today: ${today.label || ''}`;
      btn.innerHTML = `<span class="energy-emoji">${today.emoji || ENERGY_EMOJIS[today.value] || '🙂'}</span>`;
    } else {
      btn.classList.remove('logged');
      btn.title = 'Energy check-in';
      btn.innerHTML = btn.dataset.origHtml;
    }
  }

  function renderEnergyList() {
    const list = $('#energy-list');
    if (!list) return;
    list.innerHTML = '';
    const days = Object.keys(state.energy).sort().reverse().slice(0, 14);
    days.forEach((d) => {
      const e = state.energy[d];
      const row = el('div', { class: 'energy-row' }, [
        el('span', { class: 'energy-row-day' }, d === todayKey() ? 'Today' : d),
        el('span', { class: 'energy-row-emoji' }, e.emoji || (e.skipped ? '—' : '🙂')),
        el('span', { class: 'energy-row-label' }, e.label || (e.skipped ? 'Skipped' : '—')),
      ]);
      list.appendChild(row);
    });
  }

  /* ---------- Renderers ---------- */
  function renderAll() {
    renderActiveCard();
    renderTasks();
    renderFooterInfo();
  }

  function renderActiveCard() {
    const sec = $('#active-section');
    const act = activeTask();
    if (!act) {
      if (sec._paintTimer) { clearInterval(sec._paintTimer); sec._paintTimer = null; }
      sec.hidden = true;
      return;
    }
    sec.hidden = false;
    const text = $('#active-text');
    if (text) text.textContent = act.text;
    const meta = deadlineMeta(act.deadline);
    const dl = $('#active-deadline');
    if (dl) dl.textContent = meta ? meta.label : '';
    // Live timer
    const ring = $('#active-ring-fg');
    const time = $('#active-time');
    function paint() {
      const elapsed = (act.timeSpent || 0) + Math.floor((Date.now() - act.activeSince) / 1000);
      if (time) time.textContent = formatShortDuration(elapsed);
      if (ring) {
        const pct = act.minTime ? Math.min(1, elapsed / (act.minTime * 60)) : 0;
        ring.style.strokeDasharray = `${RING_CIRCUMFERENCE}`;
        ring.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pct)}`;
      }
    }
    paint();
    if (sec._paintTimer) clearInterval(sec._paintTimer);
    sec._paintTimer = setInterval(paint, 1000);
  }

  function renderTasks() {
    const top = $('#task-list');
    const empty = $('#empty-state');
    const hasAny = state.tasks.length > 0;
    empty.hidden = hasAny;
    top.hidden = !hasAny;
    top.innerHTML = '';

    const slotSize = state.settings.slotSize || 3;
    const top3 = getTopUrgent(state.tasks, slotSize);
    top3.forEach((task) => top.appendChild(buildTaskCard(task)));

    // Also update the active section if needed
    renderActiveCard();
  }

  function buildTaskCard(task) {
    const act = activeTask();
    const isActive = act && act.id === task.id;
    const meta = deadlineMeta(task.deadline);

    const pills = [];
    if (meta) {
      const cls = meta.urgency === 'over' ? 'meta-pill urgent-over' : meta.urgency === 'near' ? 'meta-pill urgent-near' : 'meta-pill';
      pills.push(el('span', { class: cls }, [el('span', { class: 'dot' }), meta.label]));
    }
    if (task.timeSpent > 0) {
      const total = isActive
        ? (task.timeSpent || 0) + Math.floor((Date.now() - task.activeSince) / 1000)
        : task.timeSpent;
      pills.push(el('span', { class: 'meta-pill time-spent' }, [
        svg('M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', { size: 11 }),
        formatShortDuration(total),
      ]));
    }

    // Priority + min time badges always shown so the user can see why this
    // task was picked as one of the 3 most urgent.
    const priorityPill = el('span', {
      class: `priority-pill-mini p${clampPriority(task.priority)}`,
    }, [
      el('span', { class: 'priority-dot' }),
      priorityLabel(task.priority),
    ]);
    const minTimePill = el('span', { class: 'mintime-pill' }, [
      svg('M12 6v6l4 2M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z', { size: 11 }),
      formatMinTime(task.minTime),
    ]);

    const card = el('div', {
      class: 'task-card' + (task.completed ? ' completed' : '') + (isActive ? ' is-active' : ''),
      dataset: { id: task.id },
    }, [
      el('div', { class: 'task-top' }, [
        el('button', {
          class: 'task-checkbox',
          'aria-label': task.completed ? 'Mark incomplete' : 'Mark complete',
          onclick: (e) => { e.stopPropagation(); toggleComplete(task.id); },
        }, [
          svg('M5 12l4 4L19 6', { size: 13, strokeWidth: 2.4 }),
        ]),
        el('div', { class: 'task-body' }, [
          el('div', { class: 'task-text' }, task.text),
          // Always-visible priority + time-estimate row.
          el('div', { class: 'meta-row' }, [priorityPill, minTimePill]),
          // Optional deadline + time-spent row (only when those exist).
          pills.length ? el('div', { class: 'task-meta' }, pills) : null,
        ]),
        el('div', { class: 'task-actions' }, [
          el('button', {
            class: 'task-action' + (isActive ? ' start-active' : ''),
            'aria-label': isActive ? 'Pause' : 'Start',
            title: isActive ? 'Pause' : 'Start',
            onclick: (e) => { e.stopPropagation(); toggleActive(task.id); },
          }, [
            isActive
              ? svg('M6 5h4v14H6zM14 5h4v14h-4z', { size: 12, fill: 'currentColor', strokeWidth: 0 })
              : svg('M8 5v14l11-7z', { size: 12, fill: 'currentColor', strokeWidth: 0 }),
          ]),
        ]),
      ]),
    ]);
    return card;
  }

  function renderFooterInfo() {
    const info = $('#footer-info');
    if (!info) return;
    const active = state.tasks.filter((t) => !t.completed).length;
    const total = state.tasks.length;
    const archived = state.archive.length;
    info.textContent = `${active} active · ${total} today${archived ? ` · ${archived} days archived` : ''}`;
  }

  function renderManageList() {
    const list = $('#task-manage-list');
    if (!list) return;
    list.innerHTML = '';
    const tasks = state.tasks
      .filter((t) => {
        if (currentFilter === 'all') return true;
        if (currentFilter === 'done') return t.completed;
        return !t.completed;
      })
      .sort((a, b) => urgencyOf(a) - urgencyOf(b));

    if (!tasks.length) {
      list.appendChild(el('div', { class: 'manage-empty' }, 'Nothing here.'));
      return;
    }

    const act = activeTask();
    tasks.forEach((task) => {
      const meta = deadlineMeta(task.deadline);
      const isActive = act && act.id === task.id;
      const metaParts = [];
      // Always show priority and min time, in that order.
      metaParts.push(priorityLabel(task.priority));
      metaParts.push(formatMinTime(task.minTime));
      if (meta) metaParts.push(meta.label);
      if (task.timeSpent > 0) {
        const total = isActive
          ? (task.timeSpent || 0) + Math.floor((Date.now() - task.activeSince) / 1000)
          : task.timeSpent;
        metaParts.push(formatShortDuration(total));
      }

      const item = el('div', {
        class: 'manage-item' + (task.completed ? ' completed' : '') + (isActive ? ' is-active' : ''),
        onclick: () => openEdit(task.id),
      }, [
        el('span', { class: `manage-item-bar p${clampPriority(task.priority)}` }),
        el('div', { class: 'manage-item-body' }, [
          el('div', { class: 'manage-item-text' }, task.text),
          el('div', { class: 'manage-item-meta' }, metaParts.join(' · ')),
        ]),
        el('button', {
          class: 'manage-item-action' + (isActive ? ' start-active' : ''),
          'aria-label': isActive ? 'Pause' : 'Start',
          title: isActive ? 'Pause' : 'Start',
          onclick: (e) => { e.stopPropagation(); toggleActive(task.id); },
        }, [
          isActive
            ? svg('M6 5h4v14H6zM14 5h4v14h-4z', { size: 12, fill: 'currentColor', strokeWidth: 0 })
            : svg('M8 5v14l11-7z', { size: 12, fill: 'currentColor', strokeWidth: 0 }),
        ]),
      ]);
      list.appendChild(item);
    });
  }

  function renderArchive() {
    const list = $('#archive-list');
    if (!list) return;
    const clearBtn = $('#archive-clear');
    if (clearBtn) clearBtn.hidden = !state.archive.length;
    list.innerHTML = '';
    if (!state.archive.length) {
      list.appendChild(el('div', { class: 'manage-empty' }, 'No archive yet.'));
      return;
    }
    [...state.archive].reverse().forEach((day) => {
      const head = el('div', { class: 'archive-day' }, day.day);
      list.appendChild(head);
      day.tasks.forEach((task) => {
        const row = el('div', { class: 'archive-row' + (task.completed ? ' done' : '') }, [
          el('span', { class: 'archive-row-text' }, task.text),
          task.completed
            ? el('span', { class: 'archive-row-tag' }, 'Done')
            : task.activeSince
              ? el('span', { class: 'archive-row-tag warn' }, 'In progress')
              : el('span', { class: 'archive-row-tag' }, 'Carried'),
        ]);
        list.appendChild(row);
      });
    });
  }

  /* ---------- Overlays ---------- */
  function openOverlay(id) {
    const overlay = $(`#${id}-overlay`);
    if (!overlay) return;
    overlay.hidden = false;
    document.body.style.overflow = 'hidden';
  }
  function closeOverlay(id) {
    const overlay = $(`#${id}-overlay`);
    if (!overlay) return;
    overlay.hidden = true;
    document.body.style.overflow = '';
  }

  /* ---------- Toast ---------- */
  let toastTimer = null;
  function toast(msg) {
    let t = $('#toast');
    if (!t) {
      t = el('div', { id: 'toast', class: 'toast' });
      document.body.appendChild(t);
    }
    t.textContent = msg;
    t.hidden = false;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => { t.classList.remove('show'); t.hidden = true; }, 2200);
  }

  /* ---------- Add task form ---------- */
  function openAdd() {
    $('#task-input').value = '';
    const di = $('#deadline-input');
    di.value = '';
    activeDeadlineInput = { input: di, presets: '#deadline-presets' };
    syncPresets(activeDeadlineInput, '');
    // Defaults for new task
    setMinTimeUI('#task-mintime', 30, 'min');
    selectPriority('#priority-row', 3);
    openOverlay('add');
    setTimeout(() => $('#task-input').focus(), 200);
  }

  function openEdit(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    editingId = id;
    $('#edit-input').value = task.text;
    const di = $('#edit-deadline-input');
    di.value = toLocalInputValue(task.deadline);
    activeDeadlineInput = { input: di, presets: '#edit-deadline-presets' };
    syncPresets(activeDeadlineInput, di.value);
    // Populate min time and priority
    const mt = Math.max(1, Math.round(Number(task.minTime) || 30));
    const unit = mt >= 60 && mt % 60 === 0 ? 'hour' : 'min';
    const mtInUnit = unit === 'hour' ? mt / 60 : mt;
    setMinTimeUI('#edit-mintime', mtInUnit, unit);
    selectPriority('#edit-priority-row', clampPriority(task.priority));
    openOverlay('edit');
    setTimeout(() => $('#edit-input').focus(), 200);
  }

  function setMinTimeUI(inputSel, value, unit) {
    const inp = $(inputSel);
    if (!inp) return;
    inp.value = value;
    const wrap = inp.parentElement;
    if (!wrap) return;
    $$('.unit-chip', wrap).forEach((c) => {
      c.classList.toggle('active', c.dataset.unit === unit);
    });
  }

  function selectPriority(rowSel, value) {
    const row = $(rowSel);
    if (!row) return;
    const p = clampPriority(value);
    $$('.priority-pill', row).forEach((pill) => {
      const matches = Number(pill.dataset.priority) === p;
      pill.classList.toggle('selected', matches);
      pill.classList.toggle('p1-selected', matches && p === 1);
      pill.classList.toggle('p2-selected', matches && p === 2);
      pill.classList.toggle('p3-selected', matches && p === 3);
      pill.classList.toggle('p4-selected', matches && p === 4);
      pill.classList.toggle('p5-selected', matches && p === 5);
    });
  }

  function readMinTimeFromUI(inputSel) {
    const inp = $(inputSel);
    if (!inp) return 30;
    const raw = Math.max(1, Math.round(Number(inp.value) || 30));
    const wrap = inp.parentElement;
    const unitChip = wrap && wrap.querySelector('.unit-chip.active');
    const unit = unitChip ? unitChip.dataset.unit : 'min';
    return unit === 'hour' ? raw * 60 : raw;
  }

  function readPriorityFromUI(rowSel) {
    const row = $(rowSel);
    if (!row) return 3;
    const sel = row.querySelector('.priority-pill.selected');
    return sel ? clampPriority(sel.dataset.priority) : 3;
  }

  function syncPresets(ctx, currentValue) {
    const root = ctx && ctx.presets ? $(ctx.presets) : null;
    if (!root) return;
    $$('.chip', root).forEach((c) => c.classList.remove('selected'));
  }

  function clearDeadline(inputSel) {
    const inp = $(inputSel);
    if (inp) inp.value = '';
  }

  function wirePresetChips() {
    document.body.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip[data-preset]');
      if (!chip) return;
      if (!activeDeadlineInput) return;
      const iso = presetToIso(chip.dataset.preset);
      if (iso) {
        activeDeadlineInput.input.value = toLocalInputValue(iso);
        const group = chip.parentElement;
        $$('.chip', group).forEach((c) => c.classList.remove('selected'));
        chip.classList.add('selected');
      }
    });
    document.body.addEventListener('change', (e) => {
      if (e.target.classList && e.target.classList.contains('datetime-input')) {
        if (activeDeadlineInput && activeDeadlineInput.input === e.target) {
          const group = e.target.parentElement.querySelector('.deadline-presets');
          if (group) $$('.chip', group).forEach((c) => c.classList.remove('selected'));
        }
      }
    });
    // Unit chips (min / hour) inside .min-time-row
    document.body.addEventListener('click', (e) => {
      const chip = e.target.closest('.unit-chip[data-unit]');
      if (!chip) return;
      const wrap = chip.parentElement;
      if (!wrap) return;
      $$('.unit-chip', wrap).forEach((c) => c.classList.remove('active'));
      chip.classList.add('active');
    });
    // Priority pills (works for both add and edit)
    document.body.addEventListener('click', (e) => {
      const pill = e.target.closest('.priority-pill[data-priority]');
      if (!pill) return;
      const row = pill.parentElement;
      if (!row) return;
      const p = clampPriority(pill.dataset.priority);
      $$('.priority-pill', row).forEach((other) => {
        other.classList.remove('selected', 'p1-selected', 'p2-selected', 'p3-selected', 'p4-selected', 'p5-selected');
      });
      pill.classList.add('selected');
      pill.classList.add(`p${p}-selected`);
    });
  }

  /* ---------- Day editor (daily / holiday planning) ---------- */
  const PRIORITY_CHOICES = [
    { n: 1, label: 'Urgent' },
    { n: 2, label: 'High' },
    { n: 3, label: 'Medium' },
    { n: 4, label: 'Low' },
    { n: 5, label: 'Long-term' },
  ];

  function selectPriorityIn(container, value) {
    if (!container) return;
    const p = clampPriority(value);
    $$('.priority-pill', container).forEach((pill) => {
      const matches = Number(pill.dataset.priority) === p;
      pill.classList.toggle('selected', matches);
      pill.classList.toggle(`p${p}-selected`, matches);
    });
  }

  function readMinTimeFromEl(inp) {
    if (!inp) return 30;
    const raw = Math.max(1, Math.round(Number(inp.value) || 30));
    const wrap = inp.parentElement;
    const unitChip = wrap && wrap.querySelector('.unit-chip.active');
    const unit = unitChip ? unitChip.dataset.unit : 'min';
    return unit === 'hour' ? raw * 60 : raw;
  }

  function readPriorityFromEl(scope) {
    if (!scope) return 3;
    const sel = scope.querySelector('.priority-pill.selected');
    return sel ? clampPriority(sel.dataset.priority) : 3;
  }

  function addEditorRow(task) {
    const list = $('#editor-list');
    const row = el('div', { class: 'editor-row' }, [
      el('div', { class: 'editor-row-top' }, [
        el('input', {
          type: 'text',
          class: 'editor-text',
          placeholder: 'e.g. Math homework',
          maxlength: '200',
          autocomplete: 'off',
        }),
        el('button', {
          class: 'editor-remove',
          type: 'button',
          'aria-label': 'Remove this row',
          title: 'Remove',
          onclick: () => row.remove(),
        }, '×'),
      ]),
      el('div', { class: 'editor-row-meta' }, [
        el('div', { class: 'priority-row editor-priority', role: 'radiogroup', 'aria-label': 'Priority' },
          PRIORITY_CHOICES.map((c) => el('button', {
            type: 'button',
            class: 'priority-pill',
            'data-priority': String(c.n),
            'aria-label': c.label,
            title: c.label,
          }, [
            el('span', { class: `priority-dot p${c.n}` }),
            el('span', { class: 'priority-label' }, c.label),
          ]))
        ),
        el('div', { class: 'min-time-row editor-minrow' }, [
          el('input', {
            type: 'number',
            class: 'min-time-input editor-min',
            min: '1',
            max: '999',
            value: '30',
            inputmode: 'numeric',
          }),
          el('div', { class: 'min-time-unit', role: 'radiogroup', 'aria-label': 'Time unit' }, [
            el('button', { type: 'button', class: 'unit-chip active', 'data-unit': 'min' }, 'min'),
            el('button', { type: 'button', class: 'unit-chip', 'data-unit': 'hour' }, 'hr'),
          ]),
        ]),
      ]),
    ]);
    if (task) {
      row.dataset.taskId = task.id;
      $('.editor-text', row).value = task.text;
      selectPriorityIn($('.editor-priority', row), task.priority);
      const mt = Math.max(1, Math.round(Number(task.minTime) || 30));
      const unit = mt >= 60 && mt % 60 === 0 ? 'hour' : 'min';
      $('.editor-min', row).value = String(unit === 'hour' ? mt / 60 : mt);
      $$('.unit-chip', row).forEach((c) => c.classList.toggle('active', c.dataset.unit === unit));
    } else {
      selectPriorityIn($('.editor-priority', row), 3);
    }
    // Enter in the text field adds another row, quick-entry style.
    $('.editor-text', row).addEventListener('keydown', (e) => {
      if (e.key !== 'Enter') return;
      e.preventDefault();
      const next = addEditorRow();
      $('.editor-text', next).focus();
    });
    list.appendChild(row);
    return row;
  }

  function openEditor() {
    ['add', 'tasks', 'edit', 'archive', 'settings', 'energy'].forEach((id) => closeOverlay(id));
    const list = $('#editor-list');
    list.innerHTML = '';
    const pending = state.tasks.filter((t) => !t.completed);
    if (pending.length) {
      pending.forEach((t) => addEditorRow(t));
    } else {
      addEditorRow();
      addEditorRow();
      addEditorRow();
    }
    const hol = holidayInfoFor(todayKey());
    $('#editor-title').textContent = hol ? 'Holiday homework' : 'Plan your day';
    $('#editor-sub').textContent = hol
      ? `${hol.name} · ${prettyDayKey(hol.start)} – ${prettyDayKey(hol.end)}. Set what you want to get done this break.`
      : 'What needs doing today?';
    $('#onboarding').hidden = true;
    $('#app').hidden = true;
    $('#editor').hidden = false;
    const firstText = $('.editor-text', list);
    if (firstText) setTimeout(() => firstText.focus(), 260);
  }

  function showMainFromEditor() {
    $('#editor').hidden = true;
    $('#app').hidden = false;
    renderAll();
    checkFirstEnergyPrompt();
  }

  function finishEditor() {
    const entries = $$('.editor-row', $('#editor-list')).map((row) => ({
      id: row.dataset.taskId || null,
      text: (($('.editor-text', row) || {}).value || '').trim(),
      minTime: readMinTimeFromEl($('.editor-min', row)),
      priority: readPriorityFromEl(row),
    })).filter((r) => r.text);

    const keptIds = new Set(entries.filter((r) => r.id).map((r) => r.id));
    // Keep completed tasks and everything still in the plan; drop the rest.
    state.tasks = state.tasks.filter((t) => t.completed || keptIds.has(t.id));
    entries.forEach((r) => {
      if (r.id) {
        const t = state.tasks.find((x) => x.id === r.id);
        if (t) {
          t.text = r.text;
          t.minTime = r.minTime;
          t.priority = r.priority;
        }
      } else {
        state.tasks.push({
          id: uuid(),
          text: r.text,
          createdDay: state.today,
          completed: false,
          completedDay: null,
          deadline: null,
          timeSpent: 0,
          activeSince: null,
          minTime: r.minTime,
          priority: r.priority,
        });
      }
    });
    state.plannedDay = todayKey();
    state.editorSeen = true;
    persist();
    showMainFromEditor();
    toast(entries.length ? `Planned ${entries.length} task${entries.length === 1 ? '' : 's'}.` : 'Day planned.');
  }

  function skipEditor() {
    state.plannedDay = todayKey();
    state.editorSeen = true;
    persist();
    showMainFromEditor();
  }

  /* ---------- Actions ---------- */
  function addTask(text, deadline, minTime, priority) {
    const trimmed = text.trim();
    if (!trimmed) return false;
    const newTask = {
      id: uuid(),
      text: trimmed,
      createdDay: state.today,
      completed: false,
      completedDay: null,
      deadline: deadline || null,
      timeSpent: 0,
      activeSince: null,
      minTime: Math.max(1, Math.round(Number(minTime) || 30)),
      priority: clampPriority(priority),
    };
    state.tasks.push(newTask);
    persist();
    renderAll();
    return true;
  }

  function deleteTask(id) {
    state.tasks = state.tasks.filter((t) => t.id !== id);
    persist();
    renderAll();
  }

  function toggleComplete(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    // Bank any running timer segment before flipping completion.
    if (task.activeSince) {
      task.timeSpent = (task.timeSpent || 0) + Math.floor((Date.now() - task.activeSince) / 1000);
    }
    task.completed = !task.completed;
    task.completedDay = task.completed ? state.today : null;
    if (task.completed) task.activeSince = null;
    persist();
    renderAll();
  }

  function toggleActive(id) {
    const task = state.tasks.find((t) => t.id === id);
    if (!task) return;
    const current = activeTask();
    if (current && current.id === id) {
      // Pause
      task.timeSpent = (task.timeSpent || 0) + Math.floor((Date.now() - task.activeSince) / 1000);
      task.activeSince = null;
    } else {
      // Start
      if (current) {
        current.timeSpent = (current.timeSpent || 0) + Math.floor((Date.now() - current.activeSince) / 1000);
        current.activeSince = null;
      }
      task.activeSince = Date.now();
    }
    persist();
    renderAll();
  }

  function refreshInfoLine() {
    const t = $('#info-line');
    if (!t) return;
    const n = state.tasks.length;
    const slot = state.settings.slotSize || 3;
    t.textContent = `Three shows the ${slot} most urgent tasks. You can store as many as you want.`;
  }

  /* ---------- Date label & ticker ---------- */
  function setDateLabel() {
    const el = $('#date-label');
    if (el) el.textContent = prettyDate();
  }
  function startTicker() {
    if (tickInterval) clearInterval(tickInterval);
    tickInterval = setInterval(() => {
      setDateLabel();
      // Re-render deadline pills and active timer
      if (!document.hidden) renderAll();
      // Day rollover
      if (todayKey() !== state.today) {
        rolloverIfNeeded();
        renderAll();
        if (shouldOpenEditor(todayKey())) {
          openEditor();
        } else if (state.settings.energyCheckIn && !state.energy[state.today]) {
          setTimeout(openEnergy, 600);
        }
      }
    }, 30000);
  }

  /* ---------- Filters ---------- */
  $$('.filter-chip').forEach((chip) => {
    chip.addEventListener('click', () => {
      currentFilter = chip.dataset.filter;
      $$('.filter-chip').forEach((c) => c.classList.toggle('active', c === chip));
      renderManageList();
    });
  });

  /* ---------- Global event wiring ---------- */
  function bindGlobalEvents() {
    renderEnergyButtonState();
    watchSystemTheme();
    wirePresetChips();

    $('#energy-btn').addEventListener('click', () => {
      if (!state.settings.energyCheckIn) {
        toast('Enable Energy check-in in Settings first.');
        return;
      }
      openEnergy();
    });
    $('#tasks-btn').addEventListener('click', () => {
      currentFilter = 'active';
      $$('.filter-chip').forEach((c) => c.classList.toggle('active', c.dataset.filter === currentFilter));
      renderManageList();
      openOverlay('tasks');
    });
    $('#archive-btn').addEventListener('click', () => {
      renderArchive();
      openOverlay('archive');
    });
    $('#settings-btn').addEventListener('click', () => {
      $('#theme-select').value = state.settings.theme;
      $('#energy-toggle').checked = state.settings.energyCheckIn;
      $('#daily-toggle').checked = !!state.settings.dailyMode;
      $('#slots-select').value = String(state.settings.slotSize);
      refreshInfoLine();
      openOverlay('settings');
    });
    $('#add-btn').addEventListener('click', openAdd);
    const emptyAdd = $('#empty-add-btn');
    if (emptyAdd) emptyAdd.addEventListener('click', openAdd);

    // Bulletproof delegation: any click on the empty-state CTA or the
    // floating add button opens the add form, even if the direct listener
    // above somehow failed to attach.
    document.addEventListener('click', (e) => {
      if (!e.target || !e.target.closest) return;
      if (e.target.closest('#empty-add-btn') || e.target.closest('#add-btn')) {
        openAdd();
      }
    }, true);

    $$('[data-close]').forEach((b) => {
      b.addEventListener('click', () => closeOverlay(b.dataset.close));
    });

    $('#add-form').addEventListener('submit', (e) => {
      e.preventDefault();
      const text = $('#task-input').value;
      const deadline = fromLocalInputValue($('#deadline-input').value);
      const minTime = readMinTimeFromUI('#task-mintime');
      const priority = readPriorityFromUI('#priority-row');
      if (addTask(text, deadline, minTime, priority)) {
        closeOverlay('add');
      }
    });

    $('#edit-form').addEventListener('submit', (e) => {
      e.preventDefault();
      if (!editingId) return;
      const task = state.tasks.find((t) => t.id === editingId);
      if (!task) return;
      task.text = $('#edit-input').value.trim() || task.text;
      task.deadline = fromLocalInputValue($('#edit-deadline-input').value);
      task.minTime = readMinTimeFromUI('#edit-mintime');
      task.priority = readPriorityFromUI('#edit-priority-row');
      persist();
      renderAll();
      closeOverlay('edit');
      editingId = null;
    });

    $('#edit-delete').addEventListener('click', async () => {
      if (!editingId) return;
      const ok = api ? await api.confirm('Delete this task?') : confirm('Delete this task?');
      if (!ok) return;
      deleteTask(editingId);
      closeOverlay('edit');
      editingId = null;
    });

    $('#deadline-clear').addEventListener('click', () => clearDeadline('#deadline-input'));
    $('#edit-deadline-clear').addEventListener('click', () => clearDeadline('#edit-deadline-input'));

    $$('.energy-btn-large').forEach((b) => {
      b.addEventListener('click', () => {
        setEnergy(Number(b.dataset.energy));
        const cont = $('#energy-continue');
        if (cont) cont.hidden = false;
      });
    });

    // Delegated fallbacks for the energy exit buttons. These run on every
    // pointerdown + click in capture phase so the buttons always work even
    // if a parent swallowed the event, the focus is wrong, or the click
    // happens to be intercepted.
    function handleEnergyExit(e) {
      const passBtn = e.target.closest && e.target.closest('#energy-pass');
      if (passBtn) {
        e.preventDefault();
        e.stopPropagation();
        if (state) {
          state.energy[state.today] = { value: 0, label: 'Skipped', ts: Date.now(), skipped: true };
          persist();
          renderEnergyButtonState();
        }
        closeOverlay('energy');
        return;
      }
      const contBtn = e.target.closest && e.target.closest('#energy-continue');
      if (contBtn) {
        e.preventDefault();
        e.stopPropagation();
        closeOverlay('energy');
        return;
      }
      if (e.type === 'keydown' && (e.key === 'Escape' || e.key === 'Esc')) {
        const open = $('#energy-overlay') && !$('#energy-overlay').hidden;
        if (open) {
          e.preventDefault();
          if (state) {
            state.energy[state.today] = { value: 0, label: 'Skipped', ts: Date.now(), skipped: true };
            persist();
            renderEnergyButtonState();
          }
          closeOverlay('energy');
        }
      }
    }
    document.addEventListener('pointerdown', handleEnergyExit, true);
    document.addEventListener('mousedown', handleEnergyExit, true);
    document.addEventListener('click', handleEnergyExit, true);
    document.addEventListener('keydown', handleEnergyExit, true);

    $('#theme-select').addEventListener('change', (e) => {
      state.settings.theme = e.target.value;
      persist();
      applyTheme();
    });
    $('#energy-toggle').addEventListener('change', (e) => {
      state.settings.energyCheckIn = e.target.checked;
      persist();
      renderEnergyButtonState();
      if (e.target.checked && !state.energy[state.today]) setTimeout(openEnergy, 250);
    });
    $('#slots-select').addEventListener('change', (e) => {
      state.settings.slotSize = Math.max(1, Math.min(3, Number(e.target.value)));
      persist();
      renderAll();
    });

    $('#show-save').addEventListener('click', () => {
      if (api) api.revealSave();
    });

    // Pause button on the active-timer card.
    $('#active-pause').addEventListener('click', () => {
      const act = activeTask();
      if (act) toggleActive(act.id);
    });

    $('#reset-onboarding').addEventListener('click', () => {
      state.onboarded = false;
      persist();
      closeOverlay('settings');
      showOnboarding();
    });

    $('#reset-all').addEventListener('click', async () => {
      const msg = 'Erase all tasks, the archive, and settings? This cannot be undone.';
      const ok = api ? await api.confirm(msg) : confirm(msg);
      if (!ok) return;
      const theme = state.settings.theme;
      state = defaultState();
      state.settings.theme = theme;
      persist();
      closeOverlay('settings');
      renderAll();
      renderEnergyButtonState();
      showOnboarding();
      toast('Everything erased.');
    });

    $('#archive-clear').addEventListener('click', async () => {
      if (!state.archive.length) return;
      const msg = 'Clear the entire archive?';
      const ok = api ? await api.confirm(msg) : confirm(msg);
      if (!ok) return;
      state.archive = [];
      persist();
      renderArchive();
      renderFooterInfo();
    });

    // Daily mode: plan each day's homework when the day starts.
    $('#daily-toggle').addEventListener('change', (e) => {
      state.settings.dailyMode = e.target.checked;
      persist();
      if (e.target.checked && shouldOpenEditor(todayKey())) {
        closeOverlay('settings');
        openEditor();
      }
    });

    // Day editor buttons.
    $('#editor-add-row').addEventListener('click', () => {
      const row = addEditorRow();
      $('.editor-text', row).focus();
    });
    $('#editor-done').addEventListener('click', finishEditor);
    $('#editor-skip').addEventListener('click', skipEditor);
  }

  /* ---------- Boot ---------- */
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      init().catch((e) => { console.error('init failed', e); showFatal(e); });
    });
  } else {
    init().catch((e) => { console.error('init failed', e); showFatal(e); });
  }
})();
