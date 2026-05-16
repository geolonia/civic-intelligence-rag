/**
 * Extract question string from dual API schema:
 *   - genai-web format: { inputs: { question: "..." } }
 *   - existing format:  { query: "..." }
 * Returns null if no valid question found.
 */
export function extractQuestion(body: Record<string, unknown>): string | null {
  const fromInputs = (body.inputs as Record<string, unknown> | undefined)?.question;
  const fromQuery = body.query;
  const question = fromInputs ?? fromQuery;
  if (typeof question !== 'string' || question.trim().length === 0) return null;
  return question.trim();
}

/**
 * Check if sourceIp is permitted by the allow-list.
 * allowedIpsEnv: comma-separated IP string from ALLOWED_IPS env var.
 * Empty string means no restriction (allow all).
 */
export function isIpAllowed(sourceIp: string | undefined, allowedIpsEnv: string): boolean {
  const allowedIps = allowedIpsEnv
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowedIps.length === 0) return true;
  if (!sourceIp) return false;
  return allowedIps.includes(sourceIp);
}
