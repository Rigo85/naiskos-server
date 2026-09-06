import { describe, expect, it } from "vitest";

import { monthlyGeneralSchedule } from "../src/repository.js";

describe("campaña mensual del sistema", () => {
  it("programa el primer domingo a las 00:30 de Lima", () => {
    expect(monthlyGeneralSchedule(new Date("2026-09-05T20:00:00Z"))).toEqual({
      period: "2026-09",
      scheduledAt: new Date("2026-09-06T05:30:00.000Z"),
    });
  });

  it("calcula correctamente un mes que comienza en domingo", () => {
    expect(monthlyGeneralSchedule(new Date("2026-11-15T12:00:00Z"))).toEqual({
      period: "2026-11",
      scheduledAt: new Date("2026-11-01T05:30:00.000Z"),
    });
  });
});
