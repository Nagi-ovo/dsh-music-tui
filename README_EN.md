# dsh-music-tui

View and control an already-running YesPlayMusic TUI from dsh-TUI. The plugin
provides the `/music` command family and a compact bar above the prompt. It
changes neither DeepSeek Harness, dsh-TUI, nor YesPlayMusic, and never starts
the player automatically.

## Features

- `/music` or `/music show`: open the music bar (hidden by default)
- `/music hide`: close the music bar
- `/music status`: show one detailed title, artist, album, and progress result
- `/music toggle`: send play/pause toggle
- `/music next`: send next track
- `/music prev`: send previous track
- `/music seek <seconds>`: jump to an absolute position, for example `/music seek 90.5`
- Show artwork, title, artist, progress, a live spectrum, and previous/play-pause/next/close controls

In fullscreen mode, mouse controls mirror slash commands: click the progress
gauge to seek, or drag for a local preview and send one seek on release. Use
`/music seek <seconds>` in inline mode. Controls are temporarily disabled
while an action is pending. Changing track or pausing never opens or closes the
bar. On hosts with the rich status-view capability, the responsive bar uses at
most three rows and preserves controls before detail on narrow terminals.
Older hosts have no persistent line; `/music` returns one detailed result.
Button glyphs follow YPM's `icons = "unicode" | "nerd"` setting and safely
fall back to Unicode when an older YPM build does not report it.
When the host supports Kitty graphics, artwork is shown as a smooth image.
Other terminals, inline and accessibility modes, and terminal multiplexers
automatically use the same-size half-block thumbnail with no extra setup.
The real audio spectrum is subscribed only at 80 columns or wider. It uses
12/18/24 cells at 80/96/120 columns, then adds one cell for every two columns
up to 48 cells. Narrowing releases this plugin's stream,
so YPM can stop the analyzer when its own spectrum is hidden. Compact `blocks`, `led`, `braille`,
and `shade` styles are built in, with an option to follow matching YPM styles.

Control responses say that a command was sent, not that playback has already
changed. The YesPlayMusic CLI acknowledgement only confirms receipt; the plugin
then refreshes status instead of treating the acknowledgement as final state.
The bar remains visible with a restart hint while the player is offline. If YPM
claims to be playing while its remote position does not advance for six seconds,
the bar suppresses the potentially synthetic spectrum and reconnects after recovery.

## Requirements

- Node.js `^22.19 || >=24`
- [dsh-TUI](https://github.com/ccch1mneyyy/dsh-TUI) `>=0.9.2 <0.11.0`
- [YesPlayMusic TUI](https://github.com/nagi-studio/YesPlayMusic) and its `ypm`
  CLI (currently verified with `ypm 0.11.0`; live spectrum requires this version)
- macOS or Linux; `ypm` TUI remote control uses a local Unix socket

Confirm that `ypm` is on `PATH`:

```sh
ypm --version
```

## Installation

This release is distributed through GitHub Releases. Install the tagged
checkout locally:

```sh
git clone --branch v0.1.0 --depth 1 https://github.com/Nagi-ovo/dsh-music-tui.git
cd dsh-music-tui
pnpm install --frozen-lockfile
pnpm build
dsh plugin --profile dsh-tui add "$PWD"
```

For development, omit `--branch v0.1.0 --depth 1` to use the latest branch.

Start YesPlayMusic TUI in another terminal or in the background, then start DSH:

```sh
dsh --profile dsh-tui
```

No YesPlayMusic source change or in-repository plugin installation is needed.
This plugin never starts or stops YesPlayMusic for you.

Bar visibility belongs to the current TUI. Running `/music` in one TUI does
not open the bar in another; playback controls from every TUI still target the
same YesPlayMusic TUI instance.

## Configuration

`cordis.patch.yml` provides these defaults:

| Key | Default | Purpose |
| --- | --- | --- |
| `executable` | `ypm` | CLI name or absolute path |
| `showStatus` | `true` | Enable the bar opened by `/music`; it still starts hidden |
| `pollIntervalMs` | `3000` | Online polling interval (1000 to 60000 ms) |
| `timeoutMs` | `3000` | Hard deadline per CLI call (250 to 30000 ms) |
| `spectrumStyle` | `follow` | `off` / `follow` / `blocks` / `led` / `braille` / `shade` |

With `showStatus: false`, no bar is registered. `/music` and `/music show` then
degrade to one detailed result; status and playback controls remain available.
The same fallback applies when the host lacks rich views or rejects the view
because of a key conflict or row budget; no background polling starts.

Override the complete row configuration in the profile's own
`cordis.patch.yml`:

```yaml
- id: dsh-music-tui
  config:
    executable: /absolute/path/to/ypm
    showStatus: true
    pollIntervalMs: 3000
    timeoutMs: 3000
    spectrumStyle: follow
```

## Architecture and trust boundary

```text
dsh-TUI /music + status
          │
          ▼
  @dsh-tui-ecosystem/music
          │ execFile / spawn(argv), no shell
          ▼
       ypm --json --tui …
          │
          ▼
  running YesPlayMusic TUI
```

- The plugin only invokes the public `ypm` CLI; it does not connect to the
  private Unix socket.
- The target is always TUI. It never guesses between GUI and TUI instances.
- Playback state is not written to the DSH session log. Only the command
  registry's normal `command/run` and `command/done` records are produced.
- External JSON, stderr, and metadata are validated, stripped of terminal
  controls, and bounded before display.
- After the bar registers successfully, status is read every three seconds by
  default. Playing progress advances locally once per second and freezes while
  paused. One failed read retains the previous state; two consecutive failures
  clear it. Offline polling then backs off.
- The spectrum subscribes to the public
  `ypm --json --tui spectrum --fps 12` NDJSON stream only while the bar is
  visible, a track exists, and the terminal is at least 80 columns wide. The
  protocol carries 32 bins bounded from 0 to 255, never PCM or a private socket.
  Disconnects clear stale pixels and reconnect with bounded backoff; hiding,
  narrowing, or unloading aborts the child process.
- `follow` accepts YPM's `blocks`, `led`, `braille`, and `shade` names and
  safely falls back to `blocks` for other styles. Duplicate frames do not
  trigger redundant TUI renders.
- Newer `ypm` builds explicitly advertise seeking with `seekable` and project
  the user's selected glyph palette through `iconStyle`. Older output keeps
  progress readable but non-interactive and uses Unicode controls.
- Newer `ypm` builds may return `coverUrl`. The plugin downloads JPEG or PNG
  only over HTTPS from `music.126.net` or its subdomains, identifies the real
  file signature when CDN headers are wrong, revalidates every redirect, and
  caps requests at two seconds, 256 KiB, and 1024×1024 pixels. Failure leaves a placeholder.
- Artwork is fetched only when its URL changes and the in-memory cache holds at
  most 16 covers. Text and controls continue to work with older `ypm` output
  that has no `coverUrl`.
- The plugin decodes artwork into 96×96 RGBA and also builds a 6×3 cell
  fallback. Kitty probing, upload, placement, and cleanup remain host-owned;
  the plugin never writes terminal escape sequences directly.
- Unload clears timers, commands, the bar, artwork requests, and active child
  processes.
- The rich status view is feature-detected without raising the
  `dsh-TUI ^0.9.2` compatibility floor. Hosts without it retain one-shot
  `/music` details and playback controls, with no persistent status or polling.
- Today's DSH profile loader mounts third-party plugins as Cordis bundles. When
  no verified Component identity exists, command registration uses the
  documented C-070 in-process compatibility path. The host entry in
  `dsh-plugin.json` is a separate standard FacetModule; when adapter-dsh is
  present, it claims `/music` before the legacy Cordis registration yields,
  preventing duplicate registration. Both paths share the command
  implementation and configured controller.

The current trust model is `trusted-in-process`: manifest permissions support
compatibility, authorization, and audit; they are not a process sandbox.

## Development and verification

```sh
pnpm install --frozen-lockfile
pnpm verify
```

Install the local checkout into a profile:

```sh
dsh plugin --profile dsh-tui add "$PWD"
```

Then test show/hide/status/toggle/next/prev/seek, fullscreen progress click and drag,
32/60/80/96/120-column layouts and all four spectrum styles, legacy-host fallback,
offline, missing-`ypm`, and plugin-unload behavior.

## License

MIT
