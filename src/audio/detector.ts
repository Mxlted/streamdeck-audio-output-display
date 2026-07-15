/**
 * AudioDetector - Detects the current default Windows audio output device.
 *
 * Detection strategy (in order):
 *   1. Persistent watcher/broker Core Audio query.
 *   2. One-shot PowerShell + embedded C# Core Audio COM fallback.
 *   3. Registry fallback - reads HKLM\SOFTWARE\Microsoft\Windows\CurrentVersion
 *      \MMDevices\Audio\Render to identify the default render endpoint and
 *      pull its FriendlyName property. Useful if PowerShell execution policy
 *      blocks Add-Type.
 *
 * The complete operation has one hard deadline and all child output is bounded.
 */

import { POWERSHELL_DETECT_SCRIPT } from "./powershell-script.js";
import { POWERSHELL_EXE, REG_EXE, runProcess } from "./process-runner.js";
import { stagePowerShellScript } from "./script-stager.js";
import { getLogger } from "../utils/logger.js";

export interface DetectionResult {
    /** The raw device name as reported by Windows, e.g. "Speakers (Realtek(R) Audio)". */
    name: string;
    /** Which detection path produced the result. */
    source: "watcher" | "powershell" | "registry" | "cache";
}

export class DetectionError extends Error {
    constructor(message: string, public readonly causes: string[] = []) {
        super(message);
        this.name = "DetectionError";
    }
}

/** Default deadline for the complete detection operation. */
const DEFAULT_TIMEOUT_MS = 5000;

export type DefaultDeviceNameResolver = (timeoutMs: number) => Promise<string>;

export class AudioDetector {
    constructor(private readonly preferredResolver?: DefaultDeviceNameResolver) {}

    /**
     * Detect the current default audio output device.
     * Tries the persistent watcher first, then one-shot PowerShell, and finally
     * the best-effort registry fallback. The timeout covers the whole operation.
     */
    async detect(timeoutMs: number = DEFAULT_TIMEOUT_MS): Promise<DetectionResult> {
        const log = getLogger();
        const causes: string[] = [];
        const deadline = Date.now() + Math.max(1, timeoutMs);

        if (this.preferredResolver) {
            try {
                log.debug("AudioDetector", "attempt 1: persistent watcher");
                const name = await this.preferredResolver(remainingMs(deadline));
                if (!name.trim()) throw new Error("watcher returned an empty device name");
                log.info("AudioDetector", `Watcher detection succeeded: "${name}"`);
                return { name, source: "watcher" };
            } catch (err) {
                const msg = errorMessage(err);
                log.warn("AudioDetector", `Watcher detection failed: ${msg}`);
                causes.push(`watcher: ${msg}`);
            }
        }

        // One-shot fallback. A second identical retry adds startup pressure and
        // does not help permanent failures such as policy-blocked Add-Type.
        try {
            log.debug("AudioDetector", "attempt 2: one-shot PowerShell Core Audio");
            const name = await this.detectViaPowerShell(deadline);
            log.info("AudioDetector", `PowerShell detection succeeded: "${name}"`);
            return { name, source: "powershell" };
        } catch (err) {
            const msg = errorMessage(err);
            log.warn("AudioDetector", `PowerShell fallback failed: ${msg}`);
            causes.push(`powershell: ${msg}`);
        }

        // Final approximate fallback, bounded by the same overall deadline.
        try {
            log.debug("AudioDetector", "attempt 3: bounded registry fallback");
            const name = await this.detectViaRegistry(deadline);
            log.info("AudioDetector", `Registry detection succeeded: "${name}"`);
            return { name, source: "registry" };
        } catch (err) {
            const msg = errorMessage(err);
            log.error("AudioDetector", `Registry attempt failed: ${msg}`);
            causes.push(`registry: ${msg}`);
        }

        throw new DetectionError("All detection methods failed", causes);
    }

    // ---------- PowerShell path ----------

    private async detectViaPowerShell(deadline: number): Promise<string> {
        const scriptPath = await stagePowerShellScript(
            "detect-default-audio.ps1",
            POWERSHELL_DETECT_SCRIPT,
        );

        const stdout = await runProcess(
            POWERSHELL_EXE,
            [
                "-NoProfile",
                "-NonInteractive",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                scriptPath,
            ],
            { timeoutMs: remainingMs(deadline) },
        );

        return this.parsePsOutput(stdout);
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
    private async detectViaRegistry(deadline: number): Promise<string> {
        const renderRoot =
            "HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\MMDevices\\Audio\\Render";

        // Step 1: enumerate Render sub-keys.
        const enumOut = await runProcess(
            REG_EXE,
            ["query", renderRoot],
            { timeoutMs: remainingMs(deadline) },
        );
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
            if (Date.now() >= deadline) break;
            const propsKey = `${renderRoot}\\${sub}\\Properties`;
            const friendlyValue =
                "{a45c254e-df1c-4efd-8020-67d146a850e0},14"; // PKEY_Device_FriendlyName

            try {
                const fnOut = await runProcess(
                    REG_EXE,
                    ["query", propsKey, "/v", friendlyValue],
                    { timeoutMs: remainingMs(deadline) },
                );
                const name = this.parseRegStringValue(fnOut);

                const stateOut = await runProcess(
                    REG_EXE,
                    ["query", `${renderRoot}\\${sub}`, "/v", "DeviceState"],
                    { timeoutMs: remainingMs(deadline) },
                );
                const state = this.parseRegDwordValue(stateOut);

                let level = 0;
                try {
                    const lvlOut = await runProcess(
                        REG_EXE,
                        ["query", `${renderRoot}\\${sub}`, "/v", "Level"],
                        { timeoutMs: remainingMs(deadline) },
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
            remainingMs(deadline);
            throw new Error("no active render devices in registry");
        }

        // Highest "Level" wins as a heuristic for "most recently default".
        remainingMs(deadline);
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

}

function remainingMs(deadline: number): number {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("detection deadline exceeded");
    return remaining;
}

function errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
}
