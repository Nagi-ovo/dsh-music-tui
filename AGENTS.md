# AGENTS.md

`dsh-music-tui` is a small Cordis companion plugin for dsh-TUI. It controls an
already-running YesPlayMusic TUI through the public `ypm` CLI; it does not
connect to YesPlayMusic's private socket and does not modify either host.

## Boundaries

- Keep the first release limited to `/music` and one `tuiStatus` contribution.
- Treat `ypm` output as untrusted: validate JSON, strip terminal controls, and
  keep process output bounded.
- Invoke bounded `ypm` requests with `execFile`; use `spawn` only for its
  long-lived NDJSON stream. Always pass an argv array with `shell: false`.
- Do not write music state into DSH session events. DSH's command registry owns
  its normal `command/run` and `command/done` lifecycle records.
- Every timer, subprocess, status entry, and command registration must be
  released with the owning Cordis activation.
- Source is pure ESM TypeScript. Relative imports include `.js`; use two spaces,
  single quotes, and no semicolons.
- Edit `src/`, never generated `lib/`. Do not commit, tag, push, or publish
  unless the user explicitly asks.

## Verification

```sh
pnpm install --frozen-lockfile
pnpm verify
```
