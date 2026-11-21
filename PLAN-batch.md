# Plan: show tools from one model call as one collapsible "Batch call" row
Base: batch-call (tercet, from main b8f3725) + batch-call (fork ~/Projects/Side/t3code, from sao f9cdd6887)
Test baseline: tercet `scripts/check`; fork `vp test run` on the Claude adapter tests
Family: claude (coordinator and workers: claude-opus-5-5 medium, Sao's choice)

Data finding (2026-11-21): tool turn items carry only their toolu_ id; the Claude message id
appears only on reasoning items (`msg_…:thinking:0`), and adaptive thinking often skips them.
Timing alone (next tool starts < 0.8s after the previous one ends), checked against the Claude logs
for 229 adjacent tool pairs in 12 threads: 0 false merges, but it missed 12 of 50 real batches.
Sao chose: fork stamps the message id on tool items, tercet groups by it, with timing as a fallback.
Carrier: `nativeItemRef.fingerprint = "claude-message:<msg id>"`. That field is already optional in
OrchestrationV2ProviderRef upstream and in the fork, so neither repo's contracts change and the
vendored upstream schema still decodes it.

- [x] 1. Fork: Claude adapter stamps the assistant message id on tool items
  Tier: worker
  After: -
  Touches: ~/Projects/Side/t3code-wt/batch-call/apps/server/src/orchestration-v2/Adapters/ClaudeAdapterV2.ts (+ its test file)
  Files: ClaudeAdapterV2.ts buildToolCallArtifacts (~4337), its 4 callers (~5625, 5674, 5862, 7636), ActiveClaudeToolCall, the tool_use block handling of assistant SDK messages
  Done when: new adapter test (2 tool_use blocks in one assistant message -> both items share fingerprint "claude-message:<id>"; a later message's tool gets a different one) passes + existing ClaudeAdapterV2 tests pass + server typecheck
- [ ] 2. Tercet: Batch call rows in workMessages
  Tier: worker
  After: -
  Touches: src/client/work-log.ts, src/client/work-log.test.tsx
  Files: work-log.ts workMessages (~222-306), isGroupable, groupSummary, summarizeToolGroup import; work-log.test.tsx style
  Done when: `bun test src/client/work-log.test.tsx` passes with the acceptance cases; `bun run typecheck` clean
- [ ] 3. Coordinator: merge, scripts/check, decisions.md entry, snapshot of the example thread collapsed + expanded
  Tier: coordinator
  After: 1,2
