import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { GlobalRegistrator } from "@happy-dom/global-registrator";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  Outlet,
  RouterProvider,
} from "@tanstack/react-router";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import {
  GuideContent,
  guideRecipient,
  PHRASES,
} from "@/components/duet/guide";
import type { AgentProfile } from "@/lib/agents/queries";

/**
 * The in-app guide: every phrase opens a new conversation with Duet, the phrase already in the
 * composer, and the filters narrow the list to one family. The app's `Button` gives a `Link` drawn
 * through `render` the button role, so the phrases are found as buttons that carry an `href`.
 */

beforeAll(() => GlobalRegistrator.register());
afterEach(() => cleanup());
afterAll(() => GlobalRegistrator.unregister());

function draw() {
  const root = createRootRoute({ component: Outlet });
  const page = createRoute({
    getParentRoute: () => root,
    path: "/",
    component: () => <GuideContent agentId="duet-1" />,
  });
  const channel = createRoute({
    getParentRoute: () => root,
    path: "/channel/new",
    component: () => null,
  });
  const router = createRouter({
    routeTree: root.addChildren([page, channel]),
    history: createMemoryHistory({ initialEntries: ["/"] }),
  });
  return render(<RouterProvider router={router as never} />);
}

const profile = (id: string, name: string) =>
  ({ id, name }) as unknown as AgentProfile;

test("each phrase links to a new conversation with Duet, prefilled", async () => {
  const view = draw();
  const links = await waitFor(() => {
    const found = view.getAllByRole("button", { name: "Écrire à Duet" });
    expect(found).toHaveLength(PHRASES.length);
    return found;
  });
  const href = new URL(links[0]!.getAttribute("href")!, "http://x");
  expect(href.pathname).toBe("/channel/new");
  expect(href.searchParams.get("agent")).toBe("duet-1");
  expect(href.searchParams.get("text")).toContain(PHRASES[0]!.say);
});

test("a filter keeps only its phrases", async () => {
  const view = draw();
  fireEvent.click(await view.findByRole("button", { name: "Missions" }));
  const missions = PHRASES.filter((phrase) => phrase.filter === "missions");
  expect(view.getAllByRole("button", { name: "Écrire à Duet" })).toHaveLength(
    missions.length,
  );
  expect(view.getByRole("button", { name: "Missions" }).getAttribute("aria-pressed")).toBe("true");
});

test("phrases go to the Bot named Duet, else the default one", () => {
  expect(
    guideRecipient([profile("a", "Helper"), profile("d", "Duet")])?.id,
  ).toBe("d");
  expect(guideRecipient([profile("a", "Helper")])?.id).toBe("a");
  expect(guideRecipient(undefined)).toBeUndefined();
});
