/**
 * Credential scrubbing, applied to every prompt excerpt before it leaves this
 * process.
 *
 * Summarising an agent's traffic means reading its prompts, and its prompts
 * contain whatever it was handling — including keys it was given and keys it
 * discovered. Sending that to a third party is an exfiltration path we are
 * building deliberately, so it gets narrowed here rather than trusted to luck.
 *
 * The patterns are prefix-anchored on purpose. A rule like "any forty-character
 * base64 run" would catch more secrets and also destroy most of the legitimate
 * content, leaving a summary written from redaction markers. These match shapes
 * that are only ever credentials.
 */

interface Rule {
  label: string;
  pattern: RegExp;
}

const RULES: Rule[] = [
  { label: "ANTHROPIC_KEY", pattern: /\bsk-ant-[A-Za-z0-9_-]{16,}/g },
  { label: "OPENROUTER_KEY", pattern: /\bsk-or-v?\d*-?[A-Za-z0-9_-]{16,}/g },
  { label: "OPENAI_KEY", pattern: /\bsk-(?:proj-)?[A-Za-z0-9_-]{20,}/g },
  { label: "GITHUB_TOKEN", pattern: /\b(?:ghp|gho|ghs|ghu|ghr)_[A-Za-z0-9]{16,}/g },
  { label: "GITHUB_PAT", pattern: /\bgithub_pat_[A-Za-z0-9_]{20,}/g },
  { label: "GOOGLE_API_KEY", pattern: /\bAIza[A-Za-z0-9_-]{20,}/g },
  { label: "AWS_ACCESS_KEY", pattern: /\b(?:AKIA|ASIA)[A-Z0-9]{16}/g },
  // The HMAC access ids minted for S3-compatible access to cloud storage.
  { label: "HMAC_ACCESS_ID", pattern: /\bGOOG1[A-Z0-9]{20,}/g },
  { label: "SLACK_TOKEN", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { label: "JWT", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
  {
    label: "PRIVATE_KEY",
    pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  },
  { label: "BEARER", pattern: /\bBearer\s+[A-Za-z0-9._~+/-]{20,}=*/g },
  {
    label: "PG_URL",
    pattern: /\bpostgres(?:ql)?:\/\/[^:\s]+:[^@\s]+@[^\s"']+/g,
  },
];

export interface Redaction {
  text: string;
  /** Counts by label, for reporting that redaction happened at all. */
  hits: Record<string, number>;
}

export function redact(input: string): Redaction {
  const hits: Record<string, number> = {};
  let text = input;

  for (const { label, pattern } of RULES) {
    text = text.replace(pattern, () => {
      hits[label] = (hits[label] ?? 0) + 1;
      return `[redacted:${label}]`;
    });
  }

  return { text, hits };
}

/** Redacts many excerpts, merging the hit counts. */
export function redactAll(inputs: string[]): { texts: string[]; hits: Record<string, number> } {
  const hits: Record<string, number> = {};
  const texts = inputs.map((input) => {
    const result = redact(input);
    for (const [label, count] of Object.entries(result.hits)) {
      hits[label] = (hits[label] ?? 0) + count;
    }
    return result.text;
  });

  return { texts, hits };
}
