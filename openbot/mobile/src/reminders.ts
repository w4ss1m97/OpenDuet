import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { api } from "./api";
import {
  type Item,
  planReminders,
  remindersOfItem,
  shouldRetry,
  snoozeMinutesLeft,
} from "./reminders-plan";

/**
 * Duet's reminders as local notifications, so they fire while the Mac that runs Duet is off. Each
 * sync replaces what the phone holds with the next 14 days of reminders. "Fait" and "Plus tard"
 * act on the phone at once and reach the server when it can; offline, they wait for the next sync.
 */

export const ITEM_CATEGORY = "duet-item";
const PENDING_KEY = "duet.pendingActions";

type PendingAction = { itemId: string; action: "done" | "snooze"; tapAt: number };

export async function registerItemCategory() {
  await Notifications.setNotificationCategoryAsync(ITEM_CATEGORY, [
    { identifier: "done", buttonTitle: "Fait", options: { opensAppToForeground: false } },
    { identifier: "snooze", buttonTitle: "Plus tard (1 h)", options: { opensAppToForeground: false } },
  ]);
}

/** One reader-writer of the queue at a time, so a tap during a replay is not written over. */
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(work: () => Promise<T>): Promise<T> {
  const next = queue.then(work, work);
  queue = next.catch(() => {});
  return next;
}

async function readPending(): Promise<PendingAction[]> {
  try {
    return JSON.parse((await SecureStore.getItemAsync(PENDING_KEY)) ?? "[]");
  } catch {
    return [];
  }
}

async function send(action: PendingAction) {
  if (action.action === "done")
    await api(`/api/openduet/items/${encodeURIComponent(action.itemId)}/status`, {
      method: "POST",
      body: { status: "done" },
    });
  else
    await api(`/api/openduet/items/${encodeURIComponent(action.itemId)}/snooze`, {
      method: "POST",
      body: { minutes: snoozeMinutesLeft(action.tapAt, Date.now()) },
    });
}

/** Sends a notification button's action, or keeps it for the next sync when offline. */
export function applyItemAction(action: PendingAction) {
  return serial(async () => {
    try {
      await send(action);
    } catch (error) {
      if (shouldRetry(error))
        await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify([...(await readPending()), action]));
    }
  });
}

function replayPending() {
  return serial(async () => {
    const left: PendingAction[] = [];
    for (const action of await readPending()) {
      try {
        await send(action);
      } catch (error) {
        if (shouldRetry(error)) left.push(action);
      }
    }
    await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(left));
  });
}

/** Acts on the phone at once, so neither button waits for the next sync. */
async function actLocally(
  response: Notifications.NotificationResponse,
  itemId: string,
  action: "done" | "snooze",
) {
  const scheduled = await Notifications.getAllScheduledNotificationsAsync();
  const ids = remindersOfItem(scheduled.map((n) => n.identifier), itemId);
  if (action === "done") {
    await Promise.all(ids.map((id) => Notifications.cancelScheduledNotificationAsync(id)));
    return;
  }
  const at = new Date(Date.now() + 3600_000);
  const content = response.notification.request.content;
  await Notifications.scheduleNotificationAsync({
    identifier: `${itemId}:${at.toISOString()}`,
    content: {
      title: content.title ?? "Duet",
      body: content.body ?? "",
      categoryIdentifier: ITEM_CATEGORY,
      data: { duetItemId: itemId },
    },
    trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: at },
  });
}

/** Fetches active items and reschedules every local reminder. Safe to call on each foreground. */
export async function syncReminders() {
  await replayPending();
  const now = new Date();
  const until = new Date(now.getTime() + 14 * 24 * 3600_000);
  const { items } = await api<{ items: Item[] }>(
    `/api/openduet/items?status=active&remindFrom=${now.toISOString()}&remindTo=${until.toISOString()}`,
  );
  const plan = planReminders(items, now);
  await Notifications.cancelAllScheduledNotificationsAsync();
  for (const reminder of plan)
    await Notifications.scheduleNotificationAsync({
      identifier: reminder.id,
      content: {
        title: reminder.title,
        body: reminder.body,
        categoryIdentifier: ITEM_CATEGORY,
        data: { duetItemId: reminder.itemId },
      },
      trigger: { type: Notifications.SchedulableTriggerInputTypes.DATE, date: reminder.at },
    });
}

/** True when the response came from a Duet item; it is then handled here. */
export function handleItemResponse(response: Notifications.NotificationResponse): boolean {
  const data = response.notification.request.content.data as { duetItemId?: unknown };
  if (typeof data?.duetItemId !== "string") return false;
  const action = response.actionIdentifier;
  if (action === "done" || action === "snooze") {
    void actLocally(response, data.duetItemId, action).catch(() => {});
    void applyItemAction({ itemId: data.duetItemId, action, tapAt: Date.now() });
  }
  return true;
}
