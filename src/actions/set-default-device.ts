/**
 * SetDefaultDeviceAction - Stream Deck key actions that switch defaults.
 *
 * The input and output variants share implementation, but have separate UUIDs
 * so they appear as distinct actions in Stream Deck.
 */

import {
    default as streamDeck,
    action,
    SingletonAction,
    type DidReceiveSettingsEvent,
    type JsonObject,
    type JsonValue,
    type KeyAction,
    type KeyDownEvent,
    type SendToPluginEvent,
    type WillAppearEvent,
} from "@elgato/streamdeck";

import {
    AudioDefaultDeviceSetter,
    SetDefaultDeviceError,
    type AudioEndpointFlow,
    type AudioEndpointDevice,
} from "../audio/default-device-setter.js";
import { wrapForKey } from "../utils/name-shortener.js";
import { getLogger } from "../utils/logger.js";

export interface SetDefaultDeviceSettings extends JsonObject {
    /** Friendly device name chosen from the property inspector. */
    selectedDeviceName?: string;
    /** Endpoint ID chosen from the property inspector; used as fallback/tie-breaker. */
    selectedDeviceId?: string;
    /** Older settings retained for migration from the previous text-field PI. */
    targetName?: string;
    fallbackDeviceId?: string;
}

interface DeviceListErrorPayload extends JsonObject {
    type: "device-list-error";
    message: string;
}

interface DeviceListItemPayload extends JsonObject {
    id: string;
    name: string;
}

interface DeviceListPayload extends JsonObject {
    type: "device-list";
    devices: DeviceListItemPayload[];
}

interface ListDevicesRequest extends JsonObject {
    type: "list-devices";
}

abstract class SetDefaultDeviceActionBase extends SingletonAction<SetDefaultDeviceSettings> {
    protected abstract readonly flow: AudioEndpointFlow;
    protected abstract readonly idleTitle: string;
    protected abstract readonly logScope: string;

    private readonly setter = new AudioDefaultDeviceSetter();

    override async onWillAppear(
        ev: WillAppearEvent<SetDefaultDeviceSettings>,
    ): Promise<void> {
        getLogger().info(this.logScope, `willAppear · context=${ev.action.id}`);
        if (!ev.action.isKey()) return;
        await this.renderIdle(ev.action, ev.payload.settings);
    }

    override async onDidReceiveSettings(
        ev: DidReceiveSettingsEvent<SetDefaultDeviceSettings>,
    ): Promise<void> {
        getLogger().info(
            this.logScope,
            `didReceiveSettings · context=${ev.action.id}`,
            ev.payload.settings,
        );
        if (!ev.action.isKey()) return;
        await this.renderIdle(ev.action, ev.payload.settings);
    }

    override async onPropertyInspectorDidAppear(): Promise<void> {
        await this.sendDeviceListToCurrentInspector();
    }

    override async onSendToPlugin(
        ev: SendToPluginEvent<JsonValue, SetDefaultDeviceSettings>,
    ): Promise<void> {
        if (!isListDevicesRequest(ev.payload)) return;
        await this.sendDeviceListToCurrentInspector();
    }

    override async onKeyDown(
        ev: KeyDownEvent<SetDefaultDeviceSettings>,
    ): Promise<void> {
        const log = getLogger();
        const settings = ev.payload.settings;
        const targetName = getSelectedDeviceName(settings);
        const fallbackDeviceId = getSelectedDeviceId(settings);

        log.info(
            this.logScope,
            `keyDown · context=${ev.action.id} · targetName="${targetName}"`,
        );

        if (!targetName && !fallbackDeviceId) {
            try {
                await ev.action.setTitle("Pick\nDevice");
                await ev.action.showAlert();
            } catch {
                /* ignore */
            }
            return;
        }

        try {
            await ev.action.setTitle("...");
        } catch {
            /* ignore */
        }

        try {
            const result = await this.setter.setDefault({
                flow: this.flow,
                targetName,
                fallbackDeviceId,
            });

            log.info(
                this.logScope,
                `set default succeeded · device="${result.name}" · matchedBy=${result.matchedBy}`,
            );

            await ev.action.setSettings({
                selectedDeviceName: result.name,
                selectedDeviceId: result.deviceId,
            });
            await this.renderSuccess(ev.action, settings, result.name);
            await ev.action.showOk();
        } catch (err) {
            const message =
                err instanceof SetDefaultDeviceError || err instanceof Error
                    ? err.message
                    : String(err);
            log.error(this.logScope, `set default failed: ${message}`, err);
            try {
                await ev.action.setTitle("Failed");
                await ev.action.showAlert();
            } catch {
                /* ignore */
            }
        }
    }

    private async renderIdle(
        key: KeyAction<SetDefaultDeviceSettings>,
        settings: SetDefaultDeviceSettings | undefined,
    ): Promise<void> {
        const title = this.formatTitle(getSelectedDeviceName(settings), this.idleTitle);
        try {
            await key.setTitle(title);
            await key.setState(0);
        } catch (err) {
            getLogger().warn(this.logScope, `setTitle failed for ${key.id}`, err);
        }
    }

    private async renderSuccess(
        key: KeyAction<SetDefaultDeviceSettings>,
        _settings: SetDefaultDeviceSettings | undefined,
        deviceName: string,
    ): Promise<void> {
        const title = this.formatTitle(deviceName, this.idleTitle);
        try {
            await key.setTitle(title);
            await key.setState(0);
        } catch (err) {
            getLogger().warn(this.logScope, `setTitle failed for ${key.id}`, err);
        }
    }

    private formatTitle(deviceName: string | undefined, fallbackTitle: string): string {
        if (deviceName && deviceName.trim().length > 0) {
            return wrapForKey(deviceName.trim());
        }

        return fallbackTitle;
    }

    private async sendDeviceListToCurrentInspector(): Promise<void> {
        const log = getLogger();
        const current = streamDeck.ui.current;
        if (!current || current.action.manifestId !== this.manifestId) return;

        let payload: DeviceListPayload | DeviceListErrorPayload;
        try {
            const devices = await this.setter.listDevices(this.flow);
            payload = {
                type: "device-list",
                devices: devices.map(toDeviceListItemPayload),
            };
        } catch (err) {
            const message =
                err instanceof SetDefaultDeviceError || err instanceof Error
                    ? err.message
                    : String(err);
            log.error(this.logScope, `device list failed: ${message}`, err);
            payload = {
                type: "device-list-error",
                message,
            };
        }

        if (streamDeck.ui.current !== current) return;

        try {
            await current.sendToPropertyInspector(payload);
        } catch (err) {
            log.warn(this.logScope, "sendToPropertyInspector failed", err);
        }
    }
}

function toDeviceListItemPayload(device: AudioEndpointDevice): DeviceListItemPayload {
    return {
        id: device.id,
        name: device.name,
    };
}

@action({ UUID: "com.nathan.defaultaudio.set-output" })
export class SetDefaultOutputDeviceAction extends SetDefaultDeviceActionBase {
    protected readonly flow = "render";
    protected readonly idleTitle = "Set\nOutput";
    protected readonly logScope = "SetDefaultOutput";
}

@action({ UUID: "com.nathan.defaultaudio.set-input" })
export class SetDefaultInputDeviceAction extends SetDefaultDeviceActionBase {
    protected readonly flow = "capture";
    protected readonly idleTitle = "Set\nInput";
    protected readonly logScope = "SetDefaultInput";
}

function getSelectedDeviceName(
    settings: SetDefaultDeviceSettings | undefined,
): string {
    return (
        settings?.selectedDeviceName?.trim() ||
        settings?.targetName?.trim() ||
        ""
    );
}

function getSelectedDeviceId(settings: SetDefaultDeviceSettings | undefined): string {
    return (
        settings?.selectedDeviceId?.trim() ||
        settings?.fallbackDeviceId?.trim() ||
        ""
    );
}

function isListDevicesRequest(payload: JsonValue): payload is ListDevicesRequest {
    return (
        typeof payload === "object" &&
        payload !== null &&
        !Array.isArray(payload) &&
        "type" in payload &&
        payload.type === "list-devices"
    );
}
