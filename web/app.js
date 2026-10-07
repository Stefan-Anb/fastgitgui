'use strict';

/* ---------- Hilfen ---------------------------------------------------------- */

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v === null ? d : v; } catch (e) { return d; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* egal */ } },
};

async function call(name, ...args) {
  const r = await window.pywebview.api[name](...args);
  if (!r.ok) throw new Error(r.error);
  return r.data;
}

const ICON = {
  add: '<svg viewBox="0 0 16 16"><path d="M8 3v10M3 8h10"/></svg>',
  scan: '<svg viewBox="0 0 16 16"><path d="M2 4.5h4l1.5 1.5H14v6.5H2z"/><path d="M9 9.5h3M10.5 8v3"/></svg>',
  fetch: '<svg viewBox="0 0 16 16"><path d="M13.5 8a5.5 5.5 0 1 1-1.6-3.9"/><path d="M13.5 2.5v3h-3"/></svg>',
};

function toast(msg, kind = 'ok', ms = 4500) {
  const el = document.createElement('div');
  el.className = 'toast ' + kind;
  el.textContent = msg;
  $('toasts').appendChild(el);
  setTimeout(() => el.remove(), kind === 'err' ? Math.max(ms, 9000) : ms);
}

function modal({ title, text, buttons }) {
  return new Promise((resolve) => {
    const box = $('modal-box');
    box.innerHTML = `<div class="modal-title">${esc(title)}</div><p>${esc(text)}</p><div class="modal-actions"></div>`;
    const acts = box.querySelector('.modal-actions');
    const done = (v) => { $('modal').classList.add('hidden'); resolve(v); };
    buttons.forEach((b) => {
      const el = document.createElement('button');
      el.className = 'btn btn-sm ' + (b.cls || 'btn-ghost');
      el.textContent = b.label;
      el.onclick = () => done(b.value);
      acts.appendChild(el);
    });
    $('modal').classList.remove('hidden');
    acts.lastChild.focus();
  });
}

function relTime(ts) {
  const d = Date.now() / 1000 - ts;
  if (d < 60) return 'gerade eben';
  if (d < 3600) return `vor ${Math.floor(d / 60)} Min`;
  if (d < 86400) return `vor ${Math.floor(d / 3600)} Std`;
  if (d < 86400 * 30) return `vor ${Math.floor(d / 86400)} Tg`;
  return new Date(ts * 1000).toLocaleDateString('de-DE');
}
const fullTime = (ts) => new Date(ts * 1000).toLocaleString('de-DE');

function setBusy(btn, busy) { btn.classList.toggle('is-busy', busy); btn.disabled = busy; }

/* ---------- Zustand --------------------------------------------------------- */

const S = {
  projects: [],     // {path, name}
  status: {},       // path -> {branch, ahead, behind, count}
  cur: null,        // aktueller Pfad
  wt: null,         // Worktree-Status des aktuellen Projekts
  hist: null,       // {rows, cols}
  histLimit: 400,
  sel: { kind: 'wip' },
  commit: null,     // commit_info bei sel.kind === 'commit'
  file: null,       // Pfad der gewaehlten Datei
  drafts: {},
  diffToken: 0,
  lastSig: '',
};

const files = () => (S.sel.kind === 'wip' ? (S.wt ? S.wt.files : []) : (S.commit ? S.commit.files : []));
const palette = () => [1, 2, 3, 4, 5, 6, 7, 8].map((i) => getComputedStyle(document.documentElement).getPropertyValue('--series-' + i).trim());
let COLORS = [];

/* ---------- Sidebar --------------------------------------------------------- */

function renderProjects() {
  const q = $('filter').value.trim().toLowerCase();
  const html = S.projects.map((p, i) => ({ p, i }))
    .filter(({ p }) => !q || p.name.toLowerCase().includes(q))
    .map(({ p, i }) => {
      const st = S.status[p.path];
      let flags = '';
      let sub = '';
      if (st) {
        sub = st.branch || '';
        if (st.count) flags += `<span class="flag-dirty" title="${st.count} geänderte Dateien">${st.count}</span>`;
        if (st.behind) flags += `<span class="flag-behind" title="${st.behind} Commits hinter Upstream">&#8595;${st.behind}</span>`;
        if (st.ahead) flags += `<span class="flag-ahead" title="${st.ahead} Commits voraus">&#8593;${st.ahead}</span>`;
      } else if (st === null) {
        sub = 'nicht lesbar';
      }
      const dot = st && st.count ? 'led-warn' : 'led-ok';
      return `<div class="proj ${p.path === S.cur ? 'is-active' : ''}" data-i="${i}" title="${esc(p.path)}">
        <span class="led led-sm ${st ? dot : 'led-neutral'} is-on"></span>
        <div class="proj-main"><div class="proj-name">${esc(p.name)}</div><div class="proj-sub">${esc(sub)}</div></div>
        <span class="proj-flags">${flags}</span>
        <button class="proj-x" data-x="${i}" title="Aus der Liste entfernen">&times;</button></div>`;
    }).join('');
  $('projects').innerHTML = html || '<div class="empty small">Keine Projekte</div>';
}

async function refreshStatus(path) {
  try {
    const st = await call('project_status', path);
    S.status[path] = st;
  } catch (e) { S.status[path] = null; }
}

async function refreshAllStatus() {
  await Promise.all(S.projects.map((p) => refreshStatus(p.path)));
  renderProjects();
}

async function loadProjects() {
  S.projects = await call('get_projects');
  renderProjects();
  $('no-project').classList.toggle('hidden', S.projects.length > 0);
  $('project-view').classList.toggle('hidden', !(S.projects.length && S.cur));
  refreshAllStatus();
}

async function afterAdd(res) {
  if (res.rejected.length) toast('Kein Git-Repository: ' + res.rejected[0], 'warn');
  if (res.added.length) toast(res.added.length === 1 ? 'Hinzugefügt: ' + res.added[0] : res.added.length + ' Projekte hinzugefügt');
  else if (!res.rejected.length) return;
  await loadProjects();
  if (res.added.length && !S.cur) selectProject(res.added[0]);
}

/* ---------- Projekt laden ---------------------------------------------------- */

async function selectProject(path) {
  if (S.cur) S.drafts[S.cur] = $('msg').value;
  S.cur = path;
  store.set('lastProject', path);
  S.sel = { kind: 'wip' };
  S.commit = null;
  S.file = null;
  S.wt = null;
  S.hist = null;
  S.lastSig = '';
  const p = S.projects.find((x) => x.path === path);
  $('p-name').textContent = p.name;
  $('p-path').textContent = path;
  $('no-project').classList.add('hidden');
  $('project-view').classList.remove('hidden');
  $('msg').value = S.drafts[path] || '';
  $('diff').innerHTML = '<div class="empty">Datei auswählen</div>';
  $('files').innerHTML = '';
  $('hist').innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  renderProjects();
  await Promise.all([refreshWT(true), loadHistory()]);
  const f = files();
  if (f.length) selectFile(f[0].path);
}

async function refreshWT(force) {
  const path = S.cur;
  if (!path) return;
  let wt;
  try { wt = await call('worktree', path); } catch (e) { if (force) toast(e.message, 'err'); return; }
  if (path !== S.cur) return;
  const sig = JSON.stringify([wt.branch, wt.oid, wt.upstream, wt.ahead, wt.behind, wt.files.map((f) => [f.path, f.st, f.staged, f.add, f.del])]);
  const headChanged = S.wt && S.wt.oid !== wt.oid;
  const first = !S.wt;
  const changed = sig !== S.lastSig;
  S.wt = wt;
  S.lastSig = sig;
  S.status[path] = { branch: wt.branch, ahead: wt.ahead, behind: wt.behind, count: wt.count, oid: wt.oid };
  if (!changed && !force) return;
  renderTopbar();
  renderProjects();
  if (S.sel.kind === 'wip') {
    // Gewaehlte Datei weg? Dann Auswahl aufheben, sonst Diff neu laden wenn sich ihr Stand geaendert hat.
    const prevFile = S.file;
    renderFiles();
    if (prevFile && !wt.files.some((f) => f.path === prevFile)) {
      S.file = null;
      $('diff').innerHTML = '<div class="empty">Datei auswählen</div>';
      const f = wt.files[0];
      if (f) selectFile(f.path);
    } else if (prevFile && !first) {
      loadDiff(true);
    }
  }
  if (headChanged) loadHistory(true); else renderHistory();
}

async function loadHistory(keepScroll) {
  const path = S.cur;
  const el = $('hist');
  const top = el.scrollTop;
  try {
    const h = await call('history', path, S.histLimit, $('all-refs').checked);
    if (path !== S.cur) return;
    S.hist = h;
  } catch (e) { toast(e.message, 'err'); return; }
  renderHistory();
  if (keepScroll) el.scrollTop = top;
}

/* ---------- Topbar ----------------------------------------------------------- */

function renderTopbar() {
  const w = S.wt;
  if (!w) return;
  $('branch-name').textContent = w.branch === '(detached)' ? 'HEAD (detached)' : w.branch;
  let pills = '';
  if (w.upstream) {
    if (w.behind) pills += `<span class="status-pill is-warn pill-sm">&#8595; ${w.behind} hinter ${esc(w.upstream)}</span>`;
    if (w.ahead) pills += `<span class="status-pill is-busy pill-sm">&#8593; ${w.ahead} voraus</span>`;
    if (!w.behind && !w.ahead) pills += `<span class="status-pill is-ok pill-sm">synchron mit ${esc(w.upstream)}</span>`;
  } else {
    pills += '<span class="status-pill pill-sm">kein Upstream</span>';
  }
  $('p-pills').innerHTML = pills;
}

/* ---------- Historie / Graph ---------------------------------------------------- */

const LW = 14;
const MAXLANES = 12;

function graphSvg(row, cols, isHead) {
  const n = Math.min(cols, MAXLANES);
  const w = n * LW + 6;
  const H = 28, mid = H / 2;
  const x = (c) => Math.min(c, MAXLANES - 1) * LW + LW / 2 + 2;
  const col = (c) => COLORS[c % COLORS.length];
  let p = '';
  const curve = (x1, y1, x2, y2, c) => {
    const ym = (y1 + y2) / 2;
    return x1 === x2
      ? `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${c}" stroke-width="1.7"/>`
      : `<path d="M${x1} ${y1} C${x1} ${ym} ${x2} ${ym} ${x2} ${y2}" fill="none" stroke="${c}" stroke-width="1.7"/>`;
  };
  for (const [a, b, kind] of row.edges) {
    if (kind === 'through') p += curve(x(a), 0, x(a), H, col(a));
    else if (kind === 'in') p += curve(x(a), 0, x(b), mid, col(a));
    else p += curve(x(a), mid, x(b), H, col(b));
  }
  const cx = x(row.col);
  const node = isHead
    ? `<circle cx="${cx}" cy="${mid}" r="5.5" fill="var(--bg)" stroke="var(--accent)" stroke-width="2"/><circle cx="${cx}" cy="${mid}" r="2.5" fill="${col(row.col)}"/>`
    : `<circle cx="${cx}" cy="${mid}" r="4" fill="${col(row.col)}" stroke="var(--bg)" stroke-width="1.5"/>`;
  return `<svg width="${w}" height="${H}" viewBox="0 0 ${w} ${H}">${p}${node}</svg>`;
}

function renderHistory() {
  const h = S.hist;
  if (!h) return;
  const w = S.wt;
  const parts = [];
  const headRow = h.rows.find((r) => r.refs.some((x) => x.t === 'head'));
  const gw = Math.min(h.cols, MAXLANES) * LW + 6;
  if (w) {
    const hc = headRow ? Math.min(headRow.col, MAXLANES - 1) * LW + LW / 2 + 2 : LW / 2 + 2;
    const label = w.count ? `${w.count} geänderte Datei${w.count === 1 ? '' : 'en'}` : 'Keine Änderungen';
    parts.push(`<div class="crow wip-row ${S.sel.kind === 'wip' ? 'is-sel' : ''}" data-wip="1">
      <svg width="${gw}" height="28" viewBox="0 0 ${gw} 28"><circle cx="${hc}" cy="14" r="4.5" fill="none" stroke="var(--warn)" stroke-width="1.7" stroke-dasharray="${w.count ? '3 2' : '0'}"/></svg>
      <div class="cmsg"><span class="csub">Arbeitsverzeichnis</span><span class="ref ${w.count ? 'tag' : ''}">${esc(label)}</span></div></div>`);
  }
  for (const r of h.rows) {
    const isHead = r.refs.some((x) => x.t === 'head');
    const refs = r.refs.map((x) => `<span class="ref ${x.t}" title="${esc(x.n)}">${esc(x.n)}</span>`).join('');
    parts.push(`<div class="crow ${S.sel.kind === 'commit' && S.sel.sha === r.sha ? 'is-sel' : ''}" data-sha="${r.sha}" title="${esc(r.short + '  ' + r.author + '  ' + fullTime(r.time))}">
      ${graphSvg(r, h.cols, isHead)}
      <div class="cmsg">${refs}<span class="csub">${esc(r.subject)}</span></div>
      <span class="cmeta"><span class="au">${esc(r.author)}</span>${relTime(r.time)}</span></div>`);
  }
  if (h.rows.length >= S.histLimit) parts.push('<div class="more">Weitere Commits werden beim Scrollen geladen</div>');
  if (!h.rows.length) parts.push('<div class="empty small">Noch keine Commits</div>');
  $('hist').innerHTML = parts.join('');
}

let loadingMore = false;
$('hist').addEventListener('scroll', async (e) => {
  const el = e.target;
  if (loadingMore || !S.hist || S.hist.rows.length < S.histLimit) return;
  if (el.scrollTop + el.clientHeight > el.scrollHeight - 300) {
    loadingMore = true;
    S.histLimit += 400;
    await loadHistory(true);
    loadingMore = false;
  }
});

$('hist').addEventListener('click', async (e) => {
  const row = e.target.closest('.crow');
  if (!row) return;
  if (row.dataset.wip) {
    S.sel = { kind: 'wip' };
    S.commit = null;
  } else {
    S.sel = { kind: 'commit', sha: row.dataset.sha };
    try { S.commit = await call('commit_info', S.cur, row.dataset.sha); } catch (err) { toast(err.message, 'err'); return; }
  }
  S.file = null;
  renderHistory();
  renderFiles();
  $('diff').innerHTML = '<div class="empty">Datei auswählen</div>';
  const f = files();
  if (f.length) selectFile(f[0].path);
});

$('all-refs').addEventListener('change', () => { S.histLimit = 400; loadHistory(); });

/* ---------- Dateiliste ----------------------------------------------------------- */

const STLABEL = { M: 'Geändert', A: 'Neu', D: 'Gelöscht', R: 'Umbenannt', C: 'Kopiert', T: 'Typ geändert', '?': 'Neu (nicht verfolgt)', '!': 'Konflikt' };

function renderFiles() {
  const wip = S.sel.kind === 'wip';
  $('commit-box').classList.toggle('hidden', !wip);
  $('commit-meta').classList.toggle('hidden', wip);
  $('files-title').textContent = wip ? 'Änderungen' : 'Commit ' + (S.commit ? S.commit.sha.slice(0, 7) : '');
  if (!wip && S.commit) {
    const c = S.commit;
    const [subject, ...rest] = c.body.split('\n');
    $('commit-meta').innerHTML = `<div class="cm-subject">${esc(subject)}</div>
      <div class="cm-line">${esc(c.author)} &middot; ${esc(fullTime(c.time))}</div>
      <div class="cm-line">${esc(c.sha)}</div>
      ${rest.join('\n').trim() ? `<div class="cm-body">${esc(rest.join('\n').trim())}</div>` : ''}`;
  }
  const list = files();
  let head = '';
  if (wip) {
    const staged = list.filter((f) => f.staged === 'full').length;
    const some = list.filter((f) => f.staged !== 'none').length;
    head = `<div class="files-head"><input type="checkbox" class="fcheck" id="all-check" ${list.length && staged === list.length ? 'checked' : ''} ${list.length ? '' : 'disabled'} title="Alle stagen / unstagen">
      <span>${list.length} Dateien &middot; ${some} gestaged</span></div>`;
  } else {
    head = `<div class="files-head"><span>${list.length} Dateien</span></div>`;
  }
  const rows = list.map((f, i) => {
    const slash = f.path.lastIndexOf('/');
    const base = f.path.slice(slash + 1), dir = slash >= 0 ? f.path.slice(0, slash + 1) : '';
    const st = f.st === '?' ? 'q' : (f.st === '!' ? 'x' : f.st);
    const stat = f.bin ? 'binär' : `${f.add != null ? `<span class="a">+${f.add}</span>` : ''} ${f.del ? `<span class="d">&minus;${f.del}</span>` : ''}`;
    const chk = wip ? `<input type="checkbox" class="fcheck" data-chk="${i}" ${f.staged === 'full' ? 'checked' : ''} title="${f.staged === 'full' ? 'Gestaged' : 'Nicht gestaged'}">` : '';
    return `<div class="frow ${f.path === S.file ? 'is-sel' : ''}" data-i="${i}" title="${esc(f.path + (f.orig ? '  (von ' + f.orig + ')' : ''))}">
      ${chk}<span class="fst ${st}" title="${esc(STLABEL[f.st] || f.st)}">${esc(f.st)}</span>
      <span class="fname">${esc(base)} <span class="dir">${esc(dir)}</span></span><span class="fstat">${stat}</span></div>`;
  }).join('');
  $('files').innerHTML = head + (rows || '<div class="empty small">Keine Änderungen</div>');
  const all = $('all-check');
  if (all) {
    const some = list.some((f) => f.staged !== 'none');
    all.indeterminate = some && !(list.length && list.every((f) => f.staged === 'full'));
  }
  if (wip) {
    const staged = list.filter((f) => f.staged !== 'none').length;
    $('commit-hint').textContent = staged ? `${staged} Datei${staged === 1 ? '' : 'en'} gestaged` : (list.length ? `Nichts gestaged: alle ${list.length} Änderungen werden mitcommittet` : 'Keine Änderungen');
    $('btn-commit').disabled = !list.length;
  }
}

$('files').addEventListener('click', async (e) => {
  const list = files();
  const chk = e.target.closest('[data-chk]');
  if (chk) {
    const f = list[+chk.dataset.chk];
    const paths = [f.orig, f.path].filter(Boolean);
    try { await call(chk.checked ? 'stage' : 'unstage', S.cur, paths); } catch (err) { toast(err.message, 'err'); }
    refreshWT(true);
    return;
  }
  if (e.target.id === 'all-check') {
    try { await call(e.target.checked ? 'stage' : 'unstage', S.cur, null); } catch (err) { toast(err.message, 'err'); }
    refreshWT(true);
    return;
  }
  const row = e.target.closest('.frow');
  if (row) selectFile(list[+row.dataset.i].path);
});

function selectFile(path) {
  S.file = path;
  document.querySelectorAll('#files .frow').forEach((r) => {
    const f = files()[+r.dataset.i];
    r.classList.toggle('is-sel', !!f && f.path === path);
  });
  loadDiff(false);
}

/* ---------- Diff ---------------------------------------------------------------- */

async function loadDiff(keepScroll, full = false) {
  const f = files().find((x) => x.path === S.file);
  const el = $('diff');
  if (!f) return;
  const token = ++S.diffToken;
  const sx = el.scrollLeft, sy = el.scrollTop;
  $('diff-title').textContent = f.path;
  if (!keepScroll) el.innerHTML = '<div class="empty"><span class="spinner"></span></div>';
  let d;
  try {
    d = await call('diff', S.cur, S.sel.kind === 'wip' ? null : S.sel.sha,
      { path: f.path, orig: f.orig, st: f.st, untracked: f.untracked }, $('ignore-ws').checked, full);
  } catch (e) { if (token === S.diffToken) el.innerHTML = `<div class="diff-note">${esc(e.message)}</div>`; return; }
  if (token !== S.diffToken) return;
  el.innerHTML = renderDiff(d, f);
  if (keepScroll) { el.scrollLeft = sx; el.scrollTop = sy; } else { el.scrollTop = 0; el.scrollLeft = 0; }
}

function renderDiff(d, f) {
  const stat = f.bin ? 'binär' : `${f.add != null ? `<span class="fstat"><span class="a">+${f.add}</span></span>` : ''} ${f.del ? `<span class="fstat"><span class="d">&minus;${f.del}</span></span>` : ''}`;
  let out = `<div class="diff-file"><b>${esc(d.path)}</b>${d.orig ? ` &middot; umbenannt von ${esc(d.orig)}` : ''} &nbsp; ${stat}</div>`;
  if (d.binary) return out + '<div class="diff-note">Binärdatei, keine Textansicht.</div>';
  if (d.empty) return out + `<div class="diff-note">${f.st === 'R' ? 'Nur umbenannt, Inhalt unverändert.' : 'Keine Textänderungen (evtl. nur Whitespace oder Dateimodus).'}</div>`;
  out += '<div class="diff-inner">';
  for (const h of d.hunks) {
    out += `<div class="dh">${esc(h.header)}</div>`;
    for (const [t, o, n, code] of h.lines) {
      const cls = t === '+' ? 'add' : (t === '-' ? 'del' : '');
      out += `<div class="dl ${cls}"><span class="ln">${o ?? ''}</span><span class="ln">${n ?? ''}</span><span class="sg">${t === ' ' ? '' : t}</span><span class="cd">${code}</span></div>`;
    }
  }
  out += '</div>';
  if (d.truncated) out += '<div class="diff-note">Diff gekürzt. <button class="btn btn-ghost btn-sm" id="diff-full">Alles anzeigen</button></div>';
  return out;
}

$('diff').addEventListener('click', (e) => { if (e.target.id === 'diff-full') loadDiff(true, true); });
$('ignore-ws').addEventListener('change', () => loadDiff(true));

/* ---------- Commit ---------------------------------------------------------------- */

async function doCommit() {
  const msg = $('msg').value.trim();
  if (!msg) { toast('Commit-Nachricht fehlt.', 'warn'); $('msg').focus(); return; }
  const btn = $('btn-commit');
  const path = S.cur;
  btn.disabled = true;
  btn.textContent = 'Prüfe Origin …';
  try {
    const chk = await call('precommit_check', path);
    if (chk.note) toast(chk.note + '. Commit wird trotzdem ausgeführt.', 'warn');
    if (chk.behind > 0) {
      const ok = await modal({
        title: 'Lokaler Stand liegt hinter Origin',
        text: `${chk.target || 'Upstream'} enthält ${chk.behind} Commit${chk.behind === 1 ? '' : 's'}, die lokal fehlen${chk.ahead ? ` (lokal ${chk.ahead} voraus)` : ''}. Ein Push wird danach nicht ohne Merge/Rebase möglich sein. Trotzdem committen?`,
        buttons: [{ label: 'Abbrechen', value: false }, { label: 'Trotzdem committen', value: true, cls: 'btn-primary' }],
      });
      if (!ok) return;
    }
    const out = await call('commit', path, $('msg').value);
    toast(out.split('\n')[0] || 'Commit erstellt');
    $('msg').value = '';
    S.drafts[path] = '';
    S.sel = { kind: 'wip' };
    S.commit = null;
    S.file = null;
    await Promise.all([refreshWT(true), loadHistory()]);
    const f = files();
    if (f.length) selectFile(f[0].path); else $('diff').innerHTML = '<div class="empty">Keine Änderungen</div>';
  } catch (e) {
    toast(e.message, 'err');
  } finally {
    btn.textContent = 'Committen';
    btn.disabled = false;
    renderFiles();
  }
}
$('btn-commit').addEventListener('click', doCommit);
$('msg').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); doCommit(); } });

/* ---------- Branch-Wechsel ---------------------------------------------------------- */

let branchData = null;

function renderBranchList() {
  const q = $('branch-filter').value.trim().toLowerCase();
  const m = (n) => !q || n.toLowerCase().includes(q);
  const item = (n, cur) => `<div class="pop-item ${cur ? 'is-current' : ''}" data-b="${esc(n)}">${esc(n)}</div>`;
  const loc = branchData.local.filter(m).map((n) => item(n, n === branchData.current)).join('');
  const rem = branchData.remote.filter(m).map((n) => item(n, false)).join('');
  $('branch-list').innerHTML = (loc ? '<div class="pop-sec">Lokal</div>' + loc : '') + (rem ? '<div class="pop-sec">Nur auf Remote</div>' + rem : '') || '<div class="empty small">Keine Treffer</div>';
}

$('branch-btn').addEventListener('click', async (e) => {
  e.stopPropagation();
  const pop = $('branch-pop');
  if (!pop.classList.contains('hidden')) { pop.classList.add('hidden'); return; }
  try { branchData = await call('branches', S.cur); } catch (err) { toast(err.message, 'err'); return; }
  $('branch-filter').value = '';
  renderBranchList();
  pop.classList.remove('hidden');
  $('branch-filter').focus();
});
$('branch-filter').addEventListener('input', renderBranchList);
$('branch-pop').addEventListener('click', async (e) => {
  e.stopPropagation();
  const it = e.target.closest('.pop-item');
  if (!it || it.classList.contains('is-current')) return;
  $('branch-pop').classList.add('hidden');
  try {
    await call('switch_branch', S.cur, it.dataset.b);
    toast('Branch gewechselt: ' + it.dataset.b);
  } catch (err) { toast(err.message, 'err'); }
  S.sel = { kind: 'wip' }; S.commit = null; S.file = null;
  await Promise.all([refreshWT(true), loadHistory()]);
  const f = files();
  if (f.length) selectFile(f[0].path); else $('diff').innerHTML = '<div class="empty">Datei auswählen</div>';
});
document.addEventListener('click', () => $('branch-pop').classList.add('hidden'));

/* ---------- Toolbar-Aktionen ----------------------------------------------------------- */

async function fetchCurrent() {
  const btn = $('btn-fetch');
  btn.disabled = true;
  btn.textContent = 'Fetch …';
  try {
    const r = await call('fetch_one', S.cur);
    toast(r.note ? 'Fetch: ' + r.note : 'Fetch abgeschlossen', r.note ? 'warn' : 'ok');
  } catch (e) { toast(e.message, 'err'); }
  btn.disabled = false;
  btn.textContent = 'Fetch';
  await Promise.all([refreshWT(true), loadHistory(true)]);
}
$('btn-fetch').addEventListener('click', fetchCurrent);
$('btn-refresh').addEventListener('click', () => { refreshWT(true); loadHistory(true); loadDiff(true); });
$('btn-folder').addEventListener('click', () => call('open_folder', S.cur).catch((e) => toast(e.message, 'err')));
$('btn-vscode').addEventListener('click', () => call('open_vscode', S.cur).catch((e) => toast(e.message, 'err')));

async function addProject() { try { await afterAdd(await call('add_project')); } catch (e) { toast(e.message, 'err'); } }
async function scanFolder() { try { await afterAdd(await call('scan_folder')); } catch (e) { toast(e.message, 'err'); } }
async function fetchAll() {
  const btn = $('btn-fetch-all');
  setBusy(btn, true);
  try {
    const r = await call('fetch_all');
    toast(r.failed ? `Fetch abgeschlossen, ${r.failed} Projekt(e) ohne Erfolg` : 'Alle Projekte gefetcht', r.failed ? 'warn' : 'ok');
  } catch (e) { toast(e.message, 'err'); }
  setBusy(btn, false);
  await refreshAllStatus();
  if (S.cur) { refreshWT(true); loadHistory(true); }
}

$('btn-add').innerHTML = ICON.add;
$('btn-scan').innerHTML = ICON.scan;
$('btn-fetch-all').innerHTML = ICON.fetch;
$('btn-add').addEventListener('click', addProject);
$('btn-scan').addEventListener('click', scanFolder);
$('btn-fetch-all').addEventListener('click', fetchAll);
$('empty-add').addEventListener('click', addProject);
$('empty-scan').addEventListener('click', scanFolder);
$('filter').addEventListener('input', renderProjects);

$('projects').addEventListener('click', async (e) => {
  const x = e.target.closest('[data-x]');
  if (x) {
    e.stopPropagation();
    const p = S.projects[+x.dataset.x];
    if (!(await modal({ title: 'Projekt entfernen?', text: `"${p.name}" wird nur aus der Liste entfernt. Der Ordner bleibt unverändert.`,
      buttons: [{ label: 'Abbrechen', value: false }, { label: 'Entfernen', value: true, cls: 'btn-danger' }] }))) return;
    await call('remove_project', p.path);
    if (S.cur === p.path) { S.cur = null; $('project-view').classList.add('hidden'); }
    await loadProjects();
    if (!S.cur && S.projects.length) selectProject(S.projects[0].path);
    return;
  }
  const row = e.target.closest('.proj');
  if (row) selectProject(S.projects[+row.dataset.i].path);
});

/* ---------- Griffe zum Verschieben der Spalten ------------------------------------------- */

document.querySelectorAll('.resizer').forEach((r) => {
  const v = r.dataset.var;
  const saved = store.get('w' + v);
  if (saved) document.documentElement.style.setProperty(v, saved + 'px');
  r.addEventListener('mousedown', (e) => {
    e.preventDefault();
    const target = r.previousElementSibling;
    const startX = e.clientX, startW = target.getBoundingClientRect().width;
    const min = +r.dataset.min, max = +r.dataset.max;
    r.classList.add('is-drag');
    document.body.style.userSelect = 'none';
    const move = (ev) => {
      const w = Math.max(min, Math.min(max, startW + ev.clientX - startX));
      document.documentElement.style.setProperty(v, w + 'px');
    };
    const up = () => {
      document.removeEventListener('mousemove', move);
      document.removeEventListener('mouseup', up);
      r.classList.remove('is-drag');
      document.body.style.userSelect = '';
      store.set('w' + v, Math.round(target.getBoundingClientRect().width));
    };
    document.addEventListener('mousemove', move);
    document.addEventListener('mouseup', up);
  });
});

/* ---------- Tastatur und Polling ----------------------------------------------------------- */

document.addEventListener('keydown', (e) => {
  if (e.key === 'F5') { e.preventDefault(); $('btn-refresh').click(); return; }
  if (e.key === 'Escape') { $('branch-pop').classList.add('hidden'); $('modal').classList.add('hidden'); }
  const tag = document.activeElement && document.activeElement.tagName;
  if (tag === 'INPUT' || tag === 'TEXTAREA') return;
  if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'j' || e.key === 'k') {
    const list = files();
    if (!list.length) return;
    const i = list.findIndex((f) => f.path === S.file);
    const next = (e.key === 'ArrowDown' || e.key === 'j') ? Math.min(list.length - 1, i + 1) : Math.max(0, i - 1);
    e.preventDefault();
    selectFile(list[next].path);
    const row = document.querySelector('#files .frow.is-sel');
    if (row) row.scrollIntoView({ block: 'nearest' });
  }
});

setInterval(() => { if (document.hasFocus() && S.cur) refreshWT(false); }, 4000);
setInterval(() => { if (document.hasFocus()) refreshAllStatus(); }, 25000);
window.addEventListener('focus', () => { if (S.projects.length) refreshAllStatus(); if (S.cur) refreshWT(false); });

/* ---------- Start --------------------------------------------------------------------------- */

async function init() {
  COLORS = palette();
  try { await loadProjects(); } catch (e) { toast(e.message, 'err'); return; }
  if (!S.projects.length) return;
  const last = store.get('lastProject');
  const start = S.projects.find((p) => p.path === last) || S.projects[0];
  selectProject(start.path);
}

if (window.pywebview && window.pywebview.api) init();
else window.addEventListener('pywebviewready', init);
