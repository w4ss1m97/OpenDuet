import { useQuery } from "@tanstack/react-query";
import { Fragment } from "react";
import { agoMillis, Chip, CockpitProblem } from "@/components/cockpit/parts";
import {
  PageEmpty,
  PageRows,
  PageSection,
} from "@/components/layout/page-shell";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { layoutDiagram } from "@/lib/cockpit/diagram-layout";
import {
  type Explanation,
  explainStatusQueryOptions,
  useGenerateExplanation,
} from "@/lib/cockpit/explore";

/** The diagram as inline SVG. Every label is a React text node, so model text can never become markup. */
export function DiagramSvg({ diagram }: { diagram: Explanation["diagram"] }) {
  const layout = layoutDiagram(diagram.nodes, diagram.edges);
  if (!layout.nodes.length) return null;
  return (
    <svg
      aria-label="Project diagram"
      className="h-auto max-w-full text-foreground"
      role="img"
      viewBox={`0 0 ${layout.width} ${layout.height}`}
      width={layout.width}
    >
      <title>Project diagram</title>
      {layout.edges.map((e) => (
        <g key={`${e.from}>${e.to}`}>
          <line
            stroke="currentColor"
            strokeOpacity={0.5}
            x1={e.x1}
            x2={e.x2}
            y1={e.y1}
            y2={e.y2}
          />
          <circle cx={e.x2} cy={e.y2} fill="currentColor" r={3} />
          {e.label ? (
            <text
              className="fill-muted-foreground"
              fontSize={10}
              textAnchor="middle"
              x={(e.x1 + e.x2) / 2}
              y={(e.y1 + e.y2) / 2}
            >
              {e.label}
            </text>
          ) : null}
        </g>
      ))}
      {layout.nodes.map((n) => (
        <g key={n.id}>
          <rect
            className="fill-muted"
            height={n.height}
            rx={6}
            stroke="currentColor"
            strokeOpacity={0.4}
            width={n.width}
            x={n.x}
            y={n.y}
          />
          <text
            fill="currentColor"
            fontSize={12}
            textAnchor="middle"
            x={n.x + n.width / 2}
            y={n.y + n.height / 2 + 4}
          >
            {n.label.length > 22 ? `${n.label.slice(0, 21)}…` : n.label}
          </text>
        </g>
      ))}
    </svg>
  );
}

function ExplanationView({ explanation }: { explanation: Explanation }) {
  return (
    <>
      <p className="type-sub whitespace-pre-wrap px-4 py-3">
        {explanation.summary}
      </p>
      {explanation.sections.map((s) => (
        <Fragment key={s.title}>
          <Separator />
          <div className="px-4 py-3">
            <h3 className="type-sub font-medium">{s.title}</h3>
            <p className="type-sub mt-1 whitespace-pre-wrap text-muted-foreground">
              {s.text}
            </p>
          </div>
        </Fragment>
      ))}
      {explanation.modules.length ? (
        <>
          <Separator />
          <div className="px-4 py-3">
            <h3 className="type-sub font-medium">Modules</h3>
            <ul className="type-sub mt-1 space-y-1">
              {explanation.modules.map((m) => (
                <li key={m.path}>
                  <span className="font-mono">{m.path}</span>
                  <span className="text-muted-foreground"> · {m.role}</span>
                </li>
              ))}
            </ul>
          </div>
        </>
      ) : null}
      {explanation.diagram.nodes.length ? (
        <>
          <Separator />
          <div className="overflow-x-auto px-4 py-3">
            <DiagramSvg diagram={explanation.diagram} />
          </div>
        </>
      ) : null}
    </>
  );
}

/** The estimate comes first; nothing is sent to the model until the button is pressed. */
export function ExplainPanel({ name }: { name: string }) {
  const { data, error, isPending } = useQuery(explainStatusQueryOptions(name));
  const generate = useGenerateExplanation(name);

  if (error) {
    return (
      <PageSection title="Explanation">
        <CockpitProblem error={error} />
      </PageSection>
    );
  }
  if (isPending) {
    return (
      <PageSection title="Explanation">
        <PageEmpty>Loading…</PageEmpty>
      </PageSection>
    );
  }

  const shown = data.cached ?? data.staleCached;
  const stale = !data.cached && data.staleCached !== null;
  const head = data.head;
  const canGenerate = head !== null && data.estimate !== null && !data.cached;

  return (
    <PageSection title="Explanation">
      <PageRows>
        {canGenerate ? (
          <div className="type-sub flex flex-wrap items-center gap-3 px-4 py-3">
            <span className="text-muted-foreground">
              Estimate: about {data.estimate?.inputTokens.toLocaleString()}{" "}
              input tokens, up to{" "}
              {data.estimate?.maxOutputTokens.toLocaleString()} output tokens.
            </span>
            <Button
              disabled={generate.isPending}
              onClick={() => generate.mutate(head)}
              type="button"
            >
              {generate.isPending
                ? "Generating…"
                : stale
                  ? "Regenerate"
                  : "Generate"}
            </Button>
            {generate.error ? (
              <span className="text-red-700 dark:text-red-400" role="alert">
                {generate.error.message}
              </span>
            ) : null}
          </div>
        ) : null}
        {!shown && !canGenerate ? (
          <div className="type-sub px-4 py-3 text-muted-foreground">
            {head === null
              ? "Empty repository, nothing to explain."
              : "No estimate available for this project."}
          </div>
        ) : null}
        {shown ? (
          <>
            {canGenerate ? <Separator /> : null}
            <div className="type-sub flex flex-wrap items-center gap-2 px-4 py-3">
              {stale ? <Chip tone="warn">stale</Chip> : null}
              <span className="text-muted-foreground">
                For {shown.head.slice(0, 7)} · {agoMillis(shown.generatedAt)}
              </span>
            </div>
            <Separator />
            <ExplanationView explanation={shown.explanation} />
          </>
        ) : null}
      </PageRows>
    </PageSection>
  );
}
