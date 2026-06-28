import { requireAdmin } from './_lib/middleware.js';
import { d1Query, d1QueryOne, d1Run } from './_lib/d1.js';

export default async function handler(req, res) {
  if (req.method === 'OPTIONS') return res.status(200).end();

  // Enforce admin privileges
  const admin = requireAdmin(req, res);
  if (!admin) return;

  const action = req.query.action || req.body?.action || '';

  try {
    // ── 1. Fetch Admin Dashboard Stats ──
    if (action === 'stats') {
      const usersCount = await d1QueryOne('SELECT COUNT(*) as cnt FROM users');
      const warnsCount = await d1QueryOne('SELECT COUNT(*) as cnt FROM warns');
      const slotsCount = await d1QueryOne("SELECT COUNT(*) as cnt FROM slots WHERE status = 'live'");

      return res.status(200).json({
        success: true,
        stats: {
          total_users: usersCount?.cnt || 0,
          total_warns: warnsCount?.cnt || 0,
          active_slots: slotsCount?.cnt || 0
        }
      });
    }

    // ── 2. List All Users ──
    if (action === 'list_users') {
      const users = await d1Query('SELECT id, username, plan, tos_accepted FROM users ORDER BY id DESC');
      return res.status(200).json({ success: true, users: users.results || [] });
    }

    // ── 3. List All Warn Logs ──
    if (action === 'list_warns') {
      const warns = await d1Query('SELECT id, username, service, reason, screenshot_proof, created_at FROM warns ORDER BY id DESC');
      return res.status(200).json({ success: true, warns: warns.results || [] });
    }

    // ── 4. List All Active Hosting Slots ──
    if (action === 'list_slots') {
      const slots = await d1Query('SELECT username, site_id, status, url FROM slots ORDER BY username ASC');
      return res.status(200).json({ success: true, slots: slots.results || [] });
    }

    // ── 5. Manual Plan Upgrade/Override ──
    if (action === 'update_plan') {
      const { username, plan } = req.body || {};
      if (!username || !plan) {
        return res.status(400).json({ success: false, message: 'username and plan required' });
      }

      const allowedPlans = ['starter', 'plus', 'pro', 'max', 'admin'];
      if (!allowedPlans.includes(plan)) {
        return res.status(400).json({ success: false, message: 'Invalid plan name' });
      }

      await d1Run('UPDATE users SET plan = ? WHERE username = ?', [plan, username]);
      return res.status(200).json({ success: true, message: `Successfully updated user ${username} plan to ${plan}.` });
    }

    // ── 6. Delete a warning log ──
    if (action === 'delete_warn') {
      const { warn_id } = req.body || {};
      if (!warn_id) {
        return res.status(400).json({ success: false, message: 'warn_id required' });
      }

      await d1Run('DELETE FROM warns WHERE id = ?', [warn_id]);
      return res.status(200).json({ success: true, message: 'Warning entry deleted.' });
    }

    return res.status(400).json({ success: false, message: 'Unknown action' });
  } catch (err) {
    console.error('[Admin API]', err);
    return res.status(500).json({ success: false, message: `Server error: ${err.message}` });
  }
}
