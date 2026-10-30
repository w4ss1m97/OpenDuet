import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash, randomBytes, randomUUID } from "node:crypto";
import { inArray } from "drizzle-orm";
import { type FakeGoogle, startFakeGoogle } from "../../scripts/fake-google/server";
import { createDatabase } from "../src/db/client";
import { users } from "../src/db/schema/core";
import type { CallTool } from "../src/openduet/brief";
import { runIntake } from "../src/openduet/items/intake";
import { createItemStore } from "../src/openduet/items/store";
import { callTool as callGoogle } from "../src/plugins/google-workspace-rest";
import { TEST_POOL, testDatabaseUrl } from "./support/database";

/**
 * The whole intake against the fake Google: mail delivered there comes back as items through the real
 * REST connector, Notes and projects are named as unreadable without the Mac, and a second run adds
 * nothing.
 */

const database = createDatabase(testDatabaseUrl(), TEST_POOL);
const owner = `openduet-intake-fake-${randomUUID()}`;
const store = createItemStore(database);
let fake: FakeGoogle;
let call: CallTool;

async function signIn(base: string): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const consent = new URL(`${base}/o/oauth2/v2/auth`);
  consent.search = new URLSearchParams({
    client_id: "test-client",
    redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
    response_type: "code",
    state: "s",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  }).toString();
  const back = new URL(
    (await fetch(consent, { redirect: "manual" })).headers.get("location") ?? "",
  );
  const tokens = await fetch(`${base}/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      code: back.searchParams.get("code") ?? "",
      client_id: "test-client",
      client_secret: "test-secret",
      redirect_uri: "http://127.0.0.1:3001/api/plugins/oauth/callback",
      code_verifier: verifier,
    }),
  });
  return ((await tokens.json()) as { access_token: string }).access_token;
}

async function deliver(from: string, subject: string, body: string) {
  const response = await fetch(`${fake.url}/__fake/deliver`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ from, subject, body }),
  });
  expect(response.status).toBe(201);
}

beforeAll(async () => {
  fake = startFakeGoogle({ port: 0 });
  const connection = { url: fake.url, token: await signIn(fake.url) };
  call = async ({ ref, args }) => {
    const result = await callGoogle(connection, ref.split("/")[1] ?? "", args);
    return { text: result.text, isError: result.isError };
  };
  await database.insert(users).values({ id: owner, email: `${owner}@example.test` });
  await deliver(
    "Malt <notifications@malt.fr>",
    "Nouveau message de Camille sur votre mission DevOps",
    "Bonjour, votre profil nous intéresse pour une mission Kubernetes.",
  );
  await deliver(
    "Fournisseur Énergie <facture@energie-exemple.fr>",
    "Votre facture Duet-E2E est disponible",
    "Montant : 45,00 € à payer avant le 20/12/2099 par prélèvement.",
  );
});

afterAll(async () => {
  await database.delete(users).where(inArray(users.id, [owner]));
  await fake.stop();
});

test("intake against the fake Google: bill active with 2 reminders, Malt followup proposed", async () => {
  const deps = { store, callTool: call, host: null, projects: [], now: () => new Date() };
  const report = await runIntake(deps, owner, "bot");
  expect(report.failed.map((f) => f.scanner).sort()).toEqual(["notes", "projects"]);

  const items = await store.list(owner, {});
  const bill = items.find((i) => i.title === "Votre facture Duet-E2E est disponible");
  expect(bill).toMatchObject({ kind: "bill", status: "active", amount: 45 });
  expect(bill?.remindAt).toHaveLength(2);
  const malt = items.find((i) => i.title.startsWith("Nouveau message de Camille"));
  expect(malt).toMatchObject({ kind: "followup", status: "proposed", channelId: "missions" });

  const again = await runIntake(deps, owner, "bot");
  expect(again).toMatchObject({ added: 0, proposed: 0 });
});
