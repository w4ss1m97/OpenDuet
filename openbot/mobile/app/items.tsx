import { Redirect } from "expo-router";
import { useCallback } from "react";
import { Button, Text, View } from "react-native";
import { api } from "../src/api";
import { authClient } from "../src/auth";
import { syncReminders } from "../src/reminders";
import type { Item } from "../src/reminders-plan";
import { card, muted, Problem, Screen, Section, useAction } from "../src/ui";
import { useLoad } from "../src/use-load";

/**
 * What Duet found but did not dare add on its own: ideas and to-dos from notes, leads with no date,
 * anything it read unclearly. Keep makes it an item Duet reminds about; Ignore drops it for good.
 */
export default function ItemsScreen() {
  const { data: session, isPending } = authClient.useSession();
  const load = useCallback(
    () => api<{ items: Item[] }>("/api/openduet/items?status=proposed"),
    [],
  );
  const proposed = useLoad(load, Boolean(session));
  const action = useAction();
  if (!session && !isPending) return <Redirect href="/" />;

  async function decide(id: string, status: "active" | "dismissed") {
    const saved = await action.run(id, () =>
      api(`/api/openduet/items/${encodeURIComponent(id)}/status`, {
        method: "POST",
        body: { status },
      }),
    );
    if (!saved) return;
    await proposed.refresh();
    if (status === "active") void syncReminders().catch(() => {});
  }

  const items = proposed.data?.items ?? [];
  return (
    <Screen refreshing={proposed.pending} onRefresh={proposed.refresh}>
      <Problem message={proposed.error ?? action.error} />
      <Section title={`À trier (${items.length})`}>
        {items.length === 0 && !proposed.pending ? (
          <Text style={muted}>Rien à trier pour l'instant.</Text>
        ) : null}
        {items.map((item) => (
          <View key={item.id} style={{ ...card, gap: 6 }}>
            <Text style={{ fontSize: 16, fontWeight: "600" }}>{item.title}</Text>
            {item.why ? <Text style={muted}>{item.why}</Text> : null}
            <View style={{ flexDirection: "row", gap: 12 }}>
              <Button
                title="Garder"
                disabled={Boolean(action.busy)}
                onPress={() => void decide(item.id, "active")}
              />
              <Button
                title="Ignorer"
                color="#b42318"
                disabled={Boolean(action.busy)}
                onPress={() => void decide(item.id, "dismissed")}
              />
            </View>
          </View>
        ))}
      </Section>
    </Screen>
  );
}
