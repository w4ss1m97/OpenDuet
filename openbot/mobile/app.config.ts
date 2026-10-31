import type { ExpoConfig } from "expo/config";

const projectId = process.env.EXPO_PUBLIC_EAS_PROJECT_ID;
const config: ExpoConfig = {
  name: "Duet",
  slug: "duet",
  version: "0.1.0",
  scheme: "openbotmobile", // kept: sign-in redirect, push links and the server trust this scheme
  orientation: "default",
  userInterfaceStyle: "automatic",
  ios: { bundleIdentifier: "fr.wassim.duet", supportsTablet: true },
  android: { package: "fr.wassim.duet" },
  plugins: [
    "expo-router",
    "expo-secure-store",
    ["expo-notifications", { defaultChannel: "duet" }],
  ],
  extra: { ...(projectId ? { eas: { projectId } } : {}) },
};
export default config;
