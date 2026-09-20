# Dedicated Summary Model Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a tested Pi extension that uses a fixed configured model for compaction without changing the conversation model.

**Architecture:** One before-compaction handler delegates to native compact() through an authenticated registry stream adapter. Global atomic JSON config and one setup/status command select the dedicated model. Errors cancel instead of falling through.

**Tech Stack:** TypeScript, Pi 0.86.0, Node test runner with tsx, GitHub Actions.

**Spec:** docs/design.md

## Global Constraints

- Target Pi 0.86.0 and Node >=22.
- Conversation model never changes. No cross-provider/account retry on errors.
- Credentials are managed by Pi, never copied or logged.
- Errors return cancel:true from the hook; no silent default compaction fallback.
- Native compaction preserves history, split turns, recent boundaries, usage and file metadata.
- Global config only; /tree branch summaries are outside scope.

### Task 1: Implement and test the extension

**Files:** Create src/index.ts (registration), src/config.ts (validation/persistence), src/compaction.ts (native adapter), tests/*.test.ts, package.json, package-lock.json, tsconfig.json.

**Interfaces:** Default extension factory takes ExtensionAPI. Config shape is `{enabled:boolean,provider:string,model:string}`. Config location is `join(getAgentDir(), 'summary-model.json')`; no config means setup required. Commands are `/summary-model status`, `select`, `set <provider> <modelId>`, `on`, `off`.

- [ ] Create package manifest with `pi.extensions: ["./src/index.ts"]`, optional `*` peer dependencies on Pi core packages, pinned 0.86.0 dev dependencies, tsx and TypeScript. Scripts: `test: tsx --test tests/*.test.ts`, `typecheck: tsc --noEmit`.
- [ ] Write failing behavioral tests using a fake registry stream and Pi's actual compact() function. Assertions include `{cancel:true}` on errors, unchanged active model, fixed target on every split summary request, `firstKeptEntryId` preservation, prior-summary/custom-instructions content and file metadata. Add blank/error/length/aborted/tool-call response cases; failed model/auth resolution; command/config validation and persistence.
- [ ] Run `npm test` and record the expected missing-implementation failure.
- [ ] Implement native compaction adapter. Resolve target with registry.find, validate configured auth, pass registry.streamSimple through compatible stream/context bridge. Disable retries in native compact(). Validate each response before native compact() accepts it; bounded categorized errors avoid raw provider payloads. Catch every ordinary hook failure and return `{cancel:true}`. Preserve abort signals.
- [ ] Implement strict global config load and atomic write with temporary file/rename; support concurrent different Pi processes by reading at each command/hook and snapshotting config for a running request. Do not overwrite malformed config silently.
- [ ] Implement command setup/status/on/off with exact IDs, available model picker, UI guards, actionable errors and status indicator. Do not use pi.setModel or write auth.json.
- [ ] Run focused tests, then `npm test` and `npm run typecheck`; fix failures and self-review. Commit only implementation-owned files and report tests.

### Task 2: Package, review, install and publish

**Files:** README.md, LICENSE, .gitignore, .github/workflows/ci.yml, docs/validation.md.

- [ ] Write Chinese README with installation, login, command examples, config format, error behavior, privacy (summary text goes to chosen provider), minimum Pi version and /tree limitation.
- [ ] Add Windows/Linux CI running `npm ci`, `npm run typecheck`, `npm test` on Node 22.
- [ ] Verify actual Pi loader sees extension command in an isolated process without a model request; record result.
- [ ] Independently review all source and tests. Fix concrete important findings and re-run affected checks.
- [ ] If existing official OAuth model metadata is unambiguous, install local package and configure that model, leaving reload to user. Otherwise ship setup command and state missing selection explicitly.
- [ ] Inspect tracked files and package dry run for credentials/config/logs. Commit final sources. Create private repository and push with `gh repo create loneshu7/pi-summary-model --private --source . --remote origin --push`.
- [ ] Verify remote URL, visibility and pushed SHA; report location, usage, validation and any live-test limits.
