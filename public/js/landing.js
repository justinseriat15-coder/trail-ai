// Landing preview: every number comes from the same demo endpoint the
// dashboard reads (/api/activities?source=demo), so the landing can never
// drift from the app it describes. Falls back to the bundled dataset offline.
import { demoActivities, DEMO_PROFILE } from '/js/demo-data.js';
import { loadVsUsual, loadReading, aerobicEngine, engineReading, weeklyVolume, easyShare, isRun, parseLocal, km } from '/js/analytics.js';

const set = (id, v) => { const el = document.getElementById(id); if (el) el.textContent = v; };

async function fill() {
  let acts = null, profile = DEMO_PROFILE, zoneById = {};
  try {
    const r = await fetch('/api/activities?source=demo');
    if (r.ok) {
      const data = await r.json();
      acts = data.activities;
      profile = data.profile || profile;
      zoneById = data.insights?.perActivity || {};
    }
  } catch { /* fall through to the bundled dataset */ }
  if (!acts) acts = demoActivities();
  const { hrMax, hrRest } = profile;

  const last7 = acts.filter((a) => isRun(a) && Date.now() - parseLocal(a.start_date_local) < 7 * 86400000);
  set('pv-vol', `${km(last7.reduce((t, a) => t + a.distance, 0))} km`);
  set('pv-vol-sub', `${last7.length} sessions, ${Math.round(last7.reduce((t, a) => t + (a.total_elevation_gain || 0), 0)).toLocaleString('en-GB')} m gain`);

  const lv = loadVsUsual(acts, hrMax, hrRest);
  set('pv-load', lv.deltaPct == null ? '—' : `${lv.deltaPct > 0 ? '+' : ''}${lv.deltaPct}%`);
  set('pv-load-sub', loadReading(lv.deltaPct).label.replace(/^.*?vs your usual: /, ''));
  if (lv.deltaPct != null) set('pvc-load', `${lv.deltaPct > 0 ? '+' : ''}${lv.deltaPct}%`);

  const eng = aerobicEngine(acts, hrMax);
  if (eng.latestSecPerKm) {
    const m = Math.floor(eng.latestSecPerKm / 60), sec = String(Math.round(eng.latestSecPerKm % 60)).padStart(2, '0');
    set('pv-engine', `${m}:${sec}/km`);
    set('pv-engine-sub', `at ${eng.refHr} bpm · ${engineReading(eng.changePct)}`);
  }

  const es = easyShare(acts.map((a) => ({ ...a, zoneSecs: zoneById[a.id]?.zoneSecs || null })));
  if (es.d28.pct != null) set('pvc-easy', `${es.d28.pct}%`);

  const wk = weeklyVolume(acts, 1)[0];
  set('pv-week', `${wk.hours} h`);
  set('pv-week-sub', `${wk.dplus.toLocaleString('en-GB')} m of climbing so far`);
}

fill();

// ---------- Motion (phase 3): everything degrades to static without JS or
// under prefers-reduced-motion; the CSS only animates once JS opts in. ----------
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

// Hero elevation profile: the line draws like a pencil following the terrain
// (3.4 s ease-in-out). Each annotation fades in when the drawn tip reaches its
// x position, so delays come from the real path length, not guesses.
function heroDraw() {
  const fig = document.querySelector('.profile');
  const line = fig?.querySelector('.pf-line');
  if (!fig || !line || reducedMotion()) return;

  const DUR = 3400, BASE = 150; // keep in sync with styles.css (.profile.anim)
  // CSS ease-in-out = cubic-bezier(.42, 0, .58, 1): eased progress at time x.
  const bezierY = (() => {
    const X = (t) => 3 * t * (1 - t) ** 2 * 0.42 + 3 * t * t * (1 - t) * 0.58 + t ** 3;
    const Y = (t) => 3 * t * t * (1 - t) + t ** 3;
    return (x) => {
      let lo = 0, hi = 1;
      for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (X(m) < x) lo = m; else hi = m; }
      return Y((lo + hi) / 2);
    };
  })();
  // Inverse: time fraction at which the draw reaches eased progress e.
  const easeInv = (e) => {
    let lo = 0, hi = 1;
    for (let i = 0; i < 26; i++) { const m = (lo + hi) / 2; if (bezierY(m) < e) lo = m; else hi = m; }
    return (lo + hi) / 2;
  };

  const start = () => {
    let total = 0;
    try { total = line.getTotalLength(); } catch { return; }
    if (!total) return;
    // Length of the path up to a given viewBox x (x grows monotonically here).
    const lengthAtX = (x) => {
      const N = 600;
      for (let i = 0; i <= N; i++) {
        const s = (i / N) * total;
        if (line.getPointAtLength(s).x >= x) return s;
      }
      return total;
    };
    fig.querySelectorAll('.pf-mark').forEach((mark) => {
      const pct = parseFloat(mark.style.left) || 0;
      const x = (pct / 100) * 1200; // viewBox is 1200 wide, stretched to the figure
      const t = BASE + DUR * easeInv(Math.min(1, lengthAtX(x) / total));
      mark.style.setProperty('--pf-delay', `${Math.round(t)}ms`);
    });
    fig.classList.add('anim');
  };

  // Start when the figure is on screen (it is display:none until boot shows the landing).
  if (!('IntersectionObserver' in window)) { start(); return; }
  const io = new IntersectionObserver((entries) => {
    if (entries.some((e) => e.isIntersecting)) { io.disconnect(); start(); }
  }, { threshold: 0.35 });
  io.observe(fig);
}

// Other landing sections: one subtle fade/slide the first time they appear.
function sectionReveals() {
  if (reducedMotion() || !('IntersectionObserver' in window)) return;
  const els = document.querySelectorAll('#landing .preview, #landing .steps, #landing .features, #landing .arch');
  if (!els.length) return;
  els.forEach((el) => el.classList.add('reveal'));
  const io = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting) { e.target.classList.add('in'); io.unobserve(e.target); }
    }
  }, { threshold: 0.12, rootMargin: '0px 0px -6% 0px' });
  els.forEach((el) => io.observe(el));
}

heroDraw();
sectionReveals();
