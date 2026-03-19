import { describe, expect, it } from "vitest";
import { buildApprovalWorkerKey } from "../src/dedupe.js";

describe("buildApprovalWorkerKey", () => {
  it("uses run id when available", () => {
    const key = buildApprovalWorkerKey({
      sessionId: "sess-1",
      challengeId: "ach-1",
      pendingId: "apj-1",
      runId: "run-1",
      jobId: "job-1",
    });
    expect(key).toBe("sess-1:ach-1:apj-1:run-1");
  });

  it("falls back to job id", () => {
    const key = buildApprovalWorkerKey({
      sessionId: "sess-2",
      challengeId: "ach-2",
      pendingId: "apj-2",
      jobId: "job-2",
    });
    expect(key).toBe("sess-2:ach-2:apj-2:job-2");
  });

  it("fills missing fields with dash", () => {
    const key = buildApprovalWorkerKey({});
    expect(key).toBe("-:-:-:-");
  });
});
