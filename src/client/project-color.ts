import { ProjectIconColor, type OrchestrationProjectShell } from "@t3tools/contracts";
import { theme } from "./theme";

// Port of projectColor, apps/web/src/projectIdentity.ts. Literal order matches web's color list.
function colorFromTitle(title: string): ProjectIconColor {
  const colors = ProjectIconColor.literals;
  const seed = title.normalize("NFKC").trim().toLocaleLowerCase("en-US") || "project";
  let index = 0;
  for (const glyph of seed) {
    index = (index * 31 + (glyph.codePointAt(0) ?? 0)) % colors.length;
  }
  return colors[index] ?? "blue";
}

/**
 * The color of a project's icon on web (the theme holds web's list): its saved icon, or else the one generated from its title.
 * An emoji icon has no color, so that project keeps the sidebar's muted text.
 */
export function projectColor(project: Pick<OrchestrationProjectShell, "title" | "projectIcon">) {
  const icon = project.projectIcon;
  if (icon?.kind === "emoji") return theme.muted;
  return theme.project[icon?.color ?? colorFromTitle(project.title)];
}
