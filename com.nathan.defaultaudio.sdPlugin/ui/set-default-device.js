(() => {
    "use strict";

    const select = document.getElementById("deviceSelect");
    const refreshButton = document.getElementById("refreshDevices");
    const status = document.getElementById("status");
    let settings = {};
    let devices = [];

    const connection = new window.StreamDeckPIConnection({
        onOpen: (initialSettings) => {
            settings = initialSettings;
            requestDevices();
        },
        onMessage: handleMessage,
        onStatus: setStatus,
    });

    window.connectElgatoStreamDeckSocket = (
        port,
        propertyInspectorUUID,
        registerEvent,
        _info,
        actionInfo,
    ) => connection.connect(port, propertyInspectorUUID, registerEvent, actionInfo);

    refreshButton.addEventListener("click", requestDevices);
    select.addEventListener("change", () => {
        const option = select.selectedOptions[0];
        if (!option?.value) return;

        settings = {
            ...settings,
            selectedDeviceId: option.value,
            selectedDeviceName: option.dataset.name || "",
        };
        delete settings.fallbackDeviceId;
        delete settings.targetName;
        connection.setSettings(settings);
        setStatus("Selection saved", "ok");
    });

    function requestDevices() {
        select.disabled = true;
        refreshButton.disabled = true;
        setStatus("Loading devices…", "");
        if (!connection.sendToPlugin({ type: "list-devices" })) {
            setStatus("Not connected to Stream Deck", "error");
        }
    }

    function handleMessage(message) {
        if (message.event === "didReceiveSettings") {
            settings = message.payload?.settings ?? {};
            renderDevices();
            return;
        }
        if (message.event !== "sendToPropertyInspector") return;

        const payload = message.payload;
        if (payload?.type === "device-list") {
            devices = Array.isArray(payload.devices) ? payload.devices : [];
            renderDevices();
            setStatus(`${devices.length} active device${devices.length === 1 ? "" : "s"}`, "ok");
        } else if (payload?.type === "device-list-error") {
            select.disabled = true;
            refreshButton.disabled = false;
            select.replaceChildren(new Option("Unable to load devices", ""));
            setStatus(payload.message || "Unable to load devices", "error");
        }
    }

    function renderDevices() {
        select.replaceChildren();
        refreshButton.disabled = false;

        const selectedId = settings.selectedDeviceId || settings.fallbackDeviceId || "";
        const selectedName = settings.selectedDeviceName || settings.targetName || "";
        if (devices.length === 0) {
            select.disabled = true;
            select.append(new Option("No active devices", ""));
            return;
        }

        const nameCounts = new Map();
        for (const device of devices) {
            nameCounts.set(device.name, (nameCounts.get(device.name) || 0) + 1);
        }

        const nameIndexes = new Map();
        let matchedSelection = false;
        select.append(new Option("Choose a device", ""));

        for (const device of devices) {
            const nextIndex = (nameIndexes.get(device.name) || 0) + 1;
            nameIndexes.set(device.name, nextIndex);
            const duplicate = (nameCounts.get(device.name) || 0) > 1;
            const option = new Option(
                duplicate ? `${device.name} #${nextIndex}` : device.name,
                device.id,
            );
            option.dataset.name = device.name;
            if (
                device.id === selectedId ||
                (!selectedId && selectedName && device.name === selectedName)
            ) {
                option.selected = true;
                matchedSelection = true;
            }
            select.append(option);
        }

        if (!matchedSelection && selectedName) {
            const missing = new Option(`${selectedName} (disconnected)`, selectedId, true, true);
            missing.disabled = true;
            select.append(missing);
        }
        select.disabled = false;
    }

    function setStatus(message, kind) {
        status.textContent = message;
        status.dataset.kind = kind;
        if (kind === "error") refreshButton.disabled = false;
    }
})();
