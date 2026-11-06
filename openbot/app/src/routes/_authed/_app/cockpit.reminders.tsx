import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { Chip, CockpitProblem, External } from "@/components/cockpit/parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Separator } from "@/components/ui/separator";
import { cockpitProjectsQueryOptions } from "@/lib/cockpit/queries";
import {
  actOnReminder,
  addReminder,
  dueFromLocal,
  type ReminderItem,
  type Repeat,
  remindersKeys,
  remindersQueryOptions,
  testNotification,
} from "@/lib/cockpit/reminders";

/** Your reminders and the automatic ones (CI red, PR waiting), with the notification status. */
export const Route = createFileRoute("/_authed/_app/cockpit/reminders")({
  component: CockpitReminders,
});

const when = (t: number) =>
  new Date(t * 1000).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });

function ReminderRow({ item, run }: { item: ReminderItem; run: (task: () => Promise<{ ok: boolean; message: string | null }>) => Promise<void> }) {
  const auto = item.kind === "auto";
  const snooze = (seconds: number) => () => run(() => actOnReminder(item.id, "snooze", Math.floor(Date.now() / 1000) + seconds));
  return (
    <div className="flex flex-wrap items-start gap-3 px-4 py-3">
      <div className="type-sub min-w-0 flex-1">
        <div className="font-medium">{item.text}</div>
        <div className="type-caption text-muted-foreground">
          {item.project ? `${item.project} · ` : ""}
          {auto ? "automatic" : when(item.due)}
          {item.repeat !== "none" ? ` · ${item.repeat}` : ""}
          {item.link ? (
            <>
              {" · "}
              {item.link.startsWith("/") ? (
                <a className="underline-offset-2 hover:underline" href={item.link}>
                  open
                </a>
              ) : (
                <External href={item.link}>open</External>
              )}
            </>
          ) : null}
        </div>
      </div>
      <Chip tone={item.state === "due" ? "warn" : "plain"}>{item.state}</Chip>
      <div className="flex gap-2">
        {/* Done on an automatic one hides it until its condition clears and comes back. */}
        <Button onClick={() => void run(() => actOnReminder(item.id, "done"))} size="sm" variant="outline">
          Done
        </Button>
        <Button onClick={() => void snooze(3600)()} size="sm" variant="outline">
          Snooze 1 h
        </Button>
        <Button onClick={() => void snooze(86_400)()} size="sm" variant="outline">
          1 day
        </Button>
        {!auto ? (
          <Button onClick={() => void run(() => actOnReminder(item.id, "delete"))} size="sm" variant="outline">
            Delete
          </Button>
        ) : null}
      </div>
    </div>
  );
}

function AddForm({ run }: { run: (task: () => Promise<{ ok: boolean; message: string | null }>) => Promise<void> }) {
  const projects = useQuery(cockpitProjectsQueryOptions());
  const [text, setText] = useState("");
  const [due, setDue] = useState("");
  const [project, setProject] = useState("");
  const [repeat, setRepeat] = useState<Repeat>("none");
  const dueSeconds = dueFromLocal(due);
  const ok = text.trim().length > 0 && text.length <= 200 && dueSeconds !== null;
  return (
    <form
      className="flex flex-col gap-3 px-4 py-3"
      onSubmit={(e) => {
        e.preventDefault();
        if (!ok || dueSeconds === null) return;
        void run(async () => {
          const out = await addReminder({ text, due: dueSeconds, project, repeat });
          if (out.ok) setText("");
          return out;
        });
      }}
    >
      <Input aria-label="Reminder" maxLength={200} onChange={(e) => setText(e.target.value)} placeholder="What to remember" value={text} />
      <div className="flex flex-wrap gap-2">
        <Input aria-label="Due" className="w-auto" onChange={(e) => setDue(e.target.value)} type="datetime-local" value={due} />
        <select aria-label="Project" className="type-sub rounded-md border border-border bg-background px-2" onChange={(e) => setProject(e.target.value)} value={project}>
          <option value="">No project</option>
          {(projects.data?.projects ?? []).map((p) => (
            <option key={p.name} value={p.name}>{p.name}</option>
          ))}
        </select>
        <select aria-label="Repeat" className="type-sub rounded-md border border-border bg-background px-2" onChange={(e) => setRepeat(e.target.value as Repeat)} value={repeat}>
          <option value="none">Once</option>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
        </select>
        <Button disabled={!ok} type="submit">Add</Button>
      </div>
    </form>
  );
}

function CockpitReminders() {
  const queryClient = useQueryClient();
  const { data, error, isPending } = useQuery(remindersQueryOptions());
  const [message, setMessage] = useState<string | null>(null);

  async function run(task: () => Promise<{ ok: boolean; message: string | null }>) {
    setMessage(null);
    try {
      const out = await task();
      if (!out.ok) setMessage(out.message);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : "Cockpit is off.");
    }
    await queryClient.invalidateQueries({ queryKey: remindersKeys.all });
  }

  return (
    <PageShell
      backButton={{ label: "Cockpit", linkProps: { to: "/cockpit/projects" } }}
      description="Things you asked to remember, and automatic ones when CI stays red or a PR waits."
      title="Reminders"
    >
      {message ? <p className="type-sub mt-4" role="alert">{message}</p> : null}
      {error ? (
        <CockpitProblem error={error} />
      ) : isPending ? (
        <PageEmpty>Loading…</PageEmpty>
      ) : (
        <>
          {data.configError || data.storeError ? (
            <p className="type-sub mt-4 text-red-700 dark:text-red-400" role="alert">{data.configError ?? data.storeError}</p>
          ) : null}
          <PageSection title="New reminder">
            <PageRows><AddForm run={run} /></PageRows>
          </PageSection>
          <PageSection title={`Reminders (${data.items.length})`}>
            {data.items.length === 0 ? (
              <PageEmpty>Nothing to remember.</PageEmpty>
            ) : (
              <PageRows>
                {data.items.map((item, i) => (
                  <Fragment key={item.id}>
                    {i > 0 ? <Separator /> : null}
                    <ReminderRow item={item} run={run} />
                  </Fragment>
                ))}
              </PageRows>
            )}
          </PageSection>
          <PageSection title="Notifications">
            <PageRows>
              <div className="type-sub flex flex-wrap items-center gap-3 px-4 py-3">
                <Chip tone={data.notifications.enabled ? "good" : "plain"}>
                  {data.notifications.enabled ? "on" : "off"}
                </Chip>
                <span className="min-w-0 flex-1 text-muted-foreground">
                  {data.notifications.enabled
                    ? `${data.notifications.quietNow ? "Quiet hours now. " : ""}${data.notifications.lastSentAt ? `Last sent ${when(data.notifications.lastSentAt)}.` : "None sent yet."}`
                    : "Enable them in cockpit-config.json. The test button still works."}
                </span>
                <Button onClick={() => void run(() => testNotification())} size="sm" variant="outline">
                  Send a test
                </Button>
              </div>
            </PageRows>
          </PageSection>
          <p className="type-caption mt-6 text-muted-foreground">
            <Link to="/cockpit/quality">Quality</Link> · <Link to="/cockpit/projects">Projects</Link>
          </p>
        </>
      )}
    </PageShell>
  );
}
