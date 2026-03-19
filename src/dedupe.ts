export function buildApprovalWorkerKey(params: {
  sessionId?: string;
  challengeId?: string;
  pendingId?: string;
  runId?: string;
  jobId?: string;
}): string {
  const normalize = (value: string | undefined): string => {
    const compact = (value ?? "").replace(/\s+/g, "");
    return compact.trim();
  };

  const session = normalize(params.sessionId) || "-";
  const challenge = normalize(params.challengeId) || "-";
  const pending = normalize(params.pendingId) || "-";
  const execution = normalize(params.runId) || normalize(params.jobId) || "-";
  return `${session}:${challenge}:${pending}:${execution}`;
}
