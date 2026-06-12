// ── GET /api/setup ──
// Creates Cloudflare D1 tables. Run ONCE after deployment.
// Replaces setup.php

import { d1Query } from './_lib/d1.js';
import { redisCmd } from './_lib/redis.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  const results = [];

  // ── 1. Create users table ──
  try {
    await d1Query(`
      CREATE TABLE IF NOT EXISTS users (
        id       INTEGER PRIMARY KEY AUTOINCREMENT,
        username TEXT NOT NULL UNIQUE,
        password TEXT NOT NULL,
        plan     TEXT NOT NULL DEFAULT 'starter'
      )
    `);
    results.push({ step: 'users table', ok: true });
  } catch (err) {
    results.push({ step: 'users table', ok: false, error: err.message });
  }

  // ── 2. Create slots table ──
  try {
    await d1Query(`
      CREATE TABLE IF NOT EXISTS slots (
        username TEXT    NOT NULL,
        site_id  INTEGER NOT NULL,
        status   TEXT    DEFAULT 'offline',
        url      TEXT    DEFAULT NULL,
        PRIMARY KEY (username, site_id)
      )
    `);
    results.push({ step: 'slots table', ok: true });
  } catch (err) {
    results.push({ step: 'slots table', ok: false, error: err.message });
  }

  // ── 3. Test Redis ──
  try {
    const pong = await redisCmd(['PING']);
    results.push({ step: 'Redis PING', ok: pong === 'PONG', result: pong });
  } catch (err) {
    results.push({ step: 'Redis PING', ok: false, error: err.message });
  }

  // ── 4. Test D1 read ──
  try {
    const row = await d1Query('SELECT COUNT(*) as cnt FROM users');
    results.push({ step: 'D1 read test', ok: true, users: row.results?.[0]?.cnt ?? 0 });
  } catch (err) {
    results.push({ step: 'D1 read test', ok: false, error: err.message });
  }

  const allOk = results.every(r => r.ok);
  return res.status(allOk ? 200 : 500).json({
    message: allOk ? '✅ Setup complete! Delete /api/setup after verifying.' : '⚠️ Some steps failed.',
    results,
  });
}
