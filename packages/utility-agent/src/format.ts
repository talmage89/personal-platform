import type { Flag } from "@platform/agent-core";

/**
 * Display helpers. Pure, so the awkward cases — a window that crosses midnight,
 * a cost too small to render at two decimals — are pinned by tests rather than
 * discovered on the page.
 */

/** Costs here are often fractions of a cent; two decimals would show "$0.00". */
export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}

export function formatCount(value: number): string {
  return value.toLocaleString("en-US");
}

export function formatTokens(value: number): string {
  if (value < 1_000) return String(value);
  if (value < 1_000_000) return `${(value / 1_000).toFixed(1)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

const hhmm = (date: Date): string => date.toISOString().slice(11, 16);
const ymd = (date: Date): string => date.toISOString().slice(0, 10);

/**
 * A window as a single line. Same-day windows print the date once; a window
 * that crosses midnight prints both dates, because "22:00 – 02:00" alone reads
 * as a four-hour span on one day rather than one that straddles two.
 */
export function formatWindow(start: Date, end: Date): string {
  if (ymd(start) === ymd(end)) return `${ymd(start)} ${hhmm(start)}–${hhmm(end)} UTC`;
  return `${ymd(start)} ${hhmm(start)} – ${ymd(end)} ${hhmm(end)} UTC`;
}

export function formatDuration(start: Date, end: Date): string {
  const minutes = Math.round((end.getTime() - start.getTime()) / 60_000);
  if (minutes < 60) return `${minutes}m`;
  const hours = minutes / 60;
  return Number.isInteger(hours) ? `${hours}h` : `${hours.toFixed(1)}h`;
}

/** Windows with a concern sort above quiet ones when a person is scanning. */
export function worstSeverity(flags: Flag[]): "concern" | "notice" | null {
  if (flags.some((f) => f.severity === "concern")) return "concern";
  if (flags.length > 0) return "notice";
  return null;
}

export function relativeAge(from: Date, now: Date): string {
  const minutes = Math.round((now.getTime() - from.getTime()) / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
