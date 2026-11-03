// Reads the bots' ntfy.sh channel (topic = the page's #hash) and folds the JSON lines into one state object.
// Nothing here is made up: every status, step, routine and usage figure comes from a line on the channel.
// ntfy.sh keeps ~12 h, so the newest lines are also cached in this browser (localStorage) and replayed on load.
const NTFY = 'https://ntfy.sh', KEEP = 800, MAX_LINE = 4096;
export const STATUSES = ['working', 'idle', 'waiting_user', 'error', 'done'];
export const QUIET_MS = 30 * 60e3;   // a "working" bot silent this long is shown as resting (it likely forgot its closing line)

export function topicFromHash() {
  const h = decodeURIComponent((location.hash || '').replace(/^#/, '')).split(/[&@?]/)[0].trim();
  return /^[A-Za-z0-9_-]{4,64}$/.test(h) ? h : null;
}

export function createFeed(topic, onChange) {
  const key = 'gbo2.feed.' + topic;
  const seen = new Set();
  let lines = [];
  const st = { bots: new Map(), floorsOrder: [], groups: {}, looks: {}, chat: {}, roster: [], usage: null, routines: new Map(),
    activity: [], finished: [], connected: false, loaded: false, lastLineAt: 0 };

  function bot(name) {
    let b = st.bots.get(name);
    if (!b) { b = { name, status: null, step: '', t: 0, group: null, inRoster: false, stepAt: 0 }; st.bots.set(name, b); }
    return b;
  }
  function ingest(l, live) {
    if (!l || l.event !== 'message' || typeof l.message !== 'string' || l.message.length > MAX_LINE) return null;
    if (seen.has(l.id)) return null; seen.add(l.id);
    let d; try { d = JSON.parse(l.message); } catch { return null; }
    if (!d || typeof d !== 'object') return null;
    const t = (l.time || 0) * 1000; st.lastLineAt = Math.max(st.lastLineAt, t);
    let ev = null;
    if (typeof d.bot === 'string' && STATUSES.includes(d.status)) {
      const b = bot(d.bot.trim().slice(0, 80));
      if (t >= b.t) {
        const prev = b.status;
        b.status = d.status; b.t = t; b.step = typeof d.step === 'string' ? d.step.slice(0, 120) : '';
        if (typeof d.group === 'string' && d.group.trim()) b.group = d.group.trim().slice(0, 40);
        b.stepAt = t;
        ev = { kind: 'status', bot: b.name, status: d.status, prev, step: b.step, t, live };
      }
      st.activity.push({ t, bot: b.name, status: d.status, step: typeof d.step === 'string' ? d.step.slice(0, 120) : '' });
      if (d.status === 'done') st.finished.push({ t, bot: b.name, step: typeof d.step === 'string' ? d.step.slice(0, 120) : '' });
    }
    if (Array.isArray(d.roster)) { st.roster = d.roster.filter((x) => typeof x === 'string').map((x) => x.trim()); for (const n of st.roster) bot(n).inRoster = true; }
    if (d.looks && typeof d.looks === 'object') Object.assign(st.looks, d.looks);
    if (d.groups && typeof d.groups === 'object') {
      for (const [n, g] of Object.entries(d.groups)) if (typeof g === 'string') { st.groups[n] = g.trim(); if (!st.floorsOrder.includes(g.trim())) st.floorsOrder.push(g.trim()); }
    }
    if (d.chat && typeof d.chat === 'object') for (const [n, u] of Object.entries(d.chat)) if (typeof u === 'string' && /^(grokbot|https):\/\//.test(u)) st.chat[n] = u;
    if (d.type === 'usage') st.usage = { pct: num(d.total_used_pct), resets: d.resets_at ? Date.parse(d.resets_at) : null, bots: d.bots && typeof d.bots === 'object' ? d.bots : {}, t };
    if (d.routines && typeof d.routines.bot === 'string' && Array.isArray(d.routines.items)) {
      st.routines.set(d.routines.bot, d.routines.items.filter((i) => i && typeof i.name === 'string').map((i) => ({ bot: d.routines.bot, name: i.name, schedule: typeof i.schedule === 'string' ? i.schedule : '', next: i.next_run ? Date.parse(i.next_run) : null })));
    }
    lines.push(l);
    return ev || { kind: 'other' };
  }
  const num = (v) => (typeof v === 'number' && isFinite(v) ? v : null);
  function save() {
    try { localStorage.setItem(key, JSON.stringify(lines.slice(-KEEP).map(({ id, time, event, message }) => ({ id, time, event, message })))); } catch {}
  }
  function trim() {
    const day = Date.now() - 24 * 3600e3;
    st.finished = st.finished.filter((f) => f.t >= day);
    if (st.activity.length > 300) st.activity = st.activity.slice(-300);
  }

  async function start() {
    let cached = []; try { cached = JSON.parse(localStorage.getItem(key)) || []; } catch {}
    let fresh = [];
    try {
      const text = await (await fetch(`${NTFY}/${encodeURIComponent(topic)}/json?poll=1&since=all`, { cache: 'no-store' })).text();
      fresh = text.split('\n').filter(Boolean).map((r) => { try { return JSON.parse(r); } catch { return null; } }).filter(Boolean);
    } catch { /* offline: the cache still shows the office */ }
    const all = [...cached, ...fresh].sort((a, b) => (a.time || 0) - (b.time || 0));
    for (const l of all) ingest(l, false);
    trim(); save(); st.loaded = true; onChange(null, st);
    const lastId = lines.length ? lines[lines.length - 1].id : null;
    follow(lastId);
    setInterval(() => { trim(); onChange(null, st); }, 30e3);
  }
  function follow(since) {
    const url = `${NTFY}/${encodeURIComponent(topic)}/sse` + (since ? `?since=${encodeURIComponent(since)}` : '');
    const es = new EventSource(url);
    es.onopen = () => { st.connected = true; onChange(null, st); };
    es.onerror = () => { st.connected = false; onChange(null, st); };
    es.onmessage = (m) => {
      let l; try { l = JSON.parse(m.data); } catch { return; }
      const ev = ingest(l, true);
      if (ev) { trim(); save(); onChange(ev, st); }
    };
  }
  return { st, start };
}

/** Status shown for a bot right now (null/old "working" -> resting). */
export function shownStatus(b, now = Date.now()) {
  if (!b.status) return 'resting';
  if (b.status === 'working' && now - b.t > QUIET_MS) return 'resting';
  if (b.status === 'idle') return 'resting';
  return b.status;
}
