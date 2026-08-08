import { describe, expect, it } from "vitest";
import { boundaryBbox, guardRegion } from "../src/africa";

const AFRICA = boundaryBbox({});

describe("guardRegion", () => {
  it("accepts a point inside Africa (Harare)", () => {
    expect(
      guardRegion(
        { kind: "point_radius", center: [31.0492, -17.8292], radiusMeters: 20000 },
        AFRICA,
      ).ok,
    ).toBe(true);
  });

  it("rejects a point outside Africa (London)", () => {
    const res = guardRegion(
      { kind: "point_radius", center: [-0.1276, 51.5072], radiusMeters: 20000 },
      AFRICA,
    );
    expect(res.ok).toBe(false);
    expect(res.reason).toBeDefined();
  });

  it("rejects a bbox that crosses the boundary", () => {
    expect(guardRegion({ kind: "bbox", bbox: [-1, 30, 60, 35] }, AFRICA).ok).toBe(false);
  });

  it("defers admin regions to the consumer", () => {
    const res = guardRegion({ kind: "admin", adminPlaceId: "abc" }, AFRICA);
    expect(res.ok).toBe(true);
    expect(res.deferred).toBe(true);
  });

  it("honours a config-overridden boundary (global)", () => {
    const global = boundaryBbox({ FUNDI_BOUNDARY_BBOX: "-90,-180,90,180" });
    expect(
      guardRegion({ kind: "point_radius", center: [-0.1276, 51.5072], radiusMeters: 1 }, global).ok,
    ).toBe(true);
  });
});
