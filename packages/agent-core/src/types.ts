/**
 * The vocabulary shared by the reader and the writer.
 *
 * Nothing here names a cloud project, dataset, or bucket. Those arrive from the
 * environment at runtime — see config.ts — because this repository is public and
 * the location of the logs is not something worth publishing.
 */

/** One model call, flattened from a trace and its observations. */
export interface Call {
  traceId: string;
  at: Date;
  model: string;
  provider: string;
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  costUsd: number;
  /** `DEFAULT` unless the provider flagged it. */
  level: string;
  statusCode: string | null;
  finishReason: string | null;
  /** The request payload, already truncated. Never assume it is complete. */
  inputExcerpt: string;
}

/** A half-open window: `[start, end)`. */
export interface Window {
  start: Date;
  end: Date;
}

export type FlagSeverity = "notice" | "concern";

/**
 * `Flag` and `ModelUsage` below are type aliases rather than interfaces on
 * purpose: both are written straight into Prisma `Json` columns, and only a
 * type alias gets the implicit index signature that `InputJsonValue` demands.
 * Converting either to an interface reintroduces a type error at the upsert.
 */

/**
 * A deterministic observation about a window.
 *
 * Flags are computed by `stats.ts` from arithmetic alone, before any model sees
 * a byte. That ordering is the point: the numbers are reproducible and auditable
 * on their own, and the model's job is to explain them rather than to find them.
 */
export type Flag = {
  code: string;
  severity: FlagSeverity;
  /** Rendered directly in the UI, so it has to read as a sentence. */
  detail: string;
};

export type ModelUsage = {
  model: string;
  calls: number;
  costUsd: number;
  totalTokens: number;
};

/** Everything derivable from the calls in a window without asking a model. */
export interface WindowStats {
  window: Window;
  callCount: number;
  costUsd: number;
  totalTokens: number;
  errorCount: number;
  /** Median prompt size. The reference point a later window compares itself to. */
  medianPromptTokens: number;
  models: ModelUsage[];
  flags: Flag[];
}

/** A finished summary: the arithmetic, plus prose describing it. */
export interface Summary extends WindowStats {
  narrative: string;
}

/** Trailing context used to decide whether a window is unusual. */
export interface Baseline {
  /** Median calls per hour over the comparison period. */
  callsPerHour: number;
  /** Median cost per hour, USD. */
  costPerHour: number;
  /** Median prompt tokens per call — the loop detector's reference point. */
  promptTokens: number;
  /** How many hours the medians were taken over. Zero means "no history yet". */
  hours: number;
}
