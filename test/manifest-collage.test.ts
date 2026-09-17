import { describe, expect, it, vi } from "vitest";
import { Database } from "../src/db.js";
import { Repository } from "../src/repository.js";

describe("manifiesto para collage", () => {
  it("incluye proporciones y conserva la preferencia guardada por el marco", async () => {
    const query = vi
      .fn()
      .mockResolvedValueOnce({
        rows: [
          {
            id: "frame",
            manifestVersion: "4",
            settingsRevision: "2",
            settings: {
              collageMode: "adaptive",
              order: "newest",
              showCaption: false,
            },
          },
        ],
      })
      .mockResolvedValueOnce({
        rows: [
          {
            id: "photo",
            kind: "photo",
            variantId: "display",
            width: 800,
            height: 1200,
            receivedAt: "2026-09-17T00:00:00Z",
          },
        ],
      });
    const repository = new Repository({ query } as unknown as Database);
    const result = await repository.getManifest(
      "frame",
      "https://naiskos.test",
    );
    expect(result.settings).toMatchObject({
      collageMode: "adaptive",
      showCaption: false,
    });
    expect(result.media).toEqual([
      expect.objectContaining({
        width: 800,
        height: 1200,
        downloadUrl: "https://naiskos.test/api/v1/files/display",
      }),
    ]);
    // Cropped thumbnails must never stand in for display proportions.
    expect(query.mock.calls[1][0]).toContain("v.width, v.height");
    expect(query.mock.calls[1][0]).not.toContain("tv.width");
  });
});
