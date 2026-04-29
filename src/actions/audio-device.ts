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

import { AudioDetector, DetectionError } from "../audio/detector.js";
import { shortenDeviceName, wrapForKey } from "../utils/name-shortener.js";
import { getLogger } from "../utils/logger.js";

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
     * Public hook so external triggers (e.g. a future audio-change watcher)
     * can ask all visible keys to re-detect.
     */
    async refreshAll(): Promise<void> {
        for (const action of this.visible.values()) {
            try {
                const settings = await action.getSettings<AudioDeviceSettings>();
                await this.refresh(action, settings);
            } catch (err) {
                getLogger().warn(
                    "Action",
                    `refreshAll: failed for ${action.id}`,
                    err,
                );
            }
        }
    }

    /** Detect, format, and push the title to the key. */
    private async refresh(
        key: KeyAction<AudioDeviceSettings>,
        settings: AudioDeviceSettings | undefined,
    ): Promise<void> {
        const log = getLogger();

        // Show a quick "..." while we detect, so the press feels responsive.
        try {
            await key.setTitle("…");
        } catch {
            /* not fatal */
        }

        // Allow user override.
        if (settings?.customLabel && settings.customLabel.trim().length > 0) {
            const label = wrapForKey(settings.customLabel.trim());
            log.debug("Action", `using custom label: "${label}"`);
            await key.setTitle(label);
            return;
        }

        try {
            const result = await this.detector.detect();
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

            await key.setTitle(wrapped);
            await key.setState(0);
        } catch (err) {
            const causes =
                err instanceof DetectionError ? err.causes.join(" | ") : String(err);
            log.error("Action", "detection failed", causes);

            try {
                await key.setTitle("Unknown");
                await key.showAlert();
            } catch {
                /* ignore */
            }
        }
    }
}
