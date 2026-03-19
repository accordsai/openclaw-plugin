import { describe, expect, it } from "vitest";
import { parseApprovalRequiredResult } from "../src/approval-payload.js";

describe("parseApprovalRequiredResult", () => {
  it("parses a valid PLAN_RUN approval payload", () => {
    const input = {
      ok: false,
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_1",
            pending_id: "apj_1",
            run_id: "run_1",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "PLAN_RUN",
                  run_id: "run_1",
                  job_id: "job_1",
                  challenge_id: "ach_1",
                  pending_id: "apj_1"
                }
              }
            }
          }
        }
      }
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.tool).toBe("vaultclaw_approval_wait");
    expect(parsed.signal.handle.kind).toBe("PLAN_RUN");
    expect(parsed.signal.handle.run_id).toBe("run_1");
    expect(parsed.signal.challengeId).toBe("ach_1");
  });

  it("parses a valid JOB approval payload", () => {
    const input = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_2",
            pending_id: "apj_2",
            job_id: "job_2",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "JOB",
                  job_id: "job_2"
                }
              }
            }
          }
        }
      }
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.handle.kind).toBe("JOB");
    expect(parsed.signal.handle.job_id).toBe("job_2");
    expect(parsed.signal.challengeId).toBe("ach_2");
  });

  it("extracts remote attestation url fields from approval payload", () => {
    const input = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_link",
            pending_id: "apj_link",
            job_id: "job_link",
            remote_attestation_url: "https://alerts.accords.ai/a/req_link?t=abc",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "JOB",
                  job_id: "job_link",
                },
              },
            },
          },
        },
      },
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.remoteAttestationURL).toBe("https://alerts.accords.ai/a/req_link?t=abc");
    expect(parsed.signal.remoteAttestationLinkMarkdown).toBe(
      "[https://alerts.accords.ai/a/req_link?t=abc](https://alerts.accords.ai/a/req_link?t=abc)",
    );
  });

  it("reports invalid payload when handle is missing", () => {
    const input = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_3",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {}
            }
          }
        }
      }
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("invalid");
    if (parsed.type !== "invalid") {
      return;
    }
    expect(parsed.message).toContain("handle");
  });

  it("returns not_approval for other error codes", () => {
    const input = {
      error: {
        code: "MCP_VALIDATION_ERROR"
      }
    };

    expect(parseApprovalRequiredResult(input)).toEqual({ type: "not_approval" });
  });

  it("parses approval payload wrapped in exec details.aggregated JSON", () => {
    const aggregated = JSON.stringify({
      ok: false,
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_agg",
            pending_id: "apj_agg",
            run_id: "run_agg",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "PLAN_RUN",
                  run_id: "run_agg",
                  challenge_id: "ach_agg",
                  pending_id: "apj_agg"
                }
              }
            }
          }
        }
      }
    });

    const input = {
      details: {
        aggregated
      }
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.handle.kind).toBe("PLAN_RUN");
    expect(parsed.signal.runId).toBe("run_agg");
    expect(parsed.signal.challengeId).toBe("ach_agg");
  });

  it("parses approval payload wrapped in exec top-level aggregated JSON", () => {
    const aggregated = JSON.stringify({
      ok: false,
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_top",
            pending_id: "apj_top",
            run_id: "run_top",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "PLAN_RUN",
                  run_id: "run_top",
                  challenge_id: "ach_top",
                  pending_id: "apj_top"
                }
              }
            }
          }
        }
      }
    });

    const input = {
      aggregated
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.runId).toBe("run_top");
    expect(parsed.signal.pendingId).toBe("apj_top");
  });

  it("parses approval payload from concatenated JSON blobs in aggregated output", () => {
    const aggregated = `{
  "base_url": "http://localhost"
}
{
  "data": null,
  "error": {
    "category": "approval",
    "code": "MCP_APPROVAL_REQUIRED",
    "details": {
      "approval": {
        "challenge_id": "ach_concat",
        "pending_id": "apj_concat",
        "next_action": {
          "tool": "vaultclaw_approval_wait",
          "arguments": {
            "handle": {
              "kind": "JOB",
              "job_id": "job_concat",
              "challenge_id": "ach_concat",
              "pending_id": "apj_concat"
            }
          }
        }
      }
    }
  },
  "ok": false
}`;

    const input = {
      details: {
        aggregated,
      },
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.handle.kind).toBe("JOB");
    expect(parsed.signal.jobId).toBe("job_concat");
    expect(parsed.signal.challengeId).toBe("ach_concat");
    expect(parsed.signal.pendingId).toBe("apj_concat");
  });

  it("parses approval payload wrapped in tool content text JSON", () => {
    const text = JSON.stringify({
      ok: false,
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: "ach_txt",
            pending_id: "apj_txt",
            job_id: "job_txt",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "JOB",
                  job_id: "job_txt",
                  challenge_id: "ach_txt",
                  pending_id: "apj_txt"
                }
              }
            }
          }
        }
      }
    });

    const input = {
      content: [{ type: "text", text }]
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.handle.kind).toBe("JOB");
    expect(parsed.signal.jobId).toBe("job_txt");
    expect(parsed.signal.pendingId).toBe("apj_txt");
  });

  it("recovers truncated approval payload from aggregated text", () => {
    const input = {
      details: {
        aggregated:
          "{\"ok\":false,\"error\":{\"code\":\"MCP_APPROVAL_REQUIRED\",\"details\":{\"approval\":{\"challenge_id\":\"ach_trunc\",\"pending_id\":\"apj_trunc\",\"run_id\":\"run_trunc 123\"",
      },
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.tool).toBe("vaultclaw_approval_wait");
    expect(parsed.signal.handle.kind).toBe("PLAN_RUN");
    expect(parsed.signal.challengeId).toBe("ach_trunc");
    expect(parsed.signal.pendingId).toBe("apj_trunc");
    expect(parsed.signal.runId).toBe("run_trunc123");
  });

  it("normalizes wrapped identifier whitespace", () => {
    const input = {
      error: {
        code: "MCP_APPROVAL_REQUIRED",
        details: {
          approval: {
            challenge_id: " ach_ 88 ",
            pending_id: " apj_ 99 ",
            run_id: " run_ abc ",
            next_action: {
              tool: "vaultclaw_approval_wait",
              arguments: {
                handle: {
                  kind: "PLAN_RUN",
                  run_id: " run_ abc ",
                },
              },
            },
          },
        },
      },
    };

    const parsed = parseApprovalRequiredResult(input);
    expect(parsed.type).toBe("approval");
    if (parsed.type !== "approval") {
      return;
    }
    expect(parsed.signal.challengeId).toBe("ach_88");
    expect(parsed.signal.pendingId).toBe("apj_99");
    expect(parsed.signal.runId).toBe("run_abc");
  });

  it("does not recover for non-approval errors", () => {
    const input = {
      details: {
        aggregated:
          "{\"ok\":false,\"error\":{\"code\":\"MCP_VALIDATION_ERROR\",\"details\":{\"approval\":{\"challenge_id\":\"ach_no\",\"pending_id\":\"apj_no\",\"run_id\":\"run_no\"",
      },
    };
    expect(parseApprovalRequiredResult(input)).toEqual({ type: "not_approval" });
  });
});
