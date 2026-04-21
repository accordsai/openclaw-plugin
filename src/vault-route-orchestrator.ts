import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  resolveFactWithScopedProviders,
  type SafeTextResolutionEvent,
  VaultFactResolutionError,
  type FactResolutionFailureReason,
} from "./vault-fact-resolver.js";
import {
  resolveVaultRoute,
  type ResolverFailure,
  type ResolverMissingInputGuidance,
  type ResolverPayload,
  type ResolverStatus,
} from "./vault-resolver-client.js";

type FactTask = {
  index: number;
  inputKey?: string;
  factKey: string;
  kind?: string;
  instructions?: string;
  requestText?: string;
  batchGroup: string;
  parallelizable: boolean;
  rawRequest: Record<string, unknown>;
};

type FactTaskOutcome =
  | { status: "completed"; task: FactTask; value: unknown; resolutionEvents: SafeTextResolutionEvent[] }
  | {
    status: "failed";
    task: FactTask;
    reason: string;
    reasonCode?: FactResolutionFailureReason;
    resolutionEvents: SafeTextResolutionEvent[];
  }
  | { status: "timed_out"; task: FactTask; reason: string; resolutionEvents: SafeTextResolutionEvent[] };

export type VaultRouteEnrichmentTelemetry = {
  usedGuidance: boolean;
  guidanceCount: number;
  askUserCount: number;
  autoRetryCount: number;
  autoRetryAttempted: boolean;
  factTasksStarted: number;
  factTasksCompleted: number;
  factTasksFailed: number;
  factTasksTimedOut: number;
  safeTextPrimaryUsed: number;
  safeTextFallbackUsed: number;
  safeTextFallbackFailed: number;
  failureReasonCodes?: FactResolutionFailureReason[];
  retryStatus?: ResolverStatus;
  fallbackToUserReason?: string;
  elapsedMs: number;
};

export type ResolveAndEnrichResult = {
  payload?: ResolverPayload;
  failure?: ResolverFailure;
  rawEnvelope: Record<string, unknown>;
  telemetry: VaultRouteEnrichmentTelemetry;
};

export type VaultAutoFillTaskHint = {
  factKey: string;
  inputKey?: string;
  kind?: string;
  instructions?: string;
  requestText?: string;
};

type RouteResolverFn = typeof resolveVaultRoute;

type FactResolverFn = (params: {
  config: OpenClawConfig;
  sessionKey?: string;
  task: FactTask;
  timeoutMs: number;
  signal: AbortSignal;
  onResolutionEvent?: (event: SafeTextResolutionEvent) => void;
}) => Promise<unknown>;

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function readString(value: unknown): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function readBoolean(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

function compact(value: string | undefined): string | undefined {
  const trimmed = readString(value);
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
  const trimmed = text.trim();
  if (!trimmed) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(trimmed) as unknown;
    return asRecord(parsed);
  } catch {
    return undefined;
  }
}

function normalizeGuidance(payload: ResolverPayload): ResolverMissingInputGuidance[] {
  if (!Array.isArray(payload.missing_input_guidance)) {
    return [];
  }
  return payload.missing_input_guidance.filter((entry) => Boolean(asRecord(entry)));
}

function normalizeProgressMode(payload: ResolverPayload): string | undefined {
  const mode = readString(asRecord(payload.progress_hint)?.mode);
  return mode?.toUpperCase();
}

function createCombinedSignal(signals: Array<AbortSignal | undefined>): AbortSignal {
  const defined = signals.filter((signal): signal is AbortSignal => Boolean(signal));
  if (defined.length === 0) {
    return new AbortController().signal;
  }
  if (defined.length === 1) {
    return defined[0];
  }
  if (typeof AbortSignal.any === "function") {
    return AbortSignal.any(defined);
  }
  const controller = new AbortController();
  const onAbort = () => controller.abort();
  for (const signal of defined) {
    signal.addEventListener("abort", onAbort, { once: true });
  }
  return controller.signal;
}

function buildFactTask(entry: ResolverMissingInputGuidance, index: number): FactTask | undefined {
  const request = asRecord(entry.external_fact_request);
  const factKey = compact(readString(request?.fact_key) ?? readString(entry.input_key));
  if (!factKey) {
    return undefined;
  }

  const batchGroup = compact(readString(request?.batch_group)) ?? "default";
  return {
    index,
    inputKey: compact(readString(entry.input_key)),
    factKey,
    kind: compact(readString(request?.fact_kind) ?? readString(request?.kind)),
    instructions: compact(readString(request?.instructions)),
    requestText: compact(readString(request?.request_text)),
    batchGroup,
    parallelizable: readBoolean(request?.parallelizable) === true,
    rawRequest: request ?? {},
  };
}

function normalizeInputKey(value: string | undefined): string | undefined {
  const normalized = compact(value)?.toLowerCase().replace(/\s+/g, "_");
  return normalized;
}

function isSubjectInputKey(value: string | undefined): boolean {
  const normalized = normalizeInputKey(value);
  if (!normalized) {
    return false;
  }
  return normalized === "subject" || normalized === "email_subject" || normalized === "subject_line";
}

function buildSyntheticSubjectFactTask(params: {
  payload: ResolverPayload;
  guidance: ResolverMissingInputGuidance[];
  index: number;
  requestText: string;
}): FactTask | undefined {
  const missingInputs = Array.isArray(params.payload.missing_inputs) ? params.payload.missing_inputs : [];
  const missingHasSubject = missingInputs.some((entry) => isSubjectInputKey(entry));
  if (!missingHasSubject) {
    return undefined;
  }

  let factKey: string | undefined;
  let inputKey: string | undefined;
  for (const entry of params.guidance) {
    const key = compact(readString(entry.input_key));
    if (!isSubjectInputKey(key)) {
      continue;
    }
    inputKey = key;
    const request = asRecord(entry.external_fact_request);
    factKey = compact(readString(request?.fact_key)) ?? key;
    break;
  }

  if (!factKey) {
    factKey = missingInputs.find((entry) => isSubjectInputKey(entry)) ?? "subject";
  }

  return {
    index: params.index,
    inputKey: inputKey ?? "subject",
    factKey,
    kind: "email_subject_generation",
    instructions: "Draft a concise email subject for the user's request.",
    requestText: params.requestText,
    batchGroup: "synthetic_subject",
    parallelizable: true,
    rawRequest: {
      fact_key: factKey,
      kind: "email_subject_generation",
      parallelizable: true,
      batch_group: "synthetic_subject",
      request_text: params.requestText,
      source: "plugin_synthetic",
    },
  };
}

function shallowClone<T extends Record<string, unknown>>(value: T): T {
  return { ...value };
}

function mergeContextWithFacts(
  base: Record<string, unknown> | undefined,
  facts: Record<string, unknown>,
): Record<string, unknown> {
  const context = shallowClone(base ?? {});
  const priorFacts = asRecord(context.facts) ?? {};
  context.facts = {
    ...priorFacts,
    ...facts,
  };
  return context;
}

function normalizeFactValue(value: unknown): unknown {
  if (typeof value !== "string") {
    return value;
  }
  const trimmed = value.trim();
  if (!trimmed) {
    return "";
  }
  const parsed = parseJsonObject(trimmed);
  if (parsed) {
    return parsed;
  }
  return trimmed;
}

function toGatewayError(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) {
    return error.message;
  }
  return String(error);
}

function toFactFailureReason(error: unknown): FactResolutionFailureReason | undefined {
  if (error instanceof VaultFactResolutionError) {
    return error.reasonCode;
  }
  const record = error as {
    reasonCode?: unknown;
    code?: unknown;
  };
  if (typeof record.reasonCode === "string") {
    return record.reasonCode as FactResolutionFailureReason;
  }
  if (record.code === "RESPONSES_ENDPOINT_UNAVAILABLE") {
    return "safe_text_unavailable";
  }
  return undefined;
}

function normalizeDomain(value: string | undefined): string | undefined {
  const trimmed = compact(value);
  if (!trimmed) {
    return undefined;
  }
  return trimmed.toLowerCase();
}

function isDomainDeterministic(domain: string | undefined, allowList: string[]): boolean {
  if (allowList.length === 0) {
    return true;
  }
  const normalized = normalizeDomain(domain);
  if (!normalized) {
    return false;
  }
  const allowed = allowList.map((entry) => entry.trim().toLowerCase()).filter((entry) => entry.length > 0);
  return allowed.includes(normalized);
}

function collectFailureReasonCodes(outcomes: FactTaskOutcome[]): FactResolutionFailureReason[] {
  const reasons = new Set<FactResolutionFailureReason>();
  for (const outcome of outcomes) {
    if (outcome.status === "failed" && outcome.reasonCode) {
      reasons.add(outcome.reasonCode);
    }
  }
  return Array.from(reasons.values()).sort();
}

function collectSafeTextEvents(outcomes: FactTaskOutcome[]): {
  safeTextPrimaryUsed: number;
  safeTextFallbackUsed: number;
  safeTextFallbackFailed: number;
} {
  const counts = {
    safeTextPrimaryUsed: 0,
    safeTextFallbackUsed: 0,
    safeTextFallbackFailed: 0,
  };

  for (const outcome of outcomes) {
    for (const event of outcome.resolutionEvents) {
      if (event === "safe_text_primary_used") {
        counts.safeTextPrimaryUsed += 1;
        continue;
      }
      if (event === "safe_text_fallback_used") {
        counts.safeTextFallbackUsed += 1;
        continue;
      }
      if (event === "safe_text_fallback_failed") {
        counts.safeTextFallbackFailed += 1;
      }
    }
  }

  return counts;
}

async function withTimeout<T>(params: {
  task: FactTask;
  timeoutMs: number;
  signal: AbortSignal;
  run: () => Promise<T>;
}): Promise<{ status: "completed"; value: T } | { status: "timed_out"; reason: string }> {
  if (params.signal.aborted) {
    return { status: "timed_out", reason: `fact task timed out for ${params.task.factKey}` };
  }
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      resolve({
        status: "timed_out",
        reason: `fact task timed out for ${params.task.factKey}`,
      });
    }, params.timeoutMs);
    timer.unref?.();

    params.run().then(
      (value) => {
        clearTimeout(timer);
        resolve({
          status: "completed",
          value,
        });
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

async function runSingleFactTask(params: {
  config: OpenClawConfig;
  task: FactTask;
  sessionKey?: string;
  deadlineMs: number;
  taskTimeoutMs: number;
  globalSignal: AbortSignal;
  resolveFact: FactResolverFn;
}): Promise<FactTaskOutcome> {
  const resolutionEvents: SafeTextResolutionEvent[] = [];
  const now = Date.now();
  if (now >= params.deadlineMs || params.globalSignal.aborted) {
    return {
      status: "timed_out",
      task: params.task,
      reason: `fact task timed out for ${params.task.factKey}`,
      resolutionEvents,
    };
  }

  const remainingMs = params.deadlineMs - now;
  const timeoutMs = Math.max(1, Math.min(params.taskTimeoutMs, remainingMs));

  const taskController = new AbortController();
  const taskTimer = setTimeout(() => taskController.abort(), timeoutMs);
  taskTimer.unref?.();
  const signal = createCombinedSignal([params.globalSignal, taskController.signal]);

  try {
    const result = await withTimeout({
      task: params.task,
      timeoutMs,
      signal,
      run: () =>
        params.resolveFact({
          config: params.config,
          sessionKey: params.sessionKey,
          task: params.task,
          timeoutMs,
          signal,
          onResolutionEvent: (event) => {
            resolutionEvents.push(event);
          },
        }),
    });
    if (result.status === "timed_out") {
      return {
        status: "timed_out",
        task: params.task,
        reason: result.reason,
        resolutionEvents,
      };
    }

    const normalized = normalizeFactValue(result.value);
    if (
      normalized === undefined ||
      normalized === null ||
      (typeof normalized === "string" && normalized.trim().length === 0)
    ) {
      return {
        status: "failed",
        task: params.task,
        reason: `fact task returned empty value for ${params.task.factKey}`,
        resolutionEvents,
      };
    }

    return {
      status: "completed",
      task: params.task,
      value: normalized,
      resolutionEvents,
    };
  } catch (error) {
    if (signal.aborted || params.globalSignal.aborted) {
      return {
        status: "timed_out",
        task: params.task,
        reason: `fact task timed out for ${params.task.factKey}`,
        resolutionEvents,
      };
    }
    return {
      status: "failed",
      task: params.task,
      reason: toGatewayError(error),
      reasonCode: toFactFailureReason(error),
      resolutionEvents,
    };
  } finally {
    clearTimeout(taskTimer);
  }
}

async function runFactTaskGroup(params: {
  config: OpenClawConfig;
  tasks: FactTask[];
  sessionKey?: string;
  deadlineMs: number;
  taskTimeoutMs: number;
  globalSignal: AbortSignal;
  resolveFact: FactResolverFn;
}): Promise<FactTaskOutcome[]> {
  const out: FactTaskOutcome[] = [];
  const tasks = [...params.tasks].sort((a, b) => a.index - b.index);

  for (let idx = 0; idx < tasks.length; idx += 1) {
    const current = tasks[idx];
    if (!current.parallelizable) {
      out.push(
        await runSingleFactTask({
          config: params.config,
          task: current,
          sessionKey: params.sessionKey,
          deadlineMs: params.deadlineMs,
          taskTimeoutMs: params.taskTimeoutMs,
          globalSignal: params.globalSignal,
          resolveFact: params.resolveFact,
        }),
      );
      continue;
    }

    const batch: FactTask[] = [current];
    for (let j = idx + 1; j < tasks.length; j += 1) {
      if (!tasks[j].parallelizable) {
        break;
      }
      batch.push(tasks[j]);
      idx = j;
    }

    const batchResults = await Promise.all(
      batch.map((task) =>
        runSingleFactTask({
          config: params.config,
          task,
          sessionKey: params.sessionKey,
          deadlineMs: params.deadlineMs,
          taskTimeoutMs: params.taskTimeoutMs,
          globalSignal: params.globalSignal,
          resolveFact: params.resolveFact,
        })),
    );
    out.push(...batchResults);
  }

  return out;
}

async function runFactTasks(params: {
  config: OpenClawConfig;
  tasks: FactTask[];
  sessionKey?: string;
  globalTimeoutMs: number;
  taskTimeoutMs: number;
  resolveFact: FactResolverFn;
}): Promise<FactTaskOutcome[]> {
  const deadlineMs = Date.now() + params.globalTimeoutMs;
  const globalController = new AbortController();
  const globalTimer = setTimeout(() => globalController.abort(), params.globalTimeoutMs);
  globalTimer.unref?.();

  try {
    const grouped = new Map<string, FactTask[]>();
    for (const task of params.tasks) {
      const existing = grouped.get(task.batchGroup) ?? [];
      existing.push(task);
      grouped.set(task.batchGroup, existing);
    }

    const groupRuns = Array.from(grouped.values()).map((groupTasks) =>
      runFactTaskGroup({
        config: params.config,
        tasks: groupTasks,
        sessionKey: params.sessionKey,
        deadlineMs,
        taskTimeoutMs: params.taskTimeoutMs,
        globalSignal: globalController.signal,
        resolveFact: params.resolveFact,
      }),
    );

    const groupResults = await Promise.all(groupRuns);
    return groupResults.flat().sort((a, b) => a.task.index - b.task.index);
  } finally {
    clearTimeout(globalTimer);
  }
}

export async function resolveAndEnrichVaultRoute(params: {
  config: OpenClawConfig;
  resolverTool: string;
  requestText: string;
  resolverTimeoutMs: number;
  sessionKey?: string;
  context?: Record<string, unknown>;
  enrichmentGlobalTimeoutMs: number;
  enrichmentTaskTimeoutMs: number;
  deterministicDomains?: string[];
  resolveRoute?: RouteResolverFn;
  resolveFact?: FactResolverFn;
  onAutoFillStart?: (params: {
    tasks: VaultAutoFillTaskHint[];
  }) => void | Promise<void>;
}): Promise<ResolveAndEnrichResult> {
  const startedAt = Date.now();
  const resolveRoute = params.resolveRoute ?? resolveVaultRoute;
  const resolveFact = params.resolveFact ?? resolveFactWithScopedProviders;

  const defaultTelemetry = {
    usedGuidance: false,
    guidanceCount: 0,
    askUserCount: 0,
    autoRetryCount: 0,
    autoRetryAttempted: false,
    factTasksStarted: 0,
    factTasksCompleted: 0,
    factTasksFailed: 0,
    factTasksTimedOut: 0,
    safeTextPrimaryUsed: 0,
    safeTextFallbackUsed: 0,
    safeTextFallbackFailed: 0,
    elapsedMs: 0,
  } satisfies Omit<VaultRouteEnrichmentTelemetry, "elapsedMs"> & { elapsedMs: number };

  const initial = await resolveRoute({
    config: params.config,
    resolverTool: params.resolverTool,
    requestText: params.requestText,
    timeoutMs: params.resolverTimeoutMs,
    sessionKey: params.sessionKey,
    context: params.context,
  });

  if (initial.failure || !initial.payload || initial.payload.status !== "RESOLVED_MISSING_INPUTS") {
    return {
      ...initial,
      telemetry: {
        ...defaultTelemetry,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  const guidance = normalizeGuidance(initial.payload);
  if (guidance.length === 0) {
    return {
      ...initial,
      telemetry: {
        ...defaultTelemetry,
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  const autoRetry = guidance.filter((entry) => entry.resolution_mode === "AUTO_RETRY_WITH_FACTS");
  const askUser = guidance.filter((entry) => entry.resolution_mode !== "AUTO_RETRY_WITH_FACTS");
  const progressMode = normalizeProgressMode(initial.payload);
  const progressHintAllowsAutoEnrich =
    progressMode === "AUTO_ENRICH_AND_RETRY" || progressMode === "PARTIAL_AUTO_ENRICH_THEN_ASK_USER";
  const shouldAttemptAutoRetry =
    autoRetry.length > 0 && (progressHintAllowsAutoEnrich || askUser.length === 0);
  const syntheticSubjectTask = shouldAttemptAutoRetry
    ? undefined
    : buildSyntheticSubjectFactTask({
      payload: initial.payload,
      guidance,
      index: autoRetry.length,
      requestText: params.requestText,
    });

  if (!shouldAttemptAutoRetry && !syntheticSubjectTask) {
    return {
      ...initial,
      telemetry: {
        ...defaultTelemetry,
        usedGuidance: true,
        guidanceCount: guidance.length,
        askUserCount: askUser.length,
        autoRetryCount: autoRetry.length,
        fallbackToUserReason: askUser.length > 0 ? "ask_user_guidance_present" : "no_auto_retry_guidance",
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  const factTasks = shouldAttemptAutoRetry
    ? autoRetry
      .map((entry, index) => buildFactTask(entry, index))
      .filter((entry): entry is FactTask => Boolean(entry))
    : syntheticSubjectTask
      ? [syntheticSubjectTask]
      : [];
  const effectiveAutoRetryCount = autoRetry.length + (syntheticSubjectTask ? 1 : 0);
  const deterministicDomains = params.deterministicDomains ?? [];

  if (factTasks.length === 0) {
    return {
      ...initial,
      telemetry: {
        ...defaultTelemetry,
        usedGuidance: true,
        guidanceCount: guidance.length,
        askUserCount: askUser.length,
        autoRetryCount: effectiveAutoRetryCount,
        autoRetryAttempted: true,
        fallbackToUserReason: "no_valid_fact_tasks",
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  if (!isDomainDeterministic(initial.payload.domain, deterministicDomains)) {
    return {
      ...initial,
      telemetry: {
        ...defaultTelemetry,
        usedGuidance: true,
        guidanceCount: guidance.length,
        askUserCount: askUser.length,
        autoRetryCount: effectiveAutoRetryCount,
        autoRetryAttempted: false,
        failureReasonCodes: ["domain_not_deterministic"],
        fallbackToUserReason: "domain_not_deterministic",
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  params.onAutoFillStart?.({
    tasks: factTasks.map((task) => ({
      factKey: task.factKey,
      inputKey: task.inputKey,
      kind: task.kind,
      instructions: task.instructions,
      requestText: task.requestText,
    })),
  });

  const taskOutcomes = await runFactTasks({
    config: params.config,
    tasks: factTasks,
    sessionKey: params.sessionKey,
    globalTimeoutMs: params.enrichmentGlobalTimeoutMs,
    taskTimeoutMs: params.enrichmentTaskTimeoutMs,
    resolveFact,
  });

  const facts: Record<string, unknown> = {};
  for (const outcome of taskOutcomes) {
    if (outcome.status === "completed") {
      facts[outcome.task.factKey] = outcome.value;
    }
  }
  const failureReasonCodes = collectFailureReasonCodes(taskOutcomes);
  const safeTextEvents = collectSafeTextEvents(taskOutcomes);

  const completedCount = taskOutcomes.filter((outcome) => outcome.status === "completed").length;
  const failedCount = taskOutcomes.filter((outcome) => outcome.status === "failed").length;
  const timedOutCount = taskOutcomes.filter((outcome) => outcome.status === "timed_out").length;

  if (completedCount === 0) {
    return {
      ...initial,
      telemetry: {
        ...defaultTelemetry,
        usedGuidance: true,
        guidanceCount: guidance.length,
        askUserCount: askUser.length,
        autoRetryCount: effectiveAutoRetryCount,
        autoRetryAttempted: true,
        factTasksStarted: factTasks.length,
        factTasksCompleted: completedCount,
        factTasksFailed: failedCount,
        factTasksTimedOut: timedOutCount,
        safeTextPrimaryUsed: safeTextEvents.safeTextPrimaryUsed,
        safeTextFallbackUsed: safeTextEvents.safeTextFallbackUsed,
        safeTextFallbackFailed: safeTextEvents.safeTextFallbackFailed,
        failureReasonCodes: failureReasonCodes.length > 0 ? failureReasonCodes : undefined,
        fallbackToUserReason: failureReasonCodes[0] ?? "no_facts_resolved",
        elapsedMs: Date.now() - startedAt,
      },
    };
  }

  const retry = await resolveRoute({
    config: params.config,
    resolverTool: params.resolverTool,
    requestText: params.requestText,
    timeoutMs: params.resolverTimeoutMs,
    sessionKey: params.sessionKey,
    context: mergeContextWithFacts(params.context, facts),
  });

  return {
    ...retry,
    telemetry: {
      ...defaultTelemetry,
      usedGuidance: true,
      guidanceCount: guidance.length,
      askUserCount: askUser.length,
      autoRetryCount: effectiveAutoRetryCount,
      autoRetryAttempted: true,
      factTasksStarted: factTasks.length,
      factTasksCompleted: completedCount,
      factTasksFailed: failedCount,
      factTasksTimedOut: timedOutCount,
      safeTextPrimaryUsed: safeTextEvents.safeTextPrimaryUsed,
      safeTextFallbackUsed: safeTextEvents.safeTextFallbackUsed,
      safeTextFallbackFailed: safeTextEvents.safeTextFallbackFailed,
      failureReasonCodes: failureReasonCodes.length > 0 ? failureReasonCodes : undefined,
      retryStatus: retry.payload?.status,
      fallbackToUserReason:
        retry.payload?.status === "RESOLVED_MISSING_INPUTS" ? "retry_still_missing_inputs" : undefined,
      elapsedMs: Date.now() - startedAt,
    },
  };
}
