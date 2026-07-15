import assert from "node:assert/strict";
import test from "node:test";

import { runProcess } from "../src/audio/process-runner.js";

test("runProcess captures successful stdout", async () => {
    const stdout = await runProcess(
        process.execPath,
        ["-e", "process.stdout.write('ready')"],
        { timeoutMs: 2000 },
    );
    assert.equal(stdout, "ready");
});

test("runProcess enforces its deadline", async () => {
    await assert.rejects(
        runProcess(process.execPath, ["-e", "setTimeout(() => {}, 1000)"], {
            timeoutMs: 50,
        }),
        /timed out/,
    );
});

test("runProcess rejects excessive output", async () => {
    await assert.rejects(
        runProcess(
            process.execPath,
            ["-e", "process.stdout.write('x'.repeat(4096))"],
            { timeoutMs: 2000, maxOutputBytes: 1024 },
        ),
        /exceeded 1024 bytes/,
    );
});
