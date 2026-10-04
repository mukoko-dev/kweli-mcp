import { beforeEach, describe, expect, it } from "vitest";
import {
  type AiConfig,
  extractText,
  gatewayOptions,
  generateDescription,
  isMissingRoute,
  resetRouteCache,
} from "../src/description";

const feature = { id: 1, type: "node", lat: 0, lon: 0, tags: {} } as never;

describe("gatewayOptions", () => {
  it("routes through the gateway with cache skipped and metadata attached", () => {
    expect(
      gatewayOptions({
        gateway: "fundi",
        metadata: { worker: "fundi-ingestion", job: "generate_description" },
      }),
    ).toEqual({
      gateway: {
        id: "fundi",
        skipCache: true,
        metadata: { worker: "fundi-ingestion", job: "generate_description" },
      },
    });
  });

  it("sends no gateway option when none is configured", () => {
    expect(gatewayOptions({})).toBeUndefined();
  });
});

describe("generateDescription budget", () => {
  it("makes no model call when the budget refuses", async () => {
    let calls = 0;
    const cfg: AiConfig = {
      binding: {
        run: async () => {
          calls++;
          return { response: "A long enough clean description of a place." };
        },
      } as unknown as AiConfig["binding"],
      model: "m",
      reserve: async () => false,
    };
    expect(await generateDescription(cfg, feature, "Place")).toBeNull();
    expect(calls).toBe(0);
  });

  it("reserves once per model call and wraps each call in the span hook", async () => {
    let reserved = 0;
    let spans = 0;
    const cfg: AiConfig = {
      binding: {
        run: async () => ({ response: "I don't have information." }),
      } as unknown as AiConfig["binding"],
      model: "m",
      reserve: async () => {
        reserved++;
        return true;
      },
      span: async (_model, fn) => {
        spans++;
        return fn();
      },
    };
    // A hedge, then one stricter retry: exactly two calls, never more.
    expect(await generateDescription(cfg, feature, "Place")).toBeNull();
    expect(reserved).toBe(2);
    expect(spans).toBe(2);
  });
});

describe("dynamic route", () => {
  beforeEach(() => resetRouteCache());
  const good = "A riverside market selling fresh produce and crafts daily.";

  it("parses both Workers AI and chat-completions shapes, dropping think blocks", () => {
    expect(extractText({ response: " x " })).toBe("x");
    expect(
      extractText({
        choices: [
          { message: { content: "<think>\n\n</think>\n\nHello there" } },
        ],
      }),
    ).toBe("Hello there");
    expect(extractText(null)).toBe("");
  });

  it("recognises a missing route", () => {
    expect(
      isMissingRoute(new Error("7003: Dynamic route 'places' not found")),
    ).toBe(true);
    expect(isMissingRoute(new Error("2003: Rate limited"))).toBe(false);
  });

  it("uses the route when it exists", async () => {
    const models: string[] = [];
    const cfg: AiConfig = {
      binding: {
        run: async (m: string) => {
          models.push(m);
          return { choices: [{ message: { content: good } }] };
        },
      } as unknown as AiConfig["binding"],
      model: "@cf/direct",
      route: "dynamic/places",
    };
    expect(await generateDescription(cfg, feature, "Market")).toBe(good);
    expect(models).toEqual(["dynamic/places"]);
  });

  it("falls back to the direct model once, then skips the missing route", async () => {
    const models: string[] = [];
    const cfg: AiConfig = {
      binding: {
        run: async (m: string) => {
          models.push(m);
          if (m.startsWith("dynamic/"))
            throw new Error("7003: Dynamic route 'places' not found");
          return { response: good };
        },
      } as unknown as AiConfig["binding"],
      model: "@cf/direct",
      route: "dynamic/places",
    };
    expect(await generateDescription(cfg, feature, "Market")).toBe(good);
    expect(await generateDescription(cfg, feature, "Market")).toBe(good);
    expect(models).toEqual(["dynamic/places", "@cf/direct", "@cf/direct"]);
  });
});
