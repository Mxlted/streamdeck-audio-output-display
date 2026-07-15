import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";

const stagedScripts = new Map<string, Promise<string>>();

/**
 * Stages an embedded PowerShell payload and coalesces concurrent callers.
 * Existing content is verified on every operation so cleanup tools or partial
 * writes self-heal.
 */
export function stagePowerShellScript(fileName: string, content: string): Promise<string> {
    const existing = stagedScripts.get(fileName);
    if (existing) return existing;

    const operation = stage(fileName, content);
    stagedScripts.set(fileName, operation);
    void operation.then(
        () => {
            if (stagedScripts.get(fileName) === operation) stagedScripts.delete(fileName);
        },
        () => {
            if (stagedScripts.get(fileName) === operation) stagedScripts.delete(fileName);
        },
    );
    return operation;
}

async function stage(fileName: string, content: string): Promise<string> {
    const dir = path.join(os.tmpdir(), "com.nathan.defaultaudio");
    const file = path.join(dir, fileName);
    await fs.mkdir(dir, { recursive: true });

    try {
        const current = await fs.readFile(file, "utf8");
        if (current === content) return file;
    } catch {
        /* Missing or unreadable scripts are rewritten below. */
    }

    await fs.writeFile(file, content, { encoding: "utf8" });
    return file;
}
