import streamDeck, { LogLevel } from "@elgato/streamdeck";
import * as path from "node:path";
import * as url from "node:url";

import { AudioDeviceAction } from "./actions/audio-device.js";
import {
    SetDefaultInputDeviceAction,
    SetDefaultOutputDeviceAction,
} from "./actions/set-default-device.js";
import { AudioDetector } from "./audio/detector.js";
import { AudioWatcher } from "./audio/watcher.js";
import { initLogger, LogLevel as FileLogLevel } from "./utils/logger.js";

const WATCHER_IDLE_STOP_MS = 30000;
const debugLogging = process.env.DEFAULT_AUDIO_DEBUG === "1";

const here = path.dirname(url.fileURLToPath(import.meta.url));
const log = initLogger({
    logDir: path.resolve(here, "..", "logs"),
    minLevel: debugLogging ? FileLogLevel.DEBUG : FileLogLevel.INFO,
});
streamDeck.logger.setLevel(debugLogging ? LogLevel.TRACE : LogLevel.INFO);

let watcherIdleTimer: NodeJS.Timeout | null = null;
let audioAction!: AudioDeviceAction;
let shuttingDown = false;

const watcher = new AudioWatcher((ev) => {
    if (ev.type === "default-changed") {
        if (ev.flow === undefined || ev.flow === 0) audioAction.scheduleRefreshAll();
        return;
    }

    if (
        ev.type === "device-added" ||
        ev.type === "device-removed" ||
        ev.type === "device-state"
    ) {
        audioAction.scheduleRefreshAll();
    }
});

const detector = new AudioDetector((timeoutMs) =>
    watcher.getDefaultRenderName(timeoutMs),
);

audioAction = new AudioDeviceAction({
    detector,
    onActiveDetectionCountChanged: (activeCount) => {
        if (shuttingDown) return;
        if (activeCount > 0) {
            if (watcherIdleTimer) {
                clearTimeout(watcherIdleTimer);
                watcherIdleTimer = null;
            }
            void watcher.start().catch((err) => {
                log.warn("plugin", "watcher unavailable; one-shot fallback remains active", err);
            });
            return;
        }

        if (watcherIdleTimer) clearTimeout(watcherIdleTimer);
        watcherIdleTimer = setTimeout(() => {
            watcherIdleTimer = null;
            watcher.stop();
        }, WATCHER_IDLE_STOP_MS);
        watcherIdleTimer.unref();
    },
});

streamDeck.actions.registerAction(audioAction);
streamDeck.actions.registerAction(new SetDefaultOutputDeviceAction());
streamDeck.actions.registerAction(new SetDefaultInputDeviceAction());

function shutdown(reason: string, exitCode: number): void {
    if (shuttingDown) return;
    shuttingDown = true;
    process.exitCode = exitCode;
    log.info("plugin", `${reason}; shutting down with code ${exitCode}`);

    if (watcherIdleTimer) {
        clearTimeout(watcherIdleTimer);
        watcherIdleTimer = null;
    }
    watcher.stop();

    void log.flushAndWait(500);
    setTimeout(() => process.exit(exitCode), 750);
}

process.once("uncaughtException", (err) => {
    log.error("process", "uncaughtException", err);
    shutdown("fatal uncaught exception", 1);
});
process.once("unhandledRejection", (reason) => {
    log.error("process", "unhandledRejection", reason);
    shutdown("fatal unhandled rejection", 1);
});
process.once("SIGTERM", () => shutdown("received SIGTERM", 0));
process.once("SIGINT", () => shutdown("received SIGINT", 0));

async function main(): Promise<void> {
    log.info("plugin", `boot · node=${process.version} · cwd=${process.cwd()}`);
    try {
        await streamDeck.connect();
    } catch (err) {
        log.error("plugin", "failed to connect to Stream Deck", err);
        shutdown("startup failed", 1);
        return;
    }

    log.info("plugin", "connected to Stream Deck");
    void audioAction.hydrateCachedDevice();
}

void main();
