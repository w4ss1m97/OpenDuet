/*
 * One macOS notification through the fixed osascript script. Title and body arrive as `item n of argv`
 * (data after `--`), never inside the script, so no text can become AppleScript. Control characters are
 * stripped and the lengths capped here; the allowlist in run.ts refuses any other osascript call.
 */
import { OSASCRIPT_HEAD, type RunDeps, runAllowed } from "./run";

const TITLE_MAX = 80;
const BODY_MAX = 240;

export const cleanNotificationText = (text: string, max: number): string =>
  text.replace(/\p{Cc}/gu, " ").replace(/\s+/g, " ").trim().slice(0, max);

export type Notifier = { send(title: string, body: string): Promise<boolean> };

export function createNotifier(deps: RunDeps = {}): Notifier {
  return {
    async send(title, body) {
      const argv = [...OSASCRIPT_HEAD, cleanNotificationText(title, TITLE_MAX), cleanNotificationText(body, BODY_MAX)];
      return (await runAllowed(argv, deps)) !== null;
    },
  };
}
