import { describe, expect, it } from "vitest";
import { settlementsToTasks } from "../src/generators";

const SETTLEMENTS: Array<{ name: string; center: [number, number] }> = [
  { name: "Harare", center: [31.0428, -17.8158] },
  { name: "Bulawayo", center: [28.5833, -20.15] },
];

describe("settlementsToTasks", () => {
  it("fans settlements into atomic point_radius tasks at bulk priority", () => {
    const tasks = settlementsToTasks(
      SETTLEMENTS,
      { radiusMeters: 20_000, categories: "all", source: { kind: "ops_mcp" } },
      "bulk:settlement",
    );
    expect(tasks).toHaveLength(2);
    expect(tasks[0].region).toEqual({
      kind: "point_radius",
      center: [31.0428, -17.8158],
      radiusMeters: 20_000,
    });
    expect(tasks[0].priority).toBe(1);
    expect(tasks[0].source.surface).toBe("bulk:settlement:Harare");
    expect(tasks[1].source.surface).toBe("bulk:settlement:Bulawayo");
  });

  it("preserves an explicit source surface instead of the generated one", () => {
    const tasks = settlementsToTasks(
      SETTLEMENTS,
      {
        radiusMeters: 5_000,
        categories: ["amenity"],
        source: { kind: "ops_mcp", surface: "kweli-admin-sync" },
      },
      "bulk:settlement",
    );
    expect(tasks.every((t) => t.source.surface === "kweli-admin-sync")).toBe(true);
    expect(tasks[0].categories).toEqual(["amenity"]);
  });
});
