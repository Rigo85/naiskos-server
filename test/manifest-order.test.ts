import { describe, expect, it } from "vitest";

import { orderManifestMedia } from "../src/repository.js";

const older = {
  id: "older",
  receivedAt: "2026-01-01T00:00:00Z",
};
const newer = {
  id: "newer",
  receivedAt: "2026-02-01T00:00:00Z",
};

describe("orden de manifiesto", () => {
  it("usa más reciente primero por defecto e invierte para oldest", () => {
    expect(
      orderManifestMedia([older, newer], "newest", 1).map((item) => item.id),
    ).toEqual(["newer", "older"]);
    expect(
      orderManifestMedia([older, newer], "oldest", 1).map((item) => item.id),
    ).toEqual(["older", "newer"]);
  });

  it("mantiene aleatorio estable por versión", () => {
    expect(orderManifestMedia([older, newer], "shuffle", 7)).toEqual(
      orderManifestMedia([older, newer], "shuffle", 7),
    );
  });
});
