(() => {
    "use strict";

    class StreamDeckPIConnection {
        constructor({ onOpen, onMessage, onStatus }) {
            this.onOpen = onOpen;
            this.onMessage = onMessage;
            this.onStatus = onStatus;
            this.websocket = undefined;
            this.uuid = "";
            this.action = "";
            this.settings = {};
        }

        connect(port, propertyInspectorUUID, registerEvent, actionInfo) {
            this.uuid = propertyInspectorUUID;
            try {
                const parsed = JSON.parse(actionInfo);
                this.action = parsed.action;
                this.settings = parsed.payload?.settings ?? {};
            } catch (error) {
                this.onStatus(`Invalid action information: ${error}`, "error");
                return;
            }

            this.websocket = new WebSocket(`ws://127.0.0.1:${port}`);
            this.websocket.addEventListener("open", () => {
                this.send({ event: registerEvent, uuid: this.uuid });
                this.send({ event: "getSettings", action: this.action, context: this.uuid });
                this.onStatus("Connected", "ok");
                this.onOpen(this.settings);
            });
            this.websocket.addEventListener("message", (event) => {
                try {
                    const message = JSON.parse(event.data);
                    if (message.event === "didReceiveSettings") {
                        this.settings = message.payload?.settings ?? {};
                    }
                    this.onMessage(message);
                } catch (error) {
                    this.onStatus(`Invalid message: ${error}`, "error");
                }
            });
            this.websocket.addEventListener("error", () => {
                this.onStatus("Property inspector connection failed", "error");
            });
            this.websocket.addEventListener("close", () => {
                this.onStatus("Disconnected from Stream Deck", "error");
            });
        }

        setSettings(settings) {
            this.settings = settings;
            return this.send({
                event: "setSettings",
                action: this.action,
                context: this.uuid,
                payload: settings,
            });
        }

        sendToPlugin(payload) {
            return this.send({
                event: "sendToPlugin",
                action: this.action,
                context: this.uuid,
                payload,
            });
        }

        send(message) {
            if (!this.websocket || this.websocket.readyState !== WebSocket.OPEN) return false;
            this.websocket.send(JSON.stringify(message));
            return true;
        }
    }

    window.StreamDeckPIConnection = StreamDeckPIConnection;
})();
