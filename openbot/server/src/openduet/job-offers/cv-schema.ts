import { z } from "zod";

/**
 * The master CV: the only source of text for every tailored CV. Written by its owner, never by the model.
 * Ids are stable slugs, unique across the whole document, so a tailoring answer can point at them.
 */

export const MAX_MASTER_BYTES = 64 * 1024;
const ID = /^[a-z0-9-]{1,40}$/;
const MONTH = /^\d{4}-(0[1-9]|1[0-2])$/;

const id = z.string().regex(ID);
const text = (max: number) => z.string().trim().min(1).max(max);
const https = z
  .string()
  .trim()
  .url()
  .refine((u) => u.startsWith("https://"), "https only");

const bullet = z.object({ id, text: text(300) }).strict();
const experience = z
  .object({
    id,
    role: text(120),
    company: text(120),
    start: z.string().regex(MONTH),
    end: z.string().regex(MONTH).nullable(),
    context: text(600).optional(),
    bullets: z.array(bullet).min(1).max(12),
    environment: z.array(text(60)).max(30).default([]),
  })
  .strict();
const skillGroup = z
  .object({ id, group: text(60), items: z.array(text(60)).min(1).max(30) })
  .strict();

export const cvMasterSchema = z
  .object({
    header: z
      .object({
        name: text(120),
        email: z.string().trim().email(),
        phone: text(40).optional(),
        linkedin: https.optional(),
        location: text(120).optional(),
      })
      .strict(),
    titles: z.array(text(120)).min(1).max(4),
    profiles: z.array(text(900)).min(1).max(3),
    certifications: z.array(z.object({ year: z.number().int().min(1990).max(2100), name: text(160) }).strict()).max(20),
    experiences: z.array(experience).min(1).max(12),
    skills: z.array(skillGroup).min(1).max(12),
    languages: z.array(z.object({ name: text(40), level: text(60) }).strict()).max(6),
  })
  .strict()
  .superRefine((cv, ctx) => {
    const seen = new Set<string>();
    const ids = [
      ...cv.experiences.flatMap((e) => [e.id, ...e.bullets.map((b) => b.id)]),
      ...cv.skills.map((s) => s.id),
    ];
    for (const value of ids) {
      if (seen.has(value)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `duplicate id ${value}` });
      seen.add(value);
    }
  });

export type CvMaster = z.infer<typeof cvMasterSchema>;
export type CvExperience = CvMaster["experiences"][number];

/** Parses a master and checks its size; throws the zod error so a route can name the first bad path. */
export function parseMaster(value: unknown): CvMaster {
  if (Buffer.byteLength(JSON.stringify(value ?? null), "utf8") > MAX_MASTER_BYTES) throw new Error("master_too_large");
  return cvMasterSchema.parse(value);
}
