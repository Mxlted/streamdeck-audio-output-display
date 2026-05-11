/**
 * AudioDefaultDeviceSetter - sets the default Windows input/output endpoint.
 *
 * Device lookup is intentionally name-first. Endpoint IDs can change after
 * driver updates or re-plugs, while friendly names tend to survive. A saved ID
 * may still be supplied as a fallback/tie-breaker for duplicate device names.
 */

import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { POWERSHELL_SET_DEFAULT_SCRIPT } from "./set-default-script.js";
import { getLogger } from "../utils/logger.js";

export type AudioEndpointFlow = "render" | "capture";

export interface SetDefaultDeviceRequest {
    flow: AudioEndpointFlow;
    targetName?: string;
    fallbackDeviceId?: string;
}

export interface AudioEndpointDevice {
    id: string;
    name: string;
}

export interface SetDefaultDeviceResult {
    name: string;
    deviceId: string;
    matchedBy: string;
}

export class SetDefaultDeviceError extends Error {
    constructor(message: string) {
        super(message);
        this.name = "SetDefaultDeviceError";
    }
}

const DEFAULT_TIMEOUT_MS = 7000;

export class AudioDefaultDeviceSetter {
    private psScriptPath: string | null = null;

    async listDevices(
        flow: AudioEndpointFlow,
        timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ): Promise<AudioEndpointDevice[]> {
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
                "-Mode",
                "List",
                "-Flow",
                flow,
            ],
            timeoutMs,
        );

        return this.parseListPsOutput(stdout);
    }

    async setDefault(
        request: SetDefaultDeviceRequest,
        timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ): Promise<SetDefaultDeviceResult> {
        const targetName = request.targetName?.trim() ?? "";
        const fallbackDeviceId = request.fallbackDeviceId?.trim() ?? "";

        if (!targetName && !fallbackDeviceId) {
            throw new SetDefaultDeviceError("Set a device name or fallback device ID first");
        }

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
                "-Mode",
                "Set",
                "-Flow",
                request.flow,
                "-TargetName",
                targetName,
                "-FallbackId",
                fallbackDeviceId,
            ],
            timeoutMs,
        );

        return this.parsePsOutput(stdout);
    }

    /**
     * Write the PowerShell script to %TEMP% once per process. The script is
     * reused for both input and output setter actions.
     */
    private async ensureScriptOnDisk(): Promise<string> {
        if (this.psScriptPath) return this.psScriptPath;

        const dir = path.join(os.tmpdir(), "com.nathan.defaultaudio");
        await fs.mkdir(dir, { recursive: true });
        const file = path.join(dir, "set-default-audio.ps1");
        await fs.writeFile(file, POWERSHELL_SET_DEFAULT_SCRIPT, { encoding: "utf8" });
        this.psScriptPath = file;

        getLogger().debug("AudioDefaultDeviceSetter", `PowerShell script staged at ${file}`);
        return file;
    }

    private parsePsOutput(stdout: string): SetDefaultDeviceResult {
        // The script writes one line:
        //   OK<TAB><name><TAB><deviceId><TAB><matchedBy>
        // or:
        //   ERR<TAB><reason>
        const line = stdout.replace(/^\uFEFF/, "").split(/\r?\n/).find((l) => l.length > 0);
        if (!line) throw new SetDefaultDeviceError("empty PowerShell output");

        const parts = line.split("\t");
        const status = parts[0];
        if (status === "OK") {
            const name = parts[1]?.trim() ?? "";
            const deviceId = parts[2]?.trim() ?? "";
            const matchedBy = parts[3]?.trim() ?? "unknown";

            if (!name || !deviceId) {
                throw new SetDefaultDeviceError(`malformed PowerShell OK output: ${line}`);
            }

            return { name, deviceId, matchedBy };
        }

        if (status === "ERR") {
            throw new SetDefaultDeviceError(parts.slice(1).join("\t").trim() || "unknown");
        }

        throw new SetDefaultDeviceError(`malformed PowerShell output: ${line}`);
    }

    private parseListPsOutput(stdout: string): AudioEndpointDevice[] {
        // The script writes one line:
        //   OK<TAB>[{"id":"...","name":"..."}]
        // or:
        //   ERR<TAB><reason>
        const line = stdout.replace(/^\uFEFF/, "").split(/\r?\n/).find((l) => l.length > 0);
        if (!line) throw new SetDefaultDeviceError("empty PowerShell output");

        const tabIdx = line.indexOf("\t");
        if (tabIdx === -1) {
            throw new SetDefaultDeviceError(`malformed PowerShell output: ${line}`);
        }

        const status = line.slice(0, tabIdx);
        const payload = line.slice(tabIdx + 1).trim();
        if (status === "ERR") {
            throw new SetDefaultDeviceError(payload || "unknown");
        }
        if (status !== "OK") {
            throw new SetDefaultDeviceError(`malformed PowerShell output: ${line}`);
        }

        let parsed: unknown;
        try {
            parsed = JSON.parse(payload);
        } catch (err) {
            throw new SetDefaultDeviceError(
                `malformed device list JSON: ${err instanceof Error ? err.message : String(err)}`,
            );
        }

        if (!Array.isArray(parsed)) {
            throw new SetDefaultDeviceError("PowerShell device list was not an array");
        }

        return parsed
            .map((item) => {
                if (
                    typeof item === "object" &&
                    item !== null &&
                    "id" in item &&
                    "name" in item &&
                    typeof item.id === "string" &&
                    typeof item.name === "string"
                ) {
                    return { id: item.id, name: item.name };
                }
                return undefined;
            })
            .filter((item): item is AudioEndpointDevice => item !== undefined);
    }

    /**
     * Spawn a process with a hard timeout. Returns stdout as UTF-8.
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
                    reject(
                        new SetDefaultDeviceError(
                            `${command} timed out after ${timeoutMs}ms`,
                        ),
                    ),
                );
            }, timeoutMs);

            child.stdout.setEncoding("utf8");
            child.stderr.setEncoding("utf8");
            child.stdout.on("data", (d) => (stdout += d));
            child.stderr.on("data", (d) => (stderr += d));

            child.on("error", (err) => {
                settle(() =>
                    reject(
                        new SetDefaultDeviceError(
                            `${command} spawn failed: ${err.message}`,
                        ),
                    ),
                );
            });

            child.on("close", (code) => {
                if (code === 0) {
                    settle(() => resolve(stdout));
                } else {
                    settle(() =>
                        reject(
                            new SetDefaultDeviceError(
                                `${command} exited ${code}: ${stderr.trim() || "(no stderr)"}`,
                            ),
                        ),
                    );
                }
            });
        });
    }
}
