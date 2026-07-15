import streamDeck, {
    action,
    SingletonAction,
    type DidReceiveSettingsEvent,
    type JsonObject,
    type KeyAction,
    type KeyDownEvent,
    type WillAppearEvent,
    type WillDisappearEvent,
} from "@elgato/streamdeck";

import { AudioDetector, DetectionError, type DetectionResult } from "../audio/detector.js";
import { shortenDeviceName, wrapForKey } from "../utils/name-shortener.js";
import { getLogger } from "../utils/logger.js";

const REFRESH_DEBOUNCE_MS = 250;
const MEMORY_CACHE_MS = 750;
const PERSISTED_CACHE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000;
const PERSIST_MIN_INTERVAL_MS = 60 * 1000;

export interface AudioDeviceSettings extends JsonObject {
    customLabel?: string;
    maxLength?: number;
    aggressiveShorten?: boolean;
    nameStyle?: "role" | "model" | "full";
}

interface GlobalAudioSettings extends JsonObject {
    lastDefaultOutputName?: string;
    lastDefaultOutputUpdatedAt?: number;
}

export interface AudioDeviceActionOptions {
    detector?: AudioDetector;
    onActiveDetectionCountChanged?: (activeCount: number) => void;
}

@action({ UUID: "com.nathan.defaultaudio.show" })
export class AudioDeviceAction extends SingletonAction<AudioDeviceSettings> {
    private readonly detector: AudioDetector;
    private readonly onActiveDetectionCountChanged?: (activeCount: number) => void;
    private readonly visible = new Map<string, KeyAction<AudioDeviceSettings>>();
    private readonly visibleSettings = new Map<string, AudioDeviceSettings>();
    private readonly activeDetectionContexts = new Set<string>();
    private readonly renderGenerations = new Map<string, number>();
    private refreshAllTimer: NodeJS.Timeout | null = null;

    private lastDetection: DetectionResult | null = null;
    private lastDetectionAt = 0;
    private completedInvalidation = -1;
    private invalidation = 0;
    private detectionInFlight: Promise<DetectionResult> | null = null;

    private globalSettings: GlobalAudioSettings = {};
    private globalSettingsLoaded = false;
    private globalSettingsLoad: Promise<void> | null = null;
    private persistChain: Promise<void> = Promise.resolve();
    private lastPersistedName = "";
    private lastPersistedAt = 0;

    constructor(options: AudioDeviceActionOptions = {}) {
        super();
        this.detector = options.detector ?? new AudioDetector();
        this.onActiveDetectionCountChanged = options.onActiveDetectionCountChanged;
    }

    override onWillAppear(ev: WillAppearEvent<AudioDeviceSettings>): void {
        const log = getLogger();
        log.info("Action", `willAppear · context=${ev.action.id}`);
        if (!ev.action.isKey()) return;

        this.visible.set(ev.action.id, ev.action);
        this.visibleSettings.set(ev.action.id, ev.payload.settings ?? {});
        void this.initializeVisibleKey(ev.action).catch((err) => {
            log.warn("Action", `initial refresh failed for ${ev.action.id}`, err);
        });
    }

    override onWillDisappear(ev: WillDisappearEvent<AudioDeviceSettings>): void {
        getLogger().info("Action", `willDisappear · context=${ev.action.id}`);
        this.visible.delete(ev.action.id);
        this.visibleSettings.delete(ev.action.id);
        this.renderGenerations.delete(ev.action.id);
        this.setDetectionActive(ev.action.id, false);
    }

    override async onKeyDown(ev: KeyDownEvent<AudioDeviceSettings>): Promise<void> {
        getLogger().info("Action", `keyDown · context=${ev.action.id}`);
        this.invalidateDetection();
        await this.refresh(ev.action, ev.payload.settings, true);
    }

    override onDidReceiveSettings(
        ev: DidReceiveSettingsEvent<AudioDeviceSettings>,
    ): void {
        getLogger().info("Action", `didReceiveSettings · context=${ev.action.id}`);
        if (!ev.action.isKey()) return;
        if (this.visible.get(ev.action.id) !== ev.action) return;

        this.visibleSettings.set(ev.action.id, ev.payload.settings ?? {});
        this.setDetectionActive(ev.action.id, !hasCustomLabel(ev.payload.settings));
        const generation = this.nextRenderGeneration(ev.action.id);
        if (hasCustomLabel(ev.payload.settings)) {
            void this.renderCustomLabel(
                ev.action,
                ev.payload.settings.customLabel,
                generation,
            );
            return;
        }

        if (this.lastDetection) {
            void this.renderResult(
                ev.action,
                ev.payload.settings,
                this.lastDetection,
                generation,
            );
            return;
        }

        void this.refresh(ev.action, ev.payload.settings, false);
    }

    /** Loads a last-known device name after the SDK connection is established. */
    async hydrateCachedDevice(): Promise<void> {
        if (this.globalSettingsLoaded) return;
        if (this.globalSettingsLoad) return this.globalSettingsLoad;

        const operation = this.loadCachedDevice();
        this.globalSettingsLoad = operation;
        try {
            await operation;
        } finally {
            if (this.globalSettingsLoad === operation) this.globalSettingsLoad = null;
        }
    }

    private async loadCachedDevice(): Promise<void> {
        try {
            const settings = await streamDeck.settings.getGlobalSettings<GlobalAudioSettings>();
            this.globalSettings = settings;
            this.globalSettingsLoaded = true;

            const name = settings.lastDefaultOutputName?.trim() ?? "";
            const updatedAt = Number(settings.lastDefaultOutputUpdatedAt ?? 0);
            const cachedAt = Number.isFinite(updatedAt) ? updatedAt : 0;
            const hasLiveDetection =
                this.lastDetection !== null && this.lastDetection.source !== "cache";
            if (!hasLiveDetection) {
                this.lastPersistedName = name;
                this.lastPersistedAt = cachedAt;
            }

            if (
                !this.lastDetection &&
                name &&
                cachedAt > 0 &&
                Date.now() - cachedAt <= PERSISTED_CACHE_MAX_AGE_MS
            ) {
                this.lastDetection = { name, source: "cache" };
                this.lastDetectionAt = cachedAt;
                getLogger().info("Action", `loaded cached device name: "${name}"`);
            }
        } catch (err) {
            this.globalSettingsLoaded = true;
            getLogger().warn("Action", "failed to load cached device name", err);
        }
    }

    private async initializeVisibleKey(
        key: KeyAction<AudioDeviceSettings>,
    ): Promise<void> {
        // Global settings are cheap and local. Loading them before starting the
        // watcher avoids immediate cold-start subprocess pressure and lets a
        // cached title render first during Stream Deck startup.
        await this.hydrateCachedDevice();
        if (this.visible.get(key.id) !== key) return;

        const settings = this.visibleSettings.get(key.id) ?? {};
        this.setDetectionActive(key.id, !hasCustomLabel(settings));
        await this.refresh(key, settings, false);
    }

    scheduleRefreshAll(): void {
        if (this.refreshAllTimer) clearTimeout(this.refreshAllTimer);
        this.refreshAllTimer = setTimeout(() => {
            this.refreshAllTimer = null;
            this.invalidateDetection();
            void this.refreshAll();
        }, REFRESH_DEBOUNCE_MS);
        this.refreshAllTimer.unref();
    }

    async refreshAll(): Promise<void> {
        if (this.visible.size === 0) return;
        const log = getLogger();

        const settingsResults = await Promise.allSettled(
            Array.from(this.visible.values(), async (action) => ({
                action,
                settings: await action.getSettings<AudioDeviceSettings>(),
                generation: this.nextRenderGeneration(action.id),
            })),
        );

        const entries = settingsResults.flatMap((result) => {
            if (result.status === "fulfilled") return [result.value];
            log.warn("Action", "refreshAll: getSettings failed", result.reason);
            return [];
        });
        if (entries.length === 0) return;

        const automaticEntries = entries.filter(({ settings }) => !hasCustomLabel(settings));
        const customEntries = entries.filter(({ settings }) => hasCustomLabel(settings));

        await Promise.allSettled(
            customEntries.map(({ action, settings, generation }) =>
                this.renderCustomLabel(
                    action,
                    settings.customLabel as string,
                    generation,
                ),
            ),
        );
        if (automaticEntries.length === 0) return;

        let result: DetectionResult;
        try {
            result = await this.requestDetection();
        } catch (err) {
            logDetectionFailure("refreshAll", err);
            if (!this.lastDetection) {
                await Promise.allSettled(
                    automaticEntries.map(({ action, generation }) =>
                        this.renderDetectionFailure(action, generation, false),
                    ),
                );
            }
            return;
        }

        await Promise.allSettled(
            automaticEntries.map(({ action, settings, generation }) =>
                this.renderResult(action, settings, result, generation),
            ),
        );
    }

    private async refresh(
        key: KeyAction<AudioDeviceSettings>,
        settings: AudioDeviceSettings | undefined,
        showAlertOnFailure: boolean,
    ): Promise<void> {
        const generation = this.nextRenderGeneration(key.id);

        if (hasCustomLabel(settings)) {
            await this.renderCustomLabel(key, settings.customLabel, generation);
            return;
        }

        if (this.lastDetection) {
            await this.renderResult(key, settings, this.lastDetection, generation);
        } else {
            await this.safeSetTitle(key, "…", generation);
        }

        try {
            const result = await this.requestDetection();
            await this.renderResult(key, settings, result, generation);
        } catch (err) {
            logDetectionFailure("refresh", err);
            if (!this.lastDetection) {
                await this.renderDetectionFailure(key, generation, showAlertOnFailure);
            } else if (showAlertOnFailure && this.isCurrentRender(key, generation)) {
                await key.showAlert().catch(() => undefined);
            }
        }
    }

    /**
     * Shares one detection across callers. If an endpoint event invalidates an
     * in-flight read, exactly one follow-up read runs before callers complete.
     */
    private async requestDetection(): Promise<DetectionResult> {
        const targetInvalidation = this.invalidation;
        if (
            this.lastDetection &&
            this.completedInvalidation >= targetInvalidation &&
            Date.now() - this.lastDetectionAt <= MEMORY_CACHE_MS
        ) {
            return this.lastDetection;
        }

        if (this.detectionInFlight) {
            await this.detectionInFlight;
            if (this.completedInvalidation < targetInvalidation) {
                return this.requestDetection();
            }
            if (!this.lastDetection) throw new Error("detection completed without a result");
            return this.lastDetection;
        }

        const operationVersion = this.invalidation;
        const operation = this.detector.detect().then((result) => {
            this.lastDetection = result;
            this.lastDetectionAt = Date.now();
            this.completedInvalidation = operationVersion;
            this.queuePersistedCache(result.name);
            return result;
        });
        this.detectionInFlight = operation;

        let result: DetectionResult;
        try {
            result = await operation;
        } finally {
            if (this.detectionInFlight === operation) this.detectionInFlight = null;
        }

        if (this.invalidation > operationVersion) return this.requestDetection();
        return result;
    }

    private invalidateDetection(): void {
        this.invalidation++;
    }

    private setDetectionActive(contextId: string, active: boolean): void {
        const wasActive = this.activeDetectionContexts.has(contextId);
        if (active === wasActive) return;

        if (active) this.activeDetectionContexts.add(contextId);
        else this.activeDetectionContexts.delete(contextId);
        this.onActiveDetectionCountChanged?.(this.activeDetectionContexts.size);
    }

    private queuePersistedCache(name: string): void {
        const now = Date.now();
        if (
            name === this.lastPersistedName &&
            now - this.lastPersistedAt < PERSIST_MIN_INTERVAL_MS
        ) {
            return;
        }

        this.lastPersistedName = name;
        this.lastPersistedAt = now;
        const persistName = name;
        const persistAt = now;
        this.persistChain = this.persistChain
            .catch(() => undefined)
            .then(async () => {
                if (!this.globalSettingsLoaded) {
                    try {
                        this.globalSettings =
                            await streamDeck.settings.getGlobalSettings<GlobalAudioSettings>();
                    } catch {
                        this.globalSettings = {};
                    }
                    this.globalSettingsLoaded = true;
                }

                this.globalSettings = {
                    ...this.globalSettings,
                    lastDefaultOutputName: persistName,
                    lastDefaultOutputUpdatedAt: persistAt,
                };
                await streamDeck.settings.setGlobalSettings(this.globalSettings);
                this.lastPersistedName = persistName;
                this.lastPersistedAt = persistAt;
            })
            .catch((err) => {
                getLogger().warn("Action", "failed to persist cached device name", err);
            });
    }

    private async renderCustomLabel(
        key: KeyAction<AudioDeviceSettings>,
        customLabel: string,
        generation: number,
    ): Promise<void> {
        await this.safeSetTitle(key, wrapForKey(customLabel.trim()), generation);
    }

    private async renderResult(
        key: KeyAction<AudioDeviceSettings>,
        settings: AudioDeviceSettings | undefined,
        result: DetectionResult,
        generation: number,
    ): Promise<void> {
        if (!this.isCurrentRender(key, generation)) return;
        const shortened = shortenDeviceName(result.name, {
            maxLength: settings?.maxLength,
            aggressive: settings?.aggressiveShorten ?? true,
            style: settings?.nameStyle ?? "role",
        });

        try {
            await key.setTitle(wrapForKey(shortened));
            if (!this.isCurrentRender(key, generation)) return;
            await key.setState(0);
        } catch (err) {
            getLogger().warn("Action", `render failed for ${key.id}`, err);
        }
    }

    private async renderDetectionFailure(
        key: KeyAction<AudioDeviceSettings>,
        generation: number,
        showAlert: boolean,
    ): Promise<void> {
        if (!this.isCurrentRender(key, generation)) return;
        try {
            await key.setTitle("Unknown");
            if (showAlert && this.isCurrentRender(key, generation)) await key.showAlert();
        } catch {
            /* The action may have disappeared. */
        }
    }

    private async safeSetTitle(
        key: KeyAction<AudioDeviceSettings>,
        title: string,
        generation: number,
    ): Promise<void> {
        if (!this.isCurrentRender(key, generation)) return;
        try {
            await key.setTitle(title);
            if (this.isCurrentRender(key, generation)) await key.setState(0);
        } catch {
            /* The action may have disappeared. */
        }
    }

    private nextRenderGeneration(contextId: string): number {
        const next = (this.renderGenerations.get(contextId) ?? 0) + 1;
        this.renderGenerations.set(contextId, next);
        return next;
    }

    private isCurrentRender(
        key: KeyAction<AudioDeviceSettings>,
        generation: number,
    ): boolean {
        return (
            this.visible.get(key.id) === key &&
            this.renderGenerations.get(key.id) === generation
        );
    }
}

function hasCustomLabel(
    settings: AudioDeviceSettings | undefined,
): settings is AudioDeviceSettings & { customLabel: string } {
    return typeof settings?.customLabel === "string" && settings.customLabel.trim().length > 0;
}

function logDetectionFailure(scope: string, err: unknown): void {
    const message =
        err instanceof DetectionError ? err.causes.join(" | ") : err instanceof Error ? err.message : String(err);
    getLogger().error("Action", `${scope}: detection failed`, message);
}
