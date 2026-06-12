// ── POST /api/callback ──
// GitHub Actions runners POST here to update slot status.
// Replaces callback.php

import { d1Run } from './_lib/d1.js';
import { redisCmd } from './_lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ error: 'POST only' });

  const { username: rawUser, site_id: rawSite, status, url = '' } = req.body ?? {};
  const username = (rawUser ?? '').replace(/[^a-zA-Z0-9-]/g, '');
  const site_id  = parseInt(rawSite, 10);

  const validStatuses = ['offline', 'booting', 'live'];
  if (!username || site_id < 1 || !validStatuses.includes(status)) {
    return res.status(400).json({ error: 'Invalid params' });
  }

  const key = `${username}_${site_id}`;

  try {
    // Update Redis session state
    if (status === 'live') {
      const now = Math.floor(Date.now() / 1000);
      await redisCmd(['HSET', `session:${key}`, 'status', 'live', 'url', url, 'session_start', String(now)]);
    } else {
      await redisCmd(['HSET', `session:${key}`, 'status', status, 'url', url]);
    }

    // Upsert into D1
    await d1Run(
      `INSERT INTO slots (username, site_id, status, url) VALUES (?, ?, ?, ?)
       ON CONFLICT(username, site_id) DO UPDATE SET status=excluded.status, url=excluded.url`,
      [username, site_id, status, url || null]
    );

    return res.status(200).json({ success: true });
  } catch (err) {
    console.error('[callback]', err);
    return res.status(500).json({ error: 'DB update failed' });
  }
}
