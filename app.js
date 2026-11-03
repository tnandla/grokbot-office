import { createFeed, topicFromHash, shownStatus, QUIET_MS, createState, ingestLine, loadHistory, STATUSES } from './feed.js';
import { createScene } from './scene.js';

const $ = (id) => document.getElementById(id);
const TZ = 'Asia/Karachi';
const fmtT = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: '2-digit', minute: '2-digit', hour12: false });
const fmtD = new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit', hour12: false });
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const LABEL = { working: 'working', waiting_user: 'needs you', error: 'error', done: 'done', resting: 'resting' };
const OTHER = 'Other';

const topic = topicFromHash();
let selFloor = null, selBot = null, layoutSig = '', st = null, liveSt = null, tourT = 0;
let replay = null;   // set while a timelapse replay is on screen
const nowMs = () => (replay ? replay.cur : Date.now());
const popUntil = new Map();   // bot -> ms until which its bubble shows after a live update
const bubbles = new Map(), tags = new Map();

const scene = createScene($('c'), { onPick: (n) => { if (n) selectBot(n); else { selBot = null; renderRight(); } } });

// ---------- day / night, tour, mobile drawers ----------
let night = localStorage.getItem('gbo2.night') === '1';
function applyNight() { if (replay) return; document.body.classList.toggle('night', night); document.body.classList.toggle('day', !night); $('btnDay').textContent = night ? '☾ Night' : '☀︎ Day'; scene.setNight(night); }
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
function tickClock() { const L = liveSt || st; $('liveText').textContent = (replay ? 'Replay (live paused) • ' : L?.connected ? 'Live • ' : L?.loaded ? 'Reconnecting • ' : 'Connecting… • ') + fmtT.format(new Date()) + ' PKT'; $('live').classList.toggle('on', !!L?.connected && !replay); }
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
const ago = (t) => { const m = Math.round((nowMs() - t) / 60e3); return m < 1 ? 'just now' : m < 60 ? m + 'm ago' : m < 1440 ? Math.floor(m / 60) + 'h ' + (m % 60) + 'm ago' : Math.floor(m / 1440) + 'd ago'; };

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
  const now = nowMs();
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
  $('finished').innerHTML = fin.slice(0, 60).map((f) => `<li><span class="t">${fmtT.format(f.t)}</span><b>${esc(f.bot)}</b> — ${esc(f.step || 'done')}</li>`).join('') || (replay ? '<li class="emptyrow">No finished tasks yet at this point of the replay.</li>' : '<li class="emptyrow">No finished tasks posted in the last 24 h.</li>');

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
  const now = nowMs();
  if (!fl) { $('floorName').textContent = '—'; $('floorSub').textContent = ''; $('floorBots').innerHTML = '<li class="emptyrow">No bots yet.</li>'; return; }
  const w = fl.bots.filter((b) => shownStatus(b, now) === 'working').length;
  $('floorName').textContent = fl.name; $('floorSub').textContent = `${w} working · ${fl.bots.length} bots`;
  const rank = { waiting_user: 0, error: 1, working: 2, done: 3, resting: 4 };
  const bots = [...fl.bots].sort((a, b) => rank[shownStatus(a, now)] - rank[shownStatus(b, now)] || b.t - a.t);
  $('floorBots').innerHTML = bots.map((b) => { const s = shownStatus(b, now), col = st.looks[b.name]?.color || '#a3a3a3';
    const quiet = b.status === 'working' && s === 'resting' ? ` (no update for ${Math.round(QUIET_MS / 60e3)}+ min)` : '';
    const step = b.status ? `${esc(b.step || '—')}${quiet} · ${ago(b.t)}` : (replay ? 'No status yet at this point of the replay' : 'No status posted yet');
    return `<li data-b="${esc(b.name)}" class="${b.name === selBot ? 'sel' : ''}"><i class="sw" style="background:${esc(col)}"></i><span class="nm">${esc(b.name)}</span><span class="st ${s}">${LABEL[s]}</span><span class="step">${step}</span>${b.name === selBot ? `<span style="grid-column:2/4;margin-top:4px">${chatBtn(b.name)}</span>` : ''}</li>`; }).join('');
  for (const li of $('floorBots').querySelectorAll('li[data-b]')) li.onclick = (e) => { if (e.target.closest('a')) return; selectBot(li.dataset.b, true); };
}
function renderUsage() {
  const u = st.usage;
  if (!u) { $('usage').innerHTML = '<div class="uh"><span>Weekly limit</span></div><div class="ur">No usage posted yet.</div>'; return; }
  const pct = u.pct, now = nowMs();
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
function notify(b, src) {
  $('noticeText').textContent = `${b.name} needs you`;
  const u = (src || st).chat[b.name] || null; const a = $('noticeChat'); if (u) { a.href = u; a.hidden = false; } else a.hidden = true;
  $('notice').hidden = false; $('notice').style.animation = 'none'; void $('notice').offsetWidth; $('notice').style.animation = '';
  $('noticeView').onclick = () => { if (replay) exitReplay(); selectBot(b.name); $('notice').hidden = true; };
  clearTimeout(noticeTimer); noticeTimer = setTimeout(() => ($('notice').hidden = true), 20000);
  chime();
}
$('noticeClose').onclick = () => ($('notice').hidden = true);

// ---------- speech bubbles + name tags, positioned every frame ----------
function overlayLoop() {
  if (st) {
    const now = Date.now(), vnow = nowMs();
    const fl = floorsList().find((f) => f.name === selFloor);
    const want = new Set();
    if (fl) for (const b of fl.bots) {
      const p = scene.project(b.name); if (!p) continue;
      const s = shownStatus(b, vnow);
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


// ---------- 24 h timelapse replay (only real lines from the feed; nothing is simulated) ----------
const fmtHM = (ms) => { const m = Math.round(ms / 60e3); return m < 60 ? m + ' min' : Math.floor(m / 60) + 'h ' + String(m % 60).padStart(2, '0') + 'm'; };
const BASE_MS = 60e3;   // the whole available window plays in ~60 s at 1x
function pktHour(ms) { const p = Object.fromEntries(new Intl.DateTimeFormat('en-GB', { timeZone: TZ, hour: 'numeric', minute: 'numeric', hourCycle: 'h23' }).formatToParts(ms).map((x) => [x.type, x.value])); return +p.hour + +p.minute / 60; }
function daylight(h) {   // Pakistan, roughly: dawn 05:45–07:00, dusk 17:00–18:15
  if (h < 5.75 || h >= 18.25) return 0; if (h < 7) return (h - 5.75) / 1.25; if (h < 17) return 1; return 1 - (h - 17) / 1.25;
}
function seedState() {   // layout (floors, desks, looks, chat links) from the live office; every status starts blank
  const r = createState(), L = liveSt;
  r.roster = [...L.roster]; r.floorsOrder = [...L.floorsOrder]; r.groups = { ...L.groups }; r.looks = { ...L.looks }; r.chat = { ...L.chat };
  for (const [n, b] of L.bots) r.bots.set(n, { name: n, status: null, step: '', t: 0, group: b.group, inRoster: b.inRoster, stepAt: 0 });
  r.loaded = true; return r;
}
function isStatusLine(l) { try { const d = JSON.parse(l.message); return d && typeof d.bot === 'string' && STATUSES.includes(d.status); } catch { return false; } }
async function startReplay() {
  if (replay || !liveSt) return;
  const btn = $('btnReplay'); btn.disabled = true; btn.textContent = '⏱ Loading…';
  let h; try { h = await loadHistory(topic); } finally { btn.disabled = false; btn.innerHTML = '⏱<span class="full"> Replay 24h</span>'; }
  const statusLines = h.lines.filter(isStatusLine);
  const now = Date.now();
  if (tourT) $('btnTour').click();
  replay = { lines: h.lines, idx: 0, st: seedState(), cur: now, t0: now, t1: now, speed: 1, playing: false, last: 0, lastFloorAt: 0, n: statusLines.length, raf: 0, lastRender: 0 };
  document.body.classList.add('replaying'); $('rbar').hidden = false; $('rclock').hidden = false;
  if (!statusLines.length) {
    $('rinfo').textContent = 'Nothing to replay: no bot status lines in the last 24 h' + (h.ntfyOk ? '' : ' (and ntfy.sh could not be reached)') + '.';
    $('rnote').textContent = 'ntfy.sh keeps about 12 h of lines; this page also remembers what it saw while it was open.';
    $('rctl').hidden = true; st = replay.st; replay.cur = now; render(); paintClock(); tickClock(); return;
  }
  $('rctl').hidden = false;
  replay.t0 = statusLines[0].time * 1000 - 60e3; replay.t1 = now; replay.cur = replay.t0;
  const span = replay.t1 - replay.t0, multi = new Date(replay.t0).toDateString() !== new Date(replay.t1).toDateString();
  const f = multi ? fmtD : fmtT;
  $('rinfo').textContent = `Replaying ${f.format(replay.t0)}–${f.format(replay.t1)} PKT · ${replay.n} status event${replay.n === 1 ? '' : 's'} · ${fmtHM(span)}`;
  $('rnote').textContent = span < 23.5 * 3600e3
    ? `Only ${fmtHM(span)} of history is available, not the full 24 h (ntfy.sh keeps ~12 h; this browser adds what it saw while the page was open${h.ntfyOk ? '' : '; ntfy.sh was unreachable, so this is the browser log only'}). Bots start blank until their first line in this window.`
    : 'Bots start blank until their first line in this window.';
  // event marks on the scrub bar
  const COL = { working: '#22c55e', waiting_user: '#f59e0b', error: '#ef4444', done: '#16a34a', idle: '#9ca3af' };
  $('rmarks').innerHTML = statusLines.map((l) => { let s = 'idle'; try { s = JSON.parse(l.message).status; } catch {}
    return `<i style="left:${((l.time * 1000 - replay.t0) / span * 100).toFixed(2)}%;background:${COL[s] || '#9ca3af'}"></i>`; }).join('');
  st = replay.st; layoutSig = ''; render(); setSpeed(1); play(true); tickClock();
  replay.raf = requestAnimationFrame(replayLoop);
}
function rebuildTo(t) {   // scrub: replay every real line up to t from a blank start
  replay.st = seedState(); replay.idx = 0; st = replay.st; replay.cur = t; applyUpTo(t, false); render(); paintClock();
}
function applyUpTo(t, anim) {
  let last = null;
  while (replay.idx < replay.lines.length && replay.lines[replay.idx].time * 1000 <= t) {
    const ev = ingestLine(replay.st, replay.lines[replay.idx++], false);
    if (ev?.kind === 'status') { last = ev; if (anim) popUntil.set(ev.bot, Date.now() + 2500); }
  }
  return last;
}
function replayLoop(ts) {
  if (!replay) return;
  const dt = replay.last ? Math.min(ts - replay.last, 250) : 0; replay.last = ts;
  if (replay.playing) {
    replay.cur = Math.min(replay.t1, replay.cur + dt * ((replay.t1 - replay.t0) / BASE_MS) * replay.speed);
    const ev = applyUpTo(replay.cur, true);
    if (ev) {
      const b = replay.st.bots.get(ev.bot);
      if (b && floorOf(b) !== selFloor && ts - replay.lastFloorAt > 2500) { replay.lastFloorAt = ts; selectFloor(floorOf(b)); }
      render({ ...ev, live: true });
    } else if (ts - replay.lastRender > 400) render();
    if (ev) replay.lastRender = ts;
    if (replay.cur >= replay.t1) { play(false); $('rinfo').dataset.end = '1'; }
    paintClock();
  }
  replay.raf = requestAnimationFrame(replayLoop);
}
function paintClock() {
  if (!replay) return;
  $('rclock').innerHTML = `<b>${fmtT.format(replay.cur)}</b> PKT<span>${new Intl.DateTimeFormat('en-GB', { timeZone: TZ, weekday: 'short', day: 'numeric', month: 'short' }).format(replay.cur)}</span>`;
  const span = replay.t1 - replay.t0; if (span > 0) $('rpos').value = Math.round((replay.cur - replay.t0) / span * 1000);
  const f = daylight(pktHour(replay.cur)); scene.setDaylight(f);
  document.body.classList.toggle('night', f < 0.5); document.body.classList.toggle('day', f >= 0.5);
}
function play(on) {
  if (!replay) return;
  if (on && replay.cur >= replay.t1) rebuildTo(replay.t0);
  replay.playing = on; replay.last = 0; $('rplay').textContent = on ? '❚❚' : '▶'; $('rplay').setAttribute('aria-label', on ? 'Pause' : 'Play');
}
function setSpeed(v) { if (!replay) return; replay.speed = v; for (const b of document.querySelectorAll('#rspeed button')) b.classList.toggle('on', +b.dataset.s === v); }
function exitReplay() {
  if (!replay) return;
  cancelAnimationFrame(replay.raf); replay = null;
  document.body.classList.remove('replaying'); $('rbar').hidden = true; $('rclock').hidden = true;
  st = liveSt; layoutSig = ''; applyNight(); render(); tickClock();
}
$('btnReplay').onclick = () => (replay ? exitReplay() : startReplay());
$('rplay').onclick = () => play(!replay.playing);
$('rexit').onclick = exitReplay;
for (const b of document.querySelectorAll('#rspeed button')) b.onclick = () => setSpeed(+b.dataset.s);
$('rpos').oninput = (e) => { if (!replay) return; const t = replay.t0 + (replay.t1 - replay.t0) * (+e.target.value / 1000);
  if (t < replay.cur) rebuildTo(t); else { replay.cur = t; applyUpTo(t, false); render(); paintClock(); } };
addEventListener('keydown', (e) => { if (!replay || e.target.closest('input,textarea')) return; if (e.key === ' ') { e.preventDefault(); play(!replay.playing); } else if (e.key === 'Escape') exitReplay(); });

// ---------- start ----------
if (!topic) {
  $('empty').hidden = false;
  $('empty').textContent = 'Open this page with your feed link (…/#<your topic>) to see your bots.';
} else {
  const feed = createFeed(topic, (ev, s) => {
    liveSt = s;
    if (ev?.kind === 'status' && ev.live && ev.status === 'waiting_user' && ev.prev !== 'waiting_user') notify(s.bots.get(ev.bot), s);
    if (replay) { tickClock(); return; }   // live lines keep arriving underneath; shown again on Exit
    st = s;
    if (ev?.kind === 'status' && ev.live) popUntil.set(ev.bot, Date.now() + 10000);
    render(ev); tickClock();
  });
  st = liveSt = feed.st;
  feed.start();
}
addEventListener('hashchange', () => location.reload());
