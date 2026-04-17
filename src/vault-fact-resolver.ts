import type { OpenClawConfig } from "openclaw/plugin-sdk";
import { invokeGatewayOpenResponse, VaultGatewayError } from "./vault-gateway-client.js";

export type FactResolutionFailureReason =
  | "unsupported_fact_kind"
  | "domain_not_deterministic"
  | "safe_text_unavailable"
  | "weather_fetch_failed";

export class VaultFactResolutionError extends Error {
  readonly reasonCode: FactResolutionFailureReason;

  constructor(params: { reasonCode: FactResolutionFailureReason; message: string }) {
    super(params.message);
    this.name = "VaultFactResolutionError";
    this.reasonCode = params.reasonCode;
  }
}

export type ScopedFactTask = {
  inputKey?: string;
  factKey: string;
  kind?: string;
  instructions?: string;
  requestText?: string;
  rawRequest: Record<string, unknown>;
};

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

function toLower(value: string | undefined): string {
  return value?.trim().toLowerCase() ?? "";
}

function stripTrailingPunctuation(value: string): string {
  return value.replace(/[)\],.!?;:]+$/g, "");
}

function extractExplicitURL(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = text.match(/https?:\/\/[^\s<>"'`]+/i);
  if (!match?.[0]) {
    return undefined;
  }
  return stripTrailingPunctuation(match[0].trim());
}

function extractLocationHint(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const normalized = text.trim();
  const weatherIn = normalized.match(/\bweather(?:\s+for|\s+in)?\s+([a-z0-9 ,.'-]+?)(?:\s+(?:today|tomorrow|tonight|this week)\b|$)/i);
  if (weatherIn?.[1]) {
    return weatherIn[1].trim();
  }
  const inLocation = normalized.match(/\bin\s+([a-z0-9 ,.'-]+?)(?:\s+(?:today|tomorrow|tonight|this week)\b|$)/i);
  if (inLocation?.[1]) {
    return inLocation[1].trim();
  }
  return undefined;
}

function extractTimeframeHint(text: string | undefined): string | undefined {
  if (!text) {
    return undefined;
  }
  const match = text.match(/\b(today|tomorrow|tonight|this week)\b/i);
  return match?.[1]?.trim();
}

function normalizeTimeframe(value: string | undefined): "today" | "tomorrow" {
  const normalized = toLower(value);
  if (normalized.includes("tomorrow")) {
    return "tomorrow";
  }
  return "today";
}

function weatherLabelForCode(code: number | undefined): string {
  switch (code) {
    case 0:
      return "clear";
    case 1:
    case 2:
      return "partly cloudy";
    case 3:
      return "overcast";
    case 45:
    case 48:
      return "foggy";
    case 51:
    case 53:
    case 55:
      return "drizzle";
    case 56:
    case 57:
      return "freezing drizzle";
    case 61:
    case 63:
    case 65:
      return "rain";
    case 66:
    case 67:
      return "freezing rain";
    case 71:
    case 73:
    case 75:
      return "snow";
    case 77:
      return "snow grains";
    case 80:
    case 81:
    case 82:
      return "rain showers";
    case 85:
    case 86:
      return "snow showers";
    case 95:
      return "thunderstorm";
    case 96:
    case 99:
      return "thunderstorm with hail";
    default:
      return "mixed conditions";
  }
}

function locationLabel(geoRow: Record<string, unknown>): string {
  const parts = [
    readString(geoRow.name),
    readString(geoRow.admin1),
    readString(geoRow.country_code),
  ].filter((entry): entry is string => Boolean(entry));
  return parts.length > 0 ? parts.join(", ") : "the requested location";
}

async function readJSONFromURL(params: {
  url: URL;
  signal: AbortSignal;
  failureMessage: string;
}): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(params.url, {
      method: "GET",
      signal: params.signal,
      headers: {
        accept: "application/json",
      },
    });
  } catch (error) {
    throw new VaultFactResolutionError({
      reasonCode: "weather_fetch_failed",
      message: `${params.failureMessage}: ${String(error)}`,
    });
  }

  if (!response.ok) {
    throw new VaultFactResolutionError({
      reasonCode: "weather_fetch_failed",
      message: `${params.failureMessage}: HTTP ${response.status}`,
    });
  }

  const parsed = await response
    .json()
    .catch(() => undefined);
  const record = asRecord(parsed);
  if (!record) {
    throw new VaultFactResolutionError({
      reasonCode: "weather_fetch_failed",
      message: `${params.failureMessage}: malformed JSON payload`,
    });
  }
  return record;
}

async function resolveWeatherFact(params: {
  task: ScopedFactTask;
  signal: AbortSignal;
}): Promise<string> {
  const raw = params.task.rawRequest;
  const location =
    readString(raw.location) ??
    extractLocationHint(params.task.requestText) ??
    extractLocationHint(readString(raw.request_text));
  if (!location) {
    throw new VaultFactResolutionError({
      reasonCode: "weather_fetch_failed",
      message: "missing location for weather fact",
    });
  }

  const timeframe = normalizeTimeframe(
    readString(raw.timeframe) ??
      extractTimeframeHint(params.task.requestText) ??
      extractTimeframeHint(readString(raw.request_text)),
  );

  const geoURL = new URL("https://geocoding-api.open-meteo.com/v1/search");
  geoURL.searchParams.set("name", location);
  geoURL.searchParams.set("count", "1");
  geoURL.searchParams.set("language", "en");
  geoURL.searchParams.set("format", "json");

  const geocodePayload = await readJSONFromURL({
    url: geoURL,
    signal: params.signal,
    failureMessage: "weather geocoding failed",
  });

  const geoRows = Array.isArray(geocodePayload.results) ? geocodePayload.results : [];
  const firstGeo = asRecord(geoRows[0]);
  const latitude = typeof firstGeo?.latitude === "number" ? firstGeo.latitude : undefined;
  const longitude = typeof firstGeo?.longitude === "number" ? firstGeo.longitude : undefined;
  if (latitude === undefined || longitude === undefined) {
    throw new VaultFactResolutionError({
      reasonCode: "weather_fetch_failed",
      message: "no matching coordinates found for weather location",
    });
  }

  const forecastURL = new URL("https://api.open-meteo.com/v1/forecast");
  forecastURL.searchParams.set("latitude", String(latitude));
  forecastURL.searchParams.set("longitude", String(longitude));
  forecastURL.searchParams.set("timezone", "auto");
  forecastURL.searchParams.set("temperature_unit", "fahrenheit");
  forecastURL.searchParams.set("current", "temperature_2m,weather_code");
  forecastURL.searchParams.set("daily", "weather_code,temperature_2m_max,temperature_2m_min");

  const forecastPayload = await readJSONFromURL({
    url: forecastURL,
    signal: params.signal,
    failureMessage: "weather forecast fetch failed",
  });

  const label = locationLabel(firstGeo ?? {});
  if (timeframe === "tomorrow") {
    const daily = asRecord(forecastPayload.daily) ?? {};
    const dailyCodes = Array.isArray(daily.weather_code) ? daily.weather_code : [];
    const dailyHighs = Array.isArray(daily.temperature_2m_max) ? daily.temperature_2m_max : [];
    const dailyLows = Array.isArray(daily.temperature_2m_min) ? daily.temperature_2m_min : [];
    const code = typeof dailyCodes[1] === "number" ? dailyCodes[1] : undefined;
    const high = typeof dailyHighs[1] === "number" ? dailyHighs[1] : undefined;
    const low = typeof dailyLows[1] === "number" ? dailyLows[1] : undefined;
    if (high === undefined || low === undefined) {
      throw new VaultFactResolutionError({
        reasonCode: "weather_fetch_failed",
        message: "tomorrow weather data unavailable",
      });
    }
    return `Tomorrow in ${label}: ${weatherLabelForCode(code)}, high ${Math.round(high)}F, low ${Math.round(low)}F.`;
  }

  const current = asRecord(forecastPayload.current) ?? {};
  const temp = typeof current.temperature_2m === "number" ? current.temperature_2m : undefined;
  const code = typeof current.weather_code === "number" ? current.weather_code : undefined;
  if (temp === undefined) {
    throw new VaultFactResolutionError({
      reasonCode: "weather_fetch_failed",
      message: "current weather data unavailable",
    });
  }
  return `Current weather in ${label}: ${Math.round(temp)}F and ${weatherLabelForCode(code)}.`;
}

function stripCodeFences(text: string): string {
  const trimmed = text.trim();
  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i);
  if (fenced?.[1]) {
    return fenced[1].trim();
  }
  return trimmed;
}

function parseSafeTextFact(text: string, factKey: string): unknown {
  const cleaned = stripCodeFences(text);
  if (!cleaned) {
    return undefined;
  }
  try {
    const parsed = JSON.parse(cleaned) as unknown;
    const parsedRecord = asRecord(parsed);
    if (parsedRecord && Object.prototype.hasOwnProperty.call(parsedRecord, factKey)) {
      return parsedRecord[factKey];
    }
  } catch {
    // ignore and return raw text below
  }
  return cleaned;
}

function extractOpenResponseText(body: Record<string, unknown>): string | undefined {
  const direct = readString(body.output_text);
  if (direct) {
    return direct;
  }

  const output = Array.isArray(body.output) ? body.output : [];
  for (const item of output) {
    const row = asRecord(item);
    if (!row) {
      continue;
    }
    const content = Array.isArray(row.content) ? row.content : [];
    for (const part of content) {
      const partRow = asRecord(part);
      if (!partRow) {
        continue;
      }
      const text = readString(partRow.text) ?? readString(asRecord(partRow.output_text)?.text);
      if (text) {
        return text;
      }
    }
  }

  return undefined;
}

function buildSafeTextPrompt(task: ScopedFactTask): string {
  const factKey = task.factKey.trim();
  const kind = toLower(task.kind);

  const baseInstruction = (() => {
    if (kind === "email_subject_generation" || toLower(factKey).includes("subject")) {
      return "Generate a concise email subject line in plain text.";
    }
    if (kind === "email_body_generation" || toLower(factKey).includes("body")) {
      return "Generate a concise email body in plain text.";
    }
    return "Generate a concise plain-text value for the missing fact.";
  })();

  const lines = [
    "Resolve one missing fact for deterministic Vault route enrichment.",
    baseInstruction,
    `fact_key: ${factKey}`,
  ];
  if (task.instructions) {
    lines.push(`instructions: ${task.instructions}`);
  }
  if (task.requestText) {
    lines.push(`request_text: ${task.requestText}`);
  }
  lines.push(`Return only JSON: {"${factKey}":"<value>"}. No markdown.`);
  return lines.join("\n");
}

function resolveAgentModel(sessionKey: string | undefined): string {
  const match = sessionKey?.match(/^agent:([^:]+):/);
  const agentID = match?.[1]?.trim();
  if (agentID) {
    return `agent:${agentID}`;
  }
  return "agent:main";
}

function isSafeTextFact(task: ScopedFactTask): boolean {
  const kind = toLower(task.kind);
  const factKey = toLower(task.factKey);
  if (kind === "email_subject_generation" || kind === "email_body_generation") {
    return true;
  }
  if (kind === "email_subject" || kind === "email_body") {
    return true;
  }
  return factKey === "email_subject" || factKey === "email_body";
}

async function resolveSafeTextFact(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  task: ScopedFactTask;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const prompt = buildSafeTextPrompt(params.task);
  let responseBody: Record<string, unknown>;
  try {
    const response = await invokeGatewayOpenResponse({
      config: params.config,
      body: {
        model: resolveAgentModel(params.sessionKey),
        input: prompt,
        stream: false,
        tool_choice: "none",
        max_output_tokens: 280,
      },
      timeoutMs: params.timeoutMs,
      signal: params.signal,
    });
    responseBody = response.body;
  } catch (error) {
    if (error instanceof VaultGatewayError && error.code === "RESPONSES_ENDPOINT_UNAVAILABLE") {
      throw new VaultFactResolutionError({
        reasonCode: "safe_text_unavailable",
        message: "safe text generation endpoint is unavailable",
      });
    }
    throw new VaultFactResolutionError({
      reasonCode: "safe_text_unavailable",
      message: `safe text generation failed: ${String(error)}`,
    });
  }

  const outputText = extractOpenResponseText(responseBody);
  if (!outputText) {
    throw new VaultFactResolutionError({
      reasonCode: "safe_text_unavailable",
      message: "safe text generation returned no output",
    });
  }
  return parseSafeTextFact(outputText, params.task.factKey);
}

function resolveConnectorInputFact(task: ScopedFactTask): unknown {
  const inputKey = toLower(task.inputKey ?? task.factKey);
  if (inputKey !== "url") {
    throw new VaultFactResolutionError({
      reasonCode: "unsupported_fact_kind",
      message: `unsupported connector input generation fact: ${inputKey || "unknown"}`,
    });
  }

  const candidates = [
    readString(task.rawRequest.url),
    task.requestText,
    readString(task.rawRequest.request_text),
    task.instructions,
  ];
  for (const candidate of candidates) {
    const url = extractExplicitURL(candidate);
    if (url) {
      return url;
    }
  }

  throw new VaultFactResolutionError({
    reasonCode: "unsupported_fact_kind",
    message: "unable to deterministically resolve URL from request text",
  });
}

export async function resolveFactWithScopedProviders(params: {
  config: OpenClawConfig;
  sessionKey?: string;
  task: ScopedFactTask;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<unknown> {
  const kind = toLower(params.task.kind);
  const factKey = toLower(params.task.factKey);

  if (kind === "weather_forecast" || factKey === "weather_summary") {
    return await resolveWeatherFact({
      task: params.task,
      signal: params.signal,
    });
  }

  if (kind === "connector_input_generation") {
    return resolveConnectorInputFact(params.task);
  }

  if (isSafeTextFact(params.task)) {
    return await resolveSafeTextFact(params);
  }

  throw new VaultFactResolutionError({
    reasonCode: "unsupported_fact_kind",
    message: `unsupported external fact kind: ${params.task.kind ?? params.task.factKey}`,
  });
}
