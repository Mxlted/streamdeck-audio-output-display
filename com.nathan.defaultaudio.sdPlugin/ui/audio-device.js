(() => {
    "use strict";

    const customLabel = document.getElementById("customLabel");
    const nameStyle = document.getElementById("nameStyle");
    const maxLength = document.getElementById("maxLength");
    const maxLengthValue = document.getElementById("maxLengthValue");
    const aggressiveShorten = document.getElementById("aggressiveShorten");
    const status = document.getElementById("status");
    let settings = {};
    let saveTimer;

    const connection = new window.StreamDeckPIConnection({
        onOpen: (initialSettings) => applySettings(initialSettings),
        onMessage: (message) => {
            if (message.event === "didReceiveSettings") {
                applySettings(message.payload?.settings ?? {});
            }
        },
        onStatus: setStatus,
    });

    window.connectElgatoStreamDeckSocket = (
        port,
        propertyInspectorUUID,
        registerEvent,
        _info,
        actionInfo,
    ) => connection.connect(port, propertyInspectorUUID, registerEvent, actionInfo);

    customLabel.addEventListener("input", queueSave);
    nameStyle.addEventListener("change", save);
    aggressiveShorten.addEventListener("change", save);
    maxLength.addEventListener("input", () => {
        maxLengthValue.value = maxLength.value;
        queueSave();
    });

    function applySettings(nextSettings) {
        settings = nextSettings;
        customLabel.value = settings.customLabel ?? "";
        nameStyle.value = settings.nameStyle ?? "role";
        maxLength.value = String(settings.maxLength ?? 22);
        maxLengthValue.value = maxLength.value;
        aggressiveShorten.checked = settings.aggressiveShorten ?? true;
    }

    function queueSave() {
        clearTimeout(saveTimer);
        saveTimer = setTimeout(save, 150);
    }

    function save() {
        clearTimeout(saveTimer);
        settings = {
            ...settings,
            customLabel: customLabel.value,
            nameStyle: nameStyle.value,
            maxLength: Number(maxLength.value),
            aggressiveShorten: aggressiveShorten.checked,
        };
        connection.setSettings(settings);
    }

    function setStatus(message, kind) {
        status.textContent = message;
        status.dataset.kind = kind;
    }
})();
