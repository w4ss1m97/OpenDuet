import * as Notifications from "expo-notifications";
import * as SecureStore from "expo-secure-store";
import { api } from "./api";
import { type Item, planReminders } from "./reminders-plan";

/**
 * Duet's reminders as local notifications, so they fire while the Mac that runs Duet is off. Each
 * sync replaces what the phone holds with the next 14 days of reminders. "Fait" and "Plus tard"
 * work from the notification; when the server cannot be reached they wait here for the next sync.
 */

export const ITEM_CATEGORY = "duet-item";
const PENDING_KEY = "duet.pendingActions";

type PendingAction = { itemId: string; action: "done" | "snooze" };

export async function registerItemCategory() {
  await Notifications.setNotificationCategoryAsync(ITEM_CATEGORY, [
    { identifier: "done", buttonTitle: "Fait", options: { opensAppToForeground: false } },
    { identifier: "snooze", buttonTitle: "Plus tard (1 h)", options: { opensAppToForeground: false } },
  ]);
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
      body: { minutes: 60 },
    });
}

/** Applies a notification button now, or keeps it for the next sync when offline. */
export async function applyItemAction(action: PendingAction) {
  try {
    await send(action);
  } catch {
    await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify([...(await readPending()), action]));
  }
}

async function replayPending() {
  const pending = await readPending();
  const left: PendingAction[] = [];
  for (const action of pending) {
    try {
      await send(action);
    } catch {
      left.push(action);
    }
  }
  await SecureStore.setItemAsync(PENDING_KEY, JSON.stringify(left));
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
  if (action === "done" || action === "snooze")
    void applyItemAction({ itemId: data.duetItemId, action });
  return true;
}
