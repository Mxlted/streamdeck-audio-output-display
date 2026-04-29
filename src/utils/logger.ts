/**
 * Logger - Custom file-based logger with timestamps, levels, and rotation.
 *
 * Logs go to <plugin-dir>/logs/plugin.log so the user can find them easily.
 * The Stream Deck SDK has its own logger; this one runs alongside it for
 * developer-friendly inspection and survives plugin restarts.
 */

import * as fs from "node:fs";
import * as path from "node:path";
import * as os from "node:os";

export enum LogLevel {
    DEBUG = 0,
    INFO = 1,
    WARN = 2,
    ERROR = 3,
}

const LEVEL_NAMES: Record<LogLevel, string> = {
    [LogLevel.DEBUG]: "DEBUG",
    [LogLevel.INFO]: "INFO ",
    [LogLevel.WARN]: "WARN ",
    [LogLevel.ERROR]: "ERROR",
};

interface LoggerOptions {
    /** Absolute path to the directory where logs should be written. */
    logDir: string;
    /** Maximum size in bytes before rotation. Defaults to 1 MiB. */
    maxSize?: number;
    /** Number of rotated files to keep. Defaults to 3. */
    maxFiles?: number;
    /** Minimum level to write. Defaults to DEBUG. */
    minLevel?: LogLevel;
}

class Logger {
    private logFile: string;
    private maxSize: number;
    private maxFiles: number;
    private minLevel: LogLevel;
    private writing = false;
    private queue: string[] = [];

    constructor(options: LoggerOptions) {
        this.maxSize = options.maxSize ?? 1024 * 1024;
        this.maxFiles = options.maxFiles ?? 3;
        this.minLevel = options.minLevel ?? LogLevel.DEBUG;

        // Ensure log directory exists. Fall back to %TEMP% if we can't write.
        let dir = options.logDir;
        try {
            fs.mkdirSync(dir, { recursive: true });
        } catch {
            dir = path.join(os.tmpdir(), "com.nathan.defaultaudio");
            fs.mkdirSync(dir, { recursive: true });
        }
        this.logFile = path.join(dir, "plugin.log");

        this.write(LogLevel.INFO, "Logger", `==== plugin started · pid=${process.pid} · log=${this.logFile}`);
    }

    setLevel(level: LogLevel): void {
        this.minLevel = level;
    }

    debug(scope: string, message: string, meta?: unknown): void {
        this.write(LogLevel.DEBUG, scope, message, meta);
    }

    info(scope: string, message: string, meta?: unknown): void {
        this.write(LogLevel.INFO, scope, message, meta);
    }

    warn(scope: string, message: string, meta?: unknown): void {
        this.write(LogLevel.WARN, scope, message, meta);
    }

    error(scope: string, message: string, meta?: unknown): void {
        this.write(LogLevel.ERROR, scope, message, meta);
    }

    /** Returns the absolute path to the log file (useful for diagnostics). */
    getLogFilePath(): string {
        return this.logFile;
    }

    private write(level: LogLevel, scope: string, message: string, meta?: unknown): void {
        if (level < this.minLevel) return;

        const ts = new Date().toISOString();
        const levelName = LEVEL_NAMES[level];
        let line = `${ts} [${levelName}] [${scope}] ${message}`;

        if (meta !== undefined) {
            try {
                if (meta instanceof Error) {
                    line += ` | ${meta.name}: ${meta.message}`;
                    if (meta.stack) line += `\n${meta.stack}`;
                } else {
                    line += ` | ${JSON.stringify(meta)}`;
                }
            } catch {
                line += ` | [unserialisable meta]`;
            }
        }

        line += "\n";

        // Mirror to stderr so it shows up in Stream Deck's debug console too.
        process.stderr.write(line);

        // Buffer + flush to avoid sync I/O on the event loop hot path.
        this.queue.push(line);
        this.flush();
    }

    private flush(): void {
        if (this.writing || this.queue.length === 0) return;
        this.writing = true;

        const batch = this.queue.join("");
        this.queue.length = 0;

        fs.appendFile(this.logFile, batch, (err) => {
            this.writing = false;

            if (err) {
                process.stderr.write(`[Logger] write failed: ${err.message}\n`);
            } else {
                this.maybeRotate();
            }

            // If new entries arrived during the write, flush them too.
            if (this.queue.length > 0) this.flush();
        });
    }

    private maybeRotate(): void {
        fs.stat(this.logFile, (err, stats) => {
            if (err || stats.size < this.maxSize) return;

            // Shift older files: plugin.log.2 -> plugin.log.3, plugin.log.1 -> plugin.log.2, etc.
            for (let i = this.maxFiles - 1; i >= 1; i--) {
                const src = `${this.logFile}.${i}`;
                const dst = `${this.logFile}.${i + 1}`;
                try {
                    if (fs.existsSync(src)) fs.renameSync(src, dst);
                } catch {
                    /* ignore */
                }
            }

            try {
                fs.renameSync(this.logFile, `${this.logFile}.1`);
            } catch {
                /* ignore - next write will recreate */
            }
        });
    }
}

let singleton: Logger | null = null;

/** Initialise the global logger. Call this once at plugin startup. */
export function initLogger(options: LoggerOptions): Logger {
    singleton = new Logger(options);
    return singleton;
}

/** Get the global logger. Throws if initLogger hasn't been called. */
export function getLogger(): Logger {
    if (!singleton) {
        throw new Error("Logger not initialised. Call initLogger() first.");
    }
    return singleton;
}
