# Default Audio Device (Stream Deck Plugin)

A Windows Stream Deck plugin that displays the current default Windows audio output device on a key. Press the key to refresh the displayed name.

## [Overview](#overview) · [Requirements](#requirements) · [Installation](#installation) · [Build from source](#build-from-source)

## Overview

This plugin reads the current default audio render endpoint from Windows and renders its friendly name on a Stream Deck key. It is a display and refresh action; it does not switch or cycle audio devices.

### Features

- Shows the current default Windows audio output device on the key.
- Press the key to re-detect and refresh the displayed name.
- Property inspector options:
  - `customLabel`: override the auto-detected name with a fixed string.
  - `maxLength`: truncate the displayed name at a chosen length.
  - `aggressiveShorten`: strip driver-style suffixes such as `(Realtek(R) Audio)`.
  - `nameStyle`: choose how to render `Friendly (Driver)` device names.
    - `role` (default): show only the role part, e.g. `Speakers`.
    - `model`: show only the driver/model part, e.g. `Realtek(R) Audio`.
    - `full`: show both, cleaned up.
- Detection strategy with hard timeouts and retry:
  1. PowerShell + embedded C# Core Audio COM (`IMMDeviceEnumerator` / `GetDefaultAudioEndpoint`).
  2. Retry of the PowerShell path once on transient failure.
  3. Windows Registry fallback that reads `HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion\MMDevices\Audio\Render`.
- File-based plugin logging under `<plugin-dir>/logs`, plus SDK trace logs.

### Tech stack

- Elgato Stream Deck SDK v2 (`@elgato/streamdeck`).
- TypeScript, bundled with Rollup to a single ES module.
- Node.js runtime (Stream Deck-bundled Node 20).
- PowerShell with embedded C# (`Add-Type`) calling the Windows Core Audio COM API.
- Windows Registry fallback via `reg.exe`.

There is no C++ or native addon. The plugin runs on whatever Node 20 build Stream Deck ships, with no `node-gyp` or `binding.gyp` step.

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
3. In the Stream Deck app, open the Actions list and drag **Default Audio** onto a key.
4. (Optional) Open the property inspector for the key to configure display options:
   - **Custom label** to force a fixed string.
   - **Max length** to control truncation.
   - **Aggressive shorten** to strip driver suffixes.
   - **Name style** to pick `role`, `model`, or `full`.

Press the key at any time to re-detect the current default device.

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
  plugin.ts                 Entry point: logger init, action registration, SDK connect.
  actions/audio-device.ts   The Stream Deck action class (key lifecycle, refresh logic).
  audio/detector.ts         PowerShell-first detector with registry fallback.
  audio/powershell-script.ts Embedded PowerShell + C# COM script payload.
  utils/logger.ts           File-based logger.
  utils/name-shortener.ts   Display-name formatting helpers.
com.nathan.defaultaudio.sdPlugin/
  manifest.json             Stream Deck plugin manifest.
  bin/plugin.js             Build output (created by Rollup).
  ui/audio-device.html      Property inspector.
  imgs/                     Plugin and action icons.
```

## License

Released under the MIT License. See [LICENSE](./LICENSE) for the full text.
