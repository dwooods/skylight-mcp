const FEED_URL = /^(https?|webcals?):\/\//i;

/**
 * Subscription feed addresses (published iCloud calendars, league schedules
 * with a user id in the query) work like passwords: anyone holding the URL can
 * read the calendar. Tool output goes to assistants and logs, so only the scheme
 * and host are kept. Anything that is not an http, https, webcal or webcals URL
 * is returned unchanged.
 */
export function redactFeedUrl(value: string): string {
  const trimmed = value.trim();
  if (!FEED_URL.test(trimmed)) return value;
  const scheme = (/^[a-z]+/i.exec(trimmed) as RegExpExecArray)[0].toLowerCase();
  try {
    // URL() does not parse webcal: hosts the same way on every runtime, so
    // parse as https and keep the original scheme for display.
    const host = new URL(trimmed.replace(/^[a-z]+:/i, "https:")).hostname;
    return `${scheme}://${host}/... (feed address hidden)`;
  } catch {
    return "(feed address hidden)";
  }
}
