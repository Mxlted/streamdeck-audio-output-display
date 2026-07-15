# Default Audio Device (Stream Deck Plugin)

A Windows Stream Deck plugin that displays the current default Windows audio output device on a key, plus actions for setting the default output or input device. The display key updates automatically when Windows changes the default device, and you can press it at any time to force a re-detect.

## [Overview](#overview) · [Requirements](#requirements) · [Installation](#installation) · [Build from source](#build-from-source) · [Troubleshooting](#troubleshooting)

## Overview

This plugin reads the current default audio render endpoint from Windows and renders its friendly name on a Stream Deck key. It also includes dedicated key actions for setting the default output or input device by endpoint ID, with exact friendly-name recovery when an ID changes.

The displayed name stays in sync without polling: a long-running PowerShell + C# subprocess registers an `IMMNotificationClient` callback with the Windows Core Audio API, reports endpoint events in real time, and answers default-device name requests without launching a new PowerShell process for every refresh.

### Features

- Shows the current default Windows audio output device on the key.
- Sets a configured output or input device as both the normal default and the communications default.
- Setter actions show a dropdown of currently available devices; output actions list output devices and input actions list input devices.
- Setter actions save both endpoint ID and friendly name. The active endpoint ID is authoritative; exact friendly-name matching recovers from ID changes after a replug or driver update.
- Reactive updates: the key refreshes automatically when Windows changes the default device, when devices are added or removed, or when device state changes.
- Press the key at any time to force a manual re-detect.
- Burst events (e.g. unplugging a headset, which fires several callbacks back-to-back) are coalesced into one detect via a 250 ms debounce.
- Concurrent appearance, settings, key, and watcher refreshes share one in-flight detection. If an endpoint changes during that read, exactly one follow-up read runs.
- The last successful output name is cached in Stream Deck global settings, rendered immediately after restart, and refreshed in the background.
- Display action property inspector options:
  - `customLabel`: override the auto-detected name with a fixed string.
  - `maxLength`: truncate the displayed name at a chosen length.
  - `aggressiveShorten`: strip driver-style suffixes such as `(Realtek(R) Audio)`.
  - `nameStyle`: choose how to render `Friendly (Driver)` device names.
    - `role` (default): show only the role part, e.g. `Speakers`.
    - `model`: show only the driver/model part, e.g. `Realtek(R) Audio`.
    - `full`: show both, cleaned up.
- Setter action property inspector:
  - One device dropdown populated from the currently active Windows input or output endpoints.
- Detection strategy with one overall 5-second deadline:
  1. Request the current friendly name from the persistent watcher.
  2. Fall back to one-shot PowerShell + embedded C# Core Audio COM.
  3. Use a bounded, best-effort Registry fallback as the final option.
- Cached global settings are hydrated before the first automatic display key starts the watcher, reducing cold-start pressure on Stream Deck.
- The watcher runs only while at least one display key needs automatic detection (custom-label keys do not start it), must emit `READY` within 7 seconds, stops after 30 idle seconds, and auto-respawns with 1, 2, 5, 10, and 30-second backoff.
- Child-process output is capped, and Windows system executables are launched by absolute path.
- File logging defaults to `INFO`; set `DEFAULT_AUDIO_DEBUG=1` for custom debug logs and SDK trace logs.

### Tech stack

- Elgato Stream Deck manifest SDK v2 with the official `@elgato/streamdeck` 2.x Node SDK.
- TypeScript, bundled with Rollup to a single ES module.
- Node.js runtime (Stream Deck-bundled Node 24).
- PowerShell with embedded C# (`Add-Type`) calling the Windows Core Audio COM API for the persistent watcher/broker and one-shot fallback operations.
- Windows Registry fallback via `reg.exe`.

There is no C++ or native addon. The plugin runs on Stream Deck's bundled Node 24 runtime, with no `node-gyp` or `binding.gyp` step. All Windows API access happens through PowerShell child processes, so there is no native ABI risk when Stream Deck updates its Node runtime.

### Platform support

- Windows only. Minimum Windows 10 (per `manifest.json`).
- Stream Deck software 7.1 or newer (per `manifest.json`).

### Requirements

- Stream Deck application 7.1+.
- Windows 10 or newer.

## Installation

This is the recommended path for everyday users.

1. Download the latest `.streamDeckPlugin` file from the Releases page:
   https://github.com/Mxlted/streamdeck-audio-output-display/releases
2. Double-click the downloaded file. The Stream Deck application will prompt to install the plugin.
3. In the Stream Deck app, open the Actions list and drag **Default Audio**, **Set Default Output**, or **Set Default Input** onto a key.
4. (Optional) Open the **Default Audio** property inspector to configure display options:
   - **Custom label** to force a fixed string.
   - **Max length** to control truncation.
   - **Aggressive shorten** to strip driver suffixes.
   - **Name style** to pick `role`, `model`, or `full`.

For setter actions, pick the device from the dropdown. Pressing the key sets that device for all Windows audio roles, including communications.

## Build from source

This section is for contributors and developers who want to build the plugin locally.

### Prerequisites

- Node.js 24 or newer. The repository's `.nvmrc` selects Node 24.
- npm (ships with Node).
- Stream Deck application 7.1+ installed for local testing.
- Elgato Stream Deck CLI for packaging and linking, available via `npx @elgato/cli` or installed globally.

There is no native build toolchain required. The repo has no `binding.gyp`, no CMake configuration, and no C++ sources to compile. Visual Studio Build Tools and Python are not needed.

### Clone

```bash
git clone https://github.com/Mxlted/streamdeck-audio-output-display.git
cd streamdeck-audio-output-display
```

### Install dependencies

```bash
npm install
```

For a full local verification pass:

```bash
npm run check
```

Individual verification commands are also available:

```bash
npm run typecheck
npm test
npm run build
npm run validate
```

### Build the plugin

Compiles `src/plugin.ts` and bundles it to `com.nathan.defaultaudio.sdPlugin/bin/plugin.js`.

```bash
npm run build
```

### Watch mode (rebuild on save and restart the plugin)

```bash
npm run watch
```

### Validate the plugin manifest and structure

```bash
npm run validate
```

### Package into a distributable `.streamDeckPlugin` file

```bash
npm run package
```

This builds and validates first, then invokes `streamdeck pack com.nathan.defaultaudio.sdPlugin` and produces a `.streamDeckPlugin` bundle suitable for distribution.

### Install the locally built plugin for testing

Link the in-tree `com.nathan.defaultaudio.sdPlugin` directory into the Stream Deck application:

```bash
npm run link
```

To force the plugin to reload after a manual change:

```bash
npm run restart
```

## Project layout

```
.nvmrc                         Node 24 development baseline.
src/
  plugin.ts                  Entry point: logger init, action registration, watcher start, SDK connect, shutdown handlers.
  actions/audio-device.ts    The Stream Deck action class (key lifecycle, refresh logic, debounced refreshAll).
  actions/set-default-device.ts Stream Deck actions for setting default output/input devices.
  audio/detector.ts          Watcher-first detector with bounded fallbacks.
  audio/default-device-setter.ts PowerShell-backed runner for setting default endpoints.
  audio/process-runner.ts    Bounded child-process runner and Windows executable paths.
  audio/powershell-script.ts One-shot detection PowerShell + C# COM script payload.
  audio/script-stager.ts     Shared verified staging for PowerShell payloads.
  audio/set-default-script.ts Setter PowerShell + C# payload using Core Audio policy COM.
  audio/watcher.ts           READY-aware watcher and request/response broker manager.
  audio/watcher-script.ts    Watcher payload for notifications and default-name requests.
  utils/logger.ts            File-based logger.
  utils/name-shortener.ts    Display-name formatting helpers.
com.nathan.defaultaudio.sdPlugin/
  manifest.json              Stream Deck plugin manifest.
  bin/plugin.js              Build output (created by Rollup).
  ui/audio-device.html       Display action property inspector.
  ui/audio-device.js         Display inspector settings behavior.
  ui/pi-connection.js        Shared inspector WebSocket connection helper.
  ui/property-inspector.css  Local inspector styling.
  ui/set-default-device.html Setter action property inspector.
  ui/set-default-device.js   Setter device-list and settings behavior.
  imgs/                      Plugin and action icons.
tests/                       Unit and Windows watcher integration tests.
.github/workflows/ci.yml     Windows Node 24 CI.
```

## Architecture

```
Stream Deck app
   |   (WebSocket, @elgato/streamdeck SDK)
   v
plugin.js (Node 24, Stream Deck-bundled)
   |
   +-- AudioDeviceAction      handles key events, calls refresh / scheduleRefreshAll
   |
   +-- SetDefault...Action    handles input/output setter key presses
   |
   +-- AudioDetector          asks the watcher first; one-shot process is fallback only
   |        |
   |        v
   |     PowerShell + C# Add-Type --> Core Audio COM (IMMDeviceEnumerator)
   |
   +-- AudioDefaultDeviceSetter
   |        |
   |        v
   |     PowerShell + C# Add-Type --> Core Audio policy COM (IPolicyConfig)
   |
   +-- AudioWatcher           manages one lazy long-lived powershell.exe
            |
            v
         PowerShell + C# Add-Type --> IMMNotificationClient plus request/response
                                       default-name resolver. Events and results
                                       return to Node over stdout.
```

The watcher subprocess handles commands on stdin. The plugin sends `STOP\n` on shutdown for a graceful unregister; if it does not exit within 500 ms, it is terminated. It is not kept running for setter-only configurations or while the display action has been absent for 30 seconds.

## Troubleshooting

Plugin logs are written to `<plugin-install-dir>/logs/plugin.log`, with up to three rotated files of 1 MiB each. Stream Deck's own SDK trace logs are written alongside.

- **Key shows `Unknown` or `…`**: persistent, one-shot PowerShell, and registry detection all failed. Check the log for the underlying cause. A previously cached name remains visible when possible.
- **Reactive updates stop working but press-to-refresh still works**: the watcher subprocess crashed and is in respawn backoff. The log will show `Watcher · respawning in <delay>ms`. After up to 30 s the next attempt runs; if it keeps failing the underlying cause (usually a Core Audio COM failure or PowerShell startup error) is logged.
- **First refresh is slower than later refreshes**: the watcher performs one cold embedded C# `Add-Type` compilation. Normal refreshes then reuse that process; the one-shot script compiles only when the watcher fallback is required.
- **`%TEMP%` was cleared by a cleanup tool**: the detector, setter, and watcher re-stage their `.ps1` payload on the next call, so this self-heals.

## License

Released under the MIT License. See [LICENSE](./LICENSE) for the full text.
