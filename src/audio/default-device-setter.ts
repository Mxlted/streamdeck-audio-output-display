/**
 * AudioDefaultDeviceSetter - sets the default Windows input/output endpoint.
 *
 * Device lookup uses the saved endpoint ID first while it remains active, then
 * exact friendly-name matching for replug/driver-update recovery.
 */

import { POWERSHELL_SET_DEFAULT_SCRIPT } from "./set-default-script.js";
import { POWERSHELL_EXE, runProcess } from "./process-runner.js";
import { stagePowerShellScript } from "./script-stager.js";

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
    async listDevices(
        flow: AudioEndpointFlow,
        timeoutMs: number = DEFAULT_TIMEOUT_MS,
    ): Promise<AudioEndpointDevice[]> {
        const scriptPath = await stagePowerShellScript(
            "set-default-audio.ps1",
            POWERSHELL_SET_DEFAULT_SCRIPT,
        );
        const stdout = await this.runPowerShell(
            ["-File", scriptPath, "-Mode", "List", "-Flow", flow],
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

        const scriptPath = await stagePowerShellScript(
            "set-default-audio.ps1",
            POWERSHELL_SET_DEFAULT_SCRIPT,
        );
        const stdout = await this.runPowerShell(
            [
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

    private parsePsOutput(stdout: string): SetDefaultDeviceResult {
        // The script writes one line:
        //   OK<TAB><name><TAB><deviceId><TAB><matchedBy>
        // or:
        //   ERR<TAB><reason>
        const line = this.findProtocolLine(stdout);
        if (!line) throw new SetDefaultDeviceError("empty PowerShell output");

        const tabIdx = line.indexOf("\t");
        if (tabIdx === -1) {
            throw new SetDefaultDeviceError(`malformed PowerShell output: ${line}`);
        }

        const status = line.slice(0, tabIdx);
        const payload = line.slice(tabIdx + 1);
        if (status === "OK") {
            const matchedByTabIdx = payload.lastIndexOf("\t");
            if (matchedByTabIdx === -1) {
                throw new SetDefaultDeviceError(`malformed PowerShell OK output: ${line}`);
            }

            const nameAndDeviceId = payload.slice(0, matchedByTabIdx);
            const deviceIdTabIdx = nameAndDeviceId.lastIndexOf("\t");
            if (deviceIdTabIdx === -1) {
                throw new SetDefaultDeviceError(`malformed PowerShell OK output: ${line}`);
            }

            const name = nameAndDeviceId.slice(0, deviceIdTabIdx).trim();
            const deviceId = nameAndDeviceId.slice(deviceIdTabIdx + 1).trim();
            const matchedBy = payload.slice(matchedByTabIdx + 1).trim() || "unknown";

            if (!name || !deviceId) {
                throw new SetDefaultDeviceError(`malformed PowerShell OK output: ${line}`);
            }

            return { name, deviceId, matchedBy };
        }

        if (status === "ERR") {
            throw new SetDefaultDeviceError(payload.trim() || "unknown");
        }

        throw new SetDefaultDeviceError(`malformed PowerShell output: ${line}`);
    }

    private parseListPsOutput(stdout: string): AudioEndpointDevice[] {
        // The script writes one line:
        //   OK<TAB>[{"id":"...","name":"..."}]
        // or:
        //   ERR<TAB><reason>
        const line = this.findProtocolLine(stdout);
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

    private findProtocolLine(stdout: string): string | undefined {
        return stdout
            .replace(/^\uFEFF/, "")
            .split(/\r?\n/)
            .find((line) => line.startsWith("OK\t") || line.startsWith("ERR\t"));
    }

    private async runPowerShell(
        args: readonly string[],
        timeoutMs: number,
    ): Promise<string> {
        try {
            return await runProcess(
                POWERSHELL_EXE,
                [
                    "-NoProfile",
                    "-NonInteractive",
                    "-ExecutionPolicy",
                    "Bypass",
                    ...args,
                ],
                { timeoutMs },
            );
        } catch (err) {
            throw new SetDefaultDeviceError(
                err instanceof Error ? err.message : String(err),
            );
        }
    }
}
