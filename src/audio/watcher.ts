/**
 * Manages the persistent PowerShell Core Audio notification process.
 *
 * In addition to endpoint notifications, the process accepts request/response
 * commands for reading the current default render endpoint. One-shot detection
 * remains available as a fallback when this process is unavailable.
 */

import { spawn, type ChildProcess } from "node:child_process";
import * as readline from "node:readline";
import { POWERSHELL_EXE } from "./process-runner.js";
import { stagePowerShellScript } from "./script-stager.js";
import { POWERSHELL_WATCHER_SCRIPT } from "./watcher-script.js";
import { getLogger } from "../utils/logger.js";

export interface WatcherEvent {
    type: "default-changed" | "device-added" | "device-removed" | "device-state";
    /** 0 = eRender, 1 = eCapture. Only set on default-changed. */
    flow?: number;
    /** 0 = eConsole, 1 = eMultimedia, 2 = eCommunications. */
    role?: number;
    deviceId?: string;
    state?: number;
}

export type WatcherCallback = (ev: WatcherEvent) => void;
export type WatcherState = "stopped" | "starting" | "ready" | "backoff";

interface Deferred {
    promise: Promise<void>;
    resolve: () => void;
    reject: (err: Error) => void;
    settled: boolean;
}

interface PendingRequest {
    resolve: (name: string) => void;
    reject: (err: Error) => void;
    timer: NodeJS.Timeout;
}

const RESPAWN_DELAYS_MS = [1000, 2000, 5000, 10000, 30000];
const READY_TIMEOUT_MS = 7000;
const STABLE_UPTIME_MS = 15000;
const STOP_GRACE_MS = 500;
const SCRIPT_FILE_NAME = "watch-default-audio.ps1";

export class AudioWatcher {
    private child: ChildProcess | null = null;
    private stopping = false;
    private currentState: WatcherState = "stopped";
    private startPromise: Promise<void> | null = null;
    private readyDeferred: Deferred | null = null;
    private readyTimer: NodeJS.Timeout | null = null;
    private readyAt = 0;
    private respawnAttempt = 0;
    private respawnTimer: NodeJS.Timeout | null = null;
    private killTimer: NodeJS.Timeout | null = null;
    private requestCounter = 0;
    private readonly pendingRequests = new Map<string, PendingRequest>();

    constructor(private readonly callback: WatcherCallback) {}

    get state(): WatcherState {
        return this.currentState;
    }

    /** Starts the watcher and resolves only after its READY protocol line. */
    async start(): Promise<void> {
        if (this.currentState === "ready") return;
        if (this.startPromise) return this.startPromise;

        this.stopping = false;
        if (this.respawnTimer) {
            clearTimeout(this.respawnTimer);
            this.respawnTimer = null;
        }

        const operation = (async () => {
            const scriptPath = await stagePowerShellScript(
                SCRIPT_FILE_NAME,
                POWERSHELL_WATCHER_SCRIPT,
            );
            getLogger().debug("Watcher", `script ready at ${scriptPath}`);
            await this.spawnAndWaitForReady(scriptPath);
        })();

        this.startPromise = operation;
        try {
            await operation;
        } catch (err) {
            if (!this.stopping && !this.child && !this.respawnTimer) {
                this.scheduleRespawn();
            }
            throw err;
        } finally {
            if (this.startPromise === operation) this.startPromise = null;
        }
    }

    stop(): void {
        const log = getLogger();
        this.stopping = true;
        this.currentState = "stopped";
        this.readyAt = 0;

        if (this.respawnTimer) {
            clearTimeout(this.respawnTimer);
            this.respawnTimer = null;
        }
        this.clearReadyTimer();
        this.rejectReady(new Error("watcher stopped"));
        this.rejectPendingRequests(new Error("watcher stopped"));

        const child = this.child;
        this.child = null;
        if (!child || child.killed) return;

        log.info("Watcher", "stopping subprocess");
        try {
            child.stdin?.write("STOP\n");
            child.stdin?.end();
        } catch {
            /* The pipe may already be closed. */
        }

        this.clearKillTimer();
        this.killTimer = setTimeout(() => {
            try {
                if (!child.killed) {
                    log.warn("Watcher", "subprocess did not exit on STOP; terminating it");
                    child.kill("SIGKILL");
                }
            } catch {
                /* The process may already have exited. */
            }
        }, STOP_GRACE_MS);
        this.killTimer.unref();
    }

    /** Reads the default render endpoint through the persistent watcher. */
    async getDefaultRenderName(timeoutMs = 3000): Promise<string> {
        const deadline = Date.now() + Math.max(1, timeoutMs);
        await this.waitForReady(deadline);

        const child = this.child;
        if (!child || this.currentState !== "ready" || !child.stdin?.writable) {
            throw new Error("watcher is not ready");
        }

        const requestId = `${process.pid}-${++this.requestCounter}`;
        const remaining = remainingMs(deadline, "watcher request deadline exceeded");

        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.pendingRequests.delete(requestId);
                reject(new Error(`watcher request timed out after ${timeoutMs}ms`));
            }, remaining);

            this.pendingRequests.set(requestId, { resolve, reject, timer });
            child.stdin?.write(
                `GET_DEFAULT_RENDER\t${requestId}\n`,
                "utf8",
                (err?: Error | null) => {
                    if (!err) return;
                    this.rejectRequest(requestId, new Error(`watcher write failed: ${err.message}`));
                },
            );
        });
    }

    private async spawnAndWaitForReady(scriptPath: string): Promise<void> {
        if (this.stopping) throw new Error("watcher is stopping");
        if (this.child) throw new Error("watcher subprocess already exists");

        const log = getLogger();
        log.info("Watcher", "spawning subprocess");
        this.currentState = "starting";
        this.readyDeferred = createDeferred();

        const child = spawn(
            POWERSHELL_EXE,
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath,
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
            const lines = readline.createInterface({ input: child.stdout });
            lines.on("line", (line) => this.handleLine(line.trim()));
        }

        child.stderr?.on("data", (data) => {
            const text = String(data).trim();
            if (text) log.warn("Watcher", `stderr: ${text}`);
        });

        child.on("error", (err) => {
            log.error("Watcher", "spawn error", err);
            this.rejectReady(new Error(`watcher spawn failed: ${err.message}`));
        });

        child.on("close", (code, signal) => {
            this.clearReadyTimer();
            this.clearKillTimer();
            this.rejectReady(new Error(`watcher exited before READY (code=${code})`));
            this.rejectPendingRequests(new Error("watcher subprocess exited"));

            const uptime = this.readyAt > 0 ? Date.now() - this.readyAt : 0;
            if (uptime >= STABLE_UPTIME_MS) this.respawnAttempt = 0;
            this.readyAt = 0;

            if (this.child === child) this.child = null;
            log.warn("Watcher", `subprocess exited code=${code} signal=${signal}`);

            if (!this.stopping) this.scheduleRespawn();
        });

        this.readyTimer = setTimeout(() => {
            const err = new Error(`watcher did not become ready within ${READY_TIMEOUT_MS}ms`);
            this.rejectReady(err);
            try {
                child.kill("SIGKILL");
            } catch {
                /* ignore */
            }
        }, READY_TIMEOUT_MS);

        await this.readyDeferred.promise;
    }

    private handleLine(line: string): void {
        if (!line) return;
        const log = getLogger();

        if (line === "READY") {
            this.clearReadyTimer();
            this.currentState = "ready";
            this.readyAt = Date.now();
            this.resolveReady();
            log.info("Watcher", "subprocess ready");
            return;
        }

        const parts = line.split("\t");
        const tag = parts[0];

        if (tag === "RESULT") {
            this.handleResult(parts);
            return;
        }

        switch (tag) {
            case "DEFAULT": {
                const flow = parseIntSafe(parts[1]);
                const role = parseIntSafe(parts[2]);
                const deviceId = parts[3] ?? "";
                log.info("Watcher", `default changed flow=${flow} role=${role}`);
                this.emitEvent({ type: "default-changed", flow, role, deviceId });
                return;
            }
            case "ADDED":
                this.emitEvent({ type: "device-added", deviceId: parts[1] ?? "" });
                return;
            case "REMOVED":
                this.emitEvent({ type: "device-removed", deviceId: parts[1] ?? "" });
                return;
            case "STATE":
                this.emitEvent({
                    type: "device-state",
                    deviceId: parts[1] ?? "",
                    state: parseIntSafe(parts[2]),
                });
                return;
            case "ERR": {
                const message = parts.slice(1).join(" ") || "unknown watcher error";
                log.error("Watcher", `subprocess error: ${message}`);
                if (this.currentState === "starting") this.rejectReady(new Error(message));
                return;
            }
            default:
                log.debug("Watcher", `unhandled line: ${line}`);
        }
    }

    private handleResult(parts: string[]): void {
        const requestId = parts[1] ?? "";
        const status = parts[2] ?? "ERR";
        const encodedPayload = parts[3] ?? "";
        const request = this.pendingRequests.get(requestId);
        if (!request) return;

        this.pendingRequests.delete(requestId);
        clearTimeout(request.timer);

        let payload: string;
        try {
            payload = Buffer.from(encodedPayload, "base64").toString("utf8");
        } catch {
            request.reject(new Error("watcher returned malformed base64"));
            return;
        }

        if (status === "OK" && payload.trim()) request.resolve(payload.trim());
        else request.reject(new Error(payload || "watcher request failed"));
    }

    private async waitForReady(deadline: number): Promise<void> {
        if (this.currentState === "ready") return;

        // Prefer the current start operation. The previous process's deferred
        // can already be settled while a replacement script is being staged.
        const readiness = this.startPromise ?? this.readyDeferred?.promise;
        if (!readiness) throw new Error(`watcher is ${this.currentState}`);

        const timeoutMs = remainingMs(deadline, "watcher readiness deadline exceeded");
        let timer: NodeJS.Timeout | undefined;
        try {
            await Promise.race([
                readiness,
                new Promise<never>((_, reject) => {
                    timer = setTimeout(
                        () => reject(new Error("watcher readiness deadline exceeded")),
                        timeoutMs,
                    );
                }),
            ]);
        } finally {
            if (timer) clearTimeout(timer);
        }
    }

    private emitEvent(ev: WatcherEvent): void {
        try {
            this.callback(ev);
        } catch (err) {
            getLogger().error("Watcher", "event callback failed", err);
        }
    }

    private scheduleRespawn(): void {
        if (this.stopping || this.respawnTimer) return;

        const idx = Math.min(this.respawnAttempt, RESPAWN_DELAYS_MS.length - 1);
        const delay = RESPAWN_DELAYS_MS[idx];
        this.respawnAttempt++;
        this.currentState = "backoff";

        getLogger().warn(
            "Watcher",
            `respawning in ${delay}ms (attempt ${this.respawnAttempt})`,
        );

        this.respawnTimer = setTimeout(() => {
            this.respawnTimer = null;
            if (this.stopping) return;
            void this.start().catch((err) => {
                getLogger().error("Watcher", "respawn failed", err);
            });
        }, delay);
        this.respawnTimer.unref();
    }

    private resolveReady(): void {
        const deferred = this.readyDeferred;
        if (!deferred || deferred.settled) return;
        deferred.settled = true;
        deferred.resolve();
    }

    private rejectReady(err: Error): void {
        const deferred = this.readyDeferred;
        if (!deferred || deferred.settled) return;
        deferred.settled = true;
        deferred.reject(err);
    }

    private rejectRequest(requestId: string, err: Error): void {
        const request = this.pendingRequests.get(requestId);
        if (!request) return;
        this.pendingRequests.delete(requestId);
        clearTimeout(request.timer);
        request.reject(err);
    }

    private rejectPendingRequests(err: Error): void {
        for (const [requestId] of this.pendingRequests) {
            this.rejectRequest(requestId, err);
        }
    }

    private clearReadyTimer(): void {
        if (!this.readyTimer) return;
        clearTimeout(this.readyTimer);
        this.readyTimer = null;
    }

    private clearKillTimer(): void {
        if (!this.killTimer) return;
        clearTimeout(this.killTimer);
        this.killTimer = null;
    }
}

function createDeferred(): Deferred {
    let resolvePromise!: () => void;
    let rejectPromise!: (err: Error) => void;
    const promise = new Promise<void>((resolve, reject) => {
        resolvePromise = resolve;
        rejectPromise = reject;
    });
    return {
        promise,
        resolve: resolvePromise,
        reject: rejectPromise,
        settled: false,
    };
}

function remainingMs(deadline: number, message: string): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error(message);
    return remaining;
}

function parseIntSafe(value: string | undefined): number {
    if (value === undefined) return -1;
    const parsed = Number.parseInt(value, 10);
    return Number.isFinite(parsed) ? parsed : -1;
}
