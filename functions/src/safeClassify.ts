/**
 * Runs a classifyX Anthropic call and falls back to `fallback` instead of
 * throwing if it fails — a rate limit, timeout, or billing issue on the
 * Anthropic side shouldn't take down the whole webhook. Matches the
 * "no automated reply" design already documented in the README: a failed
 * classification should look the same as "not confident enough" to the
 * caller, not surface as a 500 and trigger Twilio retries for a request
 * that will never succeed.
 */
export async function safeClassify<T>(logLabel: string, fallback: T, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (err) {
    console.error(`${logLabel}: classification call failed`, err);
    return fallback;
  }
}
