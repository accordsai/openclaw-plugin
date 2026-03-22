import type { ApprovalSignal, CompletionProbeResult, WaitSuccess } from "./types.js";

function formatIds(signal: ApprovalSignal): string {
  const parts: string[] = [];
  if (signal.challengeId) {
    parts.push(`challenge_id=${signal.challengeId}`);
  }
  if (signal.pendingId) {
    parts.push(`pending_id=${signal.pendingId}`);
  }
  if (signal.runId) {
    parts.push(`run_id=${signal.runId}`);
  }
  if (signal.jobId) {
    parts.push(`job_id=${signal.jobId}`);
  }
  return parts.length > 0 ? ` (${parts.join(", ")})` : "";
}

function formatAttestationLink(signal: ApprovalSignal): string {
  const markdownLink = signal.remoteAttestationLinkMarkdown?.trim();
  if (markdownLink) {
    return `\nAttestation link: ${markdownLink}`;
  }
  const url = signal.remoteAttestationURL?.trim();
  if (url) {
    return `\nAttestation link: [${url}](${url})`;
  }
  return "";
}

function formatWaitBudget(maxWaitMs: number): string {
  const minutes = Math.floor(maxWaitMs / 60000);
  if (minutes > 0 && maxWaitMs % 60000 === 0) {
    return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  }
  const seconds = Math.floor(maxWaitMs / 1000);
  return `${seconds} second${seconds === 1 ? "" : "s"}`;
}

export function approvalRequiredMessage(signal: ApprovalSignal, maxWaitMs: number): string {
  return `Approval required in Vaultclaw UI. Waiting up to ${formatWaitBudget(maxWaitMs)}...${formatIds(signal)}${formatAttestationLink(signal)}`;
}

export function invalidApprovalPayloadMessage(params: {
  reason: string;
  challengeId?: string;
  pendingId?: string;
  runId?: string;
  jobId?: string;
}): string {
  const signal: ApprovalSignal = {
    tool: "vaultclaw_approval_wait",
    handle: { kind: "JOB" },
    challengeId: params.challengeId,
    pendingId: params.pendingId,
    runId: params.runId,
    jobId: params.jobId,
  };
  return `Approval auto-wait not started: ${params.reason}.${formatIds(signal)}`;
}

function summarizeAllow(wait: WaitSuccess): string {
  const details: string[] = [];
  if (wait.terminalStatus) {
    details.push(`terminal_status=${wait.terminalStatus}`);
  }
  if (wait.decisionOutcome) {
    details.push(`decision_outcome=${wait.decisionOutcome}`);
  }
  return details.length > 0 ? ` (${details.join(", ")})` : "";
}

export function approvalAllowMessage(signal: ApprovalSignal, wait: WaitSuccess): string {
  return `Approval allowed in Vaultclaw UI. Continuing automatically.${formatIds(signal)}${summarizeAllow(wait)}`;
}

export function approvalCompletedMessage(signal: ApprovalSignal, completion: CompletionProbeResult): string {
  const details: string[] = [];
  if (completion.terminalStatus) {
    details.push(`terminal_status=${completion.terminalStatus}`);
  }
  if (completion.decisionOutcome) {
    details.push(`decision_outcome=${completion.decisionOutcome}`);
  }
  if (completion.executedSteps !== undefined) {
    details.push(`executed_steps=${completion.executedSteps}`);
  }
  if (completion.lastStep) {
    details.push(`last_step=${completion.lastStep}`);
  }
  if (completion.runId) {
    details.push(`run_id=${completion.runId}`);
  }
  if (completion.jobId) {
    details.push(`job_id=${completion.jobId}`);
  }

  const suffix = details.length > 0 ? ` (${details.join(", ")})` : formatIds(signal);
  return `Done - approval processed and Vault action completed successfully.${suffix}`;
}

export function approvalResumeFailedMessage(signal: ApprovalSignal, reason: string): string {
  return `Approval was allowed in Vaultclaw UI, but auto-resume failed: ${reason}. Reply approved or rerun the request to continue.${formatIds(signal)}`;
}

export function approvalDenyMessage(signal: ApprovalSignal): string {
  return `Denied by attestation in Vaultclaw UI.${formatIds(signal)}`;
}

export function approvalTimeoutMessage(signal: ApprovalSignal, maxWaitMs: number): string {
  return `Approval wait timed out after ${formatWaitBudget(maxWaitMs)}. Retry with same handle using vaultclaw_approval_wait.${formatIds(signal)}`;
}

export function approvalUnknownTerminalMessage(signal: ApprovalSignal, wait: WaitSuccess): string {
  const details = summarizeAllow(wait);
  return `Approval wait reached a terminal state with unknown outcome. Retry with same handle using vaultclaw_approval_wait.${formatIds(signal)}${details}`;
}

export function approvalWaitErrorMessage(signal: ApprovalSignal, reason: string): string {
  return `Approval monitoring failed before a terminal decision was observed: ${reason}. The underlying action may still complete. Check Vaultclaw status and, if needed, retry with the same handle using vaultclaw_approval_wait.${formatIds(signal)}${formatAttestationLink(signal)}`;
}
