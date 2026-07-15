import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import * as readline from "node:readline";
import { fileURLToPath } from "node:url";
import test from "node:test";

import { POWERSHELL_EXE } from "../src/audio/process-runner.js";
import { POWERSHELL_WATCHER_SCRIPT } from "../src/audio/watcher-script.js";

test(
    "watcher script reaches READY and answers a default-render request",
    { skip: process.platform !== "win32", timeout: 15000 },
    async (t) => {
        const scriptPath = fileURLToPath(new URL("../watcher-test.ps1", import.meta.url));
        await fs.writeFile(scriptPath, POWERSHELL_WATCHER_SCRIPT, "utf8");
        t.after(async () => fs.rm(scriptPath, { force: true }));

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
            { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] },
        );
        t.after(() => {
            if (!child.killed) child.kill("SIGKILL");
        });

        child.stdout.setEncoding("utf8");
        const lines = readline.createInterface({ input: child.stdout });
        const iterator = lines[Symbol.asyncIterator]();

        const ready = await nextProtocolLine(iterator, 10000);
        assert.equal(ready, "READY");

        child.stdin.write("GET_DEFAULT_RENDER\ttest-request\n");
        let result = await nextProtocolLine(iterator, 3000);
        while (!result.startsWith("RESULT\ttest-request\t")) {
            result = await nextProtocolLine(iterator, 3000);
        }

        const parts = result.split("\t");
        assert.equal(parts[0], "RESULT");
        assert.equal(parts[1], "test-request");
        assert.match(parts[2], /^(OK|ERR)$/);
        assert.doesNotThrow(() => Buffer.from(parts[3] ?? "", "base64").toString("utf8"));

        child.stdin.write("STOP\n");
        child.stdin.end();
        await new Promise<void>((resolve, reject) => {
            child.once("close", () => resolve());
            child.once("error", reject);
        });
    },
);

async function nextProtocolLine(
    iterator: AsyncIterableIterator<string>,
    timeoutMs: number,
): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
        const result = await Promise.race([
            iterator.next(),
            new Promise<never>((_, reject) => {
                timer = setTimeout(
                    () => reject(new Error(`protocol line timed out after ${timeoutMs}ms`)),
                    timeoutMs,
                );
            }),
        ]);
        if (result.done) throw new Error("watcher stdout closed unexpectedly");
        return result.value.trim();
    } finally {
        if (timer) clearTimeout(timer);
    }
}
