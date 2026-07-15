import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import test from "node:test";

const pluginRoot = path.resolve(process.cwd(), "com.nathan.defaultaudio.sdPlugin");

test("property inspectors are self-contained and expose the Stream Deck callback", async () => {
    for (const fileName of ["audio-device.html", "set-default-device.html"]) {
        const htmlPath = path.join(pluginRoot, "ui", fileName);
        const html = await fs.readFile(htmlPath, "utf8");

        assert.match(html, /default-src 'none'/);
        assert.match(html, /script-src 'self'/);
        assert.doesNotMatch(html, /https?:\/\//i);

        const localReferences = Array.from(
            html.matchAll(/(?:src|href)="([^"]+)"/g),
            (match) => match[1],
        );
        assert.ok(localReferences.length > 0);
        for (const reference of localReferences) {
            await fs.access(path.resolve(path.dirname(htmlPath), reference));
        }
    }

    const sharedConnection = await fs.readFile(
        path.join(pluginRoot, "ui", "pi-connection.js"),
        "utf8",
    );
    const displayInspector = await fs.readFile(
        path.join(pluginRoot, "ui", "audio-device.js"),
        "utf8",
    );
    const setterInspector = await fs.readFile(
        path.join(pluginRoot, "ui", "set-default-device.js"),
        "utf8",
    );

    assert.match(sharedConnection, /ws:\/\/127\.0\.0\.1:/);
    assert.match(displayInspector, /connectElgatoStreamDeckSocket/);
    assert.match(setterInspector, /connectElgatoStreamDeckSocket/);
});
