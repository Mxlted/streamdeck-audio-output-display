/**
 * AudioWatcher — manages a long-running PowerShell subprocess that reports
 * Windows audio endpoint changes via IMMNotificationClient.
 *
 * Lifecycle:
 *   start()  → stage script to %TEMP%, spawn powershell.exe, parse stdout lines
 *   stop()   → write "STOP" to stdin (graceful), SIGKILL after 500ms grace
 *   on crash → respawn with exponential backoff (1, 2, 5, 10, 30s — capped)
 *
 * The subprocess does not poll. Idle cost is ~one powershell.exe at ~30–50MB
 * RAM, ~0% CPU until Windows fires an event.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import * as readline from "node:readline";
import { POWERSHELL_WATCHER_SCRIPT } from "./watcher-script.js";
import { getLogger } from "../utils/logger.js";

export interface WatcherEvent {
    type: "default-changed" | "device-added" | "device-removed" | "device-state";
    /** 0 = eRender (output), 1 = eCapture (input). Only set on default-changed. */
    flow?: number;
    /** 0 = eConsole, 1 = eMultimedia, 2 = eCommunications. Only set on default-changed. */
    role?: number;
    /** Endpoint ID, may be empty if Windows reports "no default". */
    deviceId?: string;
    /** DEVICE_STATE_* bitfield. Only set on device-state. */
    state?: number;
}

export type WatcherCallback = (ev: WatcherEvent) => void;

const RESPAWN_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const STOP_GRACE_MS = 500;

export class AudioWatcher {
    private child: ChildProcess | null = null;
    private scriptPath: string | null = null;
    private stopping = false;
    private respawnAttempt = 0;
    private respawnTimer: NodeJS.Timeout | null = null;
    private readonly callback: WatcherCallback;

    constructor(callback: WatcherCallback) {
        this.callback = callback;
    }

    async start(): Promise<void> {
        this.stopping = false;
        await this.ensureScriptOnDisk();
        this.spawnChild();
    }

    stop(): void {
        const log = getLogger();
        this.stopping = true;

        if (this.respawnTimer) {
            clearTimeout(this.respawnTimer);
            this.respawnTimer = null;
        }

        const child = this.child;
        this.child = null;
        if (!child || child.killed) return;

        log.info("Watcher", "stopping subprocess");

        try {
            child.stdin?.write("STOP\n");
            child.stdin?.end();
        } catch {
            /* ignore — pipe may already be closed */
        }

        const killTimer = setTimeout(() => {
            try {
                if (!child.killed) {
                    log.warn("Watcher", "subprocess did not exit on STOP, sending SIGKILL");
                    child.kill("SIGKILL");
                }
            } catch {
                /* ignore */
            }
        }, STOP_GRACE_MS);
        killTimer.unref();
    }

    private async ensureScriptOnDisk(): Promise<string> {
        // Re-validate each call: %TEMP% can be wiped by cleanup tools.
        if (this.scriptPath) {
            try {
                await fs.access(this.scriptPath);
                return this.scriptPath;
            } catch {
                /* fall through and re-stage */
            }
        }

        const dir = path.join(os.tmpdir(), "com.nathan.defaultaudio");
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, "watch-default-audio.ps1");
        await fs.writeFile(file, POWERSHELL_WATCHER_SCRIPT, { encoding: "utf8" });
        this.scriptPath = file;

        getLogger().debug("Watcher", `script staged at ${file}`);
        return file;
    }

    private spawnChild(): void {
        if (this.stopping) return;
        const log = getLogger();

        if (!this.scriptPath) {
            log.error("Watcher", "spawnChild: scriptPath not set");
            return;
        }

        log.info("Watcher", "spawning subprocess");

        const child = spawn(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy", "Bypass",
                "-File", this.scriptPath,
            ],
            {
                windowsHide: true,
                stdio: ["pipe", "pipe", "pipe"],
            },
        );

        this.child = child;

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");

        if (child.stdout) {
            const rl = readline.createInterface({ input: child.stdout });
            rl.on("line", (line) => this.handleLine(line.trim()));
        }

        child.stderr?.on("data", (d) => {
            const text = String(d).trim();
            if (text.length > 0) log.warn("Watcher", `stderr: ${text}`);
        });

        child.on("error", (err) => {
            log.error("Watcher", "spawn error", err);
        });

        child.on("close", (code, signal) => {
            log.warn("Watcher", `subprocess exited code=${code} signal=${signal}`);
            if (this.child === child) this.child = null;
            if (!this.stopping) this.scheduleRespawn();
        });
    }

    private handleLine(line: string): void {
        if (line.length === 0) return;
        const log = getLogger();

        if (line === "READY") {
            log.info("Watcher", "subprocess ready");
            this.respawnAttempt = 0;
            return;
        }

        const parts = line.split("\t");
        const tag = parts[0];

        switch (tag) {
            case "DEFAULT": {
                const flow = parseIntSafe(parts[1]);
                const role = parseIntSafe(parts[2]);
                const deviceId = parts[3] ?? "";
                log.info("Watcher", `default changed flow=${flow} role=${role} id=${deviceId}`);
                this.callback({ type: "default-changed", flow, role, deviceId });
                return;
            }
            case "ADDED":
                log.info("Watcher", `device added id=${parts[1] ?? ""}`);
                this.callback({ type: "device-added", deviceId: parts[1] ?? "" });
                return;
            case "REMOVED":
                log.info("Watcher", `device removed id=${parts[1] ?? ""}`);
                this.callback({ type: "device-removed", deviceId: parts[1] ?? "" });
                return;
            case "STATE": {
                const state = parseIntSafe(parts[2]);
                log.debug("Watcher", `device state id=${parts[1] ?? ""} state=${state}`);
                this.callback({ type: "device-state", deviceId: parts[1] ?? "", state });
                return;
            }
            case "ERR":
                log.error("Watcher", `subprocess error: ${parts.slice(1).join(" ")}`);
                return;
            default:
                log.debug("Watcher", `unhandled line: ${line}`);
        }
    }

    private scheduleRespawn(): void {
        if (this.stopping) return;
        const idx = Math.min(this.respawnAttempt, RESPAWN_DELAYS_MS.length - 1);
        const delay = RESPAWN_DELAYS_MS[idx];
        this.respawnAttempt++;

        getLogger().warn(
            "Watcher",
            `respawning in ${delay}ms (attempt ${this.respawnAttempt})`,
        );

        this.respawnTimer = setTimeout(() => {
            this.respawnTimer = null;
            this.ensureScriptOnDisk()
                .then(() => this.spawnChild())
                .catch((err) => {
                    getLogger().error("Watcher", "respawn ensureScriptOnDisk failed", err);
                    this.scheduleRespawn();
                });
        }, delay);
        this.respawnTimer.unref();
    }
}

function parseIntSafe(s: string | undefined): number {
    if (s === undefined) return -1;
    const n = parseInt(s, 10);
    return Number.isFinite(n) ? n : -1;
}
