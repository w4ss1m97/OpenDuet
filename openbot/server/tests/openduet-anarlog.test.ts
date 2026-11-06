import { afterAll, beforeAll, expect, test } from "bun:test";
import { chmodSync, mkdtempSync, realpathSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AnarlogError, createAnarlogCli } from "../src/openduet/missions/anarlog";

/** The Anarlog CLI adapter, against small fake executables (never the real CLI). */

let dir: string;
beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "anarlog-test-"));
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function fake(name: string, script: string): string {
  const path = join(dir, name);
  writeFileSync(path, `#!/bin/sh\n${script}\n`);
  chmodSync(path, 0o755);
  return path;
}

const envelope = (command: string, data: unknown, pagination?: unknown) =>
  JSON.stringify({ schema_version: "1", command, data, ...(pagination ? { pagination } : {}) });

const listJson = envelope(
  "meetings.list",
  [
    { id: "m_1", title: "Entretien", started_at: "2026-11-02T13:00:00Z", ended_at: "2026-11-02T14:00:00Z", extra: 1 },
  ],
  { offset: 0, limit: 50, returned: 1, next_offset: null },
);

test("no bin, a relative bin or a missing file disables the adapter", () => {
  expect(createAnarlogCli(undefined)).toBeNull();
  expect(createAnarlogCli("")).toBeNull();
  expect(createAnarlogCli("anarlog-cli")).toBeNull();
  expect(createAnarlogCli("./anarlog-cli")).toBeNull();
  expect(createAnarlogCli(join(dir, "does-not-exist"))).toBeNull();
  expect(createAnarlogCli(dir)).toBeNull();
});

test("argv is passed without a shell, with --json, a minimal env and a fixed cwd", async () => {
  const out = join(dir, "argv.txt");
  const bin = fake(
    "argv",
    `{ for a in "$@"; do echo "ARG:$a"; done; echo "CWD:$PWD"; env | sort; } > '${out}'\nprintf '%s' '${listJson}'`,
  );
  const cli = createAnarlogCli(bin);
  expect(cli).not.toBeNull();
  const meetings = await cli!.listMeetings(new Date("2026-11-01T00:00:00Z"));
  expect(meetings).toEqual([
    {
      id: "m_1",
      title: "Entretien",
      startedAt: new Date("2026-11-02T13:00:00Z"),
      endedAt: new Date("2026-11-02T14:00:00Z"),
    },
  ]);
  const log = readFileSync(out, "utf8");
  const args = log.split("\n").filter((l) => l.startsWith("ARG:"));
  expect(args.slice(0, 3)).toEqual(["ARG:--json", "ARG:meetings", "ARG:list"]);
  const envKeys = log
    .split("\n")
    .filter((l) => /^[A-Za-z_][A-Za-z0-9_]*=/.test(l))
    .map((l) => l.split("=")[0])
    .filter((k) => !["PWD", "SHLVL", "_", "OLDPWD"].includes(k as string));
  expect(envKeys.sort()).toEqual(["HOME", "PATH"]);
  expect(log).toContain(`CWD:${realpathSync(tmpdir())}`);
});

test("getMeeting returns participants' emails and whether the transcript is ready", async () => {
  const get = (extra: Record<string, unknown>) =>
    envelope("meetings.get", {
      id: "m_1",
      title: "Entretien",
      started_at: "2026-11-02T13:00:00Z",
      ended_at: "2026-11-02T14:00:00Z",
      participants: [{ email: "RH@Acme.fr", display_name: "RH" }, { display_name: "no mail" }],
      ...extra,
    });
  const ready = createAnarlogCli(fake("get-ready", `printf '%s' '${get({ processing_status: null })}'`))!;
  expect(await ready.getMeeting("m_1")).toEqual({
    id: "m_1",
    title: "Entretien",
    startedAt: new Date("2026-11-02T13:00:00Z"),
    endedAt: new Date("2026-11-02T14:00:00Z"),
    participantEmails: ["rh@acme.fr"],
    transcriptReady: true,
  });
  const done = createAnarlogCli(fake("get-done", `printf '%s' '${get({ processing_status: "done" })}'`))!;
  expect((await done.getMeeting("m_1")).transcriptReady).toBe(true);
  const busy = createAnarlogCli(fake("get-busy", `printf '%s' '${get({ processing_status: "transcribing" })}'`))!;
  expect((await busy.getMeeting("m_1")).transcriptReady).toBe(false);
});

test("an error envelope becomes a typed AnarlogError with its code", async () => {
  const bin = fake(
    "err",
    `echo '{"error":{"code":"database_not_found","exit_code":3,"message":"nope"},"schema_version":"1"}' >&2\nexit 3`,
  );
  const err = await createAnarlogCli(bin)!.getMeeting("m_1").catch((e) => e);
  expect(err).toBeInstanceOf(AnarlogError);
  expect(err.code).toBe("database_not_found");
});

test("garbage output, an unexpected shape or a failing exit without envelope are typed errors", async () => {
  for (const [name, script] of [
    ["garbage", `echo 'not json'`],
    ["shape", `printf '%s' '{"schema_version":"1","command":"meetings.get","data":{"id":5}}'`],
    ["empty", `exit 1`],
  ] as const) {
    const err = await createAnarlogCli(fake(name, script))!.getMeeting("m_1").catch((e) => e);
    expect(err).toBeInstanceOf(AnarlogError);
  }
});

test("a call that outlives its timeout is killed and raises a typed error", async () => {
  const bin = fake("slow", `exec sleep 30`);
  const started = Date.now();
  const err = await createAnarlogCli(bin, { callTimeoutMs: 300 })!.getMeeting("m_1").catch((e) => e);
  expect(err).toBeInstanceOf(AnarlogError);
  expect(err.code).toBe("timeout");
  expect(Date.now() - started).toBeLessThan(5000);
});

test("stdout beyond the cap is refused", async () => {
  const bin = fake("huge", `yes aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa | head -c 200000`);
  const err = await createAnarlogCli(bin, { maxStdoutBytes: 10_000 })!.getMeeting("m_1").catch((e) => e);
  expect(err).toBeInstanceOf(AnarlogError);
  expect(err.code).toBe("output_too_large");
});

test("a meeting id that could be an option or carry odd characters never reaches argv", async () => {
  const out = join(dir, "never.txt");
  const bin = fake("never", `echo called > '${out}'\nexit 0`);
  const cli = createAnarlogCli(bin)!;
  for (const id of ["--help", "-x", "", "a b", "a;b", "../x", "a$(x)"]) {
    expect(await cli.getMeeting(id).catch((e) => e)).toBeInstanceOf(AnarlogError);
    expect(await cli.transcript(id, new Date(Date.now() + 5000)).catch((e) => e)).toBeInstanceOf(AnarlogError);
  }
  expect(() => readFileSync(out)).toThrow();
});

const page = (text: string, next: number | null, offset: number) =>
  envelope("meetings.transcript", { meeting_id: "m_1", text, words: [] }, { offset, limit: 500, returned: 1, next_offset: next });

test("transcript pages 500 words at a time and joins them", async () => {
  const log = join(dir, "pages.txt");
  const bin = fake(
    "pages",
    `echo "$*" >> '${log}'\noff=0\nwhile [ $# -gt 0 ]; do [ "$1" = "--offset" ] && off=$2; shift; done\n` +
      `if [ "$off" = 0 ]; then printf '%s' '${page("un deux", 500, 0)}'; else printf '%s' '${page("trois", null, 500)}'; fi`,
  );
  const result = await createAnarlogCli(bin)!.transcript("m_1", new Date(Date.now() + 10_000));
  expect(result).toEqual({ text: "un deux trois", cut: false });
  const calls = readFileSync(log, "utf8").trim().split("\n");
  expect(calls).toEqual([
    "--json meetings transcript m_1 --limit 500 --offset 0",
    "--json meetings transcript m_1 --limit 500 --offset 500",
  ]);
});

test("the transcript is cut at 12 000 words and says so", async () => {
  const words = Array.from({ length: 500 }, (_, i) => `w${i}`).join(" ");
  const bin = fake(
    "endless",
    `off=0\nwhile [ $# -gt 0 ]; do [ "$1" = "--offset" ] && off=$2; shift; done\n` +
      `next=$((off+500))\nprintf '%s' '{"schema_version":"1","command":"meetings.transcript","data":{"meeting_id":"m_1","text":"${words}","words":[]},"pagination":{"offset":0,"limit":500,"returned":500,"next_offset":'$next'}}'`,
  );
  const result = await createAnarlogCli(bin)!.transcript("m_1", new Date(Date.now() + 20_000));
  expect(result.cut).toBe(true);
  expect(result.text.split(/\s+/).length).toBe(12_000);
});

test("the transcript deadline stops the paging with a typed error", async () => {
  const bin = fake("late", `sleep 1\nprintf '%s' '${page("x", 500, 0)}'`);
  const err = await createAnarlogCli(bin)!
    .transcript("m_1", new Date(Date.now() + 200))
    .catch((e) => e);
  expect(err).toBeInstanceOf(AnarlogError);
  expect(err.code).toBe("timeout");
});
