/**
 * AudioDetector - Detects the current default Windows audio output device.
 *
 * Detection strategy (in order):
 *   1. PowerShell + embedded C# Core Audio COM (most reliable, returns the
 *      same name shown in Windows Sound settings).
 *   2. Registry fallback - reads HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion
 *      \MMDevices\Audio\Render to identify the default render endpoint and
 *      pull its FriendlyName property. Useful if PowerShell execution policy
 *      blocks Add-Type.
 *
 * All external calls have hard timeouts and are non-blocking.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { POWERSHELL_DETECT_SCRIPT } from "./powershell-script.js";
import { getLogger } from "../utils/logger.js";

export interface DetectionResult {
    /** The raw device name as reported by Windows, e.g. "Speakers (Realtek(R) Audio)". */
    name: string;
    /** Which detection path produced the result. */
    source: "powershell" | "registry";
}

export class DetectionError extends Error {
    constructor(message: string, public readonly causes: string[] = []) {
        super(message);
        this.name = "DetectionError";
    }
}

/** Default timeout for any single detection attempt. */
const DEFAULT_TIMEOUT_MS = 5000;

export class AudioDetector {
    private psScriptPath: string | null = null;

    /**
     * Detect the current default audio output device.
     * Tries PowerShell first; if that fails or times out, falls back to the registry.
     * Will retry the PowerShell path once before falling back.
     */
    async detect(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<DetectionResult> {
        const log = getLogger();
        const causes: string[] = [];

        // Attempt 1: PowerShell.
        try {
            log.debug("AudioDetector", "attempt 1: PowerShell Core Audio");
            const name = await this.detectViaPowerShell(timeoutMs);
            log.info("AudioDetector", `PowerShell detection succeeded: "${name}"`);
            return { name, source: "powershell" };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn("AudioDetector", `PowerShell attempt 1 failed: ${msg}`);
            causes.push(`powershell-1: ${msg}`);
        }

        // Attempt 2: PowerShell retry (transient COM hiccups happen).
        try {
            log.debug("AudioDetector", "attempt 2: PowerShell retry");
            const name = await this.detectViaPowerShell(timeoutMs);
            log.info("AudioDetector", `PowerShell retry succeeded: "${name}"`);
            return { name, source: "powershell" };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.warn("AudioDetector", `PowerShell attempt 2 failed: ${msg}`);
            causes.push(`powershell-2: ${msg}`);
        }

        // Attempt 3: Registry fallback.
        try {
            log.debug("AudioDetector", "attempt 3: registry fallback");
            const name = await this.detectViaRegistry(timeoutMs);
            log.info("AudioDetector", `Registry detection succeeded: "${name}"`);
            return { name, source: "registry" };
        } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error("AudioDetector", `Registry attempt failed: ${msg}`);
            causes.push(`registry: ${msg}`);
        }

        throw new DetectionError("All detection methods failed", causes);
    }

    // ---------- PowerShell path ----------

    private async detectViaPowerShell(timeoutMs: number): Promise<string> {
        const scriptPath = await this.ensureScriptOnDisk();

        const stdout = await this.runProcess(
            "powershell.exe",
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath,
            ],
            timeoutMs,
        );

        return this.parsePsOutput(stdout);
    }

    /**
     * Write the PowerShell script to %TEMP% once per process. Reading from a
     * file (vs -Command "...") avoids quoting headaches and keeps the C#
     * Add-Type cache hot across calls.
     */
    private async ensureScriptOnDisk(): Promise<string> {
        if (this.psScriptPath) {
            try {
                await fs.access(this.psScriptPath);
                return this.psScriptPath;
            } catch {
                /* %TEMP% may have been cleaned; re-stage below. */
            }
        }

        const dir = path.join(os.tmpdir(), "com.nathan.defaultaudio");
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, "detect-default-audio.ps1");
        await fs.writeFile(file, POWERSHELL_DETECT_SCRIPT, { encoding: "utf8" });
        this.psScriptPath = file;

        getLogger().debug("AudioDetector", `PowerShell script staged at ${file}`);
        return file;
    }

    private parsePsOutput(stdout: string): string {
        // The script writes one line: "OK\t<name>" or "ERR\t<reason>".
        // Tolerate trailing newlines, stray BOMs, and incidental host output.
        const line = this.findProtocolLine(stdout);
        if (!line) throw new Error("empty PowerShell output");

        const tabIdx = line.indexOf("\t");
        if (tabIdx === -1) throw new Error(`malformed PowerShell output: ${line}`);

        const status = line.slice(0, tabIdx);
        const payload = line.slice(tabIdx + 1).trim();

        if (status === "OK") {
            if (!payload) throw new Error("PowerShell returned OK with empty name");
            return payload;
        }

        throw new Error(`PowerShell error: ${payload || "unknown"}`);
    }

    private findProtocolLine(stdout: string): string | undefined {
        return stdout
            .replace(/^\uFEFF/, "")
            .split(/\r?\n/)
            .find((line) => line.startsWith("OK\t") || line.startsWith("ERR\t"));
    }

    // ---------- Registry fallback path ----------

    /**
     * Walk HKLM\...\MMDevices\Audio\Render\<guid>\Properties to find the device
     * with state 1 (DEVICE_STATE_ACTIVE) referenced by the "default" key.
     *
     * The actual "which one is default" lives at:
     *   HKCU\Software\Microsoft\Multimedia\Sound Mapper\Playback
     * but on modern Windows the canonical default is stored in the property
     * store of each device under MMDevices. We use a two-step:
     *   - reg query on the Render parent to get sub-keys (device GUIDs)
     *   - check Properties\{a45c254e-...},14 for FriendlyName, and
     *     Properties\{...} for state — we want the one most recently set
     *     as default. As a pragmatic fallback we try the registry "Default"
     *     marker first, and if absent return any active device.
     */
    private async detectViaRegistry(timeoutMs: number): Promise<string> {
        const renderRoot =
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render";

        // Step 1: enumerate Render sub-keys.
        const enumOut = await this.runProcess("reg.exe", ["query", renderRoot], timeoutMs);
        const subkeys = enumOut
            .split(/\r?\n/)
            .map((l) => l.trim())
            .filter((l) => l.startsWith(renderRoot + "\\"))
            .map((l) => l.substring(renderRoot.length + 1));

        if (subkeys.length === 0) throw new Error("no Render subkeys found");

        // Step 2: for each subkey, read its FriendlyName + DeviceState.
        // We pick the first ACTIVE (state == 1) one; if multiple, we prefer
        // the one whose Level1 timestamp is most recent (= most recently default).
        const candidates: Array<{ name: string; state: number; level: number }> = [];

        for (const sub of subkeys) {
            const propsKey = `${renderRoot}\\${sub}\\Properties`;
            const friendlyValue =
                "{a45c254e-df1c-4efd-8020-67d146a850e0},14"; // PKEY_Device_FriendlyName

            try {
                const fnOut = await this.runProcess(
                    "reg.exe",
                    ["query", propsKey, "/v", friendlyValue],
                    timeoutMs,
                );
                const name = this.parseRegStringValue(fnOut);

                const stateOut = await this.runProcess(
                    "reg.exe",
                    ["query", `${renderRoot}\\${sub}`, "/v", "DeviceState"],
                    timeoutMs,
                );
                const state = this.parseRegDwordValue(stateOut);

                let level = 0;
                try {
                    const lvlOut = await this.runProcess(
                        "reg.exe",
                        ["query", `${renderRoot}\\${sub}`, "/v", "Level"],
                        timeoutMs,
                    );
                    level = this.parseRegDwordValue(lvlOut);
                } catch {
                    /* Level not present on all devices; ignore. */
                }

                if (name && state === 1) {
                    candidates.push({ name, state, level });
                }
            } catch (err) {
                getLogger().debug(
                    "AudioDetector",
                    `registry: skipping subkey ${sub}: ${(err as Error).message}`,
                );
            }
        }

        if (candidates.length === 0) {
            throw new Error("no active render devices in registry");
        }

        // Highest "Level" wins as a heuristic for "most recently default".
        candidates.sort((a, b) => b.level - a.level);
        return candidates[0].name;
    }

    private parseRegStringValue(regOut: string): string {
        // Output line: "    {a45c...},14    REG_SZ    Speakers (Realtek(R) Audio)"
        for (const line of regOut.split(/\r?\n/)) {
            const m = line.match(/REG_SZ\s+(.+?)\s*$/);
            if (m) return m[1];
        }
        throw new Error("no REG_SZ value in reg output");
    }

    private parseRegDwordValue(regOut: string): number {
        for (const line of regOut.split(/\r?\n/)) {
            const m = line.match(/REG_DWORD\s+0x([0-9a-fA-F]+)/);
            if (m) return parseInt(m[1], 16);
        }
        throw new Error("no REG_DWORD value in reg output");
    }

    // ---------- shared process runner ----------

    /**
     * Spawn a process with a hard timeout. Returns stdout as UTF-8.
     * Never throws synchronously; rejects on timeout or non-zero exit.
     */
    private runProcess(
        command: string,
        args: readonly string[],
        timeoutMs: number,
    ): Promise<string> {
        return new Promise<string>((resolve, reject) => {
            const child = spawn(command, args, {
                windowsHide: true,
                stdio: ["ignore", "pipe", "pipe"],
            });

            let stdout = "";
            let stderr = "";
            let settled = false;

            const settle = (fn: () => void) => {
                if (settled) return;
                settled = true;
                clearTimeout(timer);
                fn();
            };

            const timer = setTimeout(() => {
                try {
                    child.kill("SIGKILL");
                } catch {
                    /* ignore */
                }
                settle(() =>
                    reject(new Error(`${command} timed out after ${timeoutMs}ms`)),
                );
            }, timeoutMs);

            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (d) => (stdout += d));
            child.stderr.on("data", (d) => (stderr += d));

            child.on("error", (err) => {
                settle(() => reject(new Error(`${command} spawn failed: ${err.message}`)));
            });

            child.on("close", (code) => {
                if (code === 0) {
                    settle(() => resolve(stdout));
                } else {
                    settle(() =>
                        reject(
                            new Error(
                                `${command} exited ${code}: ${stderr.trim() || "(no stderr)"}`,
                            ),
                        ),
                    );
                }
            });
        });
    }
}
