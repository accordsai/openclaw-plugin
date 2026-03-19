import { describe, expect, it, vi } from "vitest";
import { createApprovalNotifier, parseChannelTargetFromSessionKey } from "../src/notifier.js";

function createHarness(params?: {
  sendMessageTelegram?: Parameters<typeof vi.fn>[0];
  sendMessageWhatsApp?: Parameters<typeof vi.fn>[0];
  sendMessageDiscord?: Parameters<typeof vi.fn>[0];
  sendMessageSlack?: Parameters<typeof vi.fn>[0];
  enqueueSystemEvent?: Parameters<typeof vi.fn>[0];
  disableTelegram?: boolean;
  disableWhatsApp?: boolean;
  disableDiscord?: boolean;
  disableSlack?: boolean;
}) {
  const sendMessageTelegram = vi.fn(
    params?.sendMessageTelegram ??
      (async () => ({
        messageId: "1",
        chatId: "509928323",
      })),
  );
  const sendMessageWhatsApp = vi.fn(
    params?.sendMessageWhatsApp ??
      (async () => ({
        messageId: "1",
        toJid: "123@s.whatsapp.net",
      })),
  );
  const sendMessageDiscord = vi.fn(
    params?.sendMessageDiscord ??
      (async () => ({
        messageId: "1",
        channelId: "123",
      })),
  );
  const sendMessageSlack = vi.fn(
    params?.sendMessageSlack ??
      (async () => ({
        messageId: "1",
        channelId: "C123",
      })),
  );
  const enqueueSystemEvent = vi.fn(params?.enqueueSystemEvent ?? (() => true));
  const requestHeartbeatNow = vi.fn();
  const warn = vi.fn();

  const telegramRuntime = params?.disableTelegram ? {} : { sendMessageTelegram };
  const whatsappRuntime = params?.disableWhatsApp ? {} : { sendMessageWhatsApp };
  const discordRuntime = params?.disableDiscord ? {} : { sendMessageDiscord };
  const slackRuntime = params?.disableSlack ? {} : { sendMessageSlack };

  const notifier = createApprovalNotifier({
    runtime: {
      channel: {
        telegram: telegramRuntime,
        whatsapp: whatsappRuntime,
        discord: discordRuntime,
        slack: slackRuntime,
      },
      system: {
        enqueueSystemEvent,
        requestHeartbeatNow,
      },
    },
    logger: {
      info: () => {},
      error: () => {},
      debug: () => {},
      warn,
    },
  } as any);

  return {
    notifier,
    sendMessageTelegram,
    sendMessageWhatsApp,
    sendMessageDiscord,
    sendMessageSlack,
    enqueueSystemEvent,
    requestHeartbeatNow,
    warn,
  };
}

describe("parseChannelTargetFromSessionKey", () => {
  it("parses channel session key with no account", () => {
    expect(parseChannelTargetFromSessionKey("agent:main:telegram:direct:509928323")).toEqual({
      channel: "telegram",
      chatType: "direct",
      peerId: "509928323",
    });
  });

  it("parses channel session key with account scope", () => {
    expect(parseChannelTargetFromSessionKey("agent:main:telegram:default:direct:509928323")).toEqual({
      channel: "telegram",
      accountId: "default",
      chatType: "direct",
      peerId: "509928323",
    });
  });

  it("drops thread suffix when deriving channel target", () => {
    expect(parseChannelTargetFromSessionKey("agent:main:telegram:group:-10012345:thread:777")).toEqual({
      channel: "telegram",
      chatType: "group",
      peerId: "-10012345",
    });
  });

  it("returns undefined for non-channel agent session", () => {
    expect(parseChannelTargetFromSessionKey("agent:main:main")).toBeUndefined();
  });
});

describe("createApprovalNotifier", () => {
  it("sends telegram notifications directly for telegram sessions", async () => {
    const harness = createHarness();
    harness.notifier.post({
      sessionKey: "agent:main:telegram:direct:509928323",
      reason: "approval-required",
      text: "Approval required",
      contextKey: "approval:abc",
    });

    await Promise.resolve();
    expect(harness.sendMessageTelegram).toHaveBeenCalledTimes(1);
    expect(harness.sendMessageTelegram).toHaveBeenCalledWith("509928323", "Approval required", {
      accountId: undefined,
      plainText: "Approval required",
    });
    expect(harness.enqueueSystemEvent).not.toHaveBeenCalled();
    expect(harness.requestHeartbeatNow).not.toHaveBeenCalled();
  });

  it("falls back to system event when session is not channel-routable", () => {
    const harness = createHarness();
    harness.notifier.post({
      sessionKey: "agent:main:main",
      reason: "approval-required",
      text: "Approval required",
      contextKey: "approval:abc",
    });

    expect(harness.sendMessageTelegram).not.toHaveBeenCalled();
    expect(harness.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(harness.requestHeartbeatNow).toHaveBeenCalledTimes(1);
  });

  it("falls back to system event when direct telegram send fails", async () => {
    const harness = createHarness({
      sendMessageTelegram: async () => {
        throw new Error("send failed");
      },
    });
    harness.notifier.post({
      sessionKey: "agent:main:telegram:direct:509928323",
      reason: "approval-required",
      text: "Approval required",
      contextKey: "approval:abc",
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(harness.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct telegram send failed, falling back to system event"),
    );
  });

  it("sends whatsapp notifications directly for whatsapp sessions", async () => {
    const harness = createHarness();
    harness.notifier.post({
      sessionKey: "agent:main:whatsapp:direct:123@s.whatsapp.net",
      reason: "approval-required",
      text: "Approval required",
    });

    await Promise.resolve();
    expect(harness.sendMessageWhatsApp).toHaveBeenCalledTimes(1);
    expect(harness.sendMessageWhatsApp).toHaveBeenCalledWith("123@s.whatsapp.net", "Approval required", {
      accountId: undefined,
      verbose: false,
    });
    expect(harness.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("sends discord notifications directly for discord sessions", async () => {
    const harness = createHarness();
    harness.notifier.post({
      sessionKey: "agent:main:discord:channel:1234567890",
      reason: "approval-required",
      text: "Approval required",
    });

    await Promise.resolve();
    expect(harness.sendMessageDiscord).toHaveBeenCalledTimes(1);
    expect(harness.sendMessageDiscord).toHaveBeenCalledWith("1234567890", "Approval required", {
      accountId: undefined,
    });
    expect(harness.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("sends slack notifications directly for slack sessions", async () => {
    const harness = createHarness();
    harness.notifier.post({
      sessionKey: "agent:main:slack:direct:U123456",
      reason: "approval-required",
      text: "Approval required",
    });

    await Promise.resolve();
    expect(harness.sendMessageSlack).toHaveBeenCalledTimes(1);
    expect(harness.sendMessageSlack).toHaveBeenCalledWith("U123456", "Approval required", {
      accountId: undefined,
    });
    expect(harness.enqueueSystemEvent).not.toHaveBeenCalled();
  });

  it("falls back when whatsapp runtime direct send is unavailable", () => {
    const harness = createHarness({ disableWhatsApp: true });
    harness.notifier.post({
      sessionKey: "agent:main:whatsapp:direct:123@s.whatsapp.net",
      reason: "approval-required",
      text: "Approval required",
      contextKey: "approval:abc",
    });

    expect(harness.sendMessageWhatsApp).not.toHaveBeenCalled();
    expect(harness.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(harness.requestHeartbeatNow).toHaveBeenCalledTimes(1);
  });

  it("falls back to system event when direct slack send throws", async () => {
    const harness = createHarness({
      sendMessageSlack: async () => {
        throw new Error("slack send failed");
      },
    });
    harness.notifier.post({
      sessionKey: "agent:main:slack:direct:U123456",
      reason: "approval-required",
      text: "Approval required",
    });

    await Promise.resolve();
    await Promise.resolve();
    expect(harness.enqueueSystemEvent).toHaveBeenCalledTimes(1);
    expect(harness.requestHeartbeatNow).toHaveBeenCalledTimes(1);
    expect(harness.warn).toHaveBeenCalledWith(
      expect.stringContaining("direct slack send failed, falling back to system event"),
    );
  });
});
