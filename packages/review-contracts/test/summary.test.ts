import { describe, expect, it } from "vitest";
import { deriveQueueSummary, truncateRequirementText } from "../src/summary.js";

describe("deriveQueueSummary", () => {
  it("returns a placeholder for empty/whitespace-only text", () => {
    expect(deriveQueueSummary("")).toBe("(no requirement text)");
    expect(deriveQueueSummary("   ")).toBe("(no requirement text)");
  });

  it("truncates at the first sentence boundary within the limit", () => {
    expect(deriveQueueSummary("Brokers must re-verify KYC within 5 days. Extra trailing text.")).toBe(
      "Brokers must re-verify KYC within 5 days"
    );
  });

  it("hard-truncates with an ellipsis when no early boundary exists", () => {
    const longText = "a".repeat(150);
    const result = deriveQueueSummary(longText);
    expect(result.endsWith("…")).toBe(true);
    expect(result.length).toBe(101); // 100 chars + ellipsis
  });

  it("returns the text unchanged when short and boundary-free", () => {
    expect(deriveQueueSummary("Short obligation text")).toBe("Short obligation text");
  });

  it("truncateRequirementText is an alias of deriveQueueSummary (same derivation, FR-2)", () => {
    expect(truncateRequirementText).toBe(deriveQueueSummary);
  });
});
