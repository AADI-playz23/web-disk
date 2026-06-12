// ── Cloudflare D1 REST API Client ──
// Replaces InfinityFree MySQL (mysqli) from db.php
// D1 is accessed via the Cloudflare REST API from Vercel serverless functions.

const CF_API = 'https://api.cloudflare.com/client/v4';

/**
 * Execute a SQL query against Cloudflare D1.
 * @param {string} sql - The SQL statement with ? placeholders
 * @param {Array}  params - Bound parameters
 * @returns {Promise<{results: Array, success: boolean, meta: object}>}
 */
export async function d1Query(sql, params = []) {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const dbId      = process.env.D1_DB_ID;
  const token     = process.env.CLOUDFLARE_API_TOKEN;

  const url = `${CF_API}/accounts/${accountId}/d1/database/${dbId}/query`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify({ sql, params }),
  });

  const data = await res.json();

  if (!data.success) {
    const errMsg = data.errors?.map(e => e.message).join(', ') || 'D1 query failed';
    throw new Error(`D1 Error: ${errMsg}`);
  }

  // D1 returns an array of result sets; we always send one statement
  return data.result?.[0] ?? { results: [], success: true, meta: {} };
}

/**
 * Convenience: get a single row.
 * @returns {Promise<object|null>}
 */
export async function d1QueryOne(sql, params = []) {
  const result = await d1Query(sql, params);
  return result.results?.[0] ?? null;
}

/**
 * Convenience: get all rows.
 * @returns {Promise<Array>}
 */
export async function d1QueryAll(sql, params = []) {
  const result = await d1Query(sql, params);
  return result.results ?? [];
}

/**
 * Convenience: run a mutating query (INSERT/UPDATE/DELETE).
 * @returns {Promise<{changes: number, last_row_id: number}>}
 */
export async function d1Run(sql, params = []) {
  const result = await d1Query(sql, params);
  return {
    changes:     result.meta?.changes     ?? 0,
    last_row_id: result.meta?.last_row_id ?? null,
  };
}
