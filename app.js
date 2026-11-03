import { createFeed, topicFromHash, shownStatus, QUIET_MS } from './feed.js';
import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Asia/Karachi';
const fmtT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtD = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABEL = { working: 'working', waiting_user: 'needs you', error: 'error', done: 'done', resting: 'resting' };
const OTHER = 'Other';

const topic = topicFromHash();
let selFloor = null, selBot = null, layoutSig = '', st = null, tourT = 0;
const popUntil = new Map();   // bot -> ms until which its bubble shows after a live update
const bubbles = new Map(), tags = new Map();

const scene = createScene($('c'), { onPick: (n) => { if (n) selectBot(n); else { selBot = null; renderRight(); } } });

// ---------- day / night, tour, mobile drawers ----------
let night = localStorage.getItem('gbo2.night') === '1';
function applyNight() { document.body.classList.toggle('night', night); document.body.classList.toggle('day', !night); $('btnDay').textContent = night ? '☾ Night' : '☀︎ Day'; scene.setNight(night); }
$('btnDay').onclick = () => { night = !night; localStorage.setItem('gbo2.night', night ? '1' : '0'); applyNight(); };
applyNight();
$('btnTour').onclick = () => {
  if (tourT) { clearInterval(tourT); tourT = 0; $('btnTour').classList.remove('on'); $('btnTour').textContent = '▶ Tour'; return; }
  $('btnTour').classList.add('on'); $('btnTour').textContent = '■ Stop';
  const step = () => { const fl = floorsList(); if (!fl.length) return; const i = (fl.findIndex((f) => f.name === selFloor) + 1) % fl.length; selectFloor(fl[i].name); };
  step(); tourT = setInterval(step, 6000);
};
$('btnLeft').onclick = () => { document.body.classList.toggle('showL'); document.body.classList.remove('showR'); };
$('btnRight').onclick = () => { document.body.classList.toggle('showR'); document.body.classList.remove('showL'); };
$('scrim').onclick = () => document.body.classList.remove('showL', 'showR');
$('actToggle').onclick = () => { $('activity').classList.toggle('min'); $('actToggle').textContent = $('activity').classList.contains('min') ? '+' : '–'; };

// ---------- clock ----------
function tickClock() { $('liveText').textContent = (st?.connected ? 'Live' : st?.loaded ? 'Reconnecting' : 'Connecting…') + ' • ' + fmtT.format(new Date()) + ' PKT'; $('live').classList.toggle('on', !!st?.connected); }
setInterval(tickClock, 10e3); tickClock();

// ---------- chime (Web Audio, only after the page has had a click/tap) ----------
let actx = null;
addEventListener('pointerdown', () => { try { actx ??= new AudioContext(); actx.resume(); } catch {} }, { once: false });
function chime() {
  if (!actx || actx.state !== 'running') return;
  const t = actx.currentTime;
  for (const [f, d] of [[880, 0], [1320, 0.14]]) {
    const o = actx.createOscillator(), g = actx.createGain(); o.type = 'sine'; o.frequency.value = f;
    g.gain.setValueAtTime(0.0001, t + d); g.gain.exponentialRampToValueAtTime(0.18, t + d + 0.02); g.gain.exponentialRampToValueAtTime(0.0001, t + d + 0.6);
    o.connect(g).connect(actx.destination); o.start(t + d); o.stop(t + d + 0.7);
  }
}

// ---------- model helpers ----------
function floorOf(b) { return st.groups[b.name] || b.group || OTHER; }
function floorsList() {
  if (!st) return [];
  const names = [...st.floorsOrder];
  const map = new Map(names.map((n) => [n, []]));
  const order = [...st.roster, ...[...st.bots.keys()].filter((n) => !st.roster.includes(n))];
  for (const n of order) { const b = st.bots.get(n); if (!b) continue; const f = floorOf(b); if (!map.has(f)) { map.set(f, []); names.push(f); } if (!map.get(f).includes(b)) map.get(f).push(b); }
  return names.filter((n) => map.get(n).length).map((n) => ({ name: n, bots: map.get(n) }));
}
const chatUrl = (n) => st.chat[n] || null;
function chatBtn(n) { const u = chatUrl(n); return u ? `<a class="chatbtn" href="${esc(u)}">Open chat</a>` : `<span class="chatbtn dis" title="No chat link posted for this bot yet">No link</span>`; }
const ago = (t) => { const m = Math.round((Date.now() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago' : Math.floor(m / 1440) + 'd ago'; };

// ---------- render ----------
function render(ev) {
  const fl = floorsList();
  $('empty').hidden = fl.length > 0 || !st.loaded;
  const sig = fl.map((f) => f.name + ':' + f.bots.map((b) => b.name + '/' + JSON.stringify(st.looks[b.name] || {})).join(',')).join('|');
  if (sig !== layoutSig) {
    layoutSig = sig;
    scene.build(fl.map((f) => ({ name: f.name, bots: f.bots.map((b) => ({ name: b.name, look: st.looks[b.name] })) })));
    for (const el of [...bubbles.values(), ...tags.values()]) el.remove(); bubbles.clear(); tags.clear();
    if (!selFloor || !fl.some((f) => f.name === selFloor)) selFloor = fl[0]?.name || null;
    scene.aim(selFloor, true);
  }
  const now = Date.now();
  let c = { working: 0, waiting_user: 0, error: 0, resting: 0 };
  for (const b of st.bots.values()) { const s = shownStatus(b, now); scene.setStatus(b.name, s); c[s === 'done' ? 'resting' : s]++; }
  $('cWork').textContent = c.working; $('cWait').textContent = c.waiting_user; $('cErr').textContent = c.error; $('cRest').textContent = c.resting;

  // floors
  $('floors').innerHTML = fl.map((f) => { const act = f.bots.filter((b) => ['working', 'waiting_user', 'error'].includes(shownStatus(b, now))).length;
    return `<li data-f="${esc(f.name)}" class="${f.name === selFloor ? 'sel' : ''}"><span><i class="act ${act ? '' : 'off'}"></i>${esc(f.name)}</span><span class="n">${act}/${f.bots.length} active</span></li>`; }).join('') || '<li class="emptyrow">No floors yet</li>';
  for (const li of $('floors').querySelectorAll('li[data-f]')) li.onclick = () => { selectFloor(li.dataset.f); document.body.classList.remove('showL'); };

  // waiting on me
  const waiting = [...st.bots.values()].filter((b) => shownStatus(b, now) === 'waiting_user').sort((a, b) => b.t - a.t);
  $('waitCount').textContent = waiting.length;
  $('waiting').innerHTML = waiting.map((b) => `<li><div style="flex:1;min-width:0"><div class="nm">${esc(b.name)}</div><div class="sub">${esc(b.step || 'needs you')} · ${ago(b.t)}</div></div>${chatBtn(b.name)}</li>`).join('') || '<li class="emptyrow">Nobody is waiting on you right now.</li>';

  // finished (done lines, last 24 h)
  const fin = [...st.finished].reverse();
  $('finCount').textContent = fin.length;
  $('finished').innerHTML = fin.slice(0, 60).map((f) => `<li><span class="t">${fmtT.format(f.t)}</span><b>${esc(f.bot)}</b> — ${esc(f.step || 'done')}</li>`).join('') || '<li class="emptyrow">No finished tasks posted in the last 24 h.</li>';

  // routines
  const rs = [...st.routines.values()].flat().sort((a, b) => (a.next ?? Infinity) - (b.next ?? Infinity));
  $('routCount').textContent = rs.length;
  $('routines').innerHTML = rs.map((r) => `<li><b>${esc(r.name)}</b> <span class="sub">· ${esc(r.bot)}</span><br><span class="t">${r.next ? (r.next < now ? 'last due ' : 'next ') + fmtD.format(r.next) + ' PKT' : 'no next run posted'}</span> <span class="sub">${esc(r.schedule)}</span></li>`).join('') || '<li class="emptyrow">No routines posted yet.</li>';

  // activity (newest at the bottom, like a log)
  const acts = st.activity.slice(-80);
  const box = $('actlist'), atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 30;
  box.innerHTML = acts.map((a, i) => `<li class="${ev?.kind === 'status' && ev.live && i === acts.length - 1 ? 'new' : ''}"><span class="t">${fmtT.format(a.t)}</span><b>${esc(a.bot)}</b> – ${esc(a.step || LABEL[a.status] || a.status)}</li>`).join('') || '<li style="color:#9ca3af">No activity on the feed yet.</li>';
  if (atBottom || ev) box.scrollTop = box.scrollHeight;

  renderRight(); renderUsage();
}
function renderRight() {
  const fl = floorsList().find((f) => f.name === selFloor);
  const now = Date.now();
  if (!fl) { $('floorName').textContent = '—'; $('floorSub').textContent = ''; $('floorBots').innerHTML = '<li class="emptyrow">No bots yet.</li>'; return; }
  const w = fl.bots.filter((b) => shownStatus(b, now) === 'working').length;
  $('floorName').textContent = fl.name; $('floorSub').textContent = `${w} working · ${fl.bots.length} bots`;
  const rank = { waiting_user: 0, error: 1, working: 2, done: 3, resting: 4 };
  const bots = [...fl.bots].sort((a, b) => rank[shownStatus(a, now)] - rank[shownStatus(b, now)] || b.t - a.t);
  $('floorBots').innerHTML = bots.map((b) => { const s = shownStatus(b, now), col = st.looks[b.name]?.color || '#a3a3a3';
    const quiet = b.status === 'working' && s === 'resting' ? ` (no update for ${Math.round(QUIET_MS / 60e3)}+ min)` : '';
    const step = b.status ? `${esc(b.step || '—')}${quiet} · ${ago(b.t)}` : 'No status posted yet';
    return `<li data-b="${esc(b.name)}" class="${b.name === selBot ? 'sel' : ''}"><i class="sw" style="background:${esc(col)}"></i><span class="nm">${esc(b.name)}</span><span class="st ${s}">${LABEL[s]}</span><span class="step">${step}</span>${b.name === selBot ? `<span style="grid-column:2/4;margin-top:4px">${chatBtn(b.name)}</span>` : ''}</li>`; }).join('');
  for (const li of $('floorBots').querySelectorAll('li[data-b]')) li.onclick = (e) => { if (e.target.closest('a')) return; selectBot(li.dataset.b, true); };
}
function renderUsage() {
  const u = st.usage;
  if (!u) { $('usage').innerHTML = '<div class="uh"><span>Weekly limit</span></div><div class="ur">No usage posted yet.</div>'; return; }
  const pct = u.pct, now = Date.now();
  let reset = '';
  if (u.resets && isFinite(u.resets)) { const ms = u.resets - now; reset = ms > 0 ? `resets in ${Math.floor(ms / 864e5)}d ${Math.floor((ms % 864e5) / 36e5)}h` : 'reset time passed — waiting for a new usage post'; }
  const bots = Object.entries(u.bots).filter(([, v]) => typeof v === 'number').sort((a, b) => b[1] - a[1]);
  $('usage').innerHTML = `<div class="uh"><span>Weekly limit</span><span>${pct == null ? '—' : (+pct.toFixed(1)) + '%'}</span></div>
    <div class="bar"><i style="width:${pct == null ? 0 : Math.min(100, Math.max(0, pct))}%"></i></div>
    <div class="ur">${esc(reset)}${reset ? ' · ' : ''}posted ${fmtT.format(u.t)} PKT</div>
    ${bots.length ? `<ul>${bots.map(([n, v]) => `<li><span>${esc(n)}</span><span>${+v.toFixed(1)}%</span></li>`).join('')}</ul><div class="ur" style="margin-top:4px">Per-bot share of usage, as posted</div>` : '<div class="ur">No per-bot breakdown posted.</div>'}`;
}

function selectFloor(name) { selFloor = name; scene.aim(name); renderRight(); for (const li of $('floors').querySelectorAll('li[data-f]')) li.classList.toggle('sel', li.dataset.f === name); }
function selectBot(name, fromList) {
  const b = st.bots.get(name); if (!b) return;
  selBot = name; const f = floorOf(b); if (f !== selFloor) selectFloor(f);
  popUntil.set(name, Date.now() + 8000); renderRight();
  if (!fromList && innerWidth <= 820) document.body.classList.add('showR');
}

// ---------- notifications ----------
let noticeTimer = 0;
function notify(b) {
  $('noticeText').textContent = `${b.name} needs you`;
  const u = chatUrl(b.name); const a = $('noticeChat'); if (u) { a.href = u; a.hidden = false; } else a.hidden = true;
  $('notice').hidden = false; $('notice').style.animation = 'none'; void $('notice').offsetWidth; $('notice').style.animation = '';
  $('noticeView').onclick = () => { selectBot(b.name); $('notice').hidden = true; };
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => ($('notice').hidden = true), 20000);
  chime();
}
$('noticeClose').onclick = () => ($('notice').hidden = true);

// ---------- speech bubbles + name tags, positioned every frame ----------
function overlayLoop() {
  if (st) {
    const now = Date.now();
    const fl = floorsList().find((f) => f.name === selFloor);
    const want = new Set();
    if (fl) for (const b of fl.bots) {
      const p = scene.project(b.name); if (!p) continue;
      const s = shownStatus(b, now);
      const show = b.status && (popUntil.get(b.name) > now || b.name === selBot || ['working', 'waiting_user', 'error'].includes(s));
      let tag = tags.get(b.name);
      if (!tag) { tag = document.createElement('div'); tag.className = 'tag'; tag.textContent = b.name; $('overlay').appendChild(tag); tags.set(b.name, tag); }
      tag.style.left = p.fx + 'px'; tag.style.top = p.fy + 'px'; want.add('t' + b.name);
      if (show) {
        let el = bubbles.get(b.name); const txt = b.step || LABEL[s];
        if (!el) { el = document.createElement('div'); el.className = 'bub'; $('overlay').appendChild(el); bubbles.set(b.name, el); }
        if (el.dataset.txt !== txt) { el.dataset.txt = txt; el.innerHTML = `<b>${esc(b.name)}</b>${esc(txt.length > 70 ? txt.slice(0, 68) + '…' : txt)}`; el.classList.remove('pop'); void el.offsetWidth; el.classList.add('pop'); }
        el.style.left = p.x + 'px'; el.style.top = p.y + 'px'; el.style.zIndex = b.name === selBot ? 3 : 1; want.add('b' + b.name);
      }
    }
    for (const [n, el] of bubbles) if (!want.has('b' + n)) { el.remove(); bubbles.delete(n); }
    for (const [n, el] of tags) if (!want.has('t' + n)) { el.remove(); tags.delete(n); }
  }
  requestAnimationFrame(overlayLoop);
}
requestAnimationFrame(overlayLoop);

// ---------- start ----------
if (!topic) {
  $('empty').hidden = false;
  $('empty').textContent = 'Open this page with your feed link (…/#<your topic>) to see your bots.';
} else {
  const feed = createFeed(topic, (ev, s) => {
    st = s;
    if (ev?.kind === 'status' && ev.live) {
      popUntil.set(ev.bot, Date.now() + 10000);
      if (ev.status === 'waiting_user' && ev.prev !== 'waiting_user') notify(st.bots.get(ev.bot));
    }
    render(ev); tickClock();
  });
  st = feed.st;
  feed.start();
}
addEventListener('hashchange', () => location.reload());
