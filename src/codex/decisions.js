export const APPROVAL_DECISIONS = new Set([
  "accept",
  "acceptForSession",
  "decline",
  "cancel",
]);

export function normalizeDecision(value) {
  return APPROVAL_DECISIONS.has(value) ? value : null;
}
