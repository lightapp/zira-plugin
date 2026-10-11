// Local safeguards only; authoritative site/user quotas belong on the API server.
export function boundedFetch({
  fetchImpl = globalThis.fetch,
  maxRequests = 1000,
  maxConcurrent = 4,
  minIntervalMs = 100,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
} = {}) {
  if (!Number.isInteger(maxRequests) || maxRequests < 1 || maxRequests > 1000)
    throw new Error("Request budget must be 1–1000");
  let used = 0,
    active = 0,
    nextStart = 0,
    blocked = null;
  const queue = [];
  let limitReason;
  const fail = (message) =>
    Object.assign(new Error(message), { code: "HEALTH_REQUEST_LIMIT", limitReason });
  const request = async (url, options) => {
    while (active >= maxConcurrent)
      await new Promise((resolve) => queue.push(resolve));
    active++;
    try {
      if (blocked) throw fail(blocked);
      if (used >= maxRequests)
        throw fail(
          "Local request budget exhausted; report coverage is incomplete",
        );
      used++;
      const delay = Math.max(0, nextStart - now());
      nextStart = Math.max(now(), nextStart) + minIntervalMs;
      if (delay) await sleep(delay);
      if (blocked) throw fail(blocked);
      const response = await fetchImpl(url, options);
      if (response.status === 429) {
        blocked = "Server rate limit reached; stopped this run without retrying";
        try {
          const payload = await response.json();
          if (["user_limit", "site_limit"].includes(payload?.error?.code))
            limitReason = payload.error.code;
        } catch { /* Older gateways may return a non-JSON throttle response. */ }
        const retry = response.headers?.get("retry-after");
        const seconds =
          retry && /^\d+$/.test(retry)
            ? Number(retry)
            : retry
              ? Math.max(0, Math.ceil((Date.parse(retry) - now()) / 1000))
              : null;
        const reason = limitReason === "user_limit"
          ? "Your shared user allowance is exhausted across companies and sites"
          : limitReason === "site_limit"
            ? "A selected site's shared allowance is exhausted"
            : "Server rate limit reached";
        blocked = `${reason}${Number.isFinite(seconds) ? `; retry after ${seconds} seconds` : ""}; stopped this run without retrying; report coverage is incomplete`;
        throw fail(blocked);
      }
      return response;
    } finally {
      active--;
      queue.shift()?.();
    }
  };
  request.usage = () => ({ requests: used, maxRequests, blocked });
  return request;
}
