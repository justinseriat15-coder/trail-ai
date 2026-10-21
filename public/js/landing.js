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
