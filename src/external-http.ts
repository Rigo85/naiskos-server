export interface RetryOptions {
  retries: number;
  timeoutMs: number;
  baseDelayMs?: number;
  maximumDelayMs?: number;
  sleep?: (milliseconds: number) => Promise<void>;
}

export async function fetchExternalWithRetry(
  input: string | URL,
  init: RequestInit,
  options: RetryOptions,
): Promise<Response> {
  const sleep = options.sleep ?? delay;
  const baseDelayMs = options.baseDelayMs ?? 500;
  const maximumDelayMs = options.maximumDelayMs ?? 10_000;
  let lastError: unknown;

  for (let attempt = 0; attempt <= options.retries; attempt += 1) {
    try {
      const response = await fetch(input, {
        ...init,
        signal: AbortSignal.timeout(options.timeoutMs),
      });
      if (!retryableStatus(response.status) || attempt === options.retries) {
        return response;
      }
      lastError = new Error(`Servicio externo respondió HTTP ${response.status}`);
      await response.body?.cancel();
      await sleep(
        retryDelay(response.headers.get("retry-after"), attempt, baseDelayMs, maximumDelayMs),
      );
    } catch (error) {
      lastError = error;
      if (attempt === options.retries) throw error;
      await sleep(Math.min(maximumDelayMs, baseDelayMs * 2 ** attempt));
    }
  }
  throw lastError instanceof Error
    ? lastError
    : new Error("No se pudo consultar el servicio externo");
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

function retryDelay(
  retryAfter: string | null,
  attempt: number,
  baseDelayMs: number,
  maximumDelayMs: number,
): number {
  if (retryAfter) {
    const seconds = Number(retryAfter);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return Math.min(maximumDelayMs, seconds * 1_000);
    }
    const date = Date.parse(retryAfter);
    if (Number.isFinite(date)) {
      return Math.min(maximumDelayMs, Math.max(0, date - Date.now()));
    }
  }
  return Math.min(maximumDelayMs, baseDelayMs * 2 ** attempt);
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}
