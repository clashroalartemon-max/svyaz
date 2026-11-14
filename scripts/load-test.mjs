/**
 * Проверка доступности Supabase: 100 запросов с ограничением параллельности.
 *
 * Запуск: npm run loadtest (можно передать число и параллельность:
 * node scripts/load-test.mjs 200 20)
 * Берёт VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY из .env.
 */
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';

function readEnv() {
  try {
    const raw = readFileSync('.env', 'utf8');
    const env = {};
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const idx = trimmed.indexOf('=');
      if (idx === -1) continue;
      env[trimmed.slice(0, idx).trim()] = trimmed.slice(idx + 1).trim();
    }
    return env;
  } catch {
    return {};
  }
}

const env = readEnv();
const url = env.VITE_SUPABASE_URL;
const key = env.VITE_SUPABASE_ANON_KEY;
if (!url || !key) {
  console.error('Нет VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY в .env');
  process.exit(1);
}

const total = Number(process.argv[2] ?? 100);
// Supabase/провайдер рвёт соединения при сотне одновременных fetch из Node,
// поэтому нагрузку подаём пулом: 20 в полёте, как у реальной группы.
const concurrency = Number(process.argv[3] ?? 20);
const endpoint = `${url}/rest/v1/profiles?select=id&limit=1`;
const headers = { apikey: key, Authorization: `Bearer ${key}` };

const started = performance.now();
const results = new Array(total);
let next = 0;

async function worker() {
  for (let i = next++; i < total; i = next++) {
    const t = performance.now();
    try {
      const res = await fetch(endpoint, {
        headers,
        signal: AbortSignal.timeout(15000),
      });
      results[i] = { ok: res.ok, status: res.status, ms: performance.now() - t };
    } catch (error) {
      results[i] = { ok: false, status: 0, ms: performance.now() - t, error: String(error) };
    }
  }
}

await Promise.all(Array.from({ length: Math.min(concurrency, total) }, worker));
const elapsed = performance.now() - started;
const latencies = results.map((r) => r.ms).sort((a, b) => a - b);
const pct = (p) => Math.round(latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * p))] ?? 0);
const failed = results.filter((r) => !r.ok);

console.log(
  JSON.stringify(
    {
      requests: total,
      ok: total - failed.length,
      failed: failed.length,
      totalMs: Math.round(elapsed),
      rps: Math.round((total / elapsed) * 1000),
      p50: pct(0.5),
      p95: pct(0.95),
      p99: pct(0.99),
      statuses: [...new Set(results.map((r) => r.status))],
    },
    null,
    2,
  ),
);

if (failed.length > 0) process.exitCode = 1;
