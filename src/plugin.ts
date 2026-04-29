/**
 * plugin.ts — entry point.
 *
 * Stream Deck launches this file with Node 20. Keep this small: wire up
 * logging, register the action, start the audio watcher, connect.
 */

import streamDeck, { LogLevel } from "@elgato/streamdeck";
import * as path from "node:path";
import * as url from "node:url";

import { initLogger, LogLevel as MyLogLevel } from "./utils/logger.js";
import { AudioDeviceAction } from "./actions/audio-device.js";
import { AudioWatcher } from "./audio/watcher.js";

// Resolve <plugin-dir>/logs relative to the bundled plugin.js, regardless of
// where Stream Deck launched us from.
const here = path.dirname(url.fileURLToPath(import.meta.url));
const logDir = path.resolve(here, "..", "logs");

const log = initLogger({
    logDir,
    minLevel: MyLogLevel.DEBUG,
});

// Mirror SDK logs at DEBUG too, so the bundled .com.elgato log gets the same fidelity.
streamDeck.logger.setLevel(LogLevel.TRACE);

// Top-level safety net: never let an unhandled rejection take the process down silently.
process.on("uncaughtException", (err) => {
    log.error("process", "uncaughtException", err);
});
process.on("unhandledRejection", (reason) => {
    log.error("process", "unhandledRejection", reason as Error);
});

log.info("plugin", `boot · node=${process.version} · cwd=${process.cwd()}`);

// Register the action and create the watcher.
const audioAction = new AudioDeviceAction();
streamDeck.actions.registerAction(audioAction);

const watcher = new AudioWatcher((ev) => {
    // We only refresh on render-side changes (flow=0). Capture-flow events
    // would just spawn unnecessary detects.
    if (ev.type === "default-changed") {
        if (ev.flow === undefined || ev.flow === 0) {
            audioAction.scheduleRefreshAll();
        }
        return;
    }
    // Hot-plug and state changes can affect what Windows considers default
    // (e.g. unplug headphones → speakers become default).
    if (
        ev.type === "device-added" ||
        ev.type === "device-removed" ||
        ev.type === "device-state"
    ) {
        audioAction.scheduleRefreshAll();
    }
});

let shuttingDown = false;
const shutdown = (sig: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log.info("plugin", `received ${sig}, shutting down`);
    try {
        watcher.stop();
    } catch (err) {
        log.warn("plugin", "watcher.stop() threw", err as Error);
    }
    // Give the watcher its grace window, then exit.
    setTimeout(() => process.exit(0), 750).unref();
};

process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

streamDeck
    .connect()
    .then(() => {
        log.info("plugin", "connected to Stream Deck");
        return watcher.start();
    })
    .then(() => log.info("plugin", "watcher started"))
    .catch((err) => log.error("plugin", "startup failed", err));
