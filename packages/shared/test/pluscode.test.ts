import { describe, expect, it } from "vitest";
import { encodePlusCode } from "../src/pluscode";

// Reference vectors from the Open Location Code test suite (encoding.csv).
describe("encodePlusCode", () => {
  it("matches OLC reference vectors", () => {
    expect(encodePlusCode(20.375, 2.775, 6)).toBe("7FG49Q00+");
    expect(encodePlusCode(20.3700625, 2.7821875, 10)).toBe("7FG49QCJ+2V");
    expect(encodePlusCode(47.0000625, 8.0000625, 10)).toBe("8FVC2222+22");
    expect(encodePlusCode(-41.2730625, 174.7859375, 10)).toBe("4VCPPQGP+Q9");
  });

  it("produces a well-formed length-10 code by default", () => {
    const code = encodePlusCode(-17.8292, 31.0492);
    expect(code).toMatch(/^[23456789CFGHJMPQRVWX]{8}\+[23456789CFGHJMPQRVWX]{2}$/);
  });

  it("is deterministic", () => {
    expect(encodePlusCode(-1.2921, 36.8219)).toBe(encodePlusCode(-1.2921, 36.8219));
  });

  it("rejects non-finite input", () => {
    expect(() => encodePlusCode(NaN, 0)).toThrow();
  });
});
