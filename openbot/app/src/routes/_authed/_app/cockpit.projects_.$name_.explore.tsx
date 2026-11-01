import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { Fragment, useState } from "react";
import { ExplainPanel } from "@/components/cockpit/explain-panel";
import {
  agoSeconds,
  Chip,
  CockpitProblem,
  External,
} from "@/components/cockpit/parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
  PageShell,
} from "@/components/layout/page-shell";
import { Separator } from "@/components/ui/separator";
import {
  type ExploreFacts,
  type ExploreNode,
  exploreQueryOptions,
} from "@/lib/cockpit/explore";

/** What a project is made of, read from its committed tree. Reached from the project's page. */
export const Route = createFileRoute(
  "/_authed/_app/cockpit/projects_/$name_/explore",
)({
  component: CockpitExplore,
});

function Rows({ children }: { children: React.ReactNode[] }) {
  return (
    <PageRows>
      {children.map((child, i) => (
        // biome-ignore lint/suspicious/noArrayIndexKey: rows are static for one render
        <Fragment key={i}>
          {i > 0 ? <Separator /> : null}
          <div className="type-sub flex flex-wrap items-center gap-2 px-4 py-3">
            {child}
          </div>
        </Fragment>
      ))}
    </PageRows>
  );
}

function size(bytes: number): string {
  return bytes >= 1_048_576
    ? `${(bytes / 1_048_576).toFixed(1)} MB`
    : bytes >= 1024
      ? `${Math.round(bytes / 1024)} KB`
      : `${bytes} B`;
}

const MAX_DEPTH = 3;

const depthOf = (path: string) => path.split("/").length;

/** A row shows when every directory above it is open. */
export function visibleTree(
  tree: ExploreNode[],
  open: Set<string>,
): ExploreNode[] {
  return tree.filter((n) => {
    const parts = n.path.split("/");
    if (parts.length > MAX_DEPTH) return false;
    for (let i = 1; i < parts.length; i++) {
      if (!open.has(parts.slice(0, i).join("/"))) return false;
    }
    return true;
  });
}

function Tree({
  tree,
  truncated,
}: {
  tree: ExploreNode[];
  truncated: boolean;
}) {
  const [open, setOpen] = useState<Set<string>>(new Set());
  const rows = visibleTree(tree, open);
  const toggle = (path: string) =>
    setOpen((prev) => {
      const next = new Set(prev);
      if (!next.delete(path)) next.add(path);
      return next;
    });
  return (
    <>
      <PageRows>
        {rows.map((n, i) => (
          <Fragment key={n.path}>
            {i > 0 ? <Separator /> : null}
            <div
              className="type-sub flex items-center gap-2 py-1.5 pr-4"
              style={{ paddingLeft: `${depthOf(n.path) * 16}px` }}
            >
              {n.type === "dir" ? (
                <button
                  aria-expanded={open.has(n.path)}
                  className="font-medium"
                  onClick={() => toggle(n.path)}
                  type="button"
                >
                  {open.has(n.path) ? "▾" : "▸"} {n.path.split("/").pop()}/
                </button>
              ) : (
                <span>{n.path.split("/").pop()}</span>
              )}
              <span className="ml-auto text-muted-foreground tabular-nums">
                {n.type === "dir" ? `${n.files} files · ` : ""}
                {size(n.bytes)}
              </span>
            </div>
          </Fragment>
        ))}
      </PageRows>
      {truncated ? (
        <p className="type-caption mt-2 text-muted-foreground">
          The tree is cut short; deeper entries are not listed.
        </p>
      ) : null}
    </>
  );
}

function Facts({ facts }: { facts: ExploreFacts }) {
  const maxBytes = Math.max(1, ...facts.languages.map((l) => l.bytes));
  return (
    <>
      <PageSection title="Languages">
        {facts.languages.length ? (
          <Rows>
            {facts.languages.map((l) => (
              <Fragment key={l.name}>
                <span className="w-24 font-medium">{l.name}</span>
                <span
                  aria-hidden
                  className="h-2 rounded-full bg-primary"
                  style={{
                    width: `${Math.max(2, (l.bytes / maxBytes) * 40)}%`,
                  }}
                />
                <span className="ml-auto text-muted-foreground tabular-nums">
                  {l.files} files · {l.lines.toLocaleString()} lines
                </span>
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>No source files recognised.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Files">
        {facts.tree.length ? (
          <Tree tree={facts.tree} truncated={facts.treeTruncated} />
        ) : (
          <PageEmpty>No files.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Manifests">
        {facts.manifests.length ? (
          <PageRows>
            {facts.manifests.map((m, i) => (
              <Fragment key={m.path}>
                {i > 0 ? <Separator /> : null}
                <div className="type-sub px-4 py-3">
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{m.path}</span>
                    <Chip>{m.kind}</Chip>
                    {m.name ? (
                      <span className="text-muted-foreground">
                        {m.name}
                        {m.version ? ` ${m.version}` : ""}
                      </span>
                    ) : null}
                  </div>
                  {m.scripts.length ? (
                    <p className="mt-1 text-muted-foreground">
                      Scripts: {m.scripts.join(", ")}
                    </p>
                  ) : null}
                  {m.dependencies.length ? (
                    <p className="mt-1 text-muted-foreground">
                      {m.dependencies.length} dependencies:{" "}
                      {m.dependencies.join(", ")}
                    </p>
                  ) : null}
                </div>
              </Fragment>
            ))}
          </PageRows>
        ) : (
          <PageEmpty>No manifests.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Releases">
        {facts.tags.length || facts.releases?.length ? (
          <Rows>
            {[
              ...(facts.releases ?? []).map((r) => ({
                key: `r-${r.tag}`,
                t: r.t,
                node: (
                  <>
                    <External href={r.url}>{r.name || r.tag}</External>
                    <Chip tone="good">release</Chip>
                    {r.prerelease ? <Chip tone="warn">pre-release</Chip> : null}
                  </>
                ),
              })),
              ...facts.tags.map((t) => ({
                key: `t-${t.name}`,
                t: t.t,
                node: (
                  <>
                    <span className="font-medium">{t.name}</span>
                    <Chip>tag</Chip>
                  </>
                ),
              })),
            ]
              .sort((a, b) => b.t - a.t)
              .map((e) => (
                <Fragment key={e.key}>
                  {e.node}
                  <span className="ml-auto text-muted-foreground">
                    {agoSeconds(e.t)}
                  </span>
                </Fragment>
              ))}
          </Rows>
        ) : (
          <PageEmpty>
            {facts.releases === null
              ? "No tags. GitHub releases couldn't be read."
              : "No tags or releases."}
          </PageEmpty>
        )}
      </PageSection>

      <PageSection title="Workflows">
        {facts.workflows.length ? (
          <Rows>
            {facts.workflows.map((w) => (
              <Fragment key={w.path}>
                <span className="font-medium">{w.name}</span>
                {w.triggers.map((t) => (
                  <Chip key={t}>{t}</Chip>
                ))}
                <span className="ml-auto text-muted-foreground">
                  {w.jobs.length} jobs: {w.jobs.join(", ")}
                </span>
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>No workflows.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Docs">
        {facts.docs.length ? (
          <Rows>
            {facts.docs.map((d) => (
              <Fragment key={d.path}>
                <span className="font-medium">{d.title ?? d.path}</span>
                <span className="ml-auto text-muted-foreground">{d.path}</span>
              </Fragment>
            ))}
          </Rows>
        ) : (
          <PageEmpty>No docs.</PageEmpty>
        )}
      </PageSection>

      <PageSection title="Entry points">
        {facts.entryPoints.length ? (
          <Rows>
            {facts.entryPoints.map((p) => (
              <span className="font-mono" key={p}>
                {p}
              </span>
            ))}
          </Rows>
        ) : (
          <PageEmpty>No entry points found.</PageEmpty>
        )}
      </PageSection>
    </>
  );
}

function CockpitExplore() {
  const { name } = Route.useParams();
  const { data, error, isPending } = useQuery(exploreQueryOptions(name));
  const backButton = {
    label: name,
    linkProps: {
      to: "/cockpit/projects/$name" as const,
      params: { name },
    },
  };

  if (error || isPending) {
    return (
      <PageShell backButton={backButton} title={`${name} · Explore`}>
        {error ? (
          <CockpitProblem error={error} />
        ) : (
          <PageEmpty>Loading…</PageEmpty>
        )}
      </PageShell>
    );
  }

  return (
    <PageShell
      action={data.truncated ? <Chip tone="warn">truncated</Chip> : undefined}
      backButton={backButton}
      description={`${data.head ? data.head.slice(0, 7) : "no commits"} · ${data.files.toLocaleString()} files · ${size(data.bytes)}`}
      title={`${name} · Explore`}
    >
      <ExplainPanel name={name} />
      <Facts facts={data} />
    </PageShell>
  );
}
