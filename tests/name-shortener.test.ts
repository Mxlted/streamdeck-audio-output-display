import assert from "node:assert/strict";
import test from "node:test";

import { shortenDeviceName, wrapForKey } from "../src/utils/name-shortener.js";

test("shortenDeviceName selects role, model, and full names", () => {
    const name = "Speakers (Realtek(R) Audio)";
    assert.equal(shortenDeviceName(name, { style: "role" }), "Speakers");
    assert.equal(shortenDeviceName(name, { style: "model" }), "Realtek Audio");
    assert.equal(
        shortenDeviceName(name, { style: "full", maxLength: 40 }),
        "Speakers (Realtek Audio)",
    );
});

test("shortenDeviceName removes duplicate prefixes and bounds output", () => {
    assert.equal(
        shortenDeviceName("2- Bluetooth Headphones", { maxLength: 12 }),
        "BT Headphon…",
    );
});

test("wrapForKey marks content omitted after the third line", () => {
    assert.equal(wrapForKey("one two three four", 4), "one\ntwo\nthr…");
});
