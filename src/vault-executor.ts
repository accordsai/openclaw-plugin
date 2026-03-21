import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { parseApprovalRequiredResult } from "./approval-payload.js";
import {
  extractToolData,
  extractToolEnvelope,
  extractToolError,
  invokeGatewayTool,
  isToolSuccess,
  type VaultGatewayError,
} from "./vault-gateway-client.js";
import type { ResolverPayload } from "./vault-resolver-client.js";

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

function readMissingInputs(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  const out: string[] = [];
  for (const entry of value) {
    if (typeof entry === "string") {
      const normalized = entry.trim();
      if (normalized) {
        out.push(normalized);
      }
      continue;
    }
    const record = asRecord(entry);
    if (!record) {
      continue;
    }
    const candidate = readString(record.input_key) ?? readString(record.inputKey);
    if (candidate) {
      out.push(candidate);
    }
  }
  return Array.from(new Set(out));
}

function isPlanPayload(value: Record<string, unknown>): boolean {
  if (readString(value.type) === "connector.execution.plan.v1") {
    return true;
  }
  return Array.isArray(value.steps) && readString(value.start_step_id) !== undefined;
}

type ToolCallResult = {
  toolName: string;
  envelope: Record<string, unknown>;
  data: Record<string, unknown>;
};

type ApprovalRequiredOutcome = {
  kind: "approval_required";
  toolName: string;
  envelope: Record<string, unknown>;
};

type SuccessOutcome = {
  kind: "success";
  summary: string;
  envelope: Record<string, unknown>;
};

type ErrorOutcome = {
  kind: "error";
  message: string;
  code?: string;
};

type MissingInputsOutcome = {
  kind: "missing_inputs";
  missingInputs: string[];
};

export type VaultExecutionOutcome =
  | ApprovalRequiredOutcome
  | SuccessOutcome
  | ErrorOutcome
  | MissingInputsOutcome;

async function callTool(params: {
  config: OpenClawConfig;
  toolName: string;
  args: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs: number;
}): Promise<ToolCallResult> {
  const invoked = await invokeGatewayTool({
    config: params.config,
    tool: params.toolName,
    args: params.args,
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
  });

  const envelope = extractToolEnvelope(invoked);
  const data = extractToolData(envelope);
  return {
    toolName: params.toolName,
    envelope,
    data,
  };
}

function toErrorFromEnvelope(envelope: Record<string, unknown>): ErrorOutcome {
  const parsed = parseApprovalRequiredResult(envelope);
  if (parsed.type === "approval") {
    return {
      kind: "error",
      message: "internal parser mismatch: approval should have been handled separately",
    };
  }
  const error = extractToolError(envelope);
  return {
    kind: "error",
    code: error.code,
    message: error.message ?? "tool execution failed",
  };
}

function extractSummary(data: Record<string, unknown>): string {
  const response = asRecord(data.response);
  const fields: string[] = [];

  const status =
    readString(response?.status) ??
    readString(data.status) ??
    readString(asRecord(data.job)?.status);
  if (status) {
    fields.push(`status=${status}`);
  }

  const runId =
    readString(data.run_id) ??
    readString(response?.run_id) ??
    readString(asRecord(data.run)?.id);
  if (runId) {
    fields.push(`run_id=${runId}`);
  }

  const jobId =
    readString(data.job_id) ??
    readString(response?.job_id) ??
    readString(asRecord(data.job)?.id);
  if (jobId) {
    fields.push(`job_id=${jobId}`);
  }

  const draftId =
    readString(data.draft_id) ??
    readString(response?.draft_id) ??
    readString(asRecord(response?.output)?.draft_id);
  if (draftId) {
    fields.push(`draft_id=${draftId}`);
  }

  return fields.join(", ");
}

function maybeApprovalResult(toolName: string, envelope: Record<string, unknown>): ApprovalRequiredOutcome | undefined {
  if (isToolSuccess(envelope)) {
    return undefined;
  }
  const parsed = parseApprovalRequiredResult(envelope);
  if (parsed.type === "approval" || parsed.type === "invalid") {
    return {
      kind: "approval_required",
      toolName,
      envelope,
    };
  }
  return undefined;
}

function toGatewayError(error: unknown): ErrorOutcome {
  const record = error as VaultGatewayError;
  const code = typeof record?.code === "string" ? record.code : undefined;
  return {
    kind: "error",
    code,
    message: record?.message ?? String(error),
  };
}

function buildConnectorRequestFromRecipe(entry: Record<string, unknown>): Record<string, unknown> {
  const request = asRecord(entry.request) ?? {};
  const payload: Record<string, unknown> = {
    connector_id: readString(entry.connector_id),
    verb: readString(entry.verb),
    policy_version: readString(entry.policy_version) ?? "1",
    request,
  };

  const queryAst = asRecord(entry.query_ast_v1);
  if (queryAst) {
    payload.query_ast_v1 = queryAst;
  }

  return payload;
}

function buildConnectorRequestFromResolved(payload: ResolverPayload): Record<string, unknown> {
  const execution = payload.execution ?? {};
  const inputs = payload.inputs ?? {};
  const requestObj: Record<string, unknown> = {};
  if (readString(inputs.method)) {
    requestObj.method = readString(inputs.method);
  } else {
    requestObj.method = "GET";
  }
  if (readString(inputs.url)) {
    requestObj.url = readString(inputs.url);
  }
  if (asRecord(inputs.headers)) {
    requestObj.headers = asRecord(inputs.headers);
  }
  if (asRecord(inputs.body_json)) {
    requestObj.body_json = asRecord(inputs.body_json);
  }

  return {
    connector_id: readString(execution.connector_id),
    verb: readString(execution.verb),
    policy_version: "1",
    request: requestObj,
  };
}

async function runPlanExecute(params: {
  config: OpenClawConfig;
  plan: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs: number;
  orchestration?: Record<string, unknown>;
}): Promise<VaultExecutionOutcome> {
  const validate = await callTool({
    config: params.config,
    toolName: "vaultclaw_plan_validate",
    args: {
      plan: params.plan,
    },
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
  });
  if (!isToolSuccess(validate.envelope)) {
    return maybeApprovalResult(validate.toolName, validate.envelope) ?? toErrorFromEnvelope(validate.envelope);
  }

  const executeArgs: Record<string, unknown> = {
    plan: params.plan,
  };
  if (params.orchestration && Object.keys(params.orchestration).length > 0) {
    executeArgs.orchestration = params.orchestration;
  }

  const execute = await callTool({
    config: params.config,
    toolName: "vaultclaw_plan_execute",
    args: executeArgs,
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
  });

  const approval = maybeApprovalResult(execute.toolName, execute.envelope);
  if (approval) {
    return approval;
  }
  if (!isToolSuccess(execute.envelope)) {
    return toErrorFromEnvelope(execute.envelope);
  }

  return {
    kind: "success",
    summary: extractSummary(execute.data),
    envelope: execute.envelope,
  };
}

async function runConnectorExecute(params: {
  config: OpenClawConfig;
  request: Record<string, unknown>;
  sessionKey?: string;
  timeoutMs: number;
  orchestration?: Record<string, unknown>;
}): Promise<VaultExecutionOutcome> {
  const validate = await callTool({
    config: params.config,
    toolName: "vaultclaw_connector_validate",
    args: {
      request: params.request,
    },
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
  });
  if (!isToolSuccess(validate.envelope)) {
    return maybeApprovalResult(validate.toolName, validate.envelope) ?? toErrorFromEnvelope(validate.envelope);
  }

  const executeArgs: Record<string, unknown> = {
    request: params.request,
  };
  if (params.orchestration && Object.keys(params.orchestration).length > 0) {
    executeArgs.orchestration = params.orchestration;
  }

  const execute = await callTool({
    config: params.config,
    toolName: "vaultclaw_connector_execute_job",
    args: executeArgs,
    sessionKey: params.sessionKey,
    timeoutMs: params.timeoutMs,
  });

  const approval = maybeApprovalResult(execute.toolName, execute.envelope);
  if (approval) {
    return approval;
  }
  if (!isToolSuccess(execute.envelope)) {
    return toErrorFromEnvelope(execute.envelope);
  }

  return {
    kind: "success",
    summary: extractSummary(execute.data),
    envelope: execute.envelope,
  };
}

export async function executeResolvedVaultRoute(params: {
  config: OpenClawConfig;
  payload: ResolverPayload;
  sessionKey?: string;
  timeoutMs: number;
}): Promise<VaultExecutionOutcome> {
  try {
    if (params.payload.status === "RESOLVED_MISSING_INPUTS") {
      return {
        kind: "missing_inputs",
        missingInputs: params.payload.missing_inputs ?? [],
      };
    }

    const execution = params.payload.execution ?? {};
    const orchestration = asRecord(execution.orchestration);

    if (execution.strategy === "CONNECTOR_EXECUTE_JOB") {
      const request = buildConnectorRequestFromResolved(params.payload);
      return await runConnectorExecute({
        config: params.config,
        request,
        sessionKey: params.sessionKey,
        timeoutMs: params.timeoutMs,
        orchestration,
      });
    }

    if (execution.strategy === "PLAN_EXECUTE") {
      const inputs = params.payload.inputs ?? {};
      const plan = asRecord(inputs.plan);
      if (!plan) {
        return {
          kind: "error",
          message: "resolver returned PLAN_EXECUTE without a plan payload",
        };
      }
      return await runPlanExecute({
        config: params.config,
        plan,
        sessionKey: params.sessionKey,
        timeoutMs: params.timeoutMs,
        orchestration,
      });
    }

    if (execution.strategy === "RECIPE") {
      const route = params.payload.route ?? {};
      const cookbookID = readString(route.cookbook_id);
      const entryID = readString(route.entry_id);
      if (!cookbookID || !entryID) {
        return {
          kind: "error",
          message: "resolver returned RECIPE without cookbook_id/entry_id",
        };
      }

      const recipe = await callTool({
        config: params.config,
        toolName: "vaultclaw_recipe_get",
        args: {
          cookbook_id: cookbookID,
          recipe_id: entryID,
          version: readString(route.version),
        },
        sessionKey: params.sessionKey,
        timeoutMs: params.timeoutMs,
      });
      if (!isToolSuccess(recipe.envelope)) {
        return maybeApprovalResult(recipe.toolName, recipe.envelope) ?? toErrorFromEnvelope(recipe.envelope);
      }

      const entry = asRecord(recipe.data.entry);
      if (!entry) {
        return {
          kind: "error",
          message: "vaultclaw_recipe_get returned malformed entry",
        };
      }

      const entryType = readString(entry.entry_type) ?? readString(route.entry_type) ?? "";
      if (entryType === "recipe.plan.v1") {
        const plan = asRecord(entry.plan);
        if (!plan) {
          return {
            kind: "error",
            message: "recipe.plan.v1 entry is missing plan payload",
          };
        }
        return await runPlanExecute({
          config: params.config,
          plan,
          sessionKey: params.sessionKey,
          timeoutMs: params.timeoutMs,
          orchestration,
        });
      }

      if (entryType === "recipe.verb.v1") {
        const request = buildConnectorRequestFromRecipe(entry);
        return await runConnectorExecute({
          config: params.config,
          request,
          sessionKey: params.sessionKey,
          timeoutMs: params.timeoutMs,
          orchestration,
        });
      }

      return {
        kind: "error",
        message: `unsupported recipe entry_type: ${entryType || "unknown"}`,
      };
    }

    if (execution.strategy === "TEMPLATE") {
      const route = params.payload.route ?? {};
      const cookbookID = readString(route.cookbook_id);
      const templateID = readString(route.entry_id);
      if (!cookbookID || !templateID) {
        return {
          kind: "error",
          message: "resolver returned TEMPLATE without cookbook_id/entry_id",
        };
      }

      const recipe = await callTool({
        config: params.config,
        toolName: "vaultclaw_recipe_get",
        args: {
          cookbook_id: cookbookID,
          recipe_id: templateID,
          version: readString(route.version),
        },
        sessionKey: params.sessionKey,
        timeoutMs: params.timeoutMs,
      });
      if (!isToolSuccess(recipe.envelope)) {
        return maybeApprovalResult(recipe.toolName, recipe.envelope) ?? toErrorFromEnvelope(recipe.envelope);
      }

      const render = await callTool({
        config: params.config,
        toolName: "vaultclaw_template_render",
        args: {
          cookbook_id: cookbookID,
          template_id: templateID,
          version: readString(route.version),
          inputs: params.payload.inputs ?? {},
        },
        sessionKey: params.sessionKey,
        timeoutMs: params.timeoutMs,
      });
      if (!isToolSuccess(render.envelope)) {
        return maybeApprovalResult(render.toolName, render.envelope) ?? toErrorFromEnvelope(render.envelope);
      }

      const missingFromRender = readMissingInputs(render.data.missing_inputs);
      if (missingFromRender.length > 0) {
        return {
          kind: "missing_inputs",
          missingInputs: missingFromRender,
        };
      }

      const rendered = asRecord(render.data.rendered);
      if (!rendered) {
        return {
          kind: "error",
          message: "vaultclaw_template_render returned malformed rendered payload",
        };
      }

      const outputKind =
        readString(asRecord(render.data.source_ref)?.output_kind) ??
        readString(asRecord(render.data.sourceRef)?.output_kind);

      if ((outputKind && outputKind.toUpperCase() === "PLAN") || isPlanPayload(rendered)) {
        return await runPlanExecute({
          config: params.config,
          plan: rendered,
          sessionKey: params.sessionKey,
          timeoutMs: params.timeoutMs,
          orchestration,
        });
      }

      return await runConnectorExecute({
        config: params.config,
        request: rendered,
        sessionKey: params.sessionKey,
        timeoutMs: params.timeoutMs,
        orchestration,
      });
    }

    return {
      kind: "error",
      message: `unsupported resolver strategy: ${execution.strategy ?? "unknown"}`,
    };
  } catch (error) {
    return toGatewayError(error);
  }
}
