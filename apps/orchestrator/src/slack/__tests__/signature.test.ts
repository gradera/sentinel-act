import { createHmac } from "node:crypto";
import { describe, expect, it } from "vitest";
import { verifySlackSignature } from "../signature.js";

const SECRET = "test-signing-secret";

function sign(secret: string, timestamp: string, body: string): string {
  const digest = createHmac("sha256", secret).update(`v0:${timestamp}:${body}`).digest("hex");
  return `v0=${digest}`;
}

describe("verifySlackSignature (FR-22)", () => {
  it("accepts a validly-signed request within the replay window", () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds - 10);
    const body = "payload=%7B%22type%22%3A%22block_actions%22%7D";
    const signature = sign(SECRET, timestamp, body);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestampHeader: timestamp,
      signatureHeader: signature,
      rawBody: body,
      nowSeconds
    });
    expect(result.valid).toBe(true);
  });

  it("rejects a request signed with the wrong secret", () => {
    const nowSeconds = 1_700_000_000;
    const timestamp = String(nowSeconds - 10);
    const body = "payload=abc";
    const signature = sign("wrong-secret", timestamp, body);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestampHeader: timestamp,
      signatureHeader: signature,
      rawBody: body,
      nowSeconds
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe("signature_mismatch");
  });

  it("rejects a request whose timestamp is outside the 5-minute replay window", () => {
    const nowSeconds = 1_700_000_000;
    const staleTimestamp = String(nowSeconds - 6 * 60); // 6 minutes old
    const body = "payload=abc";
    const signature = sign(SECRET, staleTimestamp, body);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestampHeader: staleTimestamp,
      signatureHeader: signature,
      rawBody: body,
      nowSeconds
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe("timestamp_out_of_range");
  });

  it("rejects a request with a future timestamp beyond the window too (abs() bound)", () => {
    const nowSeconds = 1_700_000_000;
    const futureTimestamp = String(nowSeconds + 10 * 60);
    const body = "payload=abc";
    const signature = sign(SECRET, futureTimestamp, body);

    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestampHeader: futureTimestamp,
      signatureHeader: signature,
      rawBody: body,
      nowSeconds
    });
    expect(result.valid).toBe(false);
  });

  it("rejects a request missing the signature header", () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestampHeader: "1700000000",
      signatureHeader: undefined,
      rawBody: "payload=abc",
      nowSeconds: 1_700_000_000
    });
    expect(result.valid).toBe(false);
    expect(result.valid === false && result.reason).toBe("missing_headers");
  });

  it("rejects a request missing the timestamp header", () => {
    const result = verifySlackSignature({
      signingSecret: SECRET,
      timestampHeader: undefined,
      signatureHeader: "v0=abc",
      rawBody: "payload=abc",
      nowSeconds: 1_700_000_000
    });
    expect(result.valid).toBe(false);
  });

  it("never throws on a malformed timestamp header", () => {
    expect(() =>
      verifySlackSignature({
        signingSecret: SECRET,
        timestampHeader: "not-a-number",
        signatureHeader: "v0=abc",
        rawBody: "payload=abc"
      })
    ).not.toThrow();
  });
});
