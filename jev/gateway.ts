/**
 * Vercel AI Gateway client for Jev (Issue #13, live path).
 *
 * TypeSafe AI's `typesafe-ai/jev` is an EVALUATION model, not a language model:
 * the gateway rejects it on /v1/chat/completions with "Model ... is an
 * evaluation model, not a language model. Use the evaluation generation API
 * instead." Its API is `POST /v1/evaluate`, and it takes structured state plus
 * typed questions and answers them with choices and probabilities:
 *
 *   { model, state: <any JSON>, questions: { <id>: {
 *       type: "choice",            // choice | score | boolean
 *       instructions: "...",
 *       criteria: { <optionId>: "<what this option means>" }   // a record
 *   } } }
 *   -> { answers: { <id>: { type: "choice", choice: "<optionId>",
 *                           probabilities: {...} } },
 *        usage: { inputTokens, outputTokens }, ... }
 *
 * ## Why this client only asks CHOICE questions
 *
 * The policy surface is bounded on purpose (see jev/schema.ts), so every
 * question here is a choice between a handful of named buckets, and THIS FILE
 * owns the mapping from bucket to number. The model never emits a raw number,
 * which means it cannot emit one out of range: even a confused answer lands
 * inside the bounds and is validated once more by the adapter's parser.
 *
 * Two citywide questions are always asked (switching hint, global pressure).
 * Per-corridor and per-region questions are asked for the busiest few only,
 * capped, so the prompt stays small and the model is not asked to have opinions
 * about quiet streets.
 */
import type { JevPolicyRequest } from "./schema";
import {
  JEV_HINTS,
  JEV_LIMITS,
  JEV_SCHEMA_VERSION,
  clampWeight,
  type JevHint,
  type JevIntent,
  type JevIntentEntry,
  type JevPolicy,
} from "./schema";
import type { JevClient } from "./client";

/** Verified against the live gateway (see the file header). */
export const JEV_GATEWAY_ENDPOINT = "https://ai-gateway.vercel.sh/v1/evaluate";
export const JEV_GATEWAY_MODEL = "typesafe-ai/jev";

/**
 * Buckets the model chooses from, and the exact number each one means. These
 * are the ONLY numbers a gateway answer can produce, and every one of them sits
 * inside JEV_LIMITS.
 */
export const JEV_PRESSURE_BUCKETS = {
  relaxed: 0.75,
  steady: 1,
  assertive: 1.25,
  urgent: 1.5,
} as const;

export const JEV_WEIGHT_BUCKETS = {
  low: 0.5,
  normal: 1,
  high: 1.5,
  top: 2,
} as const;

/**
 * Coordinated zone intents (shipping pass). These are the questions that let the
 * model ask for a CITYWIDE move instead of only re-weighting what it can see:
 * "drain" releases a corridor/region, "meter" throttles entry to it. The answer
 * is a choice, the strength comes from the weight bucket already asked for the
 * same zone, and both ends are clamped by the schema.
 */
export const JEV_INTENT_MEANINGS: Record<"none" | JevIntent, string> = {
  none: "no coordinated action: let each intersection decide locally",
  drain: "release this zone: intersections serving it should switch sooner so traffic can leave",
  meter: "throttle this zone: intersections serving it should hold longer so upstream absorbs demand",
};

const PRESSURE_MEANINGS: Record<keyof typeof JEV_PRESSURE_BUCKETS, string> = {
  relaxed: "ease off: let the city settle, accept longer waits",
  steady: "keep the present balance between phases",
  assertive: "push throughput, serve queues more decisively",
  urgent: "the city is badly congested: prioritise clearing queues",
};

const WEIGHT_MEANINGS: Record<keyof typeof JEV_WEIGHT_BUCKETS, string> = {
  low: "serve it last, it is not the constraint",
  normal: "serve it like the rest of the city",
  high: "serve it ahead of most of the city",
  top: "serve it first, it is the worst bottleneck",
};

/**
 * Confidence policy for evaluation answers.
 *
 * Gateway reports a probability for each choice. An answer we cannot trust
 * must not become a policy opinion, so the selected choice is USABLE only when
 * its probability is a finite number in [0, 1] AND at least
 * `MIN_ANSWER_CONFIDENCE`. An unusable answer is dropped, and the schema's
 * neutral default takes its place: the policy stays valid and bounded, it
 * simply carries no opinion there. If nothing survives, the result is the
 * neutral policy — degraded, never assertive by accident.
 *
 * This is the ONE place the threshold lives. Callers may raise it per client
 * (`minConfidence`), and the route and the benchmark read JEV_MIN_CONFIDENCE
 * from the environment; nothing else in the codebase knows a number.
 */
export const JEV_CONFIDENCE = {
  /** Answers below this never shape a policy. A floor, not a quality bar. */
  MIN_ANSWER_CONFIDENCE: 0.25,
} as const;

/**
 * Whether an answer's confidence is usable. Absent, non-finite or out-of-range
 * confidence is unusable: an unverifiable answer is not an opinion.
 */
export function answerConfidenceUsable(confidence: unknown, minimum: number): boolean {
  return (
    typeof confidence === "number" &&
    Number.isFinite(confidence) &&
    confidence >= 0 &&
    confidence <= 1 &&
    confidence >= minimum
  );
}

const HINT_MEANINGS: Record<JevHint, string> = {
  neutral: "change nothing about switching behaviour",
  "hold-longer": "keep serving the phases that are already winning",
  "switch-sooner": "relinquish greens earlier than usual",
};

export interface GatewayJevClientOptions {
  /** Passed in, never read from the environment here. */
  readonly token: string;
  readonly endpoint?: string;
  readonly model?: string;
  /** How many of the busiest corridors / regions get their own question. */
  readonly corridorQuestions?: number;
  readonly regionQuestions?: number;
  readonly timeoutMs?: number;
  /** Minimum usable confidence per answer; defaults to JEV_CONFIDENCE. */
  readonly minConfidence?: number;
  readonly fetchImpl?: typeof fetch;
}

// Live Gateway verification with the production 18 KB state accepted 8
// questions, but returned 503 for 10 and 12. Keep the default below that
// observed failure boundary; the complete city state is still provided.
export const JEV_GATEWAY_DEFAULT_CORRIDOR_QUESTIONS = 2;
export const JEV_GATEWAY_DEFAULT_REGION_QUESTIONS = 1;
export const JEV_GATEWAY_TIMEOUT_MS = 15_000;

interface EvaluationsQuestion {
  readonly type: "choice";
  readonly instructions: string;
  readonly criteria: Record<string, string>;
}

export interface EvaluationsBody {
  readonly model: string;
  readonly state: unknown;
  readonly questions: Record<string, EvaluationsQuestion>;
}

export type BucketChoice<K extends string> = { readonly [P in K]: number };

/**
 * Ask about the busiest N entries, deterministically: queue depth, then the
 * smaller id. Quiet entries are left out rather than asked about with an
 * obvious answer.
 */
function busiest<T extends { readonly queuedVehicles: number }>(
  entries: readonly T[],
  limit: number,
  idOf: (entry: T) => number,
): T[] {
  return entries
    .filter((entry) => entry.queuedVehicles > 0)
    .slice()
    .sort((a, b) => b.queuedVehicles - a.queuedVehicles || idOf(a) - idOf(b))
    .slice(0, limit);
}

/**
 * Build the evaluation request. Exported so tests can assert the exact shape
 * without a network call, and so a recorded request can be replayed.
 */
export function buildEvaluationsBody(
  request: JevPolicyRequest,
  options: { readonly model?: string; readonly corridorQuestions?: number; readonly regionQuestions?: number } = {},
): EvaluationsBody {
  const questions: Record<string, EvaluationsQuestion> = {
    pressure: {
      type: "choice",
      instructions: "How should citywide signal pressure be adjusted for the next few seconds?",
      criteria: PRESSURE_MEANINGS,
    },
    hint: {
      type: "choice",
      instructions: "How should the controller behave when deciding whether to change phases?",
      criteria: HINT_MEANINGS,
    },
  };

  const intentQuestion = (label: string, zone: string): EvaluationsQuestion => ({
    type: "choice",
    instructions: `${label} ${zone}: should the city coordinate it as a whole, and how?`,
    criteria: JEV_INTENT_MEANINGS,
  });

  for (const corridor of busiest(
    request.corridors,
    options.corridorQuestions ?? JEV_GATEWAY_DEFAULT_CORRIDOR_QUESTIONS,
    (entry) => entry.corridorId,
  )) {
    questions[`corridor:${corridor.corridorId}`] = {
      type: "choice",
      instructions:
        `Corridor ${corridor.corridorId} (${corridor.kind}) has ${corridor.queuedVehicles} vehicles queued ` +
        `and a worst wait of ${Math.round(corridor.maxWaitMs / 1000)}s. How should it be weighted?`,
      criteria: WEIGHT_MEANINGS,
    };
    questions[`corridor-intent:${corridor.corridorId}`] = intentQuestion(
      "Corridor",
      String(corridor.corridorId),
    );
  }

  for (const region of busiest(
    request.regions,
    options.regionQuestions ?? JEV_GATEWAY_DEFAULT_REGION_QUESTIONS,
    (entry) => entry.regionId,
  )) {
    questions[`region:${region.regionId}`] = {
      type: "choice",
      instructions:
        `Region ${region.regionId} has ${region.queuedVehicles} vehicles queued across ` +
        `${region.signalizedIntersections} signals. How should it be weighted?`,
      criteria: WEIGHT_MEANINGS,
    };
    questions[`region-intent:${region.regionId}`] = intentQuestion(
      "Region",
      String(region.regionId),
    );
  }

  return {
    model: options.model ?? JEV_GATEWAY_MODEL,
    state: request,
    questions,
  };
}

interface EvaluationsAnswer {
  readonly type?: string;
  readonly choice?: unknown;
  readonly confidence?: unknown;
  readonly probabilities?: unknown;
}

export interface PolicyTranslationOptions {
  /** Minimum usable confidence for one answer; defaults to JEV_CONFIDENCE. */
  readonly minConfidence?: number;
}

/**
 * Translate the model's answers into a policy object. Every value comes from a
 * bucket table, so the result is always inside the schema's bounds; anything
 * the model answered that we did not ask about, or in a shape we do not
 * recognise, is simply left out (the policy defaults to neutral for it).
 *
 * Kept pure and exported: this is the part worth testing precisely.
 */
export function policyFromEvaluations(
  body: EvaluationsBody,
  response: unknown,
  options: PolicyTranslationOptions = {},
): JevPolicy {
  const answers = (response as { answers?: Record<string, EvaluationsAnswer> } | null)?.answers;
  if (answers === null || typeof answers !== "object") {
    throw new Error("gateway response carried no answers");
  }
  const minConfidence = options.minConfidence ?? JEV_CONFIDENCE.MIN_ANSWER_CONFIDENCE;

  const chosen = (questionId: string): string | null => {
    const answer = answers[questionId];
    if (answer === null || typeof answer !== "object") {
      return null;
    }
    const choice = answer.choice;
    if (typeof choice !== "string") return null;
    // Current Gateway choices report a probability for each option, not a
    // separate confidence. Use the selected option's own probability; only
    // legacy responses without probabilities may use confidence. Missing or
    // malformed evidence stays neutral rather than becoming a policy opinion.
    const probabilities = answer.probabilities;
    const confidence = probabilities === undefined
      ? answer.confidence
      : probabilities !== null && typeof probabilities === "object" && Object.hasOwn(probabilities, choice)
        ? (probabilities as Record<string, unknown>)[choice]
        : undefined;
    return answerConfidenceUsable(confidence, minConfidence) ? choice : null;
  };

  const bucket = <K extends string>(
    table: BucketChoice<K>,
    questionId: string,
  ): number | null => {
    const choice = chosen(questionId);
    return choice !== null && Object.hasOwn(table, choice) ? table[choice as K] : null;
  };

  const corridorWeights: { id: number; weight: number }[] = [];
  const regionWeights: { id: number; weight: number }[] = [];
  const corridorIntents: JevIntentEntry[] = [];
  const regionIntents: JevIntentEntry[] = [];
  for (const questionId of Object.keys(body.questions)) {
    const [kind, rawId] = questionId.split(":");
    if (rawId === undefined) {
      continue;
    }
    const id = Number(rawId);
    if (!Number.isInteger(id)) {
      continue;
    }
    const weight = bucket(JEV_WEIGHT_BUCKETS, questionId);
    if (weight === null) {
      continue;
    }
    if (kind === "corridor") {
      corridorWeights.push({ id, weight });
    } else if (kind === "region") {
      regionWeights.push({ id, weight });
    }
  }
  // Coordinated intents: a named choice per zone, strength from the same zone's
  // weight bucket. Unanswered -> no intent -> the controller stays neutral here.
  for (const [field, bucketMap, into] of [
    ["corridor-intent", corridorWeights, corridorIntents],
    ["region-intent", regionWeights, regionIntents],
  ] as const) {
    for (const entry of bucketMap) {
      const answer = chosen(`${field}:${entry.id}`);
      if (answer !== "drain" && answer !== "meter") {
        continue;
      }
      into.push({
        id: entry.id,
        intent: answer as JevIntent,
        strength: clampWeight(
          entry.weight,
          JEV_LIMITS.INTENT_STRENGTH_MIN,
          JEV_LIMITS.INTENT_STRENGTH_MAX,
        ),
      });
    }
  }
  corridorIntents.sort((a, b) => a.id - b.id);
  regionIntents.sort((a, b) => a.id - b.id);
  corridorWeights.sort((a, b) => a.id - b.id);
  regionWeights.sort((a, b) => a.id - b.id);

  const hint = chosen("hint");
  const pressure = bucket(JEV_PRESSURE_BUCKETS, "pressure");

  return {
    schemaVersion: JEV_SCHEMA_VERSION,
    pressureScale: pressure ?? 1,
    hint: hint !== null && (JEV_HINTS as readonly string[]).includes(hint) ? (hint as JevHint) : "neutral",
    corridorWeights,
    regionWeights,
    corridorIntents,
    regionIntents,
  };
}

/**
 * The client. Same `JevClient` contract as the mock and the generic HTTP one,
 * so the controller and the adapter do not know which is in use.
 */
export function createGatewayJevClient(options: GatewayJevClientOptions): JevClient {
  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  if (typeof fetchImpl !== "function") {
    throw new Error("createGatewayJevClient needs a fetch implementation");
  }
  const endpoint = options.endpoint ?? JEV_GATEWAY_ENDPOINT;
  const model = options.model ?? JEV_GATEWAY_MODEL;
  const timeoutMs = options.timeoutMs ?? JEV_GATEWAY_TIMEOUT_MS;

  return {
    id: "gateway",
    requestPolicy: async (request) => {
      const body = buildEvaluationsBody(request, {
        model,
        corridorQuestions: options.corridorQuestions,
        regionQuestions: options.regionQuestions,
      });
      const response = await fetchImpl(endpoint, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          accept: "application/json",
          authorization: `Bearer ${options.token}`,
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!response.ok) {
        // Status only: an upstream error body can echo credentials back.
        throw new Error(`jev gateway responded ${response.status}`);
      }
      return policyFromEvaluations(body, (await response.json()) as unknown, {
        minConfidence: options.minConfidence,
      });
    },
  };
}
