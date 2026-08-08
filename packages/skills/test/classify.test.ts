import { describe, expect, it } from "vitest";
import { classify, type OsmFeature } from "../src/classify";

function feature(tags: Record<string, string>): OsmFeature {
  return { type: "node", id: 1, lat: -17.8, lon: 31.0, tags };
}

describe("classify", () => {
  it("treats a hotel as a business (place + entity)", () => {
    const c = classify(feature({ name: "Rhino Safari Camp", tourism: "hotel" }));
    expect(c.isBusiness).toBe(true);
    expect(c.placeType).toContain("Accommodation");
    expect(c.placeType).toContain("LocalBusiness");
    expect(c.schemaOrgType).toBe("LocalBusiness");
  });

  it("treats a restaurant as a business", () => {
    const c = classify(feature({ name: "Cafe", amenity: "restaurant" }));
    expect(c.isBusiness).toBe(true);
    expect(c.placeType).toContain("Restaurant");
  });

  it("treats a waterfall as a natural, owner-less place", () => {
    const c = classify(feature({ name: "Victoria Falls", waterway: "waterfall" }));
    expect(c.isBusiness).toBe(false);
    expect(c.placeType).toContain("TouristAttraction");
  });

  it("treats a peak as a mountain landform", () => {
    const c = classify(feature({ name: "Nyangani", natural: "peak" }));
    expect(c.isBusiness).toBe(false);
    expect(c.placeType).toEqual(expect.arrayContaining(["Mountain", "Landform"]));
  });

  it("treats a shop as a store business", () => {
    const c = classify(feature({ name: "Market", shop: "supermarket" }));
    expect(c.isBusiness).toBe(true);
    expect(c.placeType).toContain("Store");
  });

  it("falls back to Place with no recognised tags", () => {
    const c = classify(feature({ name: "Somewhere", foo: "bar" }));
    expect(c.placeType).toEqual(["Place"]);
    expect(c.isBusiness).toBe(false);
  });
});
