import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHash } from "node:crypto";
import type { StudioLine, StudioDraft } from "../shared/studio";
type Role = NonNullable<StudioLine["speakerRole"]>;
export function applySpeakerRoles(
  line: StudioLine,
  roles: Map<string, { role: Role; reason?: string }>,
): StudioLine {
  if (line.speakerBasis === "manual") return line;
  const ids = line.sourceIds?.length
    ? line.sourceIds
    : [line.id.replace(/-w\d+$/, "")];
  const found = ids.map((id) => roles.get(id));
  if (!found.some(Boolean))
    return {
      ...line,
      speakerRole: line.speakerRole ?? "unknown",
      speakerBasis: line.speakerBasis ?? "unclassified",
    };
  const values = new Set(found.map((r) => r?.role ?? "unknown"));
  return {
    ...line,
    speakerRole: values.size === 1 ? [...values][0] : "unknown",
    speakerBasis: "semantic-context",
    speakerReason:
      values.size > 1
        ? "该句跨越多种声音来源，需回听拆分"
        : (found[0]?.reason ?? "逐句上下文归属，未使用声纹"),
  };
}
export async function loadSpeakerRoles(root: string, original: StudioLine[]) {
  const data = await readFile(
    join(root, "studio", "speaker-roles.json"),
    "utf8",
  )
    .then(JSON.parse)
    .catch((e) => {
      if (e.code === "ENOENT") return null;
      throw e;
    });
  const roles = new Map<string, { role: Role; reason?: string }>();
  if (!data) return roles;
  const hash = createHash("sha256")
    .update(JSON.stringify(original))
    .digest("hex");
  if (data.sourceHash !== hash) return roles; // Stale evidence is never applied to new text.
  if (!Array.isArray(data.items) || data.items.length !== original.length)
    throw new Error("字幕说话人结果未覆盖全片");
  const ids = new Set(original.map((l) => l.id));
  for (const item of data.items) {
    if (
      !ids.has(item.id) ||
      roles.has(item.id) ||
      !["host", "game", "unknown"].includes(item.role)
    )
      throw new Error("字幕说话人结果格式无效");
    roles.set(item.id, item);
  }
  return roles;
}
export function hydrateDraftRoles(
  draft: StudioDraft,
  roles: Map<string, { role: Role; reason?: string }>,
): StudioDraft {
  return {
    ...draft,
    clips: draft.clips.map((c) => ({
      ...c,
      subtitles: c.subtitles.map((l) => applySpeakerRoles(l, roles)),
      ...(c.subtitleSource
        ? {
            subtitleSource: c.subtitleSource.map((l) =>
              applySpeakerRoles(l, roles),
            ),
          }
        : {}),
    })),
  };
}
