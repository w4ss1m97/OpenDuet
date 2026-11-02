import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { GuideContent, guideRecipient } from "@/components/duet/guide";
import { PageShell } from "@/components/layout/page-shell";
import { agentListQueryOptions } from "@/lib/agents/queries";

/** How to use Duet well: its rhythm, setup, phrases to say, screens, guard rails and fixes. */
export const Route = createFileRoute("/_authed/_app/guide")({
  component: GuidePage,
});

function GuidePage() {
  const { data: agents } = useQuery(agentListQueryOptions());
  return (
    <PageShell title="Guide">
      <GuideContent agentId={guideRecipient(agents)?.id} />
    </PageShell>
  );
}
