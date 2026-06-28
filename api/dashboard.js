import { d1QueryOne, d1Run } from './_lib/d1.js';
import { redisCmd, redisParseHash } from './_lib/redis.js';
import { getPlanLimits, getWeeklyUsage } from './_lib/plans.js';
import { requireAuth } from './_lib/middleware.js';

const GITHUB_TOKEN  = process.env.GITHUB_TOKEN;
const GITHUB_OWNER  = process.env.GITHUB_OWNER;
const GITHUB_REPO   = process.env.GITHUB_REPO_ENGINE;

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).send('POST only');

  const user = requireAuth(req, res);
  if (!user) return;

  const username = user.username;

  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { }
  }

  const { site_id: rawSite, action = 'launch', password = '' } = body;
  const site_id  = parseInt(rawSite, 10);
  const key      = `${username}_${site_id}`;

  if (!site_id) return res.status(400).send('Error: Missing params');

  try {
    // ═══ LAUNCH ═══
    if (action === 'launch') {
      if (!password) return res.status(400).send('Error: Password required');

      // 1. Fetch plan from D1
      const row  = await d1QueryOne('SELECT plan, locked_until FROM users WHERE username = ?', [username]);
      if (row) {
        const isBanned = await d1QueryOne('SELECT id FROM bans WHERE username = ? AND service = ?', [username, 'webdisk']);
        if (isBanned) {
          return res.status(403).send('Error: Your account is permanently banned from this service.');
        }
        const lockedUntil = parseInt(row.locked_until || 0);
        if (lockedUntil > Math.floor(Date.now() / 1000)) {
          return res.status(403).send('Error: Your account is temporarily locked for 24 hours for policy violations.');
        }
      }
      const plan = row?.plan ?? 'starter';

      // 2. Check weekly quota
      const limits = getPlanLimits(plan);
      const usage  = await getWeeklyUsage(redisCmd, redisParseHash, username, site_id);

      if (usage.weekly_seconds >= limits.weekly) {
        return res.send('Error: Weekly quota exhausted. Upgrade your plan for more hosting time.');
      }

      const weekly_remaining = limits.weekly - usage.weekly_seconds;
      if (weekly_remaining < 300) {
        const resetsIn = Math.ceil((usage.week_start + 604800 - Math.floor(Date.now() / 1000)) / 3600);
        return res.send(`Error: Less than 5 minutes of weekly quota remaining. Resets in ${resetsIn}h.`);
      }

      // 3. Check if slot already live/booting
      const sessionData = await redisCmd(['HGETALL', `session:${key}`]);
      const session     = redisParseHash(sessionData);
      let current_status = session.status ?? 'offline';

      // Stale detection
      if (current_status === 'live' || current_status === 'booting') {
        const runner_id = session.runner_id ?? '';
        let is_stale = false;

        if (runner_id) {
          const hb = await redisCmd(['HGET', `runner:${runner_id}`, 'heartbeat']);
          if (!hb || (Math.floor(Date.now() / 1000) - parseInt(hb, 10)) > 120) is_stale = true;
        } else if (current_status === 'booting') {
          const boot_time = parseInt(session.session_start ?? 0, 10);
          is_stale = !boot_time || (Math.floor(Date.now() / 1000) - boot_time) > 180;
        }

        if (is_stale) {
          await redisCmd(['HSET', `session:${key}`, 'status', 'offline', 'url', '']);
          if (session.runner_id) {
            await redisCmd(['SREM', 'runners:active', session.runner_id]);
            await redisCmd(['DEL', `runner:${session.runner_id}`]);
            await redisCmd(['DEL', `runner:${session.runner_id}:slots`]);
          }
          current_status = 'offline';
        }
      }

      if (current_status === 'live')    return res.send('Error: This slot is already running.');
      if (current_status === 'booting') return res.send('Error: This slot is currently booting. Please wait.');

      // 4. Check runner capacity
      const runners = await redisCmd(['SMEMBERS', 'runners:active']);
      let available_runner    = false;
      let active_runner_count = 0;

      if (Array.isArray(runners) && runners.length > 0) {
        for (const rid of runners) {
          const hb = await redisCmd(['HGET', `runner:${rid}`, 'heartbeat']);
          if (hb && (Math.floor(Date.now() / 1000) - parseInt(hb, 10)) < 120) {
            active_runner_count++;
            const count = await redisCmd(['HGET', `runner:${rid}`, 'active_count']);
            if (parseInt(count, 10) < 10) available_runner = true;
          } else {
            await redisCmd(['SREM', 'runners:active', rid]);
            await redisCmd(['DEL', `runner:${rid}`]);
            await redisCmd(['DEL', `runner:${rid}:slots`]);
          }
        }
      }

      let need_new_runner = !available_runner;

      if (need_new_runner && active_runner_count >= 2) {
        if (plan === 'starter') {
          const queue_len = parseInt(await redisCmd(['LLEN', 'queue:deploy']) ?? 0, 10);
          if (queue_len < 20) return res.send('Error: All servers are currently full. Please try again in a few minutes.');
        }
        if (active_runner_count >= 2) return res.send('Error: Maximum server capacity reached. Please try again shortly.');
      }

      if (need_new_runner && active_runner_count >= 1 && plan === 'starter') {
        const queue_len = parseInt(await redisCmd(['LLEN', 'queue:deploy']) ?? 0, 10);
        if (queue_len < 20) need_new_runner = false;
      }

      // 5. Effective session limit
      const effective_session = Math.min(limits.session, weekly_remaining);

      // 6. Push to Redis deploy queue
      const deploy_data = JSON.stringify({ username, password, site_id: String(site_id), plan, session_limit: effective_session });
      await redisCmd(['LPUSH', 'queue:deploy', deploy_data]);

      // 7. Mark as booting
      await redisCmd(['HSET', `session:${key}`, 'status', 'booting']);

      // 8. Upsert into D1
      await d1Run(
        `INSERT INTO slots (username, site_id, status) VALUES (?, ?, 'booting')
         ON CONFLICT(username, site_id) DO UPDATE SET status='booting', url=NULL`,
        [username, site_id]
      );

      // 9. Dispatch GitHub Actions runner if needed
      if (need_new_runner) {
        await fetch(`https://api.github.com/repos/${GITHUB_OWNER}/${GITHUB_REPO}/actions/workflows/server.yml/dispatches`, {
          method: 'POST',
          headers: {
            'Authorization': `token ${GITHUB_TOKEN}`,
            'Accept': 'application/vnd.github.v3+json',
            'Content-Type': 'application/json',
            'User-Agent': 'AbsoraCloud-API',
          },
          body: JSON.stringify({ ref: 'main', inputs: { trigger_user: username } }),
        });
      }

      return res.send('Server Started');

    // ═══ DELETE ═══
    } else if (action === 'delete') {
      await redisCmd(['SET', `kill:${key}`, '1', 'EX', '300']);
      await redisCmd(['HSET', `session:${key}`, 'status', 'offline', 'url', '']);
      await d1Run(
        "UPDATE slots SET status='offline', url=NULL WHERE username=? AND site_id=?",
        [username, site_id]
      );
      return res.send('Deleted');
    }

    return res.status(400).send('Error: Unknown action');
  } catch (err) {
    console.error('[dashboard]', err);
    return res.status(500).send('Error: Server error');
  }
}
