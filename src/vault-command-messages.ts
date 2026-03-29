import type { VaultCommandMode } from "./types.js";

function modeLabel(mode: VaultCommandMode): string {
  return mode === "strict" ? "STRICT" : "HYBRID";
}

export function vaultStatusMessage(params: {
  enabled: boolean;
  mode: VaultCommandMode;
}): string {
  const enabledLabel = params.enabled ? "ON" : "OFF";
  return `Vault command mode: ${enabledLabel} (${modeLabel(params.mode)}).`;
}

export function vaultUsageMessage(params: {
  enabled: boolean;
  mode: VaultCommandMode;
}): string {
  return [
    vaultStatusMessage(params),
    "Usage:",
    "- /vault on [hybrid|strict]",
    "- /vault off",
    "- /vault status",
    "- /vault update token <ses_...>",
    "- /vault <natural language request>",
  ].join("\n");
}

export function strictRejectMessage(fallbackHint?: string): string {
  return fallbackHint?.trim()
    ? `Vault strict mode rejected this request: ${fallbackHint}`
    : "Vault strict mode only handles Vault-mapped actions. Use /vault off or rephrase as a Vault action.";
}

export function resolverFailureMessage(reason: string): string {
  return `Vault resolver failed: ${reason}`;
}

export function executionFailureMessage(reason: string): string {
  return `Vault execution failed: ${reason}`;
}

export function fallbackFailureMessage(reason: string): string {
  return `Hybrid fallback failed: ${reason}. Retry without /vault.`;
}

export function fallbackQueuedMessage(): string {
  return "Request routed to normal OpenClaw flow.";
}

export function approvalQueuedMessage(): string {
  return "Approval required in Vaultclaw UI. Waiting asynchronously for terminal outcome.";
}

function toLabel(field: string): string {
  const trimmed = field.trim();
  if (!trimmed) {
    return "";
  }

  const normalized = trimmed.toLowerCase();
  if (normalized === "text_plain" || normalized === "text_plain_body" || normalized === "body") {
    return "message body";
  }
  if (normalized === "subject") {
    return "subject";
  }
  if (normalized === "url") {
    return "URL";
  }
  if (normalized === "api_key") {
    return "API key";
  }

  return normalized
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[_\-.]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function compactLabels(missingInputs: string[]): string[] {
  return Array.from(
    new Set(
      missingInputs
        .map(toLabel)
        .filter((item) => item.trim().length > 0),
    ),
  );
}

function joinLabels(labels: string[]): string {
  if (labels.length <= 1) {
    return labels[0] ?? "one detail";
  }
  if (labels.length === 2) {
    return `${labels[0]} and ${labels[1]}`;
  }
  return `${labels.slice(0, -1).join(", ")}, and ${labels[labels.length - 1]}`;
}

export function autoFillStartMessage(params: {
  fetchHint?: string;
}): string {
  const base = "I found the Vault action. I am now gathering the missing details and will continue automatically.";
  if (!params.fetchHint?.trim()) {
    return base;
  }
  return `${base} ${params.fetchHint.trim()}`;
}

export function autoFillSuccessMessagePrefix(): string {
  return "I got what I needed and I am continuing with Vault now.";
}

export function missingInputsMessage(missingInputs: string[]): string {
  const labels = compactLabels(missingInputs);
  if (labels.length === 0) {
    return "I still need one more detail before I can continue. What should I use?";
  }
  if (labels.length === 1) {
    return `I still need one more detail before I can continue: ${labels[0]}. What should I use?`;
  }
  return `I still need a few more details before I can continue: ${joinLabels(labels)}. Please share them and I will continue.`;
}

export function partialAutoFillMessage(missingInputs: string[]): string {
  const labels = compactLabels(missingInputs);
  if (labels.length === 0) {
    return "I found some of what I need, but I still need one more detail from you.";
  }
  if (labels.length === 1) {
    return `I found some of what I need, but I still need one more detail from you: ${labels[0]}.`;
  }
  return `I found some of what I need, but I still need a few more details from you: ${joinLabels(labels)}.`;
}

export function failedAutoFillMessage(missingInputs: string[]): string {
  const labels = compactLabels(missingInputs);
  if (labels.length === 0) {
    return "I could not get the missing details automatically. Please provide the missing details.";
  }
  return `I could not get the missing details automatically. Please provide: ${joinLabels(labels)}.`;
}

export function successMessage(summary: string): string {
  return summary.trim().length > 0
    ? `Vault action completed. ${summary}`
    : "Vault action completed.";
}
