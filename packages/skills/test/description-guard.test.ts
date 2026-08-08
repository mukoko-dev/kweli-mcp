import { describe, expect, it } from "vitest";
import { isHedge } from "../src/description";

// §6: the v10 guard. Clean-or-absent, never a hedge. Do NOT regress this.
describe("isHedge", () => {
  it("flags refusals and meta-commentary", () => {
    const hedges = [
      "I don't have specific information about this place.",
      "I do not have reliable information.",
      "As an AI, I cannot provide details.",
      "Unfortunately, I'm unable to describe this.",
      "I'd be happy to help, but...",
      "Following the rule, here's what I can say.",
      "No specific information is available.",
      "Based on the limited information provided.",
      "Description: A lovely spot.",
      "Sure, here is a description.",
      "Here's a description of the place.",
      "SKIP",
      "skip",
      "   ",
      "too short",
    ];
    for (const h of hedges) expect(isHedge(h), h).toBe(true);
  });

  it("passes clean factual descriptions", () => {
    const clean = [
      "Victoria Falls is one of the largest waterfalls in the world, straddling the border between Zambia and Zimbabwe on the Zambezi River.",
      "A family-run guesthouse offering rooms with views over Lake Kivu and a small garden restaurant.",
    ];
    for (const c of clean) expect(isHedge(c), c).toBe(false);
  });
});
