// ── POST /api/login ──
// Verifies username + password against Cloudflare D1.
// Replaces login.php

import bcrypt from 'bcryptjs';
import { d1QueryOne } from './_lib/d1.js';

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' });

  const { username = '', password = '' } = req.body ?? {};
  const clean = username.replace(/[^a-zA-Z0-9-]/g, '').trim();

  if (!clean || !password) {
    return res.status(400).json({ success: false, message: 'Username and password required' });
  }

  try {
    const row = await d1QueryOne(
      'SELECT password FROM users WHERE username = ?',
      [clean]
    );

    if (!row) {
      return res.status(200).json({ success: false, message: 'Invalid credentials' });
    }

    const valid = await bcrypt.compare(password, row.password);
    if (valid) {
      return res.status(200).json({ success: true, message: 'Login successful' });
    } else {
      return res.status(200).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ success: false, message: 'Server error' });
  }
}
