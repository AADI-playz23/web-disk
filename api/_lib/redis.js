// ── Upstash Redis REST API Helpers ──
// Direct port of redis_cmd(), redis_pipeline(), redis_parse_hash() from db.php
// Upstash Redis is unchanged — already cloud-hosted.

/**
 * Execute a single Redis command via Upstash REST API.
 * @param {Array} args  e.g. ["HSET", "key", "field", "value"]
 * @returns {Promise<any>}  The 'result' field, or null on failure.
 */
export async function redisCmd(args) {
  const url   = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;

  const res = await fetch(url, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(args),
  });

  const data = await res.json();
  return data?.result ?? null;
}

/**
 * Execute multiple Redis commands in a single pipeline.
 * @param {Array[]} commands  Array of command arrays
 * @returns {Promise<Array>}  Array of result objects from Upstash
 */
export async function redisPipeline(commands) {
  const url   = process.env.UPSTASH_REDIS_URL;
  const token = process.env.UPSTASH_REDIS_TOKEN;

  const res = await fetch(`${url}/pipeline`, {
    method:  'POST',
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type':  'application/json',
    },
    body: JSON.stringify(commands),
  });

  return res.json();
}

/**
 * Parse a Redis HGETALL flat array into an associative object.
 * HGETALL returns ["f1","v1","f2","v2",...] → {"f1":"v1","f2":"v2",...}
 */
export function redisParseHash(data) {
  const parsed = {};
  if (Array.isArray(data)) {
    for (let i = 0; i < data.length; i += 2) {
      parsed[data[i]] = data[i + 1];
    }
  }
  return parsed;
}
