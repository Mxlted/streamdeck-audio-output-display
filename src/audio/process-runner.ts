import { spawn } from "node:child_process";
import * as path from "node:path";

const DEFAULT_MAX_OUTPUT_BYTES = 1024 * 1024;

export const WINDOWS_SYSTEM32 = path.join(
    process.env.SystemRoot || "C:\\Windows",
    "System32",
);

export const POWERSHELL_EXE = path.join(
    WINDOWS_SYSTEM32,
    "WindowsPowerShell",
    "v1.0",
    "powershell.exe",
);

export const REG_EXE = path.join(WINDOWS_SYSTEM32, "reg.exe");

export interface RunProcessOptions {
    timeoutMs: number;
    maxOutputBytes?: number;
}

/**
 * Runs a hidden child process with a hard deadline and bounded output buffers.
 * The caller receives stdout only after a successful zero exit code.
 */
export function runProcess(
    command: string,
    args: readonly string[],
    options: RunProcessOptions,
): Promise<string> {
    const timeoutMs = Math.max(1, Math.floor(options.timeoutMs));
    const maxOutputBytes = Math.max(
        1024,
        Math.floor(options.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES),
    );

    return new Promise<string>((resolve, reject) => {
        const child = spawn(command, args, {
            windowsHide: true,
            stdio: ["ignore", "pipe", "pipe"],
        });

        let stdout = "";
        let stderr = "";
        let outputBytes = 0;
        let settled = false;

        const settle = (fn: () => void) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            fn();
        };

        const fail = (message: string) => {
            try {
                child.kill("SIGKILL");
            } catch {
                /* The process may already have exited. */
            }
            settle(() => reject(new Error(message)));
        };

        const append = (channel: "stdout" | "stderr", chunk: unknown) => {
            if (settled) return;
            const text = String(chunk);
            outputBytes += Buffer.byteLength(text, "utf8");
            if (outputBytes > maxOutputBytes) {
                fail(`${command} exceeded ${maxOutputBytes} bytes of output`);
                return;
            }

            if (channel === "stdout") stdout += text;
            else stderr += text;
        };

        const timer = setTimeout(() => {
            fail(`${command} timed out after ${timeoutMs}ms`);
        }, timeoutMs);

        child.stdout?.setEncoding("utf8");
        child.stderr?.setEncoding("utf8");
        child.stdout?.on("data", (chunk) => append("stdout", chunk));
        child.stderr?.on("data", (chunk) => append("stderr", chunk));

        child.on("error", (err) => {
            settle(() => reject(new Error(`${command} spawn failed: ${err.message}`)));
        });

        child.on("close", (code) => {
            if (code === 0) {
                settle(() => resolve(stdout));
                return;
            }

            settle(() =>
                reject(
                    new Error(
                        `${command} exited ${code}: ${stderr.trim() || "(no stderr)"}`,
                    ),
                ),
            );
        });
    });
}
