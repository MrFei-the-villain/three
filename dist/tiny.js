/* ============================================================
   THREE — tray popup. Read-only view of the one most urgent
   task. Talks to the same encrypted Rust backend as the main
   app; never writes, so there are no save conflicts.
   ============================================================ */

(() => {
  'use strict';

  const STORAGE_KEY_FALLBACK = 'three.state.v1';
  const tauri = (typeof window !== 'undefined' && window.__TAURI__) ? window.__TAURI__ : null;

  const PRIORITY_LABELS = { 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low', 5: 'Long-term' };

  function clampPriority(p) {
    const n = Math.round(Number(p) || 3);
    return Math.max(1, Math.min(5, n));
  }

  // Same ranking as the main app: priority → min time → deadline.
  function urgencyOf(task, now = Date.now()) {
    if (task.completed) return Number.POSITIVE_INFINITY;
    const priority = clampPriority(task.priority);
    const minTime = Math.max(1, Number(task.minTime) || 30);
    const deadlineMin = task.deadline
      ? Math.min(999999, Math.max(0, (new Date(task.deadline).getTime() - now) / 60000))
      : 999999;
    return priority * 1e9 + minTime * 1e6 + deadlineMin;
  }

  function formatMinTime(min) {
    const m = Math.max(1, Math.round(Number(min) || 0));
    if (m < 60) return `${m} min`;
    const h = Math.floor(m / 60);
    const rem = m % 60;
    return rem ? `${h} hr ${rem} min` : `${h} hr`;
  }

  function deadlineLabel(deadline) {
    if (!deadline) return null;
    const t = new Date(deadline).getTime();
    if (isNaN(t)) return null;
    const diff = t - Date.now();
    const past = diff < 0;
    const abs = Math.abs(diff);
    const days = Math.floor(abs / 86400000);
    const hours = Math.floor((abs % 86400000) / 3600000);
    const mins = Math.floor((abs % 3600000) / 60000);
    if (abs < 60000) return past ? 'Just now' : 'Moments left';
    if (abs < 3600000) return past ? `${mins}m overdue` : `${mins}m left`;
    if (abs < 86400000) return past ? `${hours}h overdue` : `${hours}h left`;
    return past ? `${days}d overdue` : `${days}d left`;
  }

  function formatSpent(task) {
    let s = task.timeSpent || 0;
    if (task.activeSince) s += Math.floor((Date.now() - task.activeSince) / 1000);
    s = Math.max(0, Math.floor(s));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    if (h > 0) return `${h}h ${m}m spent`;
    if (m > 0) return `${m}m spent`;
    return null;
  }

  async function loadState() {
    if (tauri) {
      try { return await tauri.core.invoke('load_data'); } catch (e) { /* fall through */ }
    }
    try {
      const raw = localStorage.getItem(STORAGE_KEY_FALLBACK);
      return raw ? JSON.parse(raw) : null;
    } catch { return null; }
  }

  function applyTheme(state) {
    const pref = state && state.settings && state.settings.theme;
    const prefersDark = window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
    const dark = pref === 'dark' || ((pref === 'auto' || !pref) && prefersDark);
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
  }

  function badge(text, priority) {
    const b = document.createElement('span');
    b.className = 'badge ' + (priority ? `p${clampPriority(priority)}` : 'plain');
    const dot = document.createElement('span');
    dot.className = 'dot';
    b.appendChild(dot);
    b.appendChild(document.createTextNode(text));
    return b;
  }

  function render(state) {
    applyTheme(state);
    const card = document.getElementById('card');
    card.innerHTML = '';
    const tasks = ((state && state.tasks) || []).filter((t) => !t.completed);
    if (!tasks.length) {
      const empty = document.createElement('div');
      empty.className = 'tiny-empty';
      empty.textContent = 'Nothing planned.\nAdd a task to get going.';
      card.appendChild(empty);
      return;
    }
    tasks.sort((a, b) => urgencyOf(a) - urgencyOf(b));
    const task = tasks[0];

    const text = document.createElement('div');
    text.className = 'tiny-text';
    text.textContent = task.text;
    card.appendChild(text);

    const badges = document.createElement('div');
    badges.className = 'tiny-badges';
    const p = clampPriority(task.priority);
    badges.appendChild(badge(PRIORITY_LABELS[p], p));
    badges.appendChild(badge(formatMinTime(task.minTime)));
    const dl = deadlineLabel(task.deadline);
    if (dl) badges.appendChild(badge(dl));
    const spent = formatSpent(task);
    if (spent) badges.appendChild(badge(spent));
    card.appendChild(badges);
  }

  function refresh() {
    loadState().then(render).catch(() => {});
  }

  document.getElementById('open-btn').addEventListener('click', async () => {
    if (tauri) { try { await tauri.core.invoke('open_main'); } catch {} }
  });
  document.getElementById('exit-btn').addEventListener('click', async () => {
    if (tauri) { try { await tauri.core.invoke('exit_app'); } catch {} }
  });

  refresh();
  // Re-read the state every time the popup becomes visible, plus a slow
  // poll while it stays open, so it never shows a stale task.
  window.addEventListener('focus', refresh);
  document.addEventListener('visibilitychange', () => { if (!document.hidden) refresh(); });
  setInterval(() => { if (!document.hidden) refresh(); }, 5000);
})();
