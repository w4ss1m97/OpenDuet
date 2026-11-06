import { parisDayAt } from "../items/paris-time";

export type Grade = "again" | "hard" | "good";

/** Days until the next review, by box 1..5. */
const INTERVAL_DAYS = [1, 2, 4, 8, 16] as const;

/** Box and due date after a review: again -> box 1, hard -> same, good -> up one (max 5). Due at Paris midnight. */
export function nextReview(box: number, grade: Grade, now: Date): { box: number; dueAt: Date } {
  const next = grade === "again" ? 1 : grade === "hard" ? box : Math.min(box + 1, 5);
  const clamped = Math.min(Math.max(next, 1), 5);
  return { box: clamped, dueAt: parisDayAt(now, INTERVAL_DAYS[clamped - 1], 0) };
}

/** A card is due today when its due_at is before the start of tomorrow in Paris (overdue included). */
export function dueTodayBefore(now: Date): Date {
  return parisDayAt(now, 1, 0);
}
