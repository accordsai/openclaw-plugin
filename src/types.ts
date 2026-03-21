export type ApprovalHandleKind = "JOB" | "PLAN_RUN";

export type ApprovalHandle = {
  kind: ApprovalHandleKind;
  job_id?: string;
  run_id?: string;
  challenge_id?: string;
  pending_id?: string;
};

export type ApprovalSignal = {
  tool: string;
  handle: ApprovalHandle;
  challengeId?: string;
  pendingId?: string;
  runId?: string;
  jobId?: string;
  remoteAttestationURL?: string;
  remoteAttestationLinkMarkdown?: string;
};

export type ApprovalHandoffConfig = {
  enabled: boolean;
  pollIntervalMs: number;
  maxWaitMs: number;
  commandTimeoutMs: number;
  maxConcurrentWaits: number;
  allowMcporterFallback: boolean;
  reconcileOnValidationError: boolean;
  reconcileOnUnknownTerminal: boolean;
  reconcileOnWaitError: boolean;
  reconcileTimeoutMs: number;
};

export type VaultCommandMode = "hybrid" | "strict";

export type VaultCommandConfig = {
  enabled: boolean;
  defaultEnabled: boolean;
  defaultMode: VaultCommandMode;
  autoDisableTelegramNativeCommands: boolean;
  sessionModeTtlMs: number;
  maxConcurrentRuns: number;
  enableCoreFallback: boolean;
  coreFallbackTimeoutMs: number;
  resolverTool: string;
  resolverTimeoutMs: number;
  enrichmentGlobalTimeoutMs: number;
  enrichmentTaskTimeoutMs: number;
  deterministicDomains: string[];
};

export type PluginConfig = ApprovalHandoffConfig & {
  vaultCommand: VaultCommandConfig;
};

export type CorrelationKeys = {
  session_id?: string;
  challenge_id?: string;
  pending_id?: string;
  run_id?: string;
  job_id?: string;
};

export type WaitSuccess = {
  done: boolean;
  terminalStatus?: string;
  decisionOutcome?: string;
  raw: unknown;
};

export class WaitCallError extends Error {
  readonly code?: string;
  readonly retryable: boolean;
  readonly category: "transport" | "validation" | "auth" | "timeout" | "unknown";
  readonly details?: unknown;

  constructor(params: {
    message: string;
    code?: string;
    retryable: boolean;
    category: "transport" | "validation" | "auth" | "timeout" | "unknown";
    details?: unknown;
  }) {
    super(params.message);
    this.name = "WaitCallError";
    this.code = params.code;
    this.retryable = params.retryable;
    this.category = params.category;
    this.details = params.details;
  }
}

export type ReconcileOptions = {
  onValidationError: boolean;
  onUnknownTerminal: boolean;
  onWaitError: boolean;
  timeoutMs: number;
};

export type WaitInvoker = (params: {
  sessionKey?: string;
  handle: ApprovalHandle;
  pollIntervalMs: number;
  maxWaitMs: number;
  commandTimeoutMs: number;
  allowMcporterFallback?: boolean;
  reconcile?: ReconcileOptions;
  signal?: AbortSignal;
}) => Promise<WaitSuccess>;

export type ResumeInvoker = (params: {
  sessionKey?: string;
  signal: ApprovalSignal;
}) => Promise<void>;

export type ApprovalNotifier = {
  post: (params: {
    sessionKey?: string;
    sessionId?: string;
    text: string;
    reason: string;
    contextKey?: string;
  }) => void;
};

export type StructuredLogger = {
  debug?: (message: string) => void;
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};
