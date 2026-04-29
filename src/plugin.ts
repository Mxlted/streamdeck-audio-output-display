/**
 * plugin.ts — entry point.
 *
 * Stream Deck launches this file with Node 20. Keep this small: wire up
 * logging, register the action, connect.
 */

import streamDeck, { LogLevel } from "@elgato/streamdeck";
import * as path from "node:path";
import * as url from "node:url";

import { initLogger, getLogger, LogLevel as MyLogLevel } from "./utils/logger.js";
import { AudioDeviceAction } from "./actions/audio-device.js";

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

// Register and connect.
streamDeck.actions.registerAction(new AudioDeviceAction());

streamDeck
    .connect()
    .then(() => log.info("plugin", "connected to Stream Deck"))
    .catch((err) => log.error("plugin", "connect failed", err));
