import { d1Query, d1Run } from './d1.js';

/**
 * Log a warning infraction and enforce 24-hour lockout or permanent ban.
 * @param {string} username - User to warn
 * @param {string} service - 'webdisk', 'vps', 'devbox', 'minecraft'
 * @param {string} reason - infraction reason
 * @param {string} screenshotProofUrl - URL or path of uploaded proof
 * @returns {Promise<{warningCount: number, locked: boolean, banned: boolean}>}
 */
export async function triggerWarning(username, service, reason, screenshotProofUrl = '') {
  // 1. Log warning in warns table
  await d1Run(
    'INSERT INTO warns (username, service, reason, screenshot_proof) VALUES (?, ?, ?, ?)',
    [username, service, reason, screenshotProofUrl]
  );

  // 2. Count warnings
  const countRes = await d1Query(
    'SELECT COUNT(*) as cnt FROM warns WHERE username = ? AND service = ?',
    [username, service]
  );
  const warningCount = countRes.results?.[0]?.cnt || 0;

  let locked = false;
  let banned = false;

  if (warningCount > 3) {
    // Permanent ban
    await d1Run('UPDATE users SET banned = 1 WHERE username = ?', [username]);
    // Log to bans table
    await d1Run(
      'INSERT OR REPLACE INTO bans (username, service, reason) VALUES (?, ?, ?)',
      [username, service, reason]
    );
    // Force set slot status to offline
    await d1Run("UPDATE slots SET status = 'offline' WHERE username = ?", [username]);
    banned = true;
  } else {
    // 24h lockout
    const lockUntil = Math.floor(Date.now() / 1000) + 24 * 3600;
    await d1Run('UPDATE users SET locked_until = ? WHERE username = ?', [lockUntil, username]);
    // Force set slot status to offline
    await d1Run("UPDATE slots SET status = 'offline' WHERE username = ?", [username]);
    locked = true;
  }

  return { warningCount, locked, banned };
}
