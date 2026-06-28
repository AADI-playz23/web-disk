import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { serialize } from 'cookie';
import { d1QueryOne } from './_lib/d1.js';
import { JWT_SECRET } from './_lib/middleware.js';

export default async function handler(req, res) {
  // CORS preflight
  if (req.method === 'OPTIONS') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).json({ success: false, message: 'POST only' });

  let body = req.body ?? {};
  if (typeof body === 'string') {
    try { body = JSON.parse(body); } catch (e) { }
  }

  const { username = '', password = '' } = body;
  const clean = username.replace(/[^a-zA-Z0-9-]/g, '').trim();

  if (!clean || !password) {
    return res.status(400).json({ success: false, message: `Username and password required.` });
  }

  try {
    const row = await d1QueryOne(
      'SELECT password, plan, banned, locked_until FROM users WHERE username = ?',
      [clean]
    );

    if (!row) {
      return res.status(200).json({ success: false, message: 'Invalid credentials' });
    }

    const isBanned = await d1QueryOne('SELECT id FROM bans WHERE username = ? AND service = ?', [clean, 'webdisk']);
    if (isBanned) {
      return res.status(403).json({ success: false, message: 'Your account has been permanently banned from the Web Disk service for policy violations.' });
    }

    const lockedUntil = parseInt(row.locked_until || 0);
    if (lockedUntil > Math.floor(Date.now() / 1000)) {
      const warnResult = await d1QueryOne('SELECT reason, screenshot_proof FROM warns WHERE username = ? ORDER BY created_at DESC LIMIT 1', [clean]);
      const latestWarn = warnResult || {};
      return res.status(403).json({
        success: false,
        status: 'locked',
        message: 'Your account is temporarily locked for 24 hours.',
        locked_until: lockedUntil,
        reason: latestWarn.reason || 'Policy violation detected',
        proof: latestWarn.screenshot_proof || '',
        support_link: 'http://absoracloud.fanclub.rocks'
      });
    }

    const valid = await bcrypt.compare(password, row.password);
    if (valid) {
      const token = jwt.sign(
        { username: clean, plan: row.plan, isAdmin: row.plan === 'admin' },
        JWT_SECRET,
        { expiresIn: '7d' }
      );

      res.setHeader('Set-Cookie', serialize('auth_token', token, {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
        maxAge: 60 * 60 * 24 * 7,
        path: '/',
      }));

      return res.status(200).json({
        success: true,
        message: 'Login successful',
        user: { username: clean, plan: row.plan }
      });
    } else {
      return res.status(200).json({ success: false, message: 'Invalid credentials' });
    }
  } catch (err) {
    console.error('[login]', err);
    return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
}
