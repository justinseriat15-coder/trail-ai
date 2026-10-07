// GET /api/streams?source=demo|live&id=123 → per-second streams of one activity.
import { handler, json, query } from '../lib/http.js';
import { loadAthlete, loadStreams } from '../lib/data.js';

export default handler(['GET'], async (req, res) => {
  const q = query(req);
  const source = q.source === 'live' ? 'live' : 'demo';
  const ctx = await loadAthlete(req, res, source);
  json(res, 200, { streams: await loadStreams(ctx, q.id) });
});
