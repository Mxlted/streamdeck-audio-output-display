import commonjs from "@rollup/plugin-commonjs";
import json from "@rollup/plugin-json";
import nodeResolve from "@rollup/plugin-node-resolve";
import typescript from "@rollup/plugin-typescript";
import path from "node:path";
import url from "node:url";

const isWatching = !!process.env.ROLLUP_WATCH;
const sdPlugin = "com.nathan.defaultaudio.sdPlugin";

/** @type {import("rollup").RollupOptions} */
const config = {
    input: "src/plugin.ts",
    output: {
        file: `${sdPlugin}/bin/plugin.js`,
        format: "es",
        sourcemap: isWatching,
        sourcemapPathTransform: (relativeSourcePath, sourcemapPath) => {
            return url
                .pathToFileURL(path.resolve(path.dirname(sourcemapPath), relativeSourcePath))
                .href;
        },
    },
    plugins: [
        {
            name: "watch-externals",
            buildStart: function () {
                this.addWatchFile(`${sdPlugin}/manifest.json`);
            },
        },
        typescript({
            mapRoot: isWatching ? "./" : undefined,
            sourceMap: isWatching,
        }),
        nodeResolve({
            browser: false,
            exportConditions: ["node"],
            preferBuiltins: true,
        }),
        commonjs(),
        json(),
    ],
    external: [
        "node:fs",
        "node:path",
        "node:os",
        "node:child_process",
        "node:util",
        "node:crypto",
        "fs",
        "path",
        "os",
        "child_process",
        "util",
        "crypto",
    ],
};

export default config;
