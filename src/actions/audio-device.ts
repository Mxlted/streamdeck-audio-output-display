/**
 * AudioDeviceAction - Stream Deck key action.
 *
 * Lifecycle:
 *   - onWillAppear: detect device, set the title (action may be a Key or Dial — narrowed)
 *   - onKeyDown:    re-detect on demand
 *   - onWillDisappear: drop the instance from the visible-set
 *
 * All visible key instances are tracked by their action.id so that a future
 * external trigger (e.g. an audio-change notification) can refresh them all.
 */

import {
    action,
    SingletonAction,
    KeyAction,
    type DidReceiveSettingsEvent,
    type JsonObject,
    type KeyDownEvent,
    type WillAppearEvent,
    type WillDisappearEvent,
} from "@elgato/streamdeck";

import { AudioDetector, DetectionError, type DetectionResult } from "../audio/detector.js";
import { shortenDeviceName, wrapForKey } from "../utils/name-shortener.js";
import { getLogger } from "../utils/logger.js";

const REFRESH_DEBOUNCE_MS = 250;
type PrefetchedDetection = DetectionResult | null | undefined;

/**
 * Settings persisted per action instance.
 *
 * The `JsonObject` constraint requires every property to be a JsonValue, so
 * we extend it directly rather than declaring a flat interface — that gives
 * us the index signature the SDK generics expect.
 */
export interface AudioDeviceSettings extends JsonObject {
    /** Override the auto-detected name with a fixed string (advanced). */
    customLabel?: string;
    /** Max characters before truncation. */
    maxLength?: number;
    /** Strip "(Realtek(R) Audio)"-style driver suffixes. */
    aggressiveShorten?: boolean;
    /**
     * Which part of "Friendly (Driver)" device names to display:
     *   - "role"  → "Speakers"          (default — what type of device)
     *   - "model" → "Realtek(R) Audio"  (the specific hardware/driver)
     *   - "full"  → "Speakers (Realtek(R) Audio)"  (both, just cleaned up)
     */
    nameStyle?: "role" | "model" | "full";
}

@action({ UUID: "com.nathan.defaultaudio.show" })
export class AudioDeviceAction extends SingletonAction<AudioDeviceSettings> {
    private readonly detector = new AudioDetector();

    /** Visible key instances, keyed by Stream Deck context id. */
    private readonly visible = new Map<string, KeyAction<AudioDeviceSettings>>();

    /** Debounce timer for scheduleRefreshAll(); coalesces burst events. */
    private refreshAllTimer: NodeJS.Timeout | null = null;

    override async onWillAppear(
        ev: WillAppearEvent<AudioDeviceSettings>,
    ): Promise<void> {
        getLogger().info("Action", `willAppear · context=${ev.action.id}`);

        // ev.action is DialAction<T> | KeyAction<T>. We only support keys.
        if (!ev.action.isKey()) {
            getLogger().warn(
                "Action",
                `willAppear: action is not a key (manifest restricts to Keypad) — ignoring`,
            );
            return;
        }

        this.visible.set(ev.action.id, ev.action);
        await this.refresh(ev.action, ev.payload.settings);
    }

    override onWillDisappear(
        ev: WillDisappearEvent<AudioDeviceSettings>,
    ): void {
        getLogger().info("Action", `willDisappear · context=${ev.action.id}`);
        // ev.action here is a plain ActionContext - we just need the id.
        this.visible.delete(ev.action.id);
    }

    override async onKeyDown(
        ev: KeyDownEvent<AudioDeviceSettings>,
    ): Promise<void> {
        // ev.action is already narrowed to KeyAction<T> by the event type.
        getLogger().info("Action", `keyDown · context=${ev.action.id}`);
        await this.refresh(ev.action, ev.payload.settings);
    }

    /**
     * Fired whenever the property inspector saves new settings. We re-render
     * immediately so the user can see their style choice take effect without
     * needing to press the key.
     */
    override async onDidReceiveSettings(
        ev: DidReceiveSettingsEvent<AudioDeviceSettings>,
    ): Promise<void> {
        getLogger().info(
            "Action",
            `didReceiveSettings · context=${ev.action.id}`,
            ev.payload.settings,
        );
        if (!ev.action.isKey()) return;
        await this.refresh(ev.action, ev.payload.settings);
    }

    /**
     * Schedule a refresh of all visible keys, debounced. Multiple calls within
     * REFRESH_DEBOUNCE_MS coalesce into a single detect — important because
     * Windows often fires several IMMNotificationClient events back-to-back
     * (state change + default change + property change) for one user action.
     */
    scheduleRefreshAll(): void {
        if (this.refreshAllTimer) clearTimeout(this.refreshAllTimer);
        this.refreshAllTimer = setTimeout(() => {
            this.refreshAllTimer = null;
            void this.refreshAll();
        }, REFRESH_DEBOUNCE_MS);
        this.refreshAllTimer.unref();
    }

    /**
     * Re-detect once and apply the result to every visible key. External
     * callers should usually go through scheduleRefreshAll() instead.
     */
    async refreshAll(): Promise<void> {
        if (this.visible.size === 0) return;
        const log = getLogger();

        const visibleActions = Array.from(this.visible.values());
        const entries: Array<{
            action: KeyAction<AudioDeviceSettings>;
            settings: AudioDeviceSettings | undefined;
        }> = [];

        for (const action of visibleActions) {
            try {
                const settings = await action.getSettings<AudioDeviceSettings>();
                entries.push({ action, settings });
            } catch (err) {
                log.warn("Action", `refreshAll: getSettings failed for ${action.id}`, err);
            }
        }

        if (entries.length === 0) return;

        // Detect once; share the result across keys so we don't spawn one
        // PowerShell process per visible key. If every visible key has a custom
        // label, skip detection entirely.
        let result: PrefetchedDetection;
        if (entries.some(({ settings }) => !hasCustomLabel(settings))) {
            try {
                result = await this.detector.detect();
            } catch (err) {
                const causes =
                    err instanceof DetectionError ? err.causes.join(" | ") : String(err);
                log.error("Action", "refreshAll: detection failed", causes);
                result = null;
            }
        }

        for (const { action, settings } of entries) {
            try {
                await this.refresh(action, settings, result);
            } catch (err) {
                log.warn("Action", `refreshAll: failed for ${action.id}`, err);
            }
        }
    }

    /**
     * Detect (or use a pre-fetched result), format, and push the title to
     * the key. Pass `preDetected` from refreshAll() to share one detect
     * across all visible keys.
     */
    private async refresh(
        key: KeyAction<AudioDeviceSettings>,
        settings: AudioDeviceSettings | undefined,
        preDetected?: PrefetchedDetection,
    ): Promise<void> {
        const log = getLogger();

        // Allow user override — fast path, no detect needed.
        if (hasCustomLabel(settings)) {
            const label = wrapForKey(settings.customLabel.trim());
            log.debug("Action", `using custom label: "${label}"`);
            try {
                await key.setTitle(label);
            } catch {
                /* not fatal */
            }
            return;
        }

        // Only show the "…" placeholder when we're about to do real work
        // (no preDetected). With preDetected we render immediately and the
        // flicker would just be noise.
        if (!preDetected) {
            try {
                await key.setTitle("…");
            } catch {
                /* not fatal */
            }
        }

        if (preDetected === null) {
            await this.renderDetectionFailure(key);
            return;
        }

        let result = preDetected;
        if (!result) {
            try {
                result = await this.detector.detect();
            } catch (err) {
                const causes =
                    err instanceof DetectionError ? err.causes.join(" | ") : String(err);
                log.error("Action", "detection failed", causes);
                await this.renderDetectionFailure(key);
                return;
            }
        }

        const shortened = shortenDeviceName(result.name, {
            maxLength: settings?.maxLength,
            aggressive: settings?.aggressiveShorten ?? true,
            style: settings?.nameStyle ?? "role",
        });
        const wrapped = wrapForKey(shortened);

        log.info(
            "Action",
            `device="${result.name}" → display="${shortened}" (via ${result.source})`,
        );

        try {
            await key.setTitle(wrapped);
            await key.setState(0);
        } catch (err) {
            log.warn("Action", `setTitle failed for ${key.id}`, err);
        }
    }

    private async renderDetectionFailure(
        key: KeyAction<AudioDeviceSettings>,
    ): Promise<void> {
        try {
            await key.setTitle("Unknown");
            await key.showAlert();
        } catch {
            /* ignore */
        }
    }
}

function hasCustomLabel(
    settings: AudioDeviceSettings | undefined,
): settings is AudioDeviceSettings & { customLabel: string } {
    return typeof settings?.customLabel === "string" && settings.customLabel.trim().length > 0;
}
