// ── POST /api/register ──
// Creates a new user in Cloudflare D1.
// Replaces register.php

import bcrypt from 'bcryptjs';
import { d1QueryOne, d1Run } from './_lib/d1.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' });

  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { }
  }

  const { username = '', password = '' } = body;
  const clean = username.replace(/[^a-zA-Z0-9-]/g, '').trim();

  if (clean.length < 3 || password.length < 4) {
    return res.status(400).json({
      success: false,
      message: `Username (3+ chars) and password (4+ chars) required. Debug: typeof body=${typeof req.body}, bodyKeys=${Object.keys(body).join(',')}`,
    });
  }

  try {
    // Check duplicate
    const existing = await d1QueryOne(
      'SELECT id FROM users WHERE username = ?',
      [clean]
    );
    if (existing) {
      return res.status(200).json({ success: false, message: 'Username already taken' });
    }

    // Hash password and insert
    const hashed = await bcrypt.hash(password, 10);
    await d1Run(
      "INSERT INTO users (username, password, plan) VALUES (?, ?, 'starter')",
      [clean, hashed]
    );

    return res.status(200).json({ success: true, message: 'Account created' });
  } catch (err) {
    console.error('[register]', err);
    return res.status(500).json({ success: false, message: `Registration failed. DB Error: ${err.message}` });
  }
}
