// Transitive closure of files under packages/{contracts,client-runtime,shared} reached from apps/tui/src,
// including type-only imports. Usage: bun closure.ts <repoRoot> [aliasesJson]
import { readFileSync, existsSync, statSync, readdirSync } from "node:fs";
import { join, dirname, resolve } from "node:path";
const root = process.argv[2]!;
const aliases: Record<string, string> = process.argv[3] ? JSON.parse(process.argv[3]) : {};
const pkgs: Record<string, { dir: string; exports: any }> = {};
for (const p of readdirSync(join(root, "packages"))) { if (!existsSync(join(root, "packages", p, "package.json"))) continue;
  const dir = join(root, "packages", p);
  const pj = JSON.parse(readFileSync(join(dir, "package.json"), "utf8"));
  pkgs[pj.name] = { dir, exports: pj.exports };
}
const re = /(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\s+from\s+)?["']([^"']+)["']|import\(\s*["']([^"']+)["']\s*\)/g;
const exts = ["", ".ts", ".tsx", "/index.ts"];
function file(p: string) { for (const e of exts) { const f = p + e; if (existsSync(f) && statSync(f).isFile()) return f; } return null; }
const external = new Map<string, number>();
const missing = new Set<string>();
function resolveSpec(spec: string, from: string): string | null {
  if (spec.startsWith(".")) return file(resolve(dirname(from), spec));
  const m = spec.match(/^(@t3tools\/[^/]+)(\/.*)?$/);
  if (m && pkgs[m[1]!]) {
    const { dir, exports } = pkgs[m[1]!]!;
    let sub = "." + (m[2] ?? "");
    sub = aliases[`${m[1]}${m[2] ?? ""}`] ?? sub;
    if (sub.endsWith(".ts")) return file(join(dir, sub));
    let ent = exports?.[sub];
    if (!ent) { for (const k of Object.keys(exports ?? {})) if (k.endsWith("/*") && sub.startsWith(k.slice(0, -1))) { const v = exports[k]; const t = typeof v === "string" ? v : v.types ?? v.default; ent = t.replace("*", sub.slice(k.length - 1)); } }
    const t = typeof ent === "string" ? ent : ent?.types ?? ent?.default ?? ent?.import;
    if (!t) { missing.add(spec); return null; }
    return file(join(dir, t));
  }
  const name = spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!;
  external.set(name, (external.get(name) ?? 0) + 1);
  return null;
}
const seen = new Set<string>(); const queue: string[] = [];
function walk(d: string) { for (const e of readdirSync(d, { withFileTypes: true })) { const p = join(d, e.name); if (e.isDirectory()) walk(p); else if (/\.tsx?$/.test(e.name)) queue.push(p); } }
walk(join(root, "apps/tui/src"));
const tuiExternal = new Map<string, number>();
while (queue.length) {
  const f = queue.pop()!; if (seen.has(f)) continue; seen.add(f);
  const src = readFileSync(f, "utf8");
  const isPkg = f.includes("/packages/");
  for (const m of src.matchAll(re)) {
    const spec = (m[1] ?? m[2])!;
    const before = new Map(external);
    const r = resolveSpec(spec, f);
    if (r) queue.push(r);
    if (!isPkg) for (const [k] of external) if (!before.has(k) || external.get(k) !== before.get(k)) tuiExternal.set(k, 1);
  }
}
const files = [...seen].filter((f) => f.includes("/packages/"));
const bytes = files.reduce((n, f) => n + statSync(f).size, 0);
const byPkg: Record<string, [number, number]> = {};
for (const f of files) { const p = f.split("/packages/")[1]!.split("/")[0]!; byPkg[p] ??= [0, 0]; byPkg[p][0]++; byPkg[p][1] += statSync(f).size; }
const tests = files.filter((f) => /\.test\.tsx?$/.test(f)).length;
console.log(JSON.stringify({ files: files.length, bytes, tests, byPkg, missing: [...missing], externalFromPackages: [...external.keys()].filter((k) => !tuiExternal.has(k)).sort(), externalAll: [...external.keys()].sort() }, null, 1));
