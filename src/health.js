function percentile(values, ratio) {
  if (!values.length) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * ratio) - 1)];
}

async function sample(url, health, fetchImpl) {
  const startedAt = performance.now();
  try {
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(health.timeoutMs) });
    const body = await response.text();
    const latencyMs = performance.now() - startedAt;
    if (!response.ok) return { ok: false, latencyMs, error: `${url} : HTTP ${response.status}` };
    if (health.mustContain && !body.includes(health.mustContain)) {
      return { ok: false, latencyMs, error: `${url} : texte attendu absent` };
    }
    return { ok: true, latencyMs };
  } catch (error) {
    return { ok: false, latencyMs: performance.now() - startedAt, error: `${url} : ${error.message}` };
  }
}

export async function probe(health, { fetchImpl = fetch, sleep } = {}) {
  const results = [];
  for (let index = 0; index < health.samples; index += 1) {
    if (index > 0) await sleep(health.intervalMs);
    results.push(await sample(health.urls[index % health.urls.length], health, fetchImpl));
  }

  const failures = results.filter((result) => !result.ok);
  const errorRate = failures.length / results.length;
  const p95LatencyMs = Math.round(percentile(results.filter((r) => r.ok).map((r) => r.latencyMs), 0.95));

  const reasons = [...new Set(failures.map((failure) => failure.error))];
  if (errorRate > health.maxErrorRate) reasons.unshift(`taux d'erreur de ${Math.round(errorRate * 100)} %`);
  if (p95LatencyMs > health.maxP95LatencyMs) reasons.unshift(`latence p95 de ${p95LatencyMs} ms`);

  return {
    healthy: errorRate <= health.maxErrorRate && p95LatencyMs <= health.maxP95LatencyMs,
    errorRate,
    p95LatencyMs,
    reasons,
  };
}
