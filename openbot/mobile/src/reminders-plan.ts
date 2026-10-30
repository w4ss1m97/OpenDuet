/** Which local notifications the phone should hold. Pure, so it is tested without a device. */

/** One Duet item as `GET /api/openduet/items` returns it. */
export type Item = {
  id: string;
  kind: string;
  title: string;
  why: string | null;
  dueAt: string | null;
  remindAt: string[];
  amount: number | null;
  currency: string;
  status: "proposed" | "active" | "done" | "dismissed";
};

export type PlannedReminder = {
  id: string;
  itemId: string;
  at: Date;
  title: string;
  body: string;
};

/** iOS keeps at most 64 scheduled local notifications per app. */
export const MAX_SCHEDULED = 64;
export const WINDOW_DAYS = 14;

const dayMonth = new Intl.DateTimeFormat("fr-FR", {
  timeZone: "Europe/Paris",
  day: "2-digit",
  month: "2-digit",
});

function bodyOf(item: Item): string {
  const due = item.dueAt ? `échéance ${dayMonth.format(new Date(item.dueAt))}` : null;
  if (item.amount !== null) {
    const amount = `${item.amount.toFixed(2).replace(".", ",")} ${item.currency === "EUR" ? "€" : item.currency}`;
    return due ? `${amount} — ${due}` : amount;
  }
  return item.why ?? due ?? "Duet";
}

export function planReminders(items: Item[], now: Date): PlannedReminder[] {
  const until = now.getTime() + WINDOW_DAYS * 24 * 3600_000;
  return items
    .filter((item) => item.status === "active")
    .flatMap((item) =>
      item.remindAt.map((iso) => {
        const at = new Date(iso);
        return { id: `${item.id}:${at.toISOString()}`, itemId: item.id, at, title: item.title, body: bodyOf(item) };
      }),
    )
    .filter((r) => r.at.getTime() > now.getTime() && r.at.getTime() <= until)
    .sort((a, b) => a.at.getTime() - b.at.getTime())
    .slice(0, MAX_SCHEDULED);
}
