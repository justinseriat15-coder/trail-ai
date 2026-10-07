// Builds the coach's system prompt from server-side data only.
// The client never supplies training data to the model: it can't be spoofed,
// and private context (injury history, race plan) never reaches the browser.
import { buildSummary, decoupling, timeInZones, paceStr, km, durStr, efficiencyFactor } from '../public/js/analytics.js';

const BASE = `Tu es le coach d'endurance intégré à Trail.AI. Tu analyses des données d'entraînement réelles et tu réponds en français.

Méthode:
- Appuie chaque affirmation sur un chiffre du contexte ci-dessous (date, FC, allure, EF, ACWR, découplage). N'invente aucune donnée.
- Quand l'athlète décrit une séance ("ce matin", "hier", "la sortie longue"), identifie-la dans les séances récentes par date et type, et dis laquelle tu analyses.
- Croise toujours le ressenti déclaré avec les données objectives, et signale les contradictions.
- Indicateurs: EF (efficiency factor) = vitesse en m/min ÷ FC moyenne, comparable seulement entre footings plats ≥ 20 min. ACWR = charge 7 j ÷ moyenne hebdo 28 j (TRIMP de Banister); 0,8-1,3 = zone optimale, > 1,5 = risque accru. Découplage Pa:FC < 5 % = bonne endurance aérobie sur la durée.
- Sois direct et concis: 3 à 8 phrases ou une courte liste. Termine par une recommandation actionnable pour la prochaine séance.
- Tu n'es pas médecin: en cas de douleur persistante, oriente vers un kiné ou un médecin du sport.`;

export function buildSystemPrompt(ctx, { activityId, streams } = {}) {
  const s = buildSummary(ctx.activities, ctx.profile);
  const lines = [BASE, ''];

  lines.push(`## Profil`);
  lines.push(ctx.mode === 'demo'
    ? `Mode démo: athlète fictif, données synthétiques. Précise-le si on te demande qui est l'athlète.`
    : `Athlète: ${ctx.athlete?.firstname || 'inconnu'}.`);
  lines.push(`FC max ${s.hrMax} bpm, FC repos ${s.hrRest} bpm. Zones (% FCmax): ${s.zones.map((z) => `Z${z.zone} ${z.min}-${z.max}`).join(', ')}.`);
  lines.push(`Date du jour: ${new Date().toISOString().slice(0, 10)}.`);

  if (ctx.owner && process.env.ATHLETE_CONTEXT) {
    lines.push('', '## Contexte privé de l\'athlète (historique, blessures, objectifs)', process.env.ATHLETE_CONTEXT.trim());
  }

  lines.push('', '## Charge et tendances');
  lines.push(`ACWR actuel: ${s.acwr?.ratio ?? 'n/a'} (${s.acwrStatus.label}), charge aiguë ${s.acwr?.acute}, chronique ${s.acwr?.chronic}.`);
  lines.push(`Évolution EF sur la période (dernier tiers vs premier tiers): ${s.efChangePct ?? 'n/a'} %.`);
  lines.push(`Jours de course consécutifs max sur 14 j: ${s.consecutiveRunDays14d}.`);
  lines.push(`Volume hebdo (8 dernières semaines, la dernière est en cours): ${s.weeks.map((w) => `${w.week}: ${w.km} km/${w.dplus} m D+/${w.count} séances`).join(' | ')}.`);

  lines.push('', '## Séances récentes (plus récente en premier)');
  for (const r of s.recentRuns) {
    lines.push(`- ${r.date} | ${r.name} (${r.type}) | ${r.km} km | ${r.duration} | ${r.pace}/km | FC ${r.hr ?? 'n/a'} (max ${r.hrMax ?? 'n/a'}) | D+ ${r.dplus} m | EF ${r.ef ?? 'n/a'} | TRIMP ${r.trimp ?? 'n/a'} | id ${r.id}`);
  }

  if (activityId && streams) {
    const a = ctx.activities.find((x) => String(x.id) === String(activityId));
    if (a) {
      const z = timeInZones(streams, s.hrMax);
      lines.push('', `## Séance sélectionnée dans l'interface (analyse seconde par seconde)`);
      lines.push(`${a.name}, ${a.start_date_local.slice(0, 10)}: ${km(a.distance)} km, ${durStr(a.moving_time)}, ${paceStr(a.average_speed)}/km, FC ${Math.round(a.average_heartrate || 0)}, EF ${efficiencyFactor(a)?.toFixed(3) ?? 'n/a'}.`);
      lines.push(`Découplage Pa:FC: ${decoupling(streams) ?? 'n/a'} %. Temps en zones: ${z ? z.map((x) => `Z${x.zone} ${x.pct} %`).join(', ') : 'n/a'}.`);
    }
  }
  return lines.join('\n');
}
