import { describe, expect, it } from "vitest";
import { normalizeVaultRequestForResolver, parseVaultCommandArgs } from "../src/vault-command.js";

describe("parseVaultCommandArgs", () => {
  it("parses control commands", () => {
    expect(parseVaultCommandArgs("status")).toEqual({ kind: "status" });
    expect(parseVaultCommandArgs("off")).toEqual({ kind: "off" });
    expect(parseVaultCommandArgs("on")).toEqual({ kind: "on" });
    expect(parseVaultCommandArgs("on hybrid")).toEqual({ kind: "on", mode: "hybrid" });
    expect(parseVaultCommandArgs("on strict")).toEqual({ kind: "on", mode: "strict" });
  });

  it("treats free text as NL request", () => {
    expect(parseVaultCommandArgs("status update email")).toEqual({
      kind: "request",
      text: "status update email",
    });
  });

  it("shows usage on empty args", () => {
    expect(parseVaultCommandArgs("")).toEqual({ kind: "usage" });
    expect(parseVaultCommandArgs(undefined)).toEqual({ kind: "usage" });
  });
});

describe("normalizeVaultRequestForResolver", () => {
  it("keeps request unchanged when no explicit subject hint is present", () => {
    const input = "send an email to user@example.com explaining bouzeron aligote";
    expect(normalizeVaultRequestForResolver(input)).toBe(input);
  });

  it("appends canonical subject hint for natural language 'as subject' phrasing", () => {
    const input =
      "send an email to skl83@cornell.edu explaining the style of wine that bouzeron aligote. use 'bouzeron' as the subject";
    expect(normalizeVaultRequestForResolver(input)).toBe(`${input}\n\nSubject: bouzeron`);
  });

  it("does not append duplicate hint when subject field is already explicit", () => {
    const input = "send an email to skl83@cornell.edu subject: bouzeron";
    expect(normalizeVaultRequestForResolver(input)).toBe(input);
  });
});
