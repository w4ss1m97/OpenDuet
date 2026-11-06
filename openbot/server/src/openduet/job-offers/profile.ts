import { createHash } from "node:crypto";
import { readFile, stat } from "node:fs/promises";
import { isAbsolute } from "node:path";
import type { CvStore } from "./cv-store";
import { masterToText } from "./cv-tailor";

/** Where the freelancer's profile text comes from. A DB-backed source can replace the file one later. */
export interface ProfileSource {
  text(ownerUserId: string): Promise<string | null>;
}

export const MAX_PROFILE_CHARS = 8_000;

export const profileHash = (profile: string): string => createHash("sha256").update(profile).digest("hex");

/** One file, read at every call. A missing, relative, empty or unreadable path gives null. */
export function createFileProfileSource(path: string | undefined): ProfileSource {
  return {
    async text() {
      if (!path || !isAbsolute(path)) return null;
      try {
        if (!(await stat(path)).isFile()) return null;
        const content = (await readFile(path, "utf8")).trim();
        return content ? content.slice(0, MAX_PROFILE_CHARS) : null;
      } catch {
        return null;
      }
    },
  };
}

/** The master CV in the database when the owner has one, else `fallback` (the file). */
export function createDbProfileSource(cvStore: Pick<CvStore, "getMaster">, fallback: ProfileSource): ProfileSource {
  return {
    async text(ownerUserId) {
      const master = await cvStore.getMaster(ownerUserId);
      return master ? masterToText(master.content).slice(0, MAX_PROFILE_CHARS) : fallback.text(ownerUserId);
    },
  };
}
