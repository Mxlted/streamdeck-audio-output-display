# Default Audio Device (Stream Deck Plugin)

A Windows Stream Deck plugin that displays the current default Windows audio output device on a key, plus actions for setting the default output or input device. The display key updates automatically when Windows changes the default device, and you can press it at any time to force a re-detect.

## [Overview](#overview) · [Requirements](#requirements) · [Installation](#installation) · [Build from source](#build-from-source) · [Troubleshooting](#troubleshooting)

## Overview

This plugin reads the current default audio render endpoint from Windows and renders its friendly name on a Stream Deck key. It also includes dedicated key actions for setting the default output or input device by friendly-name matching.

The displayed name stays in sync without polling: a long-running PowerShell + C# subprocess registers an `IMMNotificationClient` callback with the Windows Core Audio API, and reports default-device, hot-plug, and state-change events back to the plugin in real time.

### Features

- Shows the current default Windows audio output device on the key.
- Sets a configured output or input device as both the normal default and the communications default.
- Setter actions show a dropdown of currently available devices; output actions list output devices and input actions list input devices.
- Setter actions save the selected friendly name first, with the endpoint ID kept behind the scenes as a tie-breaker/fallback.
- Reactive updates: the key refreshes automatically when Windows changes the default device, when devices are added or removed, or when device state changes.
- Press the key at any time to force a manual re-detect.
- Burst events (e.g. unplugging a headset, which fires several callbacks back-to-back) are coalesced into one detect via a 250 ms debounce.
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
- Detection strategy with hard timeouts and retry:
  1. PowerShell + embedded C# Core Audio COM (`IMMDeviceEnumerator` / `GetDefaultAudioEndpoint`).
  2. Retry of the PowerShell path once on transient failure.
  3. Windows Registry fallback that reads `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render`.
- Watcher subprocess auto-respawns with exponential backoff (1, 2, 5, 10, 30 s) if it crashes, and re-stages the script if `%TEMP%` is cleared between runs.
- File-based plugin logging under `<plugin-dir>/logs`, plus SDK trace logs.

### Tech stack

- Elgato Stream Deck SDK v2 (`@elgato/streamdeck`).
- TypeScript, bundled with Rollup to a single ES module.
- Node.js runtime (Stream Deck-bundled Node 20).
- PowerShell with embedded C# (`Add-Type`) calling the Windows Core Audio COM API for both one-shot detection and the long-running `IMMNotificationClient` watcher.
- Windows Registry fallback via `reg.exe`.

There is no C++ or native addon. The plugin runs on whatever Node 20 build Stream Deck ships, with no `node-gyp` or `binding.gyp` step. All Windows API access happens through PowerShell child processes, so there is no native ABI risk when Stream Deck swaps Node versions.

### Platform support

- Windows only. Minimum Windows 10 (per `manifest.json`).
- Stream Deck software 6.5 or newer (per `manifest.json`).

### Requirements

- Stream Deck application 6.5+.
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

- Node.js 20.x (the plugin runs on Stream Deck's bundled Node 20 runtime; the build also works with Node 20+).
- npm (ships with Node).
- Stream Deck application 6.5+ installed for local testing.
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

This invokes `streamdeck pack com.nathan.defaultaudio.sdPlugin` and produces a `.streamDeckPlugin` bundle suitable for distribution.

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
src/
  plugin.ts                  Entry point: logger init, action registration, watcher start, SDK connect, shutdown handlers.
  actions/audio-device.ts    The Stream Deck action class (key lifecycle, refresh logic, debounced refreshAll).
  actions/set-default-device.ts Stream Deck actions for setting default output/input devices.
  audio/detector.ts          PowerShell-first detector with registry fallback.
  audio/default-device-setter.ts PowerShell-backed runner for setting default endpoints.
  audio/powershell-script.ts One-shot detection PowerShell + C# COM script payload.
  audio/set-default-script.ts Setter PowerShell + C# payload using Core Audio policy COM.
  audio/watcher.ts           Long-running watcher subprocess manager (spawn, parse, respawn, stop).
  audio/watcher-script.ts    Watcher PowerShell + C# payload that registers IMMNotificationClient.
  utils/logger.ts            File-based logger.
  utils/name-shortener.ts    Display-name formatting helpers.
com.nathan.defaultaudio.sdPlugin/
  manifest.json              Stream Deck plugin manifest.
  bin/plugin.js              Build output (created by Rollup).
  ui/audio-device.html       Display action property inspector.
  ui/set-default-device.html Setter action property inspector.
  imgs/                      Plugin and action icons.
```

## Architecture

```
Stream Deck app
   |   (WebSocket, @elgato/streamdeck SDK)
   v
plugin.js (Node 20, Stream Deck-bundled)
   |
   +-- AudioDeviceAction      handles key events, calls refresh / scheduleRefreshAll
   |
   +-- SetDefault...Action    handles input/output setter key presses
   |
   +-- AudioDetector          spawns powershell.exe per detect (one-shot)
   |        |
   |        v
   |     PowerShell + C# Add-Type --> Core Audio COM (IMMDeviceEnumerator)
   |
   +-- AudioDefaultDeviceSetter
   |        |
   |        v
   |     PowerShell + C# Add-Type --> Core Audio policy COM (IPolicyConfig)
   |
   +-- AudioWatcher           manages one long-lived powershell.exe
            |
            v
         PowerShell + C# Add-Type --> IMMNotificationClient registered with the
                                       Core Audio enumerator; emits one tab-
                                       delimited line per change event back to
                                       Node over stdout. Node debounces and
                                       calls refreshAll().
```

The watcher subprocess blocks on stdin. The plugin sends `STOP\n` on shutdown for a graceful unregister; if it does not exit within 500 ms, it is `SIGKILL`'d. Idle resource cost is roughly 30 to 50 MB RAM and approximately 0% CPU until Windows fires an event.

## Troubleshooting

Plugin logs are written to `<plugin-install-dir>/logs/plugin.log`, with up to three rotated files of 1 MiB each. Stream Deck's own SDK trace logs are written alongside.

- **Key shows `Unknown` or `…`**: detection failed on both PowerShell and registry paths. Check the log for the underlying cause (most often PowerShell execution policy or a locked-down environment that blocks `reg.exe`).
- **Reactive updates stop working but press-to-refresh still works**: the watcher subprocess crashed and is in respawn backoff. The log will show `Watcher · respawning in <delay>ms`. After up to 30 s the next attempt runs; if it keeps failing the underlying cause (usually a Core Audio COM failure or PowerShell startup error) is logged.
- **Plugin appears to hang on first launch**: the embedded C# `Add-Type` compile cache is cold; first detect can take 3 to 5 seconds on a fresh Windows session. Subsequent detects are fast.
- **`%TEMP%` was cleared by a cleanup tool**: both the detector and the watcher re-stage their `.ps1` payload on the next call, so this self-heals.

## License

Released under the MIT License. See [LICENSE](./LICENSE) for the full text.
