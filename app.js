import {
  importDataKey, seal, unseal, randomId, b64, unb64, utf8, fromUtf8, normName, makeUserEntry, openUserEntry,
} from './crypto.js?v=6';

const REPO = 'umi-card/seiken-members';
const BRANCH = 'main';
const KEYS_PATH = 'data/keys.json';
const STATE_PATH = 'data/posts.enc.json';
const SESSION_KEY = 'seiken.session';
// On localhost, writes go to localStorage instead of GitHub (for testing).
const LOCAL = ['localhost', '127.0.0.1'].includes(location.hostname);

const ST_LABEL = { '': '未着手', doing: '進行中', done: '完了' };
const ST_NEXT = { '': 'doing', doing: 'done', done: '' };
const CATS = ['連絡', 'お知らせ', '質問', 'その他'];
const CAT_CLASS = { 連絡: '', お知らせ: '', 質問: 'q', その他: 'o' };
const TABS = [
  ['home', 'ホーム'], ['todo', '準備ToDo'], ['shift', 'シフト'], ['plan', '企画書'],
  ['board', '掲示板'], ['progress', '進捗'],
];

const S = {
  session: null, K: null, token: null, keys: null, dir: {},
  content: null, data: null, sha: null,
  ui: { open: new Set(), shiftDay: 0, onlyMine: false },
  busy: false,
};

const $app = document.getElementById('app');

/* ---------- utils ---------- */
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const linkify = (s) => esc(s).replace(/https?:\/\/[^\s<]+/g, (u) => `<a href="${u}" target="_blank" rel="noopener">${u}</a>`);
const pad = (n) => String(n).padStart(2, '0');
const ymd = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const fmtTs = (ts) => { const d = new Date(ts); return `${d.getMonth() + 1}/${d.getDate()} ${d.getHours()}:${pad(d.getMinutes())}`; };
const toMin = (hm) => { const [h, m] = hm.split(':').map(Number); return h * 60 + m; };
const span = (t) => t.split('~').map(toMin);

// ?now=2026-10-24T10:15 lets you preview the shift card at another time
const nowOverride = new URLSearchParams(location.search).get('now');
const now = () => (nowOverride ? new Date(nowOverride) : new Date());

let toastTimer;
function toast(msg) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

/* ---------- storage: GitHub (or localStorage on localhost) ---------- */
async function ghApi(path, opts = {}) {
  return fetch(`https://api.github.com/repos/${REPO}/${path}`, {
    ...opts,
    cache: 'no-store',
    headers: { Authorization: `Bearer ${S.token}`, Accept: 'application/vnd.github+json', ...(opts.headers || {}) },
  });
}

async function readFile(path) {
  if (LOCAL && localStorage.getItem('local:' + path)) return { text: localStorage.getItem('local:' + path), sha: 'local' };
  if (S.token && !LOCAL) {
    const r = await ghApi(`contents/${path}?ref=${BRANCH}`);
    if (r.ok) {
      const j = await r.json();
      return { text: fromUtf8(unb64(j.content)), sha: j.sha };
    }
  }
  const r = await fetch(`${path}?t=${Date.now()}`, { cache: 'no-store' });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return { text: await r.text(), sha: null };
}

// Returns the new sha, or throws {conflict:true} when someone else wrote first
async function writeFile(path, text, sha, message) {
  if (LOCAL) { localStorage.setItem('local:' + path, text); return 'local'; }
  if (!S.token) throw new Error('保存できません（GitHubキー未設定）');
  const r = await ghApi(`contents/${path}`, {
    method: 'PUT',
    body: JSON.stringify({ message, content: b64(utf8(text)), sha: sha || undefined, branch: BRANCH }),
  });
  if (r.status === 409 || r.status === 422) throw { conflict: true };
  if (!r.ok) throw new Error(`保存に失敗しました（GitHub ${r.status}）`);
  return (await r.json()).content.sha;
}

async function fetchKeys() {
  const { text } = await readFile(KEYS_PATH);
  return JSON.parse(text);
}

async function loadState() {
  const { text, sha } = await readFile(STATE_PATH);
  const state = await unseal(S.K, JSON.parse(text));
  state.posts ||= []; state.todo ||= {}; state.todos ||= [];
  return { state, sha };
}

// Read-modify-write with retry, so simultaneous posts don't overwrite each other
async function mutate(fn, message) {
  if (S.busy) return false;
  S.busy = true;
  try {
    for (let i = 0; i < 5; i++) {
      const { state, sha } = await loadState();
      fn(state);
      try {
        S.sha = await writeFile(STATE_PATH, JSON.stringify(await seal(S.K, state)), sha, message);
        S.data = state;
        render();
        return true;
      } catch (e) {
        if (!e.conflict) throw e;
        await new Promise((r) => setTimeout(r, 400 + Math.random() * 600));
      }
    }
    throw new Error('保存できませんでした');
  } catch (e) {
    toast(e.message || String(e));
    return false;
  } finally {
    S.busy = false;
  }
}

async function writeKeys(fn, message) {
  for (let i = 0; i < 3; i++) {
    const { text, sha } = await readFile(KEYS_PATH);
    const keys = JSON.parse(text);
    await fn(keys);
    try {
      await writeFile(KEYS_PATH, JSON.stringify(keys, null, 1), sha, message);
      S.keys = keys;
      S.dir = keys.dir ? await unseal(S.K, keys.dir) : {};
      return;
    } catch (e) {
      if (!e.conflict) throw e;
    }
  }
  throw new Error('保存に失敗しました');
}

/* ---------- session ---------- */
function saveSession() { try { localStorage.setItem(SESSION_KEY, JSON.stringify(S.session)); } catch {} }
function clearSession() { try { localStorage.removeItem(SESSION_KEY); } catch {} S.session = null; }

async function openSession(sess) {
  S.session = sess;
  S.K = await importDataKey(sess.k);
  S.token = S.keys.tok ? (await unseal(S.K, S.keys.tok)).t : null;
  S.dir = S.keys.dir ? await unseal(S.K, S.keys.dir) : {};
  const r = await fetch(`data/content.enc.json?t=${Date.now()}`, { cache: 'no-store' });
  S.content = await unseal(S.K, await r.json());
  const { state, sha } = await loadState();
  S.data = state; S.sha = sha;
}

const sessionValid = (keys, sess) => !!sess?.id && keys.users?.[sess.id]?.kid === sess.kid;
const entryByUid = (keys, uid) => Object.entries(keys.users).find(([, e]) => e.uid === uid);

async function boot() {
  let saved = null;
  try { saved = JSON.parse(localStorage.getItem(SESSION_KEY)); } catch {}
  try {
    S.keys = await fetchKeys();
  } catch {
    $app.innerHTML = '<p class="boot">読み込みに失敗しました</p>';
    return;
  }
  if (sessionValid(S.keys, saved)) {
    try {
      // the role may have been changed by the admin since the last visit
      saved.role = S.keys.users[saved.id].role;
      await openSession(saved);
      return render();
    } catch { clearSession(); }
  } else if (saved) {
    clearSession();
    return renderLogin('パスワードが変更されました');
  }
  renderLogin();
}

async function refresh(quiet = true) {
  if (!S.session || S.busy) return;
  try {
    const keys = await fetchKeys();
    if (!sessionValid(keys, S.session)) {
      clearSession();
      return renderLogin('パスワードが変更されました');
    }
    S.keys = keys;
    S.session.role = keys.users[S.session.id].role;
    S.token = keys.tok ? (await unseal(S.K, keys.tok)).t : null;
    S.dir = keys.dir ? await unseal(S.K, keys.dir) : {};
    const { state, sha } = await loadState();
    const changed = JSON.stringify(state) !== JSON.stringify(S.data);
    S.data = state; S.sha = sha;
    if (changed || !quiet) render();
    if (!quiet) toast('更新しました');
  } catch {
    if (!quiet) toast('更新に失敗しました');
  }
}

/* ---------- login screen ---------- */
function renderLogin(err = '') {
  document.title = '部員専用ページ';
  $app.innerHTML = `
  <div class="login"><form id="loginForm" autocomplete="on">
    <h1>部員専用ページ</h1>
    <label class="f" for="pw">パスワード</label>
    <input id="pw" type="password" autocomplete="current-password" required autofocus>
    <button class="btn wide" type="submit">ログイン</button>
    <p class="err" id="err">${esc(err)}</p>
  </form></div>`;
  document.getElementById('loginForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button');
    const pw = document.getElementById('pw').value;
    btn.disabled = true; btn.textContent = '確認中…';
    document.getElementById('err').textContent = '';
    try {
      S.keys = await fetchKeys();
      const u = await openUserEntry(pw, S.keys);
      if (!u) throw new Error('パスワードが違います');
      await openSession({ id: u.id, uid: u.entry.uid, name: u.name, role: u.entry.role, k: u.k, kid: u.entry.kid });
      saveSession();
      if (!location.hash) location.hash = '#home';
      render();
    } catch (e) {
      document.getElementById('err').textContent = e.message || 'ログインに失敗しました';
      btn.disabled = false; btn.textContent = 'ログイン';
    }
  });
}

/* ---------- display name ---------- */
function renderDisplayName(first) {
  const uid = S.session.uid;
  const cur = S.data.names?.[uid]?.n || '';
  const initial = initialOf(S.session.name);
  $app.innerHTML = `
  <div class="login"><form id="dnForm">
    <h1>表示名</h1>
    <input id="dn" type="text" maxlength="20" value="${esc(cur)}" placeholder="${esc(initial)}" autofocus>
    <button class="btn wide" type="submit">${first ? '決定' : '変更'}</button>
    ${first ? '' : '<button class="btn ghost wide" type="button" id="dnBack" style="margin-top:8px">戻る</button>'}
  </form></div>`;
  document.getElementById('dnBack')?.addEventListener('click', () => render());
  document.getElementById('dnForm').addEventListener('submit', async (ev) => {
    ev.preventDefault();
    const btn = ev.target.querySelector('button[type=submit]');
    const n = document.getElementById('dn').value.trim().slice(0, 20) || initial;
    btn.disabled = true;
    // if saving fails (e.g. no GitHub key yet) carry on; the prompt comes back next login
    await mutate((st) => { st.names ||= {}; st.names[uid] = { n, ts: Date.now() }; }, 'set display name');
    S.ui.namePrompted = true;
    if (!location.hash) location.hash = '#home';
    render();
  });
}

/* ---------- derived data ---------- */
const isAdmin = () => S.session?.role === 'admin';
const canDelete = (p) => isAdmin() || p.uid === S.session.uid;

// Display names: each member picks one on first login; until then their initial is shown
const initialOf = (real) => S.content.initials?.[real] || String(real || '?').slice(0, 1);
const uidOfMember = (real) => Object.keys(S.dir).find((k) => S.dir[k] === real);
const dn = (uid) => S.data.names?.[uid]?.n || initialOf(S.dir[uid]);
const dnMember = (real) => { const u = uidOfMember(real); return u ? dn(u) : initialOf(real); };
const whoOf = (p) => (p.uid ? dn(p.uid) : p.author || '');
const adminMark = (role) => (role === 'admin' ? '<span class="role">管理者</span>' : '');

function allTodos() {
  return S.content.todo.map((d) => ({ ...d, items: S.data.todos.filter((x) => x.date === d.date) }));
}
const todoById = (id) => S.data.todos.find((i) => i.id === id);
const postsOf = (kind, ref) => S.data.posts.filter((p) => p.kind === kind && (ref === undefined || p.ref === ref));

function todoStats() {
  const items = S.data.todos;
  const done = items.filter((i) => S.data.todo[i.id]?.s === 'done').length;
  return { done, total: items.length };
}

function rowNames(row) {
  const m = S.content.members;
  return {
    on: m.filter((_, i) => row.c[i] === '○'),
    sym: m.map((n, i) => (row.c[i] === '※' || row.c[i] === 'ー' ? `${dnMember(n)}（${row.c[i]}）` : null)).filter(Boolean),
  };
}

// What shift slot is happening now, and which one comes next
function shiftNow() {
  const d = now();
  const today = ymd(d);
  const m = d.getHours() * 60 + d.getMinutes();
  const days = S.content.shift.days;
  const openRows = (day) => day.rows.filter((r) => !r.closed);
  for (let i = 0; i < days.length; i++) {
    const rows = openRows(days[i]);
    if (days[i].date === today) {
      const cur = rows.find((r) => { const [s, e] = span(r.t); return s <= m && m < e; });
      let next = rows.find((r) => span(r.t)[0] > m);
      let nextDay = days[i];
      if (!next && days[i + 1]) { next = openRows(days[i + 1])[0]; nextDay = days[i + 1]; }
      return { phase: cur ? 'live' : next ? 'gap' : 'over', day: days[i], cur, next, nextDay };
    }
    if (days[i].date > today) {
      return { phase: i === 0 ? 'before' : 'gap', next: rows[0], nextDay: days[i] };
    }
  }
  return { phase: 'over' };
}

function myRanges(day, name) {
  const idx = S.content.members.indexOf(name);
  if (idx < 0) return [];
  const out = [];
  for (const r of day.rows) {
    if (r.closed || r.c[idx] !== '○') continue;
    const [s, e] = r.t.split('~');
    const last = out[out.length - 1];
    if (last && last.e === s) last.e = e; else out.push({ s, e });
  }
  return out;
}

const tm = (t) => t.replace('~', '〜');

/* ---------- render ---------- */
function route() {
  const view = location.hash.slice(1) || 'home';
  const ok = TABS.some(([k]) => k === view) || (view === 'admin' && isAdmin());
  return { view: ok ? view : 'home' };
}

function render() {
  if (!S.session) return renderLogin();
  if (!S.data.names?.[S.session.uid] && !S.ui.namePrompted) return renderDisplayName(true);
  const { view } = route();

  // keep half-typed text and focus across re-renders
  const kept = {};
  document.querySelectorAll('[data-k]').forEach((el) => { kept[el.dataset.k] = el.value; });
  const focusK = document.activeElement?.dataset?.k;

  document.title = S.content.title;
  const tabs = [...TABS, ...(isAdmin() ? [['admin', '管理']] : [])];
  const body = { home: vHome, todo: vTodo, shift: vShift, plan: vPlan, board: vBoard, progress: vProgress, admin: vAdmin }[view]();
  $app.innerHTML = `
  <header class="top">
    <div class="bar">
      <div class="ttl">${esc(S.content.title)}</div>
      <button class="link" data-act="refresh">更新</button>
      <span class="who"><button class="link" data-act="rename"><b>${esc(dn(S.session.uid))}</b></button>${adminMark(S.session.role)}</span>
      <button class="link" data-act="logout">ログアウト</button>
    </div>
    <nav class="tabs">${tabs.map(([k, l]) => `<a href="#${k}" class="${k === view ? 'on' : ''}">${l}</a>`).join('')}</nav>
  </header>
  <main>${!S.token && !LOCAL && isAdmin() ? '<div class="banner">GitHubキー未設定</div>' : ''}${body}</main>`;

  document.querySelectorAll('[data-k]').forEach((el) => { if (kept[el.dataset.k] != null) el.value = kept[el.dataset.k]; });
  if (focusK) document.querySelector(`[data-k="${focusK}"]`)?.focus();
}

/* home */
function vHome() {
  const c = S.content;
  const d = now();
  const first = new Date(c.eventDays[0].date + 'T00:00');
  const daysLeft = Math.ceil((first - new Date(ymd(d) + 'T00:00')) / 86400000);
  const evIdx = c.eventDays.findIndex((e) => e.date === ymd(d));
  const dates = `${c.eventDays.map((e) => esc(e.label)).join('・')}　${esc(c.room)}`;
  const hero = evIdx >= 0
    ? `<div class="card hero"><div class="big">${evIdx + 1}日目</div><div class="sub">${dates}</div></div>`
    : daysLeft > 0
      ? `<div class="card hero"><div><div class="sub">本番まで</div><div class="big">${daysLeft}日</div></div><div class="sub">${dates}</div></div>`
      : '';

  const { done, total } = todoStats();
  const todos = allTodos();
  const focusDay = todos.find((t) => t.date === ymd(d)) || todos.find((t) => t.date > ymd(d));
  const pending = focusDay ? focusDay.items.filter((i) => S.data.todo[i.id]?.s !== 'done') : [];

  const me = S.session.name;
  const board = postsOf('board').sort((a, b) => (b.pinned - a.pinned) || (b.ts - a.ts)).slice(0, 3);
  const prog = postsOf('progress').sort((a, b) => b.ts - a.ts).slice(0, 3);

  return `
  ${hero}
  ${vShiftNowCard()}
  <div class="grid2">
    <div class="card">
      <div class="row"><h3 class="grow">準備ToDo</h3><a class="small" href="#todo">一覧</a></div>
      <div class="small">${done} / ${total} 完了</div>
      <div class="prog" style="margin:6px 0 12px"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
      ${focusDay ? `<div class="small muted" style="margin-bottom:4px">${esc(focusDay.label)} 未完了</div>
        ${pending.length ? pending.map((i) => `<div class="small">・${esc(i.text)}</div>`).join('') : '<div class="small muted">なし</div>'}` : ''}
    </div>
    ${c.members.includes(me) ? `<div class="card">
      <div class="row"><h3 class="grow">自分のシフト</h3><a class="small" href="#shift">一覧</a></div>
      ${c.shift.days.map((day) => {
        const r = myRanges(day, me);
        return `<div class="small muted" style="margin:4px 0 2px">${esc(day.label)}</div>
          <div class="slots">${r.length ? r.map((x) => `<span class="slot">${x.s}〜${x.e}</span>`).join('') : '<span class="small muted">なし</span>'}</div>`;
      }).join('')}
    </div>` : ''}
  </div>
  <div class="card">
    <div class="row"><h3 class="grow">掲示板</h3><a class="small" href="#board">一覧</a></div>
    ${board.length ? board.map((p) => postHtml(p, { comments: false })).join('') : '<p class="empty">投稿なし</p>'}
  </div>
  <div class="card">
    <div class="row"><h3 class="grow">進捗報告</h3><a class="small" href="#progress">一覧</a></div>
    ${prog.length ? prog.map((p) => postHtml(p, { comments: false })).join('') : '<p class="empty">報告なし</p>'}
  </div>`;
}

function namesHtml(names) {
  const me = S.session.name;
  return names.length
    ? `<div class="slots">${names.map((n) => `<span class="slot ${n === me ? 'me' : ''}">${esc(dnMember(n))}</span>`).join('')}</div>`
    : '<span class="small muted">なし</span>';
}

function vShiftNowCard() {
  const s = shiftNow();
  if (s.phase === 'over') return '';
  let curHtml;
  if (s.phase === 'live') {
    const { on, sym } = rowNames(s.cur);
    curHtml = `<div class="small muted">${esc(s.day.label)} ${tm(s.cur.t)}</div>
      <div style="margin:6px 0 4px">${namesHtml(on)}</div>
      ${sym.length ? `<div class="small muted">${sym.map(esc).join('・')}</div>` : ''}`;
  } else {
    curHtml = `<div class="small muted">${s.phase === 'before' ? '開始前' : '時間外'}</div>`;
  }
  let nextHtml = '';
  if (s.next) {
    const { on } = rowNames(s.next);
    nextHtml = `<div style="margin-top:12px;padding-top:10px;border-top:1px solid var(--line)">
      <div class="small muted">次　${esc(s.nextDay.label)} ${tm(s.next.t)}</div>
      <div style="margin-top:6px">${namesHtml(on)}</div></div>`;
  }
  return `<div class="card"><div class="row"><h3 class="grow">現在のシフト</h3><a class="small" href="#shift">一覧</a></div>${curHtml}${nextHtml}</div>`;
}

/* todo */
function vTodo() {
  const { done, total } = todoStats();
  const today = ymd(now());
  return `
  <h2>準備ToDo</h2>
  <div class="card">
    <div class="small">${done} / ${total} 完了</div>
    <div class="prog" style="margin-top:6px"><i style="width:${total ? (done / total) * 100 : 0}%"></i></div>
  </div>
  ${allTodos().map((d) => `
    <div class="card">
      <div class="day-h"><h3>${esc(d.label)}</h3>${d.date === today ? '<span class="today-tag">今日</span>' : ''}</div>
      ${d.items.map(todoHtml).join('') || '<p class="empty">項目なし</p>'}
      <form class="compose" data-form="todoAdd" data-date="${d.date}" style="margin-top:10px">
        <div class="row"><input class="grow" type="text" data-k="todo-${d.date}" maxlength="200"><button class="btn small" type="submit">追加</button></div>
      </form>
    </div>`).join('')}`;
}

function todoHtml(item) {
  const st = S.data.todo[item.id] || { s: '' };
  const reports = postsOf('progress', item.id).sort((a, b) => a.ts - b.ts);
  const open = S.ui.open.has(item.id);
  return `
  <div class="todo ${st.s === 'done' ? 'is-done' : ''}">
    <div class="todo-main">
      <button class="st ${st.s}" data-act="cycle" data-id="${item.id}">${ST_LABEL[st.s]}</button>
      <div class="todo-text">
        <div class="t">${esc(item.text)}</div>
        ${item.note ? `<div class="note">${esc(item.note)}</div>` : ''}
        <div class="meta">
          ${st.uid ? `${esc(dn(st.uid))} ${fmtTs(st.ts)}　` : ''}
          <button class="link" data-act="toggle" data-id="${item.id}">報告${reports.length ? `(${reports.length})` : ''}</button>　
          <button class="link danger" data-act="todoDel" data-id="${item.id}">削除</button>
        </div>
        ${open ? `<div class="thread">
          ${reports.map((p) => postHtml(p, { comments: false, compact: true })).join('')}
          <form class="compose" data-form="progress" data-ref="${item.id}">
            <textarea data-k="prog-${item.id}" maxlength="2000" rows="2"></textarea>
            <div class="row"><button class="btn small" type="submit">報告</button></div>
          </form></div>` : ''}
      </div>
    </div>
  </div>`;
}

/* shift */
function vShift() {
  const c = S.content;
  const day = c.shift.days[S.ui.shiftDay] || c.shift.days[0];
  const me = c.members.indexOf(S.session.name);
  const cols = c.members.map((n, i) => ({ n, i })).filter(({ i }) => !S.ui.onlyMine || i === me);
  const cur = shiftNow();
  return `
  <h2>シフト</h2>
  <div class="row" style="margin-bottom:12px">
    <div class="seg">${c.shift.days.map((d, i) => `<button data-act="shiftDay" data-i="${i}" class="${d === day ? 'on' : ''}">${esc(d.label)}</button>`).join('')}</div>
    ${me >= 0 ? `<label class="small row" style="gap:6px;margin-left:auto"><input type="checkbox" data-act="onlyMine" ${S.ui.onlyMine ? 'checked' : ''}>自分のみ</label>` : ''}
  </div>
  <div class="card">
    <div class="tblwrap"><table class="shift">
      <thead><tr><th style="text-align:left">時間</th>${cols.map(({ n, i }) => `<th class="${i === me ? 'me' : ''}">${esc(dnMember(n))}</th>`).join('')}<th>人数</th></tr></thead>
      <tbody>${day.rows.map((r) => {
        if (r.closed) return `<tr class="closed"><td class="tm">${tm(r.t)}</td><td colspan="${cols.length + 1}">—</td></tr>`;
        const live = cur.phase === 'live' && cur.day === day && cur.cur === r;
        return `<tr class="${live ? 'live' : ''}"><td class="tm">${tm(r.t)}</td>${cols.map(({ i }) => {
          const v = r.c[i];
          return `<td class="${i === me ? 'me' : ''}">${v === '○' ? '<span class="on"></span>' : v ? `<span class="sym">${esc(v)}</span>` : ''}</td>`;
        }).join('')}<td class="muted">${r.c.filter((v) => v === '○').length}</td></tr>`;
      }).join('')}</tbody>
    </table></div>
  </div>`;
}

/* plan */
function vPlan() {
  const p = S.content.plan;
  return `
  <h2>企画書</h2>
  <div class="card"><h3>企画情報</h3>
    <dl class="kv">${p.info.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${esc(v)}</dd>`).join('')}
      <dt>電力</dt><dd>${esc(p.power)}</dd></dl>
  </div>
  <div class="card"><h3>企画内容</h3>
    ${p.exhibits.map((e, i) => `<div class="ex"><div class="n">${i + 1}</div><div><b>${esc(e.title)}</b><div class="small muted">${esc(e.detail)}</div></div></div>`).join('')}
  </div>
  <div class="card"><h3>注意事項</h3>
    <ul class="rules">${p.rules.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
  </div>`;
}

/* posts */
function postHtml(p, { comments = true, compact = false } = {}) {
  const cmts = comments ? postsOf('comment', p.id).sort((a, b) => a.ts - b.ts) : [];
  const open = S.ui.open.has(p.id);
  const ref = p.kind === 'progress' && p.ref && !compact ? todoById(p.ref) : null;
  return `
  <div class="${compact ? 'cmt' : 'post'}">
    <div class="post-h">
      ${p.pinned ? '<span class="badge">固定</span>' : ''}
      ${p.kind === 'board' ? `<span class="badge">${esc(p.cat)}</span>` : ''}
      ${ref ? `<span class="badge">${esc(ref.text.length > 24 ? ref.text.slice(0, 24) + '…' : ref.text)}</span>` : ''}
      <span class="a">${esc(whoOf(p))}</span>${adminMark(p.role)}<span class="ts">${fmtTs(p.ts)}</span>
    </div>
    <div class="post-b">${linkify(p.body)}</div>
    <div class="post-f small">
      ${comments ? `<button class="link" data-act="toggle" data-id="${p.id}">コメント${cmts.length ? `(${cmts.length})` : ''}</button>` : ''}
      ${isAdmin() && p.kind === 'board' ? `<button class="link" data-act="pin" data-id="${p.id}">${p.pinned ? '固定解除' : '固定'}</button>` : ''}
      ${canDelete(p) ? `<button class="link danger" data-act="del" data-id="${p.id}">削除</button>` : ''}
    </div>
    ${comments && open ? `<div class="thread">
      ${cmts.map((c) => postHtml(c, { comments: false, compact: true })).join('')}
      <form class="compose" data-form="comment" data-ref="${p.id}">
        <textarea data-k="cmt-${p.id}" maxlength="2000" rows="2"></textarea>
        <div class="row"><button class="btn small" type="submit">送信</button></div>
      </form></div>` : ''}
  </div>`;
}

function vBoard() {
  const posts = postsOf('board').sort((a, b) => (b.pinned - a.pinned) || (b.ts - a.ts));
  return `
  <h2>掲示板</h2>
  <div class="card">
    <form class="compose" data-form="board" style="margin-top:0">
      <select data-k="board-cat" style="width:auto">${CATS.map((c) => `<option>${c}</option>`).join('')}</select>
      <textarea data-k="board-body" maxlength="4000" rows="3"></textarea>
      <div class="row"><button class="btn" type="submit">投稿</button></div>
    </form>
  </div>
  <div class="card">${posts.length ? posts.map((p) => postHtml(p)).join('') : '<p class="empty">投稿なし</p>'}</div>`;
}

function vProgress() {
  const posts = postsOf('progress').sort((a, b) => b.ts - a.ts);
  return `
  <h2>進捗報告</h2>
  <div class="card">
    <form class="compose" data-form="progress" style="margin-top:0">
      <select data-k="prog-ref">
        <option value="">項目なし</option>
        ${allTodos().map((d) => `<optgroup label="${esc(d.label)}">${d.items.map((i) => `<option value="${i.id}">${esc(i.text)}</option>`).join('')}</optgroup>`).join('')}
      </select>
      <textarea data-k="prog-body" maxlength="4000" rows="3"></textarea>
      <div class="row"><button class="btn" type="submit">報告</button></div>
    </form>
  </div>
  <div class="card">${posts.length ? posts.map((p) => postHtml(p)).join('') : '<p class="empty">報告なし</p>'}</div>`;
}

/* admin */
function vAdmin() {
  const order = (n) => { const i = S.content.members.indexOf(n); return i < 0 ? 99 : i; };
  const users = Object.entries(S.dir)
    .map(([id, name]) => ({ id, name, role: entryByUid(S.keys, id)?.[1].role }))
    .filter((u) => u.role)
    .sort((x, y) => order(x.name) - order(y.name));
  const roleSel = (k, cur) => `<select data-k="${k}" style="width:auto"><option value="member" ${cur !== 'admin' ? 'selected' : ''}>部員</option><option value="admin" ${cur === 'admin' ? 'selected' : ''}>管理者</option></select>`;
  return `
  <h2>管理</h2>
  <div class="card">
    <h3>部員</h3>
    ${users.map((u) => `
      <div class="todo">
        <div class="row"><span class="grow"><b>${esc(dn(u.id))}</b> <span class="small muted">${esc(u.name)}</span>${adminMark(u.role)}</span>
          <button class="link" data-act="toggle" data-id="pw-${u.id}">パスワード変更</button>
          ${u.id !== S.session.uid ? `<button class="link danger" data-act="delUser" data-id="${u.id}">削除</button>` : ''}
        </div>
        ${S.ui.open.has('pw-' + u.id) ? `
        <form class="compose" data-form="userPw" data-id="${u.id}">
          <input type="password" data-k="upw-${u.id}" placeholder="新しいパスワード" autocomplete="new-password" minlength="4" required>
          <div class="row">${u.id === S.session.uid ? '' : roleSel(`urole-${u.id}`, u.role)}<button class="btn small" type="submit">変更</button></div>
        </form>` : ''}
      </div>`).join('')}
  </div>
  <div class="card">
    <h3>部員を追加</h3>
    <form data-form="addUser" class="compose">
      <input type="text" data-k="nu-name" placeholder="名前" maxlength="20" required>
      <input type="password" data-k="nu-pw" placeholder="パスワード" autocomplete="new-password" minlength="4" required>
      <div class="row">${roleSel('nu-role', 'member')}<button class="btn" type="submit">追加</button></div>
    </form>
  </div>
  <div class="card">
    <h3>GitHubキー</h3>
    <p class="small" style="margin-top:-4px">${S.token ? '設定済み' : '未設定'}</p>
    <form data-form="token" class="compose">
      <input type="password" data-k="tok" autocomplete="off" required>
      <div class="row"><button class="btn" type="submit">保存</button></div>
    </form>
  </div>`;
}

/* ---------- actions ---------- */
const newPost = (kind, ref, body, cat = '') => ({
  id: randomId(), kind, ref, cat, body, uid: S.session.uid, role: S.session.role, ts: Date.now(), pinned: false,
});

document.addEventListener('click', async (ev) => {
  const el = ev.target.closest('[data-act]');
  if (!el || el.tagName === 'INPUT') return;
  const { act, id } = el.dataset;
  // deletes need a second tap instead of confirm(), which some in-app browsers suppress
  if (['del', 'todoDel', 'delUser'].includes(act) && el.dataset.armed !== '1') {
    const label = el.textContent;
    el.dataset.armed = '1';
    el.textContent = 'もう一度押すと削除';
    setTimeout(() => { if (el.isConnected) { el.dataset.armed = ''; el.textContent = label; } }, 3000);
    return;
  }
  if (act === 'rename') renderDisplayName(false);
  else if (act === 'logout') { clearSession(); location.hash = ''; renderLogin(); }
  else if (act === 'refresh') refresh(false);
  else if (act === 'toggle') { S.ui.open.has(id) ? S.ui.open.delete(id) : S.ui.open.add(id); render(); }
  else if (act === 'shiftDay') { S.ui.shiftDay = Number(el.dataset.i); render(); }
  else if (act === 'cycle') {
    const next = ST_NEXT[S.data.todo[id]?.s || ''];
    await mutate((st) => {
      st.todo[id] = { s: ST_NEXT[st.todo[id]?.s || ''] ?? next, uid: S.session.uid, ts: Date.now() };
    }, `todo: ${id} → ${next || 'todo'}`);
  } else if (act === 'del') {
    await mutate((st) => { st.posts = st.posts.filter((p) => p.id !== id && p.ref !== id); }, 'delete post');
  } else if (act === 'pin') {
    await mutate((st) => { const p = st.posts.find((x) => x.id === id); if (p) p.pinned = !p.pinned; }, 'pin post');
  } else if (act === 'todoDel') {
    await mutate((st) => {
      st.todos = st.todos.filter((x) => x.id !== id);
      st.posts = st.posts.filter((p) => p.ref !== id);
      delete st.todo[id];
    }, 'delete todo');
  } else if (act === 'delUser') {
    try {
      await writeKeys(async (keys) => {
        const e = entryByUid(keys, id);
        if (e) delete keys.users[e[0]];
        const dir = keys.dir ? await unseal(S.K, keys.dir) : {};
        delete dir[id];
        keys.dir = await seal(S.K, dir);
      }, 'delete user');
      toast('削除しました');
      render();
    } catch (e) { toast(e.message); }
  }
});

document.addEventListener('change', (ev) => {
  if (ev.target.dataset.act === 'onlyMine') { S.ui.onlyMine = ev.target.checked; render(); }
});

document.addEventListener('submit', async (ev) => {
  const form = ev.target.closest('[data-form]');
  if (!form || form.id) return;
  ev.preventDefault();
  const kind = form.dataset.form;
  const val = (k) => form.querySelector(`[data-k="${k}"]`)?.value.trim() ?? '';
  // the form may have been re-rendered by mutate(), so clear the live fields
  const clear = (...ks) => ks.forEach((k) => { const el = document.querySelector(`[data-k="${k}"]`); if (el) el.value = ''; });
  const btn = form.querySelector('button[type=submit]');
  btn.disabled = true;
  try {
    if (kind === 'board') {
      const body = val('board-body');
      if (!body) return;
      if (await mutate((st) => st.posts.push(newPost('board', '', body, val('board-cat') || '連絡')), 'board post')) {
        clear('board-body'); render(); toast('投稿しました');
      }
    } else if (kind === 'comment') {
      const ref = form.dataset.ref;
      const body = val(`cmt-${ref}`);
      if (!body) return;
      if (await mutate((st) => st.posts.push(newPost('comment', ref, body)), 'comment')) { clear(`cmt-${ref}`); render(); }
    } else if (kind === 'progress') {
      const ref = form.dataset.ref ?? val('prog-ref');
      const k = form.dataset.ref ? `prog-${ref}` : 'prog-body';
      const body = val(k);
      if (!body) return;
      if (await mutate((st) => st.posts.push(newPost('progress', ref, body)), 'progress report')) {
        clear(k); render(); toast('報告しました');
      }
    } else if (kind === 'todoAdd') {
      const date = form.dataset.date;
      const text = val(`todo-${date}`);
      if (!text) return;
      if (await mutate((st) => st.todos.push({ id: 't' + randomId(8), date, text, uid: S.session.uid }), 'add todo')) {
        clear(`todo-${date}`); render();
      }
    } else if (kind === 'userPw') {
      const uid = form.dataset.id;
      const pw = val(`upw-${uid}`);
      if (pw.length < 4) return toast('4文字以上にしてください');
      const self = uid === S.session.uid;
      const role = self ? S.session.role : val(`urole-${uid}`) || 'member';
      btn.textContent = '変更中…';
      let newId;
      await writeKeys(async (keys) => {
        const old = entryByUid(keys, uid);
        if (!old) throw new Error('この部員は削除されています');
        const { id, entry } = await makeUserEntry(pw, S.session.k, { uid, name: S.dir[uid], role }, keys);
        if (keys.users[id] && keys.users[id].uid !== uid) throw new Error('他の人と同じパスワードは使えません');
        delete keys.users[old[0]];
        keys.users[id] = entry;
        newId = id;
      }, 'change user password');
      if (self) { S.session.id = newId; S.session.kid = S.keys.users[newId].kid; saveSession(); }
      S.ui.open.delete(`pw-${uid}`);
      toast('変更しました');
      render();
    } else if (kind === 'addUser') {
      const name = normName(val('nu-name'));
      const pw = val('nu-pw');
      if (!name) return;
      if (pw.length < 4) return toast('4文字以上にしてください');
      if (Object.values(S.dir).includes(name)) return toast('登録済みの名前です');
      btn.textContent = '追加中…';
      const uid = randomId(8);
      await writeKeys(async (keys) => {
        const { id, entry } = await makeUserEntry(pw, S.session.k, { uid, name, role: val('nu-role') || 'member' }, keys);
        if (keys.users[id]) throw new Error('他の人と同じパスワードは使えません');
        keys.users[id] = entry;
        keys.dir = await seal(S.K, { ...(keys.dir ? await unseal(S.K, keys.dir) : {}), [uid]: name });
      }, 'add user');
      clear('nu-name', 'nu-pw');
      toast('追加しました');
      render();
    } else if (kind === 'token') {
      const tok = val('tok');
      btn.textContent = '確認中…';
      const r = await fetch(`https://api.github.com/repos/${REPO}`, { headers: { Authorization: `Bearer ${tok}` }, cache: 'no-store' });
      const j = r.ok ? await r.json() : null;
      if (!j?.permissions?.push) throw new Error('このキーでは書き込めません');
      S.token = tok;
      const box = await seal(S.K, { t: tok });
      await writeKeys(async (keys) => { keys.tok = box; }, 'set GitHub key');
      clear('tok');
      toast('保存しました');
      render();
    }
  } catch (e) {
    toast(e.message || String(e));
  } finally {
    if (btn.isConnected) { btn.disabled = false; }
  }
});

window.addEventListener('hashchange', () => { if (S.session?.name) { render(); window.scrollTo(0, 0); } });
setInterval(() => { if (document.visibilityState === 'visible') refresh(); }, 60000);
setInterval(() => { if (S.session?.name && !document.querySelector('[data-k]:focus') && ['home', 'shift'].includes(route().view)) render(); }, 30000);
document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'visible') refresh(); });

boot();
