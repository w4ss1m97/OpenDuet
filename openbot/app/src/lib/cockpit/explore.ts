import {
  queryOptions,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { CockpitOffError } from "./queries";

/*
 * Project explorer (C1c): facts read from a project's committed tree, and a model-written
 * explanation of it. Types mirror server/src/openduet/cockpit/types.ts exactly. Like the rest of the
 * cockpit these calls are cross-origin to 127.0.0.1 and carry no credentials.
 */

export type ExploreNode = {
  path: string;
  type: "dir" | "file";
  files: number;
  bytes: number;
};

export type ExploreLanguage = {
  name: string;
  files: number;
  bytes: number;
  lines: number;
};

export type ExploreManifest = {
  path: string;
  kind: "npm" | "python" | "rust" | "go" | "gradle" | "other";
  name: string | null;
  version: string | null;
  dependencies: string[];
  scripts: string[];
};

export type ExploreWorkflow = {
  path: string;
  name: string;
  triggers: string[];
  jobs: string[];
};

export type ExploreDoc = { path: string; title: string | null; bytes: number };

export type ExploreTag = { name: string; t: number; sha: string };

export type ExploreRelease = {
  tag: string;
  name: string;
  t: number;
  url: string;
  prerelease: boolean;
};

/** Facts from the committed HEAD tree only. `head` is null for an empty repo. */
export type ExploreFacts = {
  head: string | null;
  /** Milliseconds since the epoch. */
  generatedAt: number;
  files: number;
  bytes: number;
  /** True when the tree had more than 50 000 entries or a git answer was too big. */
  truncated: boolean;
  languages: ExploreLanguage[];
  tree: ExploreNode[];
  treeTruncated: boolean;
  manifests: ExploreManifest[];
  workflows: ExploreWorkflow[];
  docs: ExploreDoc[];
  entryPoints: string[];
  /** Newest first. */
  tags: ExploreTag[];
  /** Null when the project has no GitHub remote or gh failed. */
  releases: ExploreRelease[] | null;
};

export type ExplainSection = { title: string; text: string };
export type ExplainNode = { id: string; label: string; kind: string };
export type ExplainEdge = { from: string; to: string; label: string };
export type ExplainModule = { path: string; role: string };

/** What the model explains. The diagram is data: the app draws it, labels are plain text. */
export type Explanation = {
  summary: string;
  sections: ExplainSection[];
  modules: ExplainModule[];
  diagram: { nodes: ExplainNode[]; edges: ExplainEdge[] };
};

export type CachedExplanation = {
  head: string;
  generatedAt: number;
  explanation: Explanation;
};

export type ExplainStatus = {
  head: string | null;
  promptVersion: number;
  estimate: { inputTokens: number; maxOutputTokens: number } | null;
  cached: CachedExplanation | null;
  staleCached: CachedExplanation | null;
};

export type ExplainResult = {
  head: string;
  promptVersion: number;
  cached: boolean;
  generatedAt: number;
  explanation: Explanation;
};

export const exploreKeys = {
  explore: (name: string) => ["cockpit", "explore", name] as const,
  explain: (name: string) => ["cockpit", "explain", name] as const,
};

const BASE = `http://127.0.0.1:${import.meta.env.VITE_COCKPIT_PORT ?? 3002}`;

const path = (name: string, tail: string) =>
  `/api/cockpit/projects/${encodeURIComponent(name)}/${tail}`;

async function send(
  url: string,
  init: RequestInit,
  signal?: AbortSignal,
): Promise<Response> {
  try {
    return await fetch(`${BASE}${url}`, {
      ...init,
      credentials: "omit",
      ...(signal ? { signal } : {}),
    });
  } catch (error) {
    if (signal?.aborted) throw error;
    throw new CockpitOffError();
  }
}

async function read<T>(url: string, signal?: AbortSignal): Promise<T> {
  const response = await send(url, {}, signal);
  if (!response.ok) {
    throw new Error(
      response.status === 404
        ? "That project isn't in the cockpit list."
        : response.status === 503
          ? "Explanations are not configured."
          : "Couldn't load the explorer. Reload the page.",
    );
  }
  return (await response.json()) as T;
}

export const exploreQueryOptions = (name: string) =>
  queryOptions({
    queryKey: exploreKeys.explore(name),
    queryFn: ({ signal }): Promise<ExploreFacts> =>
      read(path(name, "explore"), signal),
    retry: false,
  });

export const explainStatusQueryOptions = (name: string) =>
  queryOptions({
    queryKey: exploreKeys.explain(name),
    queryFn: ({ signal }): Promise<ExplainStatus> =>
      read(path(name, "explain"), signal),
    retry: false,
  });

/** Why a generation failed, said for a person. */
export function generateErrorMessage(
  status: number,
  retryAfter: string | null,
): string {
  if (status === 409) return "The code changed. Reload and re-estimate.";
  if (status === 429) {
    const seconds = Number(retryAfter);
    return Number.isFinite(seconds) && seconds > 0
      ? `Too many explanations. Try again in ${seconds >= 60 ? `${Math.ceil(seconds / 60)} min` : `${Math.ceil(seconds)} s`}.`
      : "Another explanation is running. Try again in a moment.";
  }
  if (status === 502) {
    return "Generation failed. Nothing was charged beyond the attempt.";
  }
  if (status === 503) return "Explanations are not configured.";
  return "Couldn't generate the explanation.";
}

/** POST with no body; `head` is the HEAD the estimate was shown for. */
export async function generateExplanation(
  name: string,
  head: string,
): Promise<ExplainResult> {
  const response = await send(
    `${path(name, "explain")}?head=${encodeURIComponent(head)}`,
    { method: "POST" },
  );
  if (!response.ok) {
    throw new Error(
      generateErrorMessage(
        response.status,
        response.headers.get("Retry-After"),
      ),
    );
  }
  return (await response.json()) as ExplainResult;
}

export function useGenerateExplanation(name: string) {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (head: string) => generateExplanation(name, head),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: exploreKeys.explain(name) }),
  });
}
