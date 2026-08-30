import { afterEach, describe, expect, it, vi } from "vitest";

import { fetchExternalWithRetry } from "../src/external-http.js";

afterEach(() => vi.unstubAllGlobals());

describe("peticiones a terceros", () => {
  it("realiza un intento inicial y tres reintentos para fallos transitorios", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 500 }))
      .mockResolvedValueOnce(new Response(null, { status: 429 }))
      .mockRejectedValueOnce(new TypeError("red no disponible"))
      .mockResolvedValueOnce(Response.json({ ok: true }));
    vi.stubGlobal("fetch", fetchMock);
    const sleeps: number[] = [];

    const response = await fetchExternalWithRetry(
      "https://third-party.test/data",
      {},
      {
        retries: 3,
        timeoutMs: 1_000,
        sleep: async (milliseconds) => {
          sleeps.push(milliseconds);
        },
      },
    );

    expect(response.ok).toBe(true);
    expect(fetchMock).toHaveBeenCalledTimes(4);
    expect(sleeps).toHaveLength(3);
  });

  it("no repite errores permanentes HTTP 4xx", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(null, { status: 401 }));
    vi.stubGlobal("fetch", fetchMock);

    const response = await fetchExternalWithRetry(
      "https://third-party.test/data",
      {},
      { retries: 3, timeoutMs: 1_000, sleep: async () => undefined },
    );

    expect(response.status).toBe(401);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("agota exactamente las tres repeticiones y propaga el último fallo", async () => {
    const fetchMock = vi.fn().mockRejectedValue(new TypeError("timeout"));
    vi.stubGlobal("fetch", fetchMock);

    await expect(
      fetchExternalWithRetry("https://third-party.test/data", {}, {
        retries: 3,
        timeoutMs: 1_000,
        sleep: async () => undefined,
      }),
    ).rejects.toThrow("timeout");
    expect(fetchMock).toHaveBeenCalledTimes(4);
  });
});
