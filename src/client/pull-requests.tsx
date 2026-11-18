import { createElement, Fragment, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import { useKeyboard } from "@opentui/react";
import { useLayout } from "./layout-context";
import type { TextareaRenderable, ScrollBoxRenderable } from "@opentui/core";
import type { PullRequestReviewVerdict } from "@t3tools/contracts";
import type { Actions } from "../actions";
import type { BranchTarget } from "./git-workflows.tsx";
import { workspaceCwd, workspaceKey } from "./git-workflows.ts";
import { diffFiles } from "./diff";
import { prKey, type PRSelection, type PullRequestWorkflow } from "./pull-requests.ts";
import { theme } from "./theme";

export function PullRequestPanel({ workflow, target, effects, close }: { workflow: PullRequestWorkflow; target?: BranchTarget; effects?: Actions; close: () => void }) {
  const state = useSyncExternalStore(workflow.subscribe, workflow.snapshot);
  const [selection, setSelection] = useState<PRSelection>();
  const [cursor, setCursor] = useState(0);
  const [editing, setEditing] = useState(false);
  const [confirm, setConfirm] = useState<"create" | "discussion" | PullRequestReviewVerdict>();
  const [file, setFile] = useState<number>();
  const [notice, setNotice] = useState("");
  const editor = useRef<TextareaRenderable>(null);
  const generation = useRef(0);
  const scroll = useRef<ScrollBoxRenderable>(null);
  const workspace = target && workspaceKey(target);
  // Phone sizes (the frame's narrow/short thresholds): buttons share wrapping rows instead of one each.
  const compact = useLayout().compact;
  const key = target && prKey(target, selection);
  useEffect(() => { setSelection(undefined); setEditing(false); setConfirm(undefined); setCursor(0); }, [workspace]);
  useEffect(() => {
    setFile(undefined); setNotice("");
    if (target) void workflow.refresh(target, selection);
    return () => { generation.current++; workflow.cancel(); };
  }, [workflow, workspace, selection]);
  const value = state.status === "ready" && state.target === key ? state.value : undefined;
  const list = value && "entries" in value ? value : undefined;
  const data = value && "detail" in value ? value : undefined;
  const diff = value && "sources" in value ? value : undefined;
  const files = diffFiles(diff?.sources.map((s) => s.diff).join("\n") ?? "");
  const busy = state.status === "loading";
  const refresh = () => { if (target) void workflow.refresh(target, selection); };
  const choose = (index: number) => {
    if (target && list?.entries[index]) { const request = ++generation.current;
      void workflow.selection(target, list.entries[index]!).then((chosen) => { if (request === generation.current) { setSelection(chosen); setCursor(0); } }).catch(() => { if (request === generation.current) setNotice("PR account unavailable. Check host authentication and refresh."); }); }
    else if (files[index]) setFile(index);
  };
  const back = () => {
    if (confirm) setConfirm(undefined);
    else if (editing) setEditing(false);
    else if (file !== undefined) setFile(undefined);
    else if (diff) refresh();
    else if (selection) { setSelection(undefined); setCursor(0); }
    else close();
  };
  const execute = () => {
    if (!target || !confirm) return;
    const action = confirm; setConfirm(undefined); setEditing(false);
    if (action === "create") void workflow.create(target);
    else if (selection) void workflow.submit(target, selection, action);
  };
  const external = (url: string) => {
    if (!effects?.openUrl) { setNotice("URL opener unavailable. Use Copy link."); return; }
    void effects.openUrl(url).catch(() => setNotice("Could not open URL. Check launcher or read-only settings; use Copy link."));
  };
  useKeyboard((event) => {
    if (event.defaultPrevented) return;
    if (event.name === "escape") { event.preventDefault(); back(); return; }
    if (editing) {
      if (event.ctrl && ["s", "a", "r", "e"].includes(event.name)) { event.preventDefault(); setConfirm(({ s: "discussion", a: "approve", r: "request-changes", e: "comment" } as const)[event.name as "s" | "a" | "r" | "e"]); setEditing(false); }
      return;
    }
    if (event.ctrl || event.meta) return;
    if (confirm) { if (event.name === "return") { event.preventDefault(); execute(); } return; }
    if (selection && event.name === "o") { event.preventDefault(); external(selection.url); }
    if (selection && event.name === "y") { event.preventDefault(); effects?.copy(selection.url); }
    if (selection && ["l", "u", "w", "W"].includes(event.sequence)) { event.preventDefault(); link(({ l: "link", u: "unlink", w: "watch", W: "unwatch" } as const)[event.sequence as "l" | "u" | "w" | "W"]); }
    if (event.name === "r") { event.preventDefault(); refresh(); }
    if (event.name === "return") { event.preventDefault(); choose(cursor); }
    if (event.name === "n" && !selection) { event.preventDefault(); setConfirm("create"); }
    if (event.name === "c" && selection) { event.preventDefault(); setEditing(true); }
    if (event.name === "d" && target && selection) { event.preventDefault(); void workflow.diff(target, selection); }
    const delta = ["up", "k"].includes(event.name) ? -1 : ["down", "j"].includes(event.name) ? 1 : 0;
    if (delta && (data || file !== undefined)) { event.preventDefault(); scroll.current?.scrollBy(delta); return; }
    if (delta) { event.preventDefault(); setCursor((n) => Math.max(0, Math.min((list?.entries.length ?? files.length) - 1, n + delta))); }
  });
  const button = (label: string, action: () => void) => <text flexShrink={0} fg={theme.accent} onMouseUp={(e) => { if (e.button === 0) action(); }}>{compact ? `${label} ` : label}</text>;
  const buttons = (...items: ReactNode[]) => compact ? createElement("box", { flexShrink: 0, flexDirection: "row", flexWrap: "wrap" }, ...items) : createElement(Fragment, null, ...items);
  const link = (action: "link" | "unlink" | "watch" | "unwatch") => { if (target && selection) void workflow.link(target, selection, action); };
  return <box position="absolute" left={0} top={0} width="100%" height="100%" border borderColor={theme.accent} backgroundColor={theme.canvas} flexDirection="column" title="Pull requests">
    {compact ? buttons(button("[Esc Back]", back), button("[r Refresh]", refresh)) : button("[Esc Back]", back)}
    <text flexShrink={0} fg={theme.plain}>{target ? `${workspaceCwd(target)} · thread ${target.threadId ?? "none"}` : "Select a thread first"}</text>
    {selection && <text flexShrink={0} fg={theme.strong}>{`${selection.ref.host} / ${selection.ref.repository} #${selection.ref.number}`}</text>}
    {!compact && button("[r Refresh]", refresh)}
    {busy && <text flexShrink={0} fg={theme.muted}>Loading / action pending… Closing cannot undo a write.</text>}
    {state.status === "error" && state.target === key && <text flexShrink={0} fg={theme.red}>{state.error.message}</text>}
    {notice && <text flexShrink={0} fg={theme.muted}>{notice}</text>}
    {confirm ? <box flexShrink={0} flexDirection="column">
      <text flexShrink={0} fg={theme.strong}>{confirm === "create" ? `Create PR for ${target?.branch} at ${target && workspaceCwd(target)}. Stock workflow may push this branch and generate PR text.` : `Submit ${confirm} to ${selection?.ref.repository} #${selection?.ref.number}. Body below.`}</text>
      <text flexShrink={0} fg={theme.plain}>{confirm === "create" ? "No automatic retry. Inspect host if result is uncertain." : key && workflow.draft(key)}</text>
      {button("[Enter Confirm submission]", execute)}
    </box> : editing ? <box minHeight={0} flexGrow={1} flexDirection="column">
      <text flexShrink={0} fg={theme.muted}>{compact ? "Draft · Esc saves" : "Draft · Esc saves · Ctrl+s post · Ctrl+e review · Ctrl+a approve · Ctrl+r changes"}</text>
      <textarea key={key} ref={editor} focused cursorColor={theme.strong} flexGrow={1} minHeight={2} initialValue={key ? workflow.draft(key) : ""} onContentChange={() => { if (key && editor.current) workflow.setDraft(key, editor.current.plainText); }} />
      {buttons(
        button("[Post discussion comment]", () => { setEditing(false); setConfirm("discussion"); }),
        button("[Comment review]", () => { setEditing(false); setConfirm("comment"); }),
        button("[Approve]", () => { setEditing(false); setConfirm("approve"); }),
        button("[Request changes]", () => { setEditing(false); setConfirm("request-changes"); }),
      )}
    </box> : <scrollbox ref={scroll} minHeight={0} flexGrow={1} scrollY scrollX={false}>
      {!selection && button("[n Create PR for current branch]", () => setConfirm("create"))}
      {list?.errors.map((e) => <text flexShrink={0} key={e.projectId} fg={theme.red}>{`${e.projectTitle}: PR listing unavailable. Check server Git host authentication.`}</text>)}
      {list?.providers.filter((p) => !p.configured).map((p) => <text flexShrink={0} key={p.host} fg={theme.muted}>{`${p.host}: configure Git host credentials in T3 Web.`}</text>)}
      {list && !list.entries.length && <text fg={theme.plain}>No PRs returned. Check host setup if unexpected.</text>}
      {list?.entries.map((entry, index) => <text flexShrink={0} key={`${entry.host}/${entry.repository}/${entry.number}`} fg={index === cursor ? theme.strong : theme.plain} bg={index === cursor ? theme.highlight : undefined} onMouseUp={() => choose(index)}>{`${index === cursor ? "› " : ""}#${entry.number} ${entry.title} · ${entry.state}${entry.isDraft ? " draft" : ""} · ${entry.checksState ?? "checks unknown"}`}</text>)}
      {list?.truncated && <text fg={theme.muted}>Listing limited to 100. Use T3 Web for more PRs.</text>}
      {selection && buttons(
        button("[y Copy link]", () => { effects?.copy(selection.url); setNotice(effects ? "Link copied" : "Clipboard unavailable"); }),
        button("[o Open PR]", () => external(selection.url)),
        button("[Open host diff]", () => external(`${selection.url}/files`)),
        button("[l Link to this thread]", () => link("link")),
        button("[u Unlink from this thread]", () => link("unlink")),
        button("[w Watch: enable thread notifications]", () => link("watch")),
        button("[W Unwatch: disable thread notifications]", () => link("unwatch")),
        button("[c Comment / review draft]", () => setEditing(true)),
        button("[d Local branch comparison]", () => { if (target) void workflow.diff(target, selection); }),
      )}
      {data && <>
        <text flexShrink={0} fg={theme.strong}>{`${data.detail.title}\n${data.detail.state}${data.detail.isDraft ? " · draft" : ""} · ${data.detail.mergeability}\n${data.detail.headBranch} → ${data.detail.baseBranch}\n+${data.detail.additions} −${data.detail.deletions}\n${data.detail.body}`}</text>
        <text flexShrink={0} fg={theme.accent}>Checks</text>
        {!data.checks?.checks.length && <text flexShrink={0} fg={theme.muted}>Checks unknown / none reported</text>}
        {data.checks?.checks.map((c, i) => <text flexShrink={0} key={i} fg={theme.plain} onMouseUp={() => { if (c.url) external(c.url); }}>{`${c.status} · ${c.name}${c.description ? ` · ${c.description}` : ""}`}</text>)}
        <text flexShrink={0} fg={theme.accent}>Discussion and reviews</text>
        {data.activity.comments.map((c) => <text flexShrink={0} key={c.id} fg={theme.plain}>{`${c.author?.login ?? "unknown"} · ${c.reviewState ?? c.kind}\n${c.body}`}</text>)}
        {data.activity.reviewThreads.map((t) => <text flexShrink={0} key={t.id} fg={theme.plain}>{`${t.path}:${t.line ?? "?"} · ${t.isResolved ? "resolved" : "unresolved"}${t.isOutdated ? " · outdated" : ""}\n${t.comments.map((c) => `${c.author?.login ?? "unknown"}: ${c.body}`).join("\n")}${t.nextCommentsCursor ? "\nMore replies on host" : ""}`}</text>)}
        {(data.activity.commentsTruncated || data.activity.reviewThreadsTruncated) && <text fg={theme.muted}>Discussion truncated. Open PR for full history.</text>}
      </>}
      {diff && <>
        <text flexShrink={0} fg={theme.muted}>Local branch comparison; may differ from remote PR. Enter/click a file; Esc back.</text>
        {(diff.incomplete || diff.sources.some((s) => s.truncated || s.patchesDeferred)) && <text fg={theme.red}>Comparison incomplete. Use host diff for full changes.</text>}
        {file === undefined ? files.map((f, i) => <text flexShrink={0} key={i} fg={cursor === i ? theme.accent : theme.plain} onMouseUp={() => setFile(i)}>{`${cursor === i ? "› " : ""}${f.path} +${f.additions} −${f.deletions}`}</text>) : files[file]?.lines.map((line, i) => <text flexShrink={0} key={i} fg={line.startsWith("+") ? theme.green : line.startsWith("-") ? theme.red : theme.plain}>{line}</text>)}
      </>}
    </scrollbox>}
  </box>;
}
