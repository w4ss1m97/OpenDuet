import * as Notifications from "expo-notifications";
import { router, Stack } from "expo-router";
import { useEffect, useRef } from "react";
import { AppState } from "react-native";
import { authClient } from "../src/auth";
import { notificationDestination } from "../src/links";
import { handleItemResponse, registerItemCategory, syncReminders } from "../src/reminders";

Notifications.setNotificationHandler({
  handleNotification: async () => ({
    shouldShowBanner: true,
    shouldShowList: true,
    shouldPlaySound: true,
    shouldSetBadge: false,
  }),
});
export default function Layout() {
  const { data: session } = authClient.useSession();
  const pending = useRef<unknown>(null);
  const handled = useRef<string | null>(null);
  useEffect(() => {
    const open = (response: Notifications.NotificationResponse) => {
      const id = response.notification.request.identifier;
      if (handled.current === id) return;
      if (handleItemResponse(response)) {
        handled.current = id;
        if (session && response.actionIdentifier === Notifications.DEFAULT_ACTION_IDENTIFIER)
          router.push("/items");
        return;
      }
      pending.current = response.notification.request.content.data;
      if (session) {
        const destination = notificationDestination(pending.current);
        if (destination) router.push(destination);
        handled.current = id;
        pending.current = null;
      }
    };
    const last = Notifications.getLastNotificationResponse();
    if (last) open(last);
    const subscription =
      Notifications.addNotificationResponseReceivedListener(open);
    return () => subscription.remove();
  }, [session]);
  // Duet's reminders: refreshed whenever the app comes back, so they fire even with the Mac off.
  useEffect(() => {
    if (!session) return;
    const sync = () => void syncReminders().catch(() => {});
    void registerItemCategory().catch(() => {});
    sync();
    const subscription = AppState.addEventListener("change", (state) => {
      if (state === "active") sync();
    });
    return () => subscription.remove();
  }, [session]);
  return (
    <Stack screenOptions={{ headerBackTitle: "Back" }}>
      <Stack.Screen name="index" options={{ title: "OpenBot" }} />
      <Stack.Screen name="conversation" options={{ title: "Conversation" }} />
      <Stack.Screen name="approvals" options={{ title: "Approval inbox" }} />
      <Stack.Screen name="bots" options={{ title: "Bots" }} />
      <Stack.Screen name="bot" options={{ title: "Bot" }} />
      <Stack.Screen name="computer" options={{ title: "Computer" }} />
      <Stack.Screen name="routine" options={{ title: "Routine" }} />
      <Stack.Screen name="memory" options={{ title: "Memory" }} />
      <Stack.Screen name="rules" options={{ title: "Custom rules" }} />
      <Stack.Screen name="plugins" options={{ title: "Plugins" }} />
      <Stack.Screen name="items" options={{ title: "À trier" }} />
      <Stack.Screen name="missions" options={{ title: "Missions" }} />
    </Stack>
  );
}
