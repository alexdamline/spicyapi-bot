import { SpicyApiError, SpicyTransportError, type TaskRecord } from "@spicyapi/sdk";
import OpenAI from "openai";
import { InputError } from "./inputs.js";
import type { SpendSnapshot, SpendVerdict } from "./ledger.js";
import type { QuoteDecision } from "./media.js";
import { formatUsd, type Nanos } from "./money.js";

/** Plain-text explanation of a failed API call, safe to show in a chat. */
export function describeError(error: unknown): string {
  if (error instanceof InputError) return error.message;
  if (error instanceof SpicyApiError) {
    const ref = error.requestId ? ` (request ${error.requestId})` : "";
    switch (error.code) {
      case 40201:
        return "The SpicyAPI account behind this bot is out of balance. Nothing was charged.";
      case 40202:
        return "This bot's API key has reached the spend cap set in the SpicyAPI console. Nothing was charged.";
      case 40301:
        return "This bot's API key is not allowed to use that model. Pick another model, or allow it in the SpicyAPI console.";
      case 40310:
        return "The SpicyAPI account behind this bot has not verified its email address yet.";
      case 40004:
        return `That combination of settings is not available right now: ${error.message}`;
      case 50301:
        return "That model is temporarily unavailable. Try again later or pick another model.";
      case 40901:
        return "The price changed while submitting. Nothing was charged; please try again.";
    }
    if (error.status === 401) return "The bot's SpicyAPI key was rejected. The operator needs to check SPICY_API_KEY.";
    if (error.status === 429) {
      const wait = error.retryAfterSeconds ? ` Try again in ${error.retryAfterSeconds}s.` : " Try again shortly.";
      return `Too many requests right now.${wait}`;
    }
    if (error.status === 400) return `The request was not accepted: ${error.message}${ref}`;
    if (error.status >= 500) return `SpicyAPI is having trouble right now. Try again later.${ref}`;
    return `SpicyAPI returned an error: ${error.message}${ref}`;
  }
  if (error instanceof OpenAI.APIError) {
    if (error.code === "content_rejected") return "The model declined to answer that. Try rephrasing, or switch the chat model with /models.";
    if (error.status === 401) return "The bot's SpicyAPI key was rejected. The operator needs to check SPICY_API_KEY.";
    if (error.status === 402) return "The SpicyAPI account behind this bot is out of balance or at its spend cap.";
    if (error.status === 429) return "Too many requests right now. Try again shortly.";
    return `The chat request failed: ${error.message}`;
  }
  if (error instanceof SpicyTransportError) return "Could not reach SpicyAPI. Check the bot's network connection and try again.";
  return "Something went wrong. The operator can find details in the bot's log.";
}

/** Explanation of a failed (not charged) task. */
export function describeFailedTask(task: TaskRecord): string {
  const reason = task.errorMessage ? `\nReason: ${task.errorMessage}` : "";
  switch (task.errorCode) {
    case "content_rejected":
      return `The model declined this request. Try rewording it, or pick another model with /models.${reason}`;
    case "invalid_asset":
      return `The input image could not be used. Try a different image.${reason}`;
    case "rate_limited":
    case "upstream_unavailable":
    case "timeout":
    case "upstream_failed":
      return `The model service had a problem. Try again in a minute.${reason}`;
    default:
      return `Generation failed.${reason}`;
  }
}

export function describeVerdict(verdict: Exclude<SpendVerdict, { ok: true }>): string {
  switch (verdict.reason) {
    case "concurrency":
      return `You already have ${verdict.limit} generation${verdict.limit === 1 ? "" : "s"} running. Wait for one to finish.`;
    case "user_cap":
      return `This would go over your daily limit of ${formatUsd(verdict.limit)} (${formatUsd(verdict.remaining)} left today). Limits reset at 00:00 UTC.`;
    case "global_cap":
      return `This would go over the bot's daily limit of ${formatUsd(verdict.limit)} (${formatUsd(verdict.remaining)} left today). Limits reset at 00:00 UTC.`;
  }
}

/** Why a quoted request is not going ahead. Nothing has been charged at this point. */
export function describeRefusal(decision: QuoteDecision): string {
  if (decision.kind === "too_expensive") {
    return `This would cost up to ${formatUsd(decision.worst)}, above the per-request limit of ${formatUsd(decision.limit)}. Nothing was charged.`;
  }
  if (decision.kind === "over_budget") return `${describeVerdict(decision.verdict)} Nothing was charged.`;
  return `The price changed to ${formatUsd(decision.worst)} since you confirmed. Nothing was charged; send the command again to see the new price.`;
}

export function confirmText(worst: Nanos, modelName: string): string {
  return [
    `${modelName} will cost up to ${formatUsd(worst)}.`,
    "Tap Confirm to start. Once started it cannot be cancelled; failed generations are not charged.",
  ].join("\n");
}

export function elapsedLabel(ms: number): string {
  const seconds = Math.max(0, Math.round(ms / 1000));
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, "0")}s`;
}

export function progressText(state: string, elapsedMs: number, worst: Nanos, modelName: string): string {
  const label = state === "queued" ? "Queued" : state === "running" ? "Generating" : state === "succeeded" ? "Finishing" : state;
  return `${label}... ${elapsedLabel(elapsedMs)}\n${modelName} · up to ${formatUsd(worst)}`;
}

export function resultCaption(modelName: string, charged: Nanos, final: boolean, taskId: string): string {
  return `${modelName} · ${formatUsd(charged)}${final ? "" : " (estimate)"} · task ${taskId}`;
}

export const STILL_RUNNING =
  "This is taking longer than the bot waits. The task is still running and will be billed; the result will be in your SpicyAPI console under Logs.";

export function spendSummary(snap: SpendSnapshot, limits: { userDaily: Nanos; globalDaily: Nanos }, owner: boolean, balance?: string): string {
  const mine = snap.userSettled + snap.userHeld;
  const lines = [
    `Today (UTC ${snap.day}):`,
    `• You: ${formatUsd(mine)}${snap.userHeld > 0 ? ` (incl. ${formatUsd(snap.userHeld)} in progress)` : ""}` +
      (owner ? "" : ` of ${formatUsd(limits.userDaily)}`),
  ];
  if (owner) {
    const all = snap.globalSettled + snap.globalHeld;
    lines.push(`• Whole bot: ${formatUsd(all)} of ${formatUsd(limits.globalDaily)}`);
    if (balance !== undefined) lines.push(`• SpicyAPI balance: ${balance}`);
  }
  lines.push("Limits reset at 00:00 UTC.");
  return lines.join("\n");
}
