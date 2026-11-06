import { Redirect } from "expo-router";
import { useCallback, useState } from "react";
import { Button, Text, View } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import {
  daysInStage,
  groupByStage,
  type Mission,
  nextStages,
  type Relance,
  STAGE_LABELS,
  type Stage,
} from "../src/missions";
import { card, muted, Problem, Screen, Section, useAction } from "../src/ui";
import { useLoad } from "../src/use-load";

type Board = { missions: Mission[]; drafts: Relance[] };

/**
 * The freelance pipeline: pistes Duet found but wants confirmed (keep, ignore or merge into a mission
 * you already follow), active missions by stage with buttons to move them on, and the follow-up drafts
 * Duet wrote for silent applications.
 */
export default function MissionsScreen() {
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(async (): Promise<Board> => {
    const { missions } = await api<{ missions: Mission[] }>("/api/openduet/missions");
    const waiting = missions.filter(
      (m) => m.review === "active" && (m.stage === "applied" || m.stage === "talking"),
    );
    const details = await Promise.all(
      waiting.map((m) =>
        api<{ relances: Relance[] }>(`/api/openduet/missions/${encodeURIComponent(m.id)}`),
      ),
    );
    const drafts = details.flatMap((d) => d.relances).filter((r) => r.status === "draft");
    return { missions, drafts };
  }, []);
  const board = useLoad(load, Boolean(session));
  const action = useAction();
  const [merging, setMerging] = useState("");
  if (!session && !isPending) return <Redirect href="/" />;

  async function patch(id: string, body: Record<string, string>) {
    const saved = await action.run(id, () =>
      api(`/api/openduet/missions/${encodeURIComponent(id)}`, { method: "PATCH", body }),
    );
    if (!saved) return;
    setMerging("");
    await board.refresh();
  }

  async function settle(relance: Relance, status: "sent" | "dismissed") {
    const saved = await action.run(relance.id, () =>
      api(
        `/api/openduet/missions/${encodeURIComponent(relance.missionId)}/relances/${encodeURIComponent(relance.id)}`,
        { method: "PATCH", body: { status } },
      ),
    );
    if (saved) await board.refresh();
  }

  const missions = board.data?.missions ?? [];
  const drafts = board.data?.drafts ?? [];
  const proposed = missions.filter((m) => m.review === "proposed");
  const active = missions.filter((m) => m.review === "active");
  const openActive = active.filter((m) => m.stage !== "signed" && m.stage !== "refused");
  const now = new Date();
  const busy = Boolean(action.busy);
  const titleOf = (id: string) => missions.find((m) => m.id === id)?.title ?? "";

  return (
    <Screen refreshing={board.pending} onRefresh={board.refresh}>
      <Problem message={board.error ?? action.error} />
      <Section title={`À trier (${proposed.length})`}>
        {proposed.length === 0 && !board.pending ? (
          <Text style={muted}>Rien à trier pour l'instant.</Text>
        ) : null}
        {proposed.map((m) => (
          <View key={m.id} style={{ ...card, gap: 6 }}>
            <Text style={{ fontSize: 16, fontWeight: "600" }}>{m.title}</Text>
            <Text style={muted}>{m.company}</Text>
            <View style={{ flexDirection: "row", gap: 12, flexWrap: "wrap" }}>
              <Button
                title="Garder"
                disabled={busy}
                onPress={() => void patch(m.id, { review: "active" })}
              />
              <Button
                title="Fusionner"
                disabled={busy || openActive.length === 0}
                onPress={() => setMerging(merging === m.id ? "" : m.id)}
              />
              <Button
                title="Ignorer"
                color="#b42318"
                disabled={busy}
                onPress={() => void patch(m.id, { review: "dismissed" })}
              />
            </View>
            {merging === m.id ? (
              <View style={{ gap: 4 }}>
                <Text style={muted}>Fusionner dans :</Text>
                {openActive.map((target) => (
                  <Button
                    key={target.id}
                    title={target.title}
                    disabled={busy}
                    onPress={() => void patch(m.id, { mergeInto: target.id })}
                  />
                ))}
              </View>
            ) : null}
          </View>
        ))}
      </Section>
      {groupByStage(active).map((group) => (
        <Section key={group.stage} title={`${STAGE_LABELS[group.stage]} (${group.missions.length})`}>
          {group.missions.map((m) => (
            <View key={m.id} style={{ ...card, gap: 6 }}>
              <Text style={{ fontSize: 16, fontWeight: "600" }}>{m.title}</Text>
              <Text style={muted}>
                {[m.company, m.role].filter(Boolean).join(" · ")}
              </Text>
              <Text style={muted}>depuis {daysInStage(m, now)} j</Text>
              <View style={{ flexDirection: "row", gap: 8, flexWrap: "wrap" }}>
                {nextStages(m.stage).map((to: Stage) => (
                  <Button
                    key={to}
                    title={STAGE_LABELS[to]}
                    color={to === "refused" ? "#b42318" : undefined}
                    disabled={busy}
                    onPress={() => void patch(m.id, { stage: to })}
                  />
                ))}
              </View>
            </View>
          ))}
        </Section>
      ))}
      <Section title={`Relances (${drafts.length})`}>
        {drafts.length === 0 && !board.pending ? (
          <Text style={muted}>Aucune relance à envoyer.</Text>
        ) : null}
        {drafts.map((r) => (
          <View key={r.id} style={{ ...card, gap: 6 }}>
            <Text style={{ fontSize: 16, fontWeight: "600" }}>{titleOf(r.missionId)}</Text>
            <Text selectable>{r.body}</Text>
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Button title="Envoyé" disabled={busy} onPress={() => void settle(r, "sent")} />
              <Button
                title="Ignorer"
                color="#b42318"
                disabled={busy}
                onPress={() => void settle(r, "dismissed")}
              />
            </View>
          </View>
        ))}
      </Section>
    </Screen>
  );
}
