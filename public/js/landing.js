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
    // The wipe reveals the figure left to right, so each mark fires when the
    // eased wipe reaches its x position (x grows monotonically across the viewBox).
    fig.querySelectorAll('.pf-mark').forEach((mark) => {
      const pct = parseFloat(mark.style.left) || 0;
      const t = BASE + DUR * easeInv(Math.min(1, pct / 100));
      mark.style.setProperty('--pf-delay', `${Math.round(t)}ms`);
    });
    const begin = () => {
      fig.classList.add('anim');
      // Completion guard: the final frame is identical to the base styles, so
      // removing .anim after the last animation always lands on the finished
      // figure - even if the browser throttled or froze the CSS animation
      // mid-flight (background tab, GPU quirks). Without .anim the line is
      // fully drawn and the marks are visible.
      setTimeout(() => fig.classList.remove('anim'), BASE + DUR + 1100);
    };
    // Never start while the tab is hidden: Chrome pauses animations in
    // background tabs, which can leave the draw frozen part-way. Start when
    // the visitor is actually looking.
    if (document.hidden) {
      const onVis = () => {
        if (document.hidden) return;
        document.removeEventListener('visibilitychange', onVis);
        begin();
      };
      document.addEventListener('visibilitychange', onVis);
    } else {
      begin();
    }
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
  const els = document.querySelectorAll('#landing .preview, #landing .features, #landing .arch');
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

// "How it works": scroll-driven sticky story. Where CSS animation-timeline is
// supported the keyframes in styles.css do everything and no JS runs. Elsewhere
// (older Safari, Firefox) a passive scroll listener maps track progress to the
// three step classes. Native scroll speed always; nothing is hijacked.
// ?sda=off forces the JS fallback for testing the no-support path.
function stepsStory() {
  const section = document.querySelector('.steps');
  const track = document.getElementById('steps-track');
  if (!section || !track || reducedMotion()) return;
  const forceFallback = new URLSearchParams(location.search).get('sda') === 'off';
  if (!forceFallback && CSS.supports('animation-timeline: view()')) return;
  section.classList.add('jsfb');
  let tick = false;
  const update = () => {
    tick = false;
    const r = track.getBoundingClientRect();
    const total = r.height - innerHeight;
    const p = total > 0 ? Math.min(1, Math.max(0, -r.top / total)) : 1;
    const step = p < 0.34 ? 1 : p < 0.67 ? 2 : 3;
    section.classList.toggle('st-1', step === 1);
    section.classList.toggle('st-2', step === 2);
    section.classList.toggle('st-3', step === 3);
  };
  const onScroll = () => { if (!tick) { tick = true; requestAnimationFrame(update); } };
  addEventListener('scroll', onScroll, { passive: true });
  addEventListener('resize', onScroll);
  update();
}

stepsStory();
