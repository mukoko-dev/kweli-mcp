import { describe, expect, it } from "vitest";
import {
  extractText,
  isMissingRoute,
  stripThinkBlocks,
} from "../src/description";

describe("stripThinkBlocks", () => {
  it("removes closed blocks, any case, several of them", () => {
    expect(stripThinkBlocks("a<think>x</think>b<THINK>y\nz</Think>c")).toBe(
      "abc",
    );
  });

  it("leaves an unclosed opener alone", () => {
    expect(stripThinkBlocks("a<think>b")).toBe("a<think>b");
    expect(stripThinkBlocks("<think>a</think>b<think>c")).toBe("b<think>c");
  });

  it("is linear on many unclosed openers", () => {
    const evil = "<think>".repeat(200_000);
    const t = performance.now();
    expect(stripThinkBlocks(evil)).toBe(evil);
    expect(performance.now() - t).toBeLessThan(1000);
  });

  it("is used by extractText", () => {
    expect(extractText({ response: "<think>hmm</think> Hello" })).toBe("Hello");
  });
});

describe("isMissingRoute", () => {
  it("matches the same messages as before", () => {
    expect(isMissingRoute(new Error("7003"))).toBe(true);
    expect(isMissingRoute("Dynamic route 'places' not found")).toBe(true);
    expect(isMissingRoute("dynamic route  not found")).toBe(true);
    expect(isMissingRoute("dynamic route not found")).toBe(false);
    expect(isMissingRoute("dynamic route x\ny not found")).toBe(false);
    expect(isMissingRoute(new Error("2003: Rate limited"))).toBe(false);
  });

  it("is linear on a long message that never matches", () => {
    const evil = "dynamic route ".repeat(100_000);
    const t = performance.now();
    expect(isMissingRoute(evil)).toBe(false);
    expect(performance.now() - t).toBeLessThan(1000);
  });
});
