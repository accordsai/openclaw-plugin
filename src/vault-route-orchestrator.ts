import type { OpenClawConfig } from "openclaw/plugin-sdk";
import {
  extractToolData,
  extractToolEnvelope,
  extractToolError,
  invokeGatewayTool,
  isToolSuccess,
  type VaultGatewayError,
} from "./vault-gateway-client.js";
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
  | { status: "completed"; task: FactTask; value: unknown }
  | { status: "failed"; task: FactTask; reason: string }
  | { status: "timed_out"; task: FactTask; reason: string };

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
    kind: compact(readString(request?.kind)),
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
    kind: "email_subject",
    instructions: "Draft a concise email subject for the user's request.",
    requestText: params.requestText,
    batchGroup: "synthetic_subject",
    parallelizable: true,
    rawRequest: {
      fact_key: factKey,
      kind: "email_subject",
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

function buildFactResolverPrompt(task: FactTask): string {
  const extra = shallowClone(task.rawRequest);
  delete extra.fact_key;
  delete extra.kind;
  delete extra.parallelizable;
  delete extra.batch_group;
  delete extra.instructions;
  delete extra.request_text;

  const lines = [
    "Resolve one missing fact for vault route enrichment.",
    `fact_key: ${task.factKey}`,
  ];
  if (task.inputKey) {
    lines.push(`input_key: ${task.inputKey}`);
  }
  if (task.kind) {
    lines.push(`kind: ${task.kind}`);
  }
  if (task.instructions) {
    lines.push(`instructions: ${task.instructions}`);
  }
  if (task.requestText) {
    lines.push(`request_text: ${task.requestText}`);
  }
  if (Object.keys(extra).length > 0) {
    lines.push(`context: ${JSON.stringify(extra)}`);
  }
  lines.push(`Return only JSON: {"${task.factKey}": <value_or_null>}. No markdown.`);
  return lines.join("\n");
}

function readFactValueFromRecord(record: Record<string, unknown>, factKey: string): unknown {
  if (Object.prototype.hasOwnProperty.call(record, factKey)) {
    return record[factKey];
  }

  const factKeyInRecord = readString(record.fact_key) ?? readString(record.factKey);
  if (factKeyInRecord && factKeyInRecord === factKey) {
    if (Object.prototype.hasOwnProperty.call(record, "value")) {
      return record.value;
    }
    if (Object.prototype.hasOwnProperty.call(record, "fact_value")) {
      return record.fact_value;
    }
    if (Object.prototype.hasOwnProperty.call(record, "factValue")) {
      return record.factValue;
    }
  }

  const response = asRecord(record.response);
  if (response) {
    const nested = readFactValueFromRecord(response, factKey);
    if (nested !== undefined) {
      return nested;
    }
  }

  const output = asRecord(record.output);
  if (output) {
    const nested = readFactValueFromRecord(output, factKey);
    if (nested !== undefined) {
      return nested;
    }
  }

  return undefined;
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

function extractFactValue(data: Record<string, unknown>, factKey: string): unknown {
  const direct = readFactValueFromRecord(data, factKey);
  if (direct !== undefined) {
    return normalizeFactValue(direct);
  }

  const reply = data.reply;
  if (typeof reply === "string") {
    const parsed = parseJsonObject(reply);
    if (parsed && Object.prototype.hasOwnProperty.call(parsed, factKey)) {
      return parsed[factKey];
    }
    return reply.trim();
  }
  const replyRecord = asRecord(reply);
  if (replyRecord) {
    const nested = readFactValueFromRecord(replyRecord, factKey);
    if (nested !== undefined) {
      return normalizeFactValue(nested);
    }
  }

  const result = asRecord(data.result);
  if (result) {
    const nested = readFactValueFromRecord(result, factKey);
    if (nested !== undefined) {
      return normalizeFactValue(nested);
    }
  }

  return undefined;
}

function toGatewayError(error: unknown): string {
  const parsed = error as VaultGatewayError;
  if (typeof parsed?.message === "string" && parsed.message.trim().length > 0) {
    return parsed.message;
  }
  return String(error);
}

async function resolveFactViaSessionsSend(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  task: FactTask;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const timeoutSeconds = Math.max(1, Math.ceil(Math.max(params.timeoutMs, 1000) / 1000));
  const targetSession = params.sessionKey ?? "main";

  const invoked = await invokeGatewayTool({
    config: params.config,
    tool: "sessions_send",
    args: {
      sessionKey: targetSession,
      message: buildFactResolverPrompt(params.task),
      timeoutSeconds,
    },
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
    signal: params.signal,
  });

  const envelope = extractToolEnvelope(invoked);
  if (!isToolSuccess(envelope)) {
    const error = extractToolError(envelope);
    throw new Error(error.message ?? "sessions_send returned failure");
  }
  const data = extractToolData(envelope);
  return extractFactValue(data, params.task.factKey);
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
  const now = Date.now();
  if (now >= params.deadlineMs || params.globalSignal.aborted) {
    return {
      status: "timed_out",
      task: params.task,
      reason: `fact task timed out for ${params.task.factKey}`,
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
        }),
    });
    if (result.status === "timed_out") {
      return {
        status: "timed_out",
        task: params.task,
        reason: result.reason,
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
      };
    }

    return {
      status: "completed",
      task: params.task,
      value: normalized,
    };
  } catch (error) {
    if (signal.aborted || params.globalSignal.aborted) {
      return {
        status: "timed_out",
        task: params.task,
        reason: `fact task timed out for ${params.task.factKey}`,
      };
    }
    return {
      status: "failed",
      task: params.task,
      reason: toGatewayError(error),
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
  resolveRoute?: RouteResolverFn;
  resolveFact?: FactResolverFn;
  onAutoFillStart?: (params: {
    tasks: VaultAutoFillTaskHint[];
  }) => void | Promise<void>;
}): Promise<ResolveAndEnrichResult> {
  const startedAt = Date.now();
  const resolveRoute = params.resolveRoute ?? resolveVaultRoute;
  const resolveFact = params.resolveFact ?? resolveFactViaSessionsSend;

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
      factTasksCompleted: taskOutcomes.filter((outcome) => outcome.status === "completed").length,
      factTasksFailed: taskOutcomes.filter((outcome) => outcome.status === "failed").length,
      factTasksTimedOut: taskOutcomes.filter((outcome) => outcome.status === "timed_out").length,
      retryStatus: retry.payload?.status,
      fallbackToUserReason:
        retry.payload?.status === "RESOLVED_MISSING_INPUTS" ? "retry_still_missing_inputs" : undefined,
      elapsedMs: Date.now() - startedAt,
    },
  };
}
