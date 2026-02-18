const SERVICE_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c01";
const DATA_CHAR_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c02";
const CONFIG_CHAR_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c03";

const MAX_CONNECTIONS = 4;
const CSV_ACK_EVERY = 1;
const HISTORY_TICK_MS = 60;
const HISTORY_MAX_ROWS = 200;
const HISTORY_CHART_MAX = 800;
const AUTO_RECONNECT = true;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 15000;
const RECONNECT_MAX_ATTEMPTS = 6;

const SENSOR_TYPE_OPTIONS = [
  { value: "i2c", label: "I2C" },
  { value: "onewire", label: "One Wire" },
  { value: "analog", label: "Analogique" },
  { value: "digital", label: "Numerique" },
  { value: "random", label: "Random" },
];

const SENSOR_PIN_FIELDS = {
  i2c: [
    { key: "sda", label: "Pin SDA" },
    { key: "scl", label: "Pin SCL" },
  ],
  onewire: [
    { key: "onewire", label: "Pin One Wire" },
  ],
  analog: [
    { key: "analog", label: "Pin analogique" },
  ],
  digital: [
    { key: "digital", label: "Pin numerique" },
  ],
  random: [],
};

const COMMON_PIN_FIELDS = [
  { key: "button", label: "Pin bouton" },
  { key: "neopixel", label: "Pin NeoPixel" },
];

const METRIC_PROFILES = {
  temperature: { label: "Temperature", unit: "°C", min: -10, max: 50 },
  pressure: { label: "Pression", unit: "hPa", min: 900, max: 1100 },
  humidity: { label: "Humidite", unit: "%", min: 0, max: 100 },
  gas: { label: "Gaz", unit: "KOhm", min: 0, max: 500 },
  iaq: { label: "IAQ", unit: "", min: 0, max: 500 },
  iaq_accuracy: { label: "Precision IAQ", unit: "", min: 0, max: 3 },
  co2eq: { label: "eCO2", unit: "ppm", min: 350, max: 10000 },
  breath_voc: { label: "VOC", unit: "ppm", min: 0, max: 10 },
  generic: { label: "Valeur", unit: "", min: 0, max: 100 },
};

const KNOWN_METRIC_KEYS = new Set([
  "temperature",
  "pressure",
  "humidity",
  "gas",
  "iaq",
  "iaq_accuracy",
  "co2eq",
  "breath_voc",
  "generic",
]);

const SENSOR_LABELS = {
  i2c: "I2C",
  onewire: "One Wire",
  analog: "Analogique",
  digital: "Numerique",
  random: "Random",
  bme680: "bme680",
  bmp280: "bmp280",
  gy63: "ms5611",
  ds18b20: "ds18b20",
  dht11: "dht11",
  dht22: "dht22",
};

const RESERVED_KEYS = new Set([
  "sensor",
  "type",
  "id",
  "name",
  "addr",
  "i2c",
  "flash",
  "fs",
  "csv_chunk",
  "csvchunk",
  "metrics",
  "values",
  "data",
  "profiles",
  "profile",
  "ranges",
  "range",
  "button",
  "neopixel",
  "neo",
]);

const devices = new Map();
const encoder = new TextEncoder();
const decoder = new TextDecoder();

const connectBtn = document.getElementById("connectBtn");
const disconnectAllBtn = document.getElementById("disconnectAllBtn");
const configList = document.getElementById("configList");
const vizList = document.getElementById("vizList");
const configEmpty = document.getElementById("configEmpty");
const vizEmpty = document.getElementById("vizEmpty");
const bleNotice = document.getElementById("bleNotice");
const configModal = document.getElementById("configModal");
const configModalTitle = document.getElementById("configModalTitle");
const configModalForm = document.getElementById("configModalForm");
const configModalName = document.getElementById("configModalName");
const configModalSensor = document.getElementById("configModalSensor");
const configModalPins = document.getElementById("configModalPins");
const configModalFrequency = document.getElementById("configModalFrequency");
const configModalStoreFlash = document.getElementById("configModalStoreFlash");
const configModalStatus = document.getElementById("configModalStatus");
const configModalDetected = document.getElementById("configModalDetected");
const configModalClose = document.getElementById("configModalClose");
const configModalClearFlash = document.getElementById("configModalClearFlash");
const configModalExportFlash = document.getElementById("configModalExportFlash");

let activeModalEntryId = null;

if (!navigator.bluetooth) {
  bleNotice.innerHTML = "<strong>Attention:</strong> Web Bluetooth n'est pas supporte sur ce navigateur.";
}

connectBtn.addEventListener("click", async () => {
  try {
    await connectDevice();
  } catch (err) {
    console.error(err);
    alert("Connexion BLE impossible. Verifie que tu es en HTTPS et sur Chrome/Edge.");
  }
});

disconnectAllBtn.addEventListener("click", () => {
  for (const entry of devices.values()) {
    entry.autoReconnect = false;
    entry.reconnecting = false;
    if (entry.reconnectTimer) {
      clearTimeout(entry.reconnectTimer);
      entry.reconnectTimer = null;
    }
    if (entry.device?.gatt?.connected) {
      entry.device.gatt.disconnect();
    }
  }
  updateControls();
});

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => switchTab(tab.dataset.tab));
}

if (configModalSensor) {
  configModalSensor.innerHTML = "";
  SENSOR_TYPE_OPTIONS.forEach((option) => {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    configModalSensor.appendChild(opt);
  });
}

if (configModalClose) {
  configModalClose.addEventListener("click", () => closeConfigModal());
}

if (configModal) {
  configModal.addEventListener("click", (event) => {
    if (event.target && event.target.dataset && event.target.dataset.modalClose) {
      closeConfigModal();
    }
  });
}

document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && configModal && configModal.classList.contains("open")) {
    closeConfigModal();
  }
});

if (configModalName) {
  configModalName.addEventListener("input", (event) => {
    const entry = getActiveModalEntry();
    if (!entry) return;
    const draft = ensureConfigDraft(entry);
    draft.name = event.target.value;
    draft.touched = true;
  });
}

if (configModalSensor) {
  configModalSensor.addEventListener("change", (event) => {
    const entry = getActiveModalEntry();
    if (!entry) return;
    const draft = ensureConfigDraft(entry);
    draft.sensorType = event.target.value;
    draft.touched = true;
    renderModalPinFields(draft);
  });
}

if (configModalFrequency) {
  configModalFrequency.addEventListener("input", (event) => {
    const entry = getActiveModalEntry();
    if (!entry) return;
    const draft = ensureConfigDraft(entry);
    draft.frequency = event.target.value;
    draft.touched = true;
  });
}

if (configModalStoreFlash) {
  configModalStoreFlash.addEventListener("change", (event) => {
    const entry = getActiveModalEntry();
    if (!entry) return;
    const draft = ensureConfigDraft(entry);
    draft.storeFlash = event.target.checked;
    draft.touched = true;
  });
}

if (configModalForm) {
  configModalForm.addEventListener("submit", (event) => {
    event.preventDefault();
    const entry = getActiveModalEntry();
    if (!entry) return;
    const draft = ensureConfigDraft(entry);
    sendConfig(entry, draft);
  });
}

if (configModalClearFlash) {
  configModalClearFlash.addEventListener("click", () => {
    const entry = getActiveModalEntry();
    if (!entry) return;
    sendFlashCommand(entry, "flash_clear", "Demande d'effacement envoyee.");
  });
}

if (configModalExportFlash) {
  configModalExportFlash.addEventListener("click", () => {
    const entry = getActiveModalEntry();
    if (!entry) return;
    if (entry.csvData) {
      downloadCsv(entry, entry.csvData);
      setDraftStatus(entry, "ok", "CSV pret a telecharger.");
      return;
    }
    sendFlashCommand(entry, "flash_export", "Export CSV demande.");
  });
}

function switchTab(name) {
  document.querySelectorAll(".tab").forEach((btn) => {
    const active = btn.dataset.tab === name;
    btn.classList.toggle("active", active);
    btn.setAttribute("aria-selected", active ? "true" : "false");
  });
  document.querySelectorAll(".tab-panel").forEach((panel) => {
    panel.classList.toggle("active", panel.id === `tab-${name}`);
  });
}

function normalizeKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (!/^[a-z0-9_.-]+$/.test(raw)) return null;
  return raw;
}

function expandMetricKey(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "g") return "generic";
  if (raw === "t") return "temperature";
  if (raw === "p") return "pressure";
  if (raw === "h") return "humidity";
  if (raw === "ia") return "iaq_accuracy";
  if (raw === "co2") return "co2eq";
  if (raw === "voc") return "breath_voc";
  return raw;
}

function normalizeMetricKey(rawKey, sensorHint = null) {
  const raw = String(rawKey || "").trim().toLowerCase();
  if (!raw) return null;
  if (raw === "g") {
    const sensor = normalizeKey(sensorHint);
    if (sensor === "bme680") return "gas";
    return "generic";
  }
  const key = normalizeKey(expandMetricKey(raw));
  if (!key) return null;
  return KNOWN_METRIC_KEYS.has(key) ? key : null;
}

function normalizeText(value, maxLen = 40) {
  if (value === undefined || value === null) return "";
  const text = String(value).trim();
  if (!text) return "";
  return text.slice(0, maxLen);
}

function toNumber(value) {
  if (value === undefined || value === null || value === "") return null;
  const num = Number(value);
  return Number.isFinite(num) ? num : null;
}

function parseBoolean(value) {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  const raw = String(value).trim().toLowerCase();
  if (!raw) return null;
  if (["1", "true", "yes", "on"].includes(raw)) return true;
  if (["0", "false", "no", "off"].includes(raw)) return false;
  return null;
}

function normalizePin(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim();
  if (!raw) return null;
  const num = Number(raw);
  if (!Number.isInteger(num)) return null;
  if (num < 0) return null;
  return num;
}

function baseProfileForKey(key) {
  const base = METRIC_PROFILES[key] || METRIC_PROFILES.generic || { label: key, unit: "", min: 0, max: 100 };
  return {
    label: base.label || key,
    unit: base.unit || "",
    min: Number.isFinite(base.min) ? base.min : 0,
    max: Number.isFinite(base.max) ? base.max : 100,
  };
}

function sanitizeProfile(update, base, key = "") {
  const profile = { ...base };
  const warnings = [];

  const label = normalizeText(update.label, 50);
  if (label) profile.label = label;
  const unit = normalizeText(update.unit, 12);
  if (unit || update.unit === "") profile.unit = unit;

  const min = toNumber(update.min);
  const max = toNumber(update.max);
  if (min !== null) profile.min = min;
  if (max !== null) profile.max = max;

  if (Number.isFinite(profile.min) && Number.isFinite(profile.max) && profile.min >= profile.max) {
    warnings.push(`Range invalide pour ${key || "metrique"} (min >= max).`);
    profile.min = base.min;
    profile.max = base.max;
  }

  return { profile, warnings };
}

function ensureMetricProfile(entry, key) {
  if (!entry.metricProfiles) entry.metricProfiles = {};
  if (!entry.metricProfiles[key]) entry.metricProfiles[key] = baseProfileForKey(key);
  return entry.metricProfiles[key];
}

function applyProfileUpdate(entry, key, update) {
  const base = ensureMetricProfile(entry, key);
  const { profile } = sanitizeProfile(update, base, key);
  entry.metricProfiles[key] = profile;
  if (entry.metrics && entry.metrics[key]) {
    entry.metrics[key].profile = profile;
  }
  return profile;
}

function safeDomId(value) {
  return String(value || "device").replace(/[^a-z0-9_-]/gi, "");
}

function detectSensorType(value) {
  const raw = String(value || "").trim().toLowerCase();
  if (!raw) return "i2c";
  if (raw.includes("i2c")) return "i2c";
  if (raw.includes("onewire") || raw.includes("one-wire") || raw.includes("1wire")) return "onewire";
  if (raw.includes("analog") || raw.includes("adc")) return "analog";
  if (raw.includes("digital") || raw.includes("gpio")) return "digital";
  if (raw.includes("random")) return "random";
  return "i2c";
}

function ensureConfigDraft(entry) {
  if (!entry.configDraft) {
    entry.configDraft = {
      name: entry.name || "",
      sensorType: detectSensorType(entry.sensor),
      pins: {
        sda: "",
        scl: "",
        onewire: "",
        analog: "",
        digital: "",
        button: "",
        neopixel: "",
      },
      frequency: "",
      storeFlash: false,
      status: null,
      touched: false,
    };
  }

  const draft = entry.configDraft;
  if (!draft.name && entry.name) draft.name = entry.name;
  if (!draft.sensorType) draft.sensorType = detectSensorType(entry.sensor);
  if (!draft.pins) {
    draft.pins = {
      sda: "",
      scl: "",
      onewire: "",
      analog: "",
      digital: "",
      button: "",
      neopixel: "",
    };
  }

  return draft;
}

function sensorLabel(sensor) {
  const key = normalizeKey(sensor) || String(sensor || "").toLowerCase();
  return SENSOR_LABELS[key] || String(sensor || "Inconnu").toUpperCase();
}

function upsertRecognizedSensor(entry, sensor, addr = null) {
  const normalized = normalizeKey(sensor);
  if (!normalized) return;
  if (normalized === "i2c") return;
  if (!entry.recognizedSensors) entry.recognizedSensors = [];
  const normalizedAddr = addr ? String(addr).toLowerCase() : "";
  const exists = entry.recognizedSensors.some((item) =>
    item && item.sensor === normalized && (item.addr || "") === normalizedAddr
  );
  if (!exists) {
    entry.recognizedSensors.push({ sensor: normalized, addr: normalizedAddr || null });
  }
}

function getRecognizedSensors(entry) {
  const list = Array.isArray(entry.recognizedSensors) ? entry.recognizedSensors : [];
  if (list.length === 0) return [];
  return list.map((item) => {
    const label = sensorLabel(item.sensor);
    return item.addr ? `${label} (${item.addr})` : label;
  });
}

function getPrimarySensorLabel(entry) {
  const recognized = getRecognizedSensors(entry);
  if (recognized.length > 0) return recognized[0];
  return sensorLabel(entry.sensor || "Inconnu");
}

function getActiveModalEntry() {
  if (!activeModalEntryId) return null;
  return devices.get(activeModalEntryId) || null;
}

function extractConfigFromObject(source) {
  if (!source || typeof source !== "object") return null;
  const config = {};

  if (source.name !== undefined) {
    const name = normalizeText(source.name, 32);
    if (name) config.name = name;
  }

  if (source.sensor !== undefined || source.type !== undefined) {
    const rawSensor = source.sensor !== undefined ? source.sensor : source.type;
    const sensor = normalizeKey(rawSensor);
    if (sensor) config.sensorType = sensor;
  }

  const frequency =
    toNumber(source.frequency)
    ?? toNumber(source.freq)
    ?? toNumber(source.interval)
    ?? toNumber(source.period);
  if (frequency !== null) config.frequency = frequency;

  const storeFlash =
    parseBoolean(source.store_flash)
    ?? parseBoolean(source.storeFlash)
    ?? parseBoolean(source.save)
    ?? parseBoolean(source.flash);
  if (storeFlash !== null) config.storeFlash = storeFlash;

  const pins = {};
  if (source.i2c && typeof source.i2c === "object") {
    if (source.i2c.sda !== undefined) pins.sda = source.i2c.sda;
    if (source.i2c.scl !== undefined) pins.scl = source.i2c.scl;
  }
  if (source.onewire !== undefined) {
    if (typeof source.onewire === "object") {
      if (source.onewire.pin !== undefined) pins.onewire = source.onewire.pin;
    } else {
      pins.onewire = source.onewire;
    }
  }
  if (source.analog !== undefined) {
    if (typeof source.analog === "object") {
      if (source.analog.pin !== undefined) pins.analog = source.analog.pin;
    } else {
      pins.analog = source.analog;
    }
  }
  if (source.digital !== undefined) {
    if (typeof source.digital === "object") {
      if (source.digital.pin !== undefined) pins.digital = source.digital.pin;
    } else {
      pins.digital = source.digital;
    }
  }
  if (source.button !== undefined) {
    if (typeof source.button === "object") {
      if (source.button.pin !== undefined) pins.button = source.button.pin;
    } else {
      pins.button = source.button;
    }
  }
  if (source.button_pin !== undefined) {
    pins.button = source.button_pin;
  }
  if (source.neopixel !== undefined) {
    if (typeof source.neopixel === "object") {
      if (source.neopixel.pin !== undefined) pins.neopixel = source.neopixel.pin;
    } else {
      pins.neopixel = source.neopixel;
    }
  }
  if (source.neopixel_pin !== undefined) {
    pins.neopixel = source.neopixel_pin;
  }
  if (source.neo !== undefined) {
    if (typeof source.neo === "object") {
      if (source.neo.pin !== undefined) pins.neopixel = source.neo.pin;
    } else {
      pins.neopixel = source.neo;
    }
  }
  if (source.pins && typeof source.pins === "object") {
    if (source.pins.sda !== undefined) pins.sda = source.pins.sda;
    if (source.pins.scl !== undefined) pins.scl = source.pins.scl;
    if (source.pins.onewire !== undefined) pins.onewire = source.pins.onewire;
    if (source.pins.analog !== undefined) pins.analog = source.pins.analog;
    if (source.pins.digital !== undefined) pins.digital = source.pins.digital;
    if (source.pins.button !== undefined) pins.button = source.pins.button;
    if (source.pins.neopixel !== undefined) pins.neopixel = source.pins.neopixel;
  }

  if (Object.keys(pins).length > 0) config.pins = pins;

  return Object.keys(config).length > 0 ? config : null;
}

function extractFlashFromObject(source) {
  if (!source || typeof source !== "object") return null;
  const flash = {};

  const total = toNumber(source.total ?? source.size ?? source.capacity);
  if (total !== null) flash.total = total;

  const used = toNumber(source.used ?? source.use);
  if (used !== null) flash.used = used;

  const free = toNumber(source.free ?? source.free_bytes ?? source.freeBytes);
  if (free !== null) flash.free = free;

  const percentUsed = toNumber(
    source.percent_used
    ?? source.percentUsed
    ?? source.percent
    ?? source.used_percent
    ?? source.usage
  );
  if (percentUsed !== null) flash.percentUsed = percentUsed;

  const logBytes = toNumber(source.log_bytes ?? source.logBytes ?? source.log);
  if (logBytes !== null) flash.logBytes = logBytes;

  const estSamples = toNumber(
    source.est_samples
    ?? source.estSamples
    ?? source.estimated_samples
    ?? source.samples
  );
  if (estSamples !== null) flash.estSamples = estSamples;

  const estSeconds = toNumber(
    source.est_seconds
    ?? source.estSeconds
    ?? source.estimated_seconds
    ?? source.seconds
  );
  if (estSeconds !== null) flash.estSeconds = estSeconds;

  return Object.keys(flash).length > 0 ? flash : null;
}

function normalizeFlashField(field) {
  if (!field) return null;
  switch (field) {
    case "total":
    case "used":
    case "free":
      return field;
    case "percent":
    case "percent_used":
    case "percentused":
    case "used_percent":
    case "usage":
      return "percentUsed";
    case "log_bytes":
    case "logbytes":
    case "log":
      return "logBytes";
    case "est_samples":
    case "estsamples":
    case "samples":
      return "estSamples";
    case "est_seconds":
    case "estseconds":
    case "seconds":
      return "estSeconds";
    default:
      return null;
  }
}

function extractFlashFieldFromKey(key) {
  if (!key) return null;
  if (key.startsWith("flash.")) return normalizeFlashField(key.slice(6));
  if (key.startsWith("flash_")) return normalizeFlashField(key.slice(6));
  if (key.startsWith("fs.")) return normalizeFlashField(key.slice(3));
  if (key.startsWith("fs_")) return normalizeFlashField(key.slice(3));
  return null;
}

function applyConfigUpdate(entry, config, options = {}) {
  if (!config) return;
  const draft = ensureConfigDraft(entry);
  const shouldApply = options.force || !draft.touched;
  const prevSensor = entry.sensor;
  const prevOrder = Array.isArray(entry.metricOrder) ? entry.metricOrder.join(",") : "";

  if (config.name) {
    entry.name = config.name;
    if (shouldApply) draft.name = config.name;
  }

  if (config.sensorType) {
    entry.sensor = config.sensorType;
    if (shouldApply) draft.sensorType = config.sensorType;
  }

  if (config.sensorType && prevSensor && prevSensor !== config.sensorType) {
    entry.metrics = {};
    entry.metricOrder = [];
    entry.metricProfiles = {};
    entry.historyRows = [];
    entry.historyQueue = [];
    entry.historyLoading = false;
    entry.recognizedSensors = [];
  }

  if (entry.sensor && entry.sensor === "random") {
    entry.metrics = {};
    entry.metricOrder = [];
    entry.metricProfiles = {};
    ensureMetric(entry, "generic");
  } else if (prevOrder && entry.metricOrder && entry.metricOrder.join(",") !== prevOrder) {
    entry.metrics = {};
    entry.metricOrder = [];
    entry.metricProfiles = {};
  }

  if (config.frequency !== undefined && config.frequency !== null) {
    if (shouldApply) draft.frequency = String(config.frequency);
  }

  if (config.storeFlash !== undefined) {
    if (shouldApply) draft.storeFlash = !!config.storeFlash;
  }

  if (config.pins && shouldApply) {
    draft.pins = {
      sda: draft.pins?.sda ?? "",
      scl: draft.pins?.scl ?? "",
      onewire: draft.pins?.onewire ?? "",
      analog: draft.pins?.analog ?? "",
      digital: draft.pins?.digital ?? "",
      button: draft.pins?.button ?? "",
      neopixel: draft.pins?.neopixel ?? "",
      ...config.pins,
    };
  }

  if (configModal && configModal.classList.contains("open") && activeModalEntryId === entry.id) {
    if (configModalName) configModalName.value = draft.name || "";
    if (configModalSensor) configModalSensor.value = draft.sensorType || "i2c";
    renderModalPinFields(draft);
    if (configModalFrequency) configModalFrequency.value = draft.frequency || "";
    if (configModalStoreFlash) configModalStoreFlash.checked = !!draft.storeFlash;
  }

  renderAll();
}

function renderModalPinFields(draft) {
  if (!configModalPins) return;
  configModalPins.innerHTML = "";
  const sensorType = draft.sensorType || "i2c";
  const fields = [
    ...(SENSOR_PIN_FIELDS[sensorType] || []),
    ...COMMON_PIN_FIELDS,
  ];
  const pins = draft.pins || {};

  fields.forEach((field) => {
    const wrapper = document.createElement("div");
    wrapper.className = "field";

    const label = document.createElement("label");
    label.setAttribute("for", `config-modal-pin-${field.key}`);
    label.textContent = field.label;

    const input = document.createElement("input");
    input.type = "number";
    input.min = "0";
    input.inputMode = "numeric";
    input.id = `config-modal-pin-${field.key}`;
    input.placeholder = "GPIO12";
    input.value = pins[field.key] ?? "";
    input.addEventListener("input", (event) => {
      pins[field.key] = event.target.value;
      draft.touched = true;
    });

    wrapper.appendChild(label);
    wrapper.appendChild(input);
    configModalPins.appendChild(wrapper);
  });
}

function openConfigModal(entry) {
  if (!configModal) return;
  activeModalEntryId = entry.id;
  const draft = ensureConfigDraft(entry);

  if (configModalTitle) {
    configModalTitle.textContent = `Configurer ${entry.name || "ESP32"}`;
  }
  if (configModalName) configModalName.value = draft.name || "";
  if (configModalSensor) configModalSensor.value = draft.sensorType || "i2c";
  if (configModalFrequency) configModalFrequency.value = draft.frequency || "";
  if (configModalStoreFlash) configModalStoreFlash.checked = !!draft.storeFlash;

  renderModalPinFields(draft);
  renderModalDetectedSensors(entry);
  updateModalStatusForEntry(entry);
  updateExportButton(entry);

  configModal.classList.add("open");
  configModal.setAttribute("aria-hidden", "false");
  document.body.classList.add("modal-open");
  if (configModalName) configModalName.focus();
  requestConfig(entry);
}

function closeConfigModal() {
  if (!configModal) return;
  configModal.classList.remove("open");
  configModal.setAttribute("aria-hidden", "true");
  document.body.classList.remove("modal-open");
  activeModalEntryId = null;
}

function updateModalStatusForEntry(entry) {
  if (!configModal || !configModalStatus) return;
  if (!configModal.classList.contains("open")) return;
  if (activeModalEntryId !== entry.id) return;
  const draft = ensureConfigDraft(entry);
  configModalStatus.textContent = draft.status ? draft.status.message : "";
  configModalStatus.className = `config-status ${draft.status ? draft.status.type : ""}`;
  renderModalDetectedSensors(entry);
  updateExportButton(entry);
}

function renderModalDetectedSensors(entry) {
  if (!configModalDetected) return;
  const recognized = getRecognizedSensors(entry);
  if (recognized.length === 0) {
    configModalDetected.textContent = "Capteurs reconnus: aucun (en attente de mesures).";
    return;
  }
  configModalDetected.textContent = `Capteurs reconnus: ${recognized.join(", ")}`;
}

async function requestConfig(entry) {
  if (!entry.connected || !entry.configChar) {
    setDraftStatus(entry, "error", "ESP32 non connecte.");
    return;
  }

  setDraftStatus(entry, "info", "Lecture de la configuration...");
  return enqueueBle(entry, async () => {
    let configApplied = false;
    let updated = false;

    if (typeof entry.configChar.readValue === "function") {
      try {
        const value = await entry.configChar.readValue();
        const raw = decodeValue(value);
        const parsed = parsePayload(raw);
        if (parsed.config) {
          applyConfigUpdate(entry, parsed.config, { force: true });
          setDraftStatus(entry, "ok", "Configuration lue.");
          configApplied = true;
          updated = true;
        }
        if (parsed.flash) {
          entry.flash = parsed.flash;
          updated = true;
        }
        if (updated) {
          renderAll();
        }
      } catch (err) {
        console.warn("Config read failed", err);
      }
    }

    try {
      await sendBlePayload(entry, { action: "config_get" });
      if (!configApplied) {
        setDraftStatus(entry, "ok", "Demande de config envoyee.");
      }
    } catch (err) {
      console.error("Config request failed", err);
      if (!configApplied) {
        setDraftStatus(entry, "error", "Erreur lors de la demande de config.");
      }
    }
  });
}

function setDraftStatus(entry, type, message) {
  const draft = ensureConfigDraft(entry);
  draft.status = { type, message, ts: Date.now() };
  updateConfigStatus(entry);
  updateModalStatusForEntry(entry);
}

function updateExportButton(entry) {
  if (!configModalExportFlash) return;
  if (!configModal || !configModal.classList.contains("open")) return;
  if (!entry || activeModalEntryId !== entry.id) return;
  const transfer = entry.csvTransfer;
  let label = "Exporter la flash (CSV)";
  if (entry.csvData) {
    label = "Telecharger la flash (CSV)";
  } else if (entry.csvInProgress) {
    if (transfer && Number.isFinite(transfer.total) && transfer.total > 0) {
      const pct = Math.min(100, Math.round((transfer.received / transfer.total) * 100));
      label = `Export en cours... ${pct}%`;
    } else {
      label = "Export en cours...";
    }
  }
  configModalExportFlash.textContent = label;
  configModalExportFlash.disabled = !!entry.csvInProgress && !entry.csvData;
}

function updateConfigStatus(entry) {
  const domId = safeDomId(entry.id);
  const statusEl = document.getElementById(`status-${domId}`);
  if (!statusEl) return;
  const draft = ensureConfigDraft(entry);
  statusEl.textContent = draft.status ? draft.status.message : "";
  statusEl.className = `config-status ${draft.status ? draft.status.type : ""}`;
}

function buildConfigPayload(entry, draft) {
  const payload = {};
  const warnings = [];

  const name = normalizeText(draft.name, 32);
  if (name) payload.name = name;

  const sensorType = normalizeKey(draft.sensorType);
  if (sensorType) payload.sensor = sensorType;

  const pins = draft.pins || {};
  if (sensorType === "i2c") {
    const hasPins = String(pins.sda || "").trim() || String(pins.scl || "").trim();
    if (hasPins) {
      const sda = normalizePin(pins.sda);
      const scl = normalizePin(pins.scl);
      if (sda !== null || scl !== null) {
        payload.i2c = {};
        if (sda !== null) payload.i2c.sda = sda;
        if (scl !== null) payload.i2c.scl = scl;
      } else {
        warnings.push("Pins I2C manquants.");
      }
    }
  } else if (sensorType === "onewire") {
    const hasPin = String(pins.onewire || "").trim();
    if (hasPin) {
      const pin = normalizePin(pins.onewire);
      if (pin !== null) {
        payload.onewire = { pin };
      } else {
        warnings.push("Pin One Wire manquant.");
      }
    }
  } else if (sensorType === "analog") {
    const hasPin = String(pins.analog || "").trim();
    if (hasPin) {
      const pin = normalizePin(pins.analog);
      if (pin !== null) {
        payload.analog = { pin };
      } else {
        warnings.push("Pin analogique manquant.");
      }
    }
  } else if (sensorType === "digital") {
    const hasPin = String(pins.digital || "").trim();
    if (hasPin) {
      const pin = normalizePin(pins.digital);
      if (pin !== null) {
        payload.digital = { pin };
      } else {
        warnings.push("Pin numerique manquant.");
      }
    }
  } else if (sensorType === "random") {
    // No pins required
  }

  const hasButtonPin = String(pins.button || "").trim();
  if (hasButtonPin) {
    const pin = normalizePin(pins.button);
    if (pin !== null) {
      payload.button = { pin };
    } else {
      warnings.push("Pin bouton manquant.");
    }
  }

  const hasNeoPin = String(pins.neopixel || "").trim();
  if (hasNeoPin) {
    const pin = normalizePin(pins.neopixel);
    if (pin !== null) {
      payload.neopixel = { pin };
    } else {
      warnings.push("Pin NeoPixel manquant.");
    }
  }

  const frequency = toNumber(draft.frequency);
  if (frequency !== null) {
    if (frequency > 0) {
      payload.frequency = frequency;
    } else {
      warnings.push("Frequence invalide.");
    }
  }

  payload.store_flash = !!draft.storeFlash;

  if (Object.keys(payload).length === 0) {
    return { payload: null, warnings };
  }

  return { payload, warnings };
}

async function sendConfig(entry, draft) {
  if (!entry.connected || !entry.configChar) {
    setDraftStatus(entry, "error", "ESP32 non connecte.");
    return;
  }

  const { payload, warnings } = buildConfigPayload(entry, draft);
  if (!payload) {
    setDraftStatus(entry, "error", "Aucune configuration valide a envoyer.");
    return;
  }

  try {
    await enqueueBle(entry, async () => {
      await sendBlePayload(entry, payload);
    });

    if (payload.name) {
      entry.name = payload.name;
      draft.name = payload.name;
      draft.touched = false;
    }
    if (payload.sensor) {
      entry.sensor = payload.sensor;
      draft.sensorType = payload.sensor;
    }

    const warningSuffix = warnings.length ? ` (${warnings.length} avertissement(s))` : "";
    const message = `Config envoyee${warningSuffix}.`;
    setDraftStatus(entry, "ok", message);
    if (warnings.length) console.warn("Config warnings", warnings);
    renderAll();
  } catch (err) {
    console.error("Config write failed", err);
    setDraftStatus(entry, "error", "Erreur lors de l'envoi BLE.");
  }
}

async function sendFlashCommand(entry, action, successMessage) {
  if (!entry.connected || !entry.configChar) {
    setDraftStatus(entry, "error", "ESP32 non connecte.");
    return;
  }

  if (action === "flash_export") {
    if (entry.csvInProgress) {
      setDraftStatus(entry, "info", "Export deja en cours.");
      return;
    }
    resetCsvTransfer(entry);
    entry.csvData = null;
    entry.csvInProgress = true;
    entry.csvMode = "download";
    ensureCsvTransfer(entry);
    scheduleCsvTimeout(entry);
    updateExportButton(entry);
  }

  const payload = { action };
  if (action === "flash_export") {
    payload.format = "csv";
  }

  try {
    await enqueueBle(entry, async () => {
      await sendBlePayload(entry, payload);
    });
    setDraftStatus(entry, "ok", successMessage);
  } catch (err) {
    console.error("Flash command failed", err);
    if (action === "flash_export") {
      entry.csvInProgress = false;
      entry.csvMode = null;
      resetCsvTransfer(entry);
      updateExportButton(entry);
    }
    setDraftStatus(entry, "error", "Erreur lors de la commande flash.");
  }
}


async function requestFlashStatus(entry, options = {}) {
  const { silent = true } = options;
  if (!entry.connected || !entry.configChar) {
    if (!silent) setDraftStatus(entry, "error", "ESP32 non connecte.");
    return;
  }

  try {
    await enqueueBle(entry, async () => {
      await sendBlePayload(entry, { action: "flash_status" });
    });
    if (!silent) {
      setDraftStatus(entry, "ok", "Demande d'etat envoyee.");
    }
  } catch (err) {
    console.error("Flash status request failed", err);
    if (!silent) {
      setDraftStatus(entry, "error", "Erreur lors de la demande flash.");
    }
  }
}

async function sendTimeSync(entry, options = {}) {
  const { silent = true } = options;
  if (!entry.connected || !entry.configChar) {
    if (!silent) setDraftStatus(entry, "error", "ESP32 non connecte.");
    return false;
  }

  try {
    await enqueueBle(entry, async () => {
      await sendBlePayload(entry, {
        action: "time_sync",
        epoch_ms: Date.now(),
        tz_offset_min: new Date().getTimezoneOffset(),
      });
    });
    if (!silent) {
      setDraftStatus(entry, "ok", "Heure synchronisee.");
    }
    return true;
  } catch (err) {
    console.error("Time sync failed", err);
    if (!silent) {
      setDraftStatus(entry, "error", "Erreur lors de la synchro heure.");
    }
    return false;
  }
}

async function toggleRecording(entry) {
  const draft = ensureConfigDraft(entry);
  const previousValue = !!draft.storeFlash;
  const nextValue = !previousValue;

  draft.storeFlash = nextValue;
  if (configModal && configModal.classList.contains("open") && activeModalEntryId === entry.id) {
    if (configModalStoreFlash) configModalStoreFlash.checked = !!draft.storeFlash;
  }
  renderAll();

  if (!entry.connected || !entry.configChar) {
    draft.storeFlash = previousValue;
    renderAll();
    setDraftStatus(entry, "error", "ESP32 non connecte.");
    return;
  }

  const message = nextValue
    ? "Activation de l'enregistrement..."
    : "Arret de l'enregistrement...";
  setDraftStatus(entry, "info", message);

  try {
    await enqueueBle(entry, async () => {
      if (nextValue) {
        await sendBlePayload(entry, {
          action: "time_sync",
          epoch_ms: Date.now(),
          tz_offset_min: new Date().getTimezoneOffset(),
        });
      }
      await sendBlePayload(entry, { store_flash: nextValue });
    });
    setTimeout(() => requestFlashStatus(entry, { silent: true }), 400);
  } catch (err) {
    console.error("Store flash update failed", err);
    draft.storeFlash = previousValue;
    renderAll();
    setDraftStatus(entry, "error", "Erreur lors de la mise a jour.");
  }
}

function resetHistory(entry) {
  entry.historyRows = [];
  entry.historyAll = [];
  entry.historyQueue = [];
  entry.historyLoading = true;
  entry.historyStreamDone = false;
  entry.historyLoaded = false;
  entry.historyStopSent = false;
  entry.historyExpectedSeq = 0;
  entry.historyTimer = entry.historyTimer || null;
  entry.historyCollapsed = true;
}

function ensureHistoryProcessor(entry) {
  if (entry.historyTimer) return;
  entry.historyTimer = setInterval(() => {
    processHistoryQueue(entry);
  }, HISTORY_TICK_MS);
}

function stopHistoryProcessor(entry) {
  if (!entry.historyTimer) return;
  clearInterval(entry.historyTimer);
  entry.historyTimer = null;
}

function processHistoryQueue(entry) {
  if (!entry.historyQueue || entry.historyQueue.length === 0) {
    if (entry.historyStreamDone) {
      entry.historyLoading = false;
      entry.historyLoaded = true;
      entry.csvInProgress = false;
      entry.csvMode = null;
      stopHistoryProcessor(entry);
      if (!entry.historyStopSent && entry.connected) {
        entry.historyStopSent = true;
        enqueueBle(entry, async () => {
          await sendBlePayload(entry, { action: "flash_stream_stop" });
        });
      }
      renderAll();
    }
    return;
  }

  const metric = ensureMetric(entry, "generic");
  let processed = 0;
  while (entry.historyQueue.length > 0 && processed < 20) {
    const line = entry.historyQueue.shift();
    processed += 1;
    const parsed = parseCsvLine(line);
    if (!parsed) continue;

    const { timestamp, value } = parsed;
    pushHistoryEntry(entry, metric, timestamp, value);
  }

  if (entry.historyQueue.length > 2000) {
    entry.historyQueue = entry.historyQueue.slice(-2000);
  }

  renderAll();
}

function formatTimestampForTable(date = new Date()) {
  const pad = (num) => String(num).padStart(2, "0");
  const day = pad(date.getDate());
  const month = pad(date.getMonth() + 1);
  const year = pad(date.getFullYear() % 100);
  const hours = pad(date.getHours());
  const minutes = pad(date.getMinutes());
  const seconds = pad(date.getSeconds());
  return `${day}/${month}/${year} ${hours}:${minutes}:${seconds}`;
}

function parseCsvLine(line) {
  if (!line) return null;
  const trimmed = String(line).trim();
  if (!trimmed || trimmed.startsWith("date_time,")) return null;
  const parts = trimmed.split(",");
  if (parts.length < 2) return null;
  const timestamp = parts[0].trim();
  const value = Number(parts[1]);
  if (!Number.isFinite(value)) return null;
  return { timestamp, value };
}

function pushHistoryEntry(entry, metric, timestamp, value) {
  metric.latest = value;
  metric.values.push({ ts: Date.now(), value });
  if (metric.values.length > HISTORY_CHART_MAX) metric.values.shift();

  if (!entry.historyRows) entry.historyRows = [];
  entry.historyRows.push({ timestamp, value });
  if (entry.historyRows.length > HISTORY_MAX_ROWS) entry.historyRows.shift();

  if (!entry.historyAll) entry.historyAll = [];
  entry.historyAll.push({ timestamp, value });
}

async function startHistoryStream(entry) {
  if (!entry.connected || !entry.configChar) {
    setDraftStatus(entry, "error", "ESP32 non connecte.");
    return;
  }
  if (entry.csvInProgress) {
    setDraftStatus(entry, "info", "Export deja en cours.");
    return;
  }
  entry.csvInProgress = true;
  entry.csvMode = "history";
  resetCsvTransfer(entry);
  resetHistory(entry);
  entry.metrics = {};
  entry.metricOrder = [];
  entry.metricProfiles = {};
  ensureMetric(entry, "generic");
  entry.metricOrder = ["generic"];
  setDraftStatus(entry, "info", "Chargement historique...");
  updateExportButton(entry);
  ensureHistoryProcessor(entry);

  try {
    await enqueueBle(entry, async () => {
      await sendBlePayload(entry, { action: "flash_stream" });
    });
  } catch (err) {
    console.error("History stream failed", err);
    entry.csvInProgress = false;
    entry.csvMode = null;
    entry.historyLoading = false;
    stopHistoryProcessor(entry);
    setDraftStatus(entry, "error", "Erreur lors du chargement.");
  }
}
function getConnectedCount() {
  let count = 0;
  for (const entry of devices.values()) {
    if (entry.connected) count += 1;
  }
  return count;
}

function updateControls() {
  const count = getConnectedCount();
  connectBtn.disabled = count >= MAX_CONNECTIONS;
  connectBtn.textContent = count >= MAX_CONNECTIONS
    ? `Max ${MAX_CONNECTIONS} connectes`
    : `Connecter un ESP32 (${count}/${MAX_CONNECTIONS})`;
  disconnectAllBtn.disabled = count === 0;
}

function scheduleReconnect(entry) {
  if (!AUTO_RECONNECT || entry.autoReconnect === false) return;
  if (!entry.device) return;
  if (entry.reconnectTimer) return;

  const attempts = entry.reconnectAttempts || 0;
  if (attempts >= RECONNECT_MAX_ATTEMPTS) {
    entry.reconnecting = false;
    renderAll();
    return;
  }

  const delay = Math.min(RECONNECT_BASE_DELAY * (2 ** attempts), RECONNECT_MAX_DELAY);
  entry.reconnecting = true;
  entry.reconnectTimer = setTimeout(() => attemptReconnect(entry), delay);
  renderAll();
}

async function attemptReconnect(entry) {
  entry.reconnectTimer = null;
  if (getConnectedCount() >= MAX_CONNECTIONS) {
    scheduleReconnect(entry);
    return;
  }
  try {
    await connectWithDevice(entry.device, entry);
  } catch (err) {
    console.warn("Reconnect failed", err);
    entry.connected = false;
    entry.reconnectAttempts = (entry.reconnectAttempts || 0) + 1;
    scheduleReconnect(entry);
  }
}

function ensureDisconnectListener(entry, device) {
  if (entry.disconnectListener) return;
  entry.disconnectListener = () => handleDisconnect(device.id);
  device.addEventListener("gattserverdisconnected", entry.disconnectListener);
}

async function connectWithDevice(device, entry) {
  const server = await device.gatt.connect();
  const service = await server.getPrimaryService(SERVICE_UUID);
  const dataChar = await service.getCharacteristic(DATA_CHAR_UUID);
  const configChar = await service.getCharacteristic(CONFIG_CHAR_UUID);

  await dataChar.startNotifications();
  dataChar.addEventListener("characteristicvaluechanged", (event) => {
    handleNotification(device.id, event.target.value);
  });

  const record = entry || {
    id: device.id,
    metrics: {},
    metricOrder: [],
  };

  record.name = device.name || record.name || "ESP32";
  record.device = device;
  record.dataChar = dataChar;
  record.configChar = configChar;
  record.connected = true;
  record.reconnecting = false;
  record.autoReconnect = true;
  record.reconnectAttempts = 0;
  if (!record.metricProfiles) record.metricProfiles = {};
  if (record.historyCollapsed === undefined) record.historyCollapsed = true;
  if (record.reconnectTimer) {
    clearTimeout(record.reconnectTimer);
    record.reconnectTimer = null;
  }
  devices.set(device.id, record);
  ensureDisconnectListener(record, device);
  renderAll();
  await requestConfig(record);
  await sendTimeSync(record, { silent: true });
  return record;
}

async function connectDevice() {
  if (getConnectedCount() >= MAX_CONNECTIONS) {
    alert(`Maximum ${MAX_CONNECTIONS} ESP32 connectes.`);
    return;
  }

  const device = await navigator.bluetooth.requestDevice({
    acceptAllDevices: true,
    optionalServices: [SERVICE_UUID],
  });

  let entry = devices.get(device.id) || null;
  if (entry && entry.connected) {
    alert("Cet ESP32 est deja connecte.");
    return;
  }
  if (entry && entry.reconnectTimer) {
    clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
  }

  entry = await connectWithDevice(device, entry);
}

function handleDisconnect(deviceId) {
  const entry = devices.get(deviceId);
  if (!entry) return;
  entry.connected = false;
  entry.bleQueue = Promise.resolve();
  entry.csvInProgress = false;
  entry.csvMode = null;
  entry.historyLoading = false;
  entry.historyStreamDone = true;
  entry.historyStopSent = false;
  stopHistoryProcessor(entry);
  resetCsvTransfer(entry);
  renderAll();
  scheduleReconnect(entry);
}

function handleNotification(deviceId, valueView) {
  const entry = devices.get(deviceId);
  if (!entry) return;

  const raw = decodeValue(valueView);
  const parts = splitBleMessages(raw);
  if (parts.length === 0) return;

  parts.forEach((part) => {
    const parsed = parsePayload(part);
    applyParsedPayload(entry, parsed);
  });
}

function splitBleMessages(raw) {
  if (!raw) return [];
  let text = String(raw).trim();
  if (text && text[0] !== "{" && text.includes("{")) {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      text = text.slice(start, end + 1);
    }
  }
  if (!text) return [];
  if (text.startsWith("{") && text.includes("}")) {
    const items = [];
    let depth = 0;
    let start = -1;
    for (let i = 0; i < text.length; i += 1) {
      const ch = text[i];
      if (ch === "{") {
        if (depth === 0) start = i;
        depth += 1;
      } else if (ch === "}") {
        depth = Math.max(0, depth - 1);
        if (depth === 0 && start !== -1) {
          items.push(text.slice(start, i + 1));
          start = -1;
        }
      }
    }
    if (items.length > 0) return items;
  }
  return text.split(/\n+/).map((line) => line.trim()).filter((line) => line);
}

function applyParsedPayload(entry, parsed) {
  const structuralUpdate = !!(
    parsed.name
    || parsed.ack
    || parsed.sensor
    || parsed.addr
    || parsed.csv
    || parsed.csvChunk
    || parsed.config
    || parsed.flash
  );

  if (parsed.sensor) {
    entry.sensor = parsed.sensor;
    upsertRecognizedSensor(entry, parsed.sensor, parsed.addr || entry.address || null);
  }
  if (parsed.addr) entry.address = parsed.addr;
  if (parsed.name) {
    entry.name = parsed.name;
    if (entry.configDraft && !entry.configDraft.touched) {
      entry.configDraft.name = parsed.name;
    }
  }
  if (parsed.config) {
    applyConfigUpdate(entry, parsed.config);
  }
  if (parsed.flash) {
    entry.flash = parsed.flash;
  }
  if (parsed.ack === "name") {
    const type = parsed.status === "ok" ? "ok" : "error";
    const message = parsed.message || (type === "ok" ? "Nom mis a jour." : "Erreur de configuration.");
    setDraftStatus(entry, type, message);
  } else if (parsed.ack) {
    const type = parsed.status === "error" ? "error" : "ok";
    const message = parsed.message || `Ack ${parsed.ack}.`;
    if ((parsed.ack === "flash_export" || parsed.ack === "flash_stream") && type === "error") {
      entry.csvInProgress = false;
      entry.csvMode = null;
      entry.historyLoading = false;
      entry.historyStreamDone = true;
      resetCsvTransfer(entry);
      stopHistoryProcessor(entry);
      updateExportButton(entry);
    }
    setDraftStatus(entry, type, message);
  }
  if (parsed.csv) {
    if (entry.csvMode === "history") {
      handleHistoryInline(entry, parsed.csv);
    } else {
      entry.csvData = parsed.csv;
      entry.csvInProgress = false;
      entry.csvMode = null;
      resetCsvTransfer(entry);
      updateExportButton(entry);
      downloadCsv(entry, parsed.csv);
      setDraftStatus(entry, "ok", "CSV recu.");
    }
  }
  if (parsed.csvChunk) {
    handleCsvChunk(entry, parsed.csvChunk);
  }
  const profileEntries = parsed.profiles ? Object.entries(parsed.profiles) : [];
  if (profileEntries.length > 0) {
    entry.metricProfiles = {};
    const allowed = new Set();
    profileEntries.forEach(([key, profile]) => {
      const normalized = normalizeKey(key);
      if (!normalized) return;
      allowed.add(normalized);
      applyProfileUpdate(entry, normalized, profile);
    });
    if (entry.metrics) {
      Object.keys(entry.metrics).forEach((key) => {
        if (!allowed.has(key)) delete entry.metrics[key];
      });
    }
    entry.metricOrder = Array.from(allowed);
  }

  const keys = Object.keys(parsed.metrics);
  const liveTimestamp = parsed.timestamp;
  if (keys.length === 0) {
    if (structuralUpdate || profileEntries.length > 0) {
      renderAll();
    }
    return;
  }

  keys.forEach((key) => {
    const value = parsed.metrics[key];
    if (!Number.isFinite(value)) return;
    const metric = ensureMetric(entry, key);
    metric.latest = value;
    metric.values.push({ ts: Date.now(), value });
    if (metric.values.length > 120) metric.values.shift();
    if (key === "generic") {
      const timestamp = liveTimestamp || formatTimestampForTable();
      pushHistoryEntry(entry, metric, timestamp, value);
    }
  });

  if (entry.sensor === "random") {
    entry.metricOrder = ["generic"];
  }

  // High-frequency live data should not recreate config cards at each packet,
  // otherwise config buttons become hard to click at short refresh rates.
  if (structuralUpdate || profileEntries.length > 0) {
    renderAll();
  } else {
    renderViz(Array.from(devices.values()));
    updateControls();
  }
}

function decodeValue(view) {
  const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const text = decoder.decode(slice);
  return text.replace(/\u0000/g, "").trim();
}

function enqueueBle(entry, task) {
  if (!entry) return Promise.reject(new Error("No device entry"));
  const chain = entry.bleQueue || Promise.resolve();
  const next = chain.then(task, task);
  entry.bleQueue = next.catch((err) => {
    console.warn("BLE queued op failed", err);
  });
  return next;
}

async function sendBlePayload(entry, payload) {
  const encoded = encoder.encode(JSON.stringify(payload));
  await entry.configChar.writeValue(encoded);
}

function ensureCsvTransfer(entry, exportId = null) {
  if (!entry.csvTransfer || (exportId !== null && entry.csvTransfer.id !== exportId)) {
    resetCsvTransfer(entry);
    entry.csvTransfer = {
      id: exportId,
      chunks: [],
      total: null,
      received: 0,
      lastSeq: null,
      startedAt: Date.now(),
      lastReceivedAt: Date.now(),
      timeoutId: null,
    };
  }
  return entry.csvTransfer;
}

function resetCsvTransfer(entry) {
  if (entry.csvTransfer && entry.csvTransfer.timeoutId) {
    clearTimeout(entry.csvTransfer.timeoutId);
  }
  entry.csvTransfer = null;
}

function scheduleCsvTimeout(entry) {
  if (!entry.csvTransfer) return;
  if (entry.csvTransfer.timeoutId) clearTimeout(entry.csvTransfer.timeoutId);
  entry.csvTransfer.timeoutId = setTimeout(() => {
    const transfer = entry.csvTransfer;
    if (!transfer) return;
    if (entry.csvMode === "history") return;
    const lastIndex = transfer.lastSeq;
    if (lastIndex === null) {
      setDraftStatus(entry, "error", "CSV incomplet (timeout).");
    } else {
      const missing = transfer.chunks
        .slice(0, lastIndex + 1)
        .some((val) => typeof val !== "string");
      setDraftStatus(entry, missing ? "error" : "ok", missing ? "CSV incomplet." : "CSV recu.");
    }
    entry.csvInProgress = false;
    resetCsvTransfer(entry);
    updateExportButton(entry);
  }, 30000);
}

function handleCsvChunk(entry, chunk) {
  if (!chunk) return;
  if (chunk.lineMode && entry.csvMode === "history") {
    handleHistoryBlock(entry, chunk);
    return;
  }
  const transfer = ensureCsvTransfer(entry, chunk.id ?? null);
  entry.csvInProgress = true;
  const data = chunk.data ? String(chunk.data) : "";
  const seq = Number.isFinite(chunk.seq) ? chunk.seq : transfer.chunks.length;
  const total = Number.isFinite(chunk.total) ? chunk.total : null;
  const isLast = chunk.last === true;

  if (total !== null) transfer.total = total;
  transfer.lastReceivedAt = Date.now();
  if (!transfer.chunks[seq]) {
    transfer.chunks[seq] = data;
    transfer.received += data.length;
  }
  if (isLast) transfer.lastSeq = seq;

  if (chunk.lineMode) {
    const shouldAck = isLast || (CSV_ACK_EVERY > 0 && ((seq + 1) % CSV_ACK_EVERY === 0));
    if (shouldAck) {
      sendCsvAck(entry, transfer.id, seq);
    }
  }

  let complete = false;
  if (transfer.lastSeq !== null) {
    const lastIndex = transfer.lastSeq;
    complete = transfer.chunks.slice(0, lastIndex + 1).every((val) => typeof val === "string");
  } else if (transfer.total !== null) {
    complete = transfer.received >= transfer.total;
  }

  if (complete) {
    const lastIndex = transfer.lastSeq !== null ? transfer.lastSeq : transfer.chunks.length - 1;
    const assembled = transfer.chunks
      .slice(0, lastIndex + 1)
      .map((val) => val || "")
      .join(chunk.lineMode ? "\n" : "");
    entry.csvInProgress = false;
    entry.csvMode = null;
    resetCsvTransfer(entry);
    if (assembled) {
      let csvData = assembled;
      if (chunk.lineMode && !assembled.startsWith("date_time,")) {
        csvData = `date_time,value1,value2\n${assembled}`;
      }
      entry.csvData = csvData;
      updateExportButton(entry);
      downloadCsv(entry, entry.csvData);
      setDraftStatus(entry, "ok", "CSV recu.");
    } else {
      setDraftStatus(entry, "error", "CSV incomplet.");
    }
  } else {
    setDraftStatus(entry, "info", "Reception CSV...");
    updateExportButton(entry);
    scheduleCsvTimeout(entry);
  }
}

function handleHistoryBlock(entry, chunk) {
  if (!entry.historyQueue) entry.historyQueue = [];
  entry.historyLoading = true;
  ensureHistoryProcessor(entry);
  const data = chunk.data ? String(chunk.data) : "";
  const lines = data.split("\n").map((line) => line.trim()).filter((line) => line);
  lines.forEach((line) => {
    if (line.startsWith("date_time,")) return;
    entry.historyQueue.push(line);
  });
  if (chunk.last === true) {
    entry.historyStreamDone = true;
  }
  if (entry.historyStreamDone && entry.historyQueue.length === 0) {
    entry.historyLoading = false;
    entry.historyLoaded = true;
    entry.csvInProgress = false;
    entry.csvMode = null;
    stopHistoryProcessor(entry);
    if (!entry.historyStopSent && entry.connected) {
      entry.historyStopSent = true;
      enqueueBle(entry, async () => {
        await sendBlePayload(entry, { action: "flash_stream_stop" });
      });
    }
  }
  const shouldAck = chunk.last === true
    || (CSV_ACK_EVERY > 0 && ((chunk.seq + 1) % CSV_ACK_EVERY === 0));
  if (shouldAck) {
    sendCsvAck(entry, chunk.id, chunk.seq);
  }
  renderAll();
}

function handleHistoryInline(entry, csvText) {
  resetHistory(entry);
  ensureHistoryProcessor(entry);
  const lines = String(csvText).split("\n").map((line) => line.trim()).filter((line) => line);
  lines.forEach((line) => {
    if (line.startsWith("date_time,")) return;
    entry.historyQueue.push(line);
  });
  entry.historyStreamDone = true;
  if (entry.historyQueue.length === 0) {
    entry.historyLoading = false;
    entry.historyLoaded = true;
    entry.csvInProgress = false;
    entry.csvMode = null;
    stopHistoryProcessor(entry);
    if (!entry.historyStopSent && entry.connected) {
      entry.historyStopSent = true;
      enqueueBle(entry, async () => {
        await sendBlePayload(entry, { action: "flash_stream_stop" });
      });
    }
  }
}

function sendCsvAck(entry, id, seq) {
  if (!entry || !entry.connected || !entry.configChar) return;
  if (!Number.isFinite(id) || !Number.isFinite(seq)) return;
  enqueueBle(entry, async () => {
    await sendBlePayload(entry, { action: "csv_ack", id, seq });
  });
}

function parsePayload(raw) {
  let sensor = null;
  let addr = null;
  let name = null;
  let ack = null;
  let status = null;
  let message = null;
  let csv = null;
  let csvChunk = null;
  let config = null;
  let flash = null;
  let timestamp = null;
  const metrics = {};
  const profiles = {};

  if (!raw) return { sensor, addr, name, ack, status, message, csv, csvChunk, config, flash, timestamp, metrics, profiles };

  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (obj.sensor) sensor = String(obj.sensor).toLowerCase();
      if (obj.type) sensor = String(obj.type).toLowerCase();
      if (obj.s && !sensor) sensor = String(obj.s).toLowerCase();
      if (obj.name) name = String(obj.name);
      if (obj.addr) addr = String(obj.addr);
      if (obj.i2c) addr = String(obj.i2c);
      if (obj.ack) ack = String(obj.ack).toLowerCase();
      if (obj.status) status = String(obj.status).toLowerCase();
      if (obj.message) message = String(obj.message);
      if (obj.msg && !message) message = String(obj.msg);
      if (obj.csv) csv = String(obj.csv);
      if (obj.flash_csv) csv = String(obj.flash_csv);
      if (obj.flashCsv) csv = String(obj.flashCsv);
      if (obj.ts) timestamp = String(obj.ts);
      if (!timestamp && obj.timestamp) timestamp = String(obj.timestamp);
      if (obj.csv_chunk && typeof obj.csv_chunk === "object") {
        const chunkData = obj.csv_chunk.data !== undefined ? String(obj.csv_chunk.data) : "";
        const chunkSeq = toNumber(obj.csv_chunk.seq);
        const chunkTotal = toNumber(obj.csv_chunk.total);
        const chunkLast = parseBoolean(obj.csv_chunk.last);
        const chunkId = toNumber(obj.csv_chunk.id ?? obj.csv_chunk.export_id ?? obj.csv_chunk.exportId);
        csvChunk = {
          seq: chunkSeq !== null ? chunkSeq : null,
          id: chunkId !== null ? chunkId : null,
          total: chunkTotal !== null ? chunkTotal : null,
          last: chunkLast === true,
          data: chunkData,
        };
      }
      if (obj.csv_block && typeof obj.csv_block === "object") {
        const blockData = obj.csv_block.data !== undefined ? String(obj.csv_block.data) : "";
        const blockSeq = toNumber(obj.csv_block.seq);
        const blockLast = parseBoolean(obj.csv_block.last);
        const blockId = toNumber(obj.csv_block.id ?? obj.csv_block.export_id ?? obj.csv_block.exportId);
        csvChunk = {
          seq: blockSeq !== null ? blockSeq : null,
          id: blockId !== null ? blockId : null,
          total: null,
          last: blockLast === true,
          data: blockData,
          lineMode: true,
        };
      }

      const configSource = obj.config || obj.settings || obj.cfg || null;
      const extractedConfig = extractConfigFromObject(configSource || obj);
      if (extractedConfig) config = extractedConfig;

      const flashSource =
        (configSource && configSource.flash)
        || obj.flash
        || obj.fs
        || obj.filesystem;
      const extractedFlash = extractFlashFromObject(flashSource);
      if (extractedFlash) flash = extractedFlash;

      if (!flash) {
        const flatFlash = extractFlashFromObject({
          total: obj.flash_total ?? obj.fs_total,
          used: obj.flash_used ?? obj.fs_used,
          free: obj.flash_free ?? obj.fs_free,
          percent_used:
            obj.flash_percent_used
            ?? obj.flash_percent
            ?? obj.fs_percent_used
            ?? obj.fs_percent,
          log_bytes: obj.flash_log_bytes ?? obj.log_bytes,
          est_samples: obj.flash_est_samples ?? obj.est_samples,
          est_seconds: obj.flash_est_seconds ?? obj.est_seconds,
        });
        if (flatFlash) flash = flatFlash;
      }

      const metricSource = obj.metrics || obj.m || obj.values || obj.data;
      if (metricSource && typeof metricSource === "object") {
        Object.entries(metricSource).forEach(([rawKey, value]) => {
          const key = normalizeMetricKey(rawKey, sensor);
          const num = toNumber(value);
          if (!key || num === null) return;
          metrics[key] = num;
        });
      } else {
        if (obj.temperature !== undefined) metrics.temperature = Number(obj.temperature);
        if (obj.temp !== undefined) metrics.temperature = Number(obj.temp);
        if (obj.pressure !== undefined) metrics.pressure = Number(obj.pressure);
        if (obj.press !== undefined) metrics.pressure = Number(obj.press);
        if (obj.humidity !== undefined) metrics.humidity = Number(obj.humidity);
        if (obj.value !== undefined) metrics.generic = Number(obj.value);

      }

      const profileSource = obj.profiles || obj.profile || obj.metricProfiles || obj.metric_profiles;
      if (profileSource && typeof profileSource === "object") {
        Object.entries(profileSource).forEach(([rawKey, value]) => {
          const key = normalizeKey(rawKey);
          if (!key || !value || typeof value !== "object") return;
          profiles[key] = profiles[key] || {};
          if (value.label !== undefined) profiles[key].label = value.label;
          if (value.unit !== undefined) profiles[key].unit = value.unit;
          if (value.min !== undefined) profiles[key].min = value.min;
          if (value.max !== undefined) profiles[key].max = value.max;
        });
      }

      const ranges = obj.ranges || obj.range;
      if (ranges && typeof ranges === "object") {
        Object.entries(ranges).forEach(([rawKey, value]) => {
          const key = normalizeKey(rawKey);
          if (!key) return;
          profiles[key] = profiles[key] || {};
          if (Array.isArray(value) && value.length >= 2) {
            profiles[key].min = value[0];
            profiles[key].max = value[1];
          } else if (value && typeof value === "object") {
            if (value.min !== undefined) profiles[key].min = value.min;
            if (value.max !== undefined) profiles[key].max = value.max;
          }
        });
      }

      return { sensor, addr, name, ack, status, message, csv, csvChunk, config, flash, timestamp, metrics, profiles };
    } catch (err) {
      // ignore
    }
  }

  const pairs = raw.split(/[;,\n]+/);
  pairs.forEach((part) => {
    const kv = part.match(/^\s*"?([a-z0-9_.-]+)"?\s*[:=]\s*"?([^"]+?)"?\s*$/i);
    if (!kv) return;
    const rawKey = kv[1];
    const rawValue = kv[2].trim();
    const key = normalizeKey(rawKey);
    if (!key) return;

    if (key === "sensor" || key === "type" || key === "id") {
      sensor = rawValue.toLowerCase();
      return;
    }
    if (key === "name") {
      name = rawValue;
      return;
    }
    if (key === "addr" || key === "i2c") {
      addr = rawValue.toLowerCase();
      return;
    }
    if (key === "ack") {
      ack = rawValue.toLowerCase();
      return;
    }
    if (key === "status") {
      status = rawValue.toLowerCase();
      return;
    }
    if (key === "message" || key === "msg") {
      message = rawValue;
      return;
    }
    if (key === "csv" || key === "flash_csv" || key === "flashcsv") {
      csv = rawValue;
      return;
    }

    if (["frequency", "freq", "interval", "period"].includes(key)) {
      config = config || {};
      const freq = toNumber(rawValue);
      if (freq !== null) config.frequency = freq;
      return;
    }

    if (["store_flash", "storeflash", "save", "flash"].includes(key)) {
      config = config || {};
      const val = parseBoolean(rawValue);
      if (val !== null) config.storeFlash = val;
      return;
    }

    const flashField = extractFlashFieldFromKey(key);
    if (flashField) {
      const num = toNumber(rawValue);
      if (num !== null) {
        flash = flash || {};
        flash[flashField] = num;
      }
      return;
    }

    const pinMatch = key.match(/^(i2c|onewire|one_wire|analog|digital|button|neopixel|neo)\.?(sda|scl|pin)?$/);
    if (pinMatch) {
      const group = pinMatch[1];
      const field = pinMatch[2];
      config = config || {};
      config.pins = config.pins || {};
      if (group === "i2c") {
        if (field === "sda" || field === "scl") {
          config.pins[field] = rawValue;
        }
      } else if (group === "onewire" || group === "one_wire") {
        config.pins.onewire = rawValue;
      } else if (group === "analog") {
        config.pins.analog = rawValue;
      } else if (group === "digital") {
        config.pins.digital = rawValue;
      } else if (group === "button") {
        config.pins.button = rawValue;
      } else if (group === "neopixel" || group === "neo") {
        config.pins.neopixel = rawValue;
      }
      return;
    }

    const profileMatch = key.match(/^(?:profile|profil|range|ranges)\.([a-z0-9_.-]+)\.(label|unit|min|max)$/);
    if (profileMatch) {
      const profileKey = normalizeKey(profileMatch[1]);
      const field = profileMatch[2];
      if (!profileKey) return;
      profiles[profileKey] = profiles[profileKey] || {};
      if (field === "min" || field === "max") {
        const num = toNumber(rawValue);
        if (num !== null) profiles[profileKey][field] = num;
      } else {
        profiles[profileKey][field] = rawValue;
      }
      return;
    }

    const metricMatch = key.match(/^(?:metric|metrics|value|values|data)\.([a-z0-9_.-]+)$/);
    const metricKey = metricMatch ? normalizeMetricKey(metricMatch[1], sensor) : normalizeMetricKey(key, sensor);
    if (!metricKey || RESERVED_KEYS.has(metricKey)) return;

    const value = toNumber(rawValue);
    if (value === null) return;
    metrics[metricKey] = value;
  });

  return { sensor, addr, name, ack, status, message, csv, csvChunk, config, flash, timestamp, metrics, profiles };
}

function ensureMetric(entry, key) {
  if (!entry.metrics) entry.metrics = {};
  if (!entry.metricOrder) entry.metricOrder = [];
  if (!entry.metrics[key]) {
    const profile = ensureMetricProfile(entry, key);
    entry.metrics[key] = { key, profile, values: [], latest: null };
    entry.metricOrder.push(key);
  }
  return entry.metrics[key];
}

function renderAll() {
  const list = Array.from(devices.values());
  const active = document.activeElement;
  const editingConfig = active
    && configList.contains(active)
    && (active.tagName === "INPUT" || active.tagName === "TEXTAREA" || active.tagName === "SELECT");
  if (!editingConfig) {
    renderConfig(list);
  }
  renderViz(list);
  updateControls();
}

function renderConfig(list) {
  configList.innerHTML = "";

  if (list.length === 0) {
    configEmpty.style.display = "block";
    return;
  }
  configEmpty.style.display = "none";

  list.forEach((entry) => {
    const draft = ensureConfigDraft(entry);

    const domId = safeDomId(entry.id);
    const card = document.createElement("div");
    card.className = "device-card";

    const title = document.createElement("div");
    title.className = "device-title";
    title.innerHTML = `
      <h3>${entry.name}</h3>
      <span class="badge ${entry.connected ? "" : "offline"}">${entry.connected ? "Connecte" : "Deconnecte"}</span>
    `;

    const meta = document.createElement("div");
    meta.className = "config-meta";
    const primarySensorLabel = getPrimarySensorLabel(entry);
    const addrLabel = entry.address || "--";
    const recognized = getRecognizedSensors(entry);
    const recognizedLabel = recognized.length ? recognized.join(", ") : "Aucun";
    const flashLabel = formatFlashSummary(entry.flash);
    const flashPercent = getFlashPercent(entry.flash);
    meta.innerHTML = `
      <div><strong>Capteur:</strong> ${primarySensorLabel}</div>
      <div><strong>Adresse:</strong> ${addrLabel}</div>
      <div><strong>Reconnu(s):</strong> ${recognizedLabel}</div>
      <div><strong>FS:</strong> ${flashLabel}</div>
    `;

    const fsUsage = document.createElement("div");
    fsUsage.className = "fs-usage";

    const fsRow = document.createElement("div");
    fsRow.className = "fs-row";

    const fsLabel = document.createElement("span");
    fsLabel.className = "fs-label";
    fsLabel.textContent = "FS";

    const fsValue = document.createElement("span");
    fsValue.className = "fs-value";
    fsValue.textContent = flashLabel;

    fsRow.appendChild(fsLabel);
    fsRow.appendChild(fsValue);

    const fsBar = document.createElement("div");
    fsBar.className = "fs-bar";

    const fsFill = document.createElement("span");
    fsFill.className = "fs-fill";
    if (Number.isFinite(flashPercent)) {
      const clamped = Math.max(0, Math.min(100, flashPercent));
      fsFill.style.width = `${Math.round(clamped)}%`;
    } else {
      fsBar.classList.add("is-unknown");
      fsFill.style.width = "100%";
    }
    fsBar.appendChild(fsFill);

    fsUsage.appendChild(fsRow);
    fsUsage.appendChild(fsBar);

    const actions = document.createElement("div");
    actions.className = "config-actions";
    const configBtn = document.createElement("button");
    configBtn.type = "button";
    configBtn.className = "btn small primary";
    configBtn.textContent = "Configurer";
    configBtn.disabled = !entry.connected;
    configBtn.addEventListener("click", () => openConfigModal(entry));
    actions.appendChild(configBtn);

    const recording = !!draft.storeFlash;
    const recordBtn = document.createElement("button");
    recordBtn.type = "button";
    recordBtn.className = `btn small ghost record-btn ${recording ? "is-recording" : ""}`;
    recordBtn.innerHTML = `
      <span class="record-indicator" aria-hidden="true"></span>
      <span class="record-label">${recording ? "STOP" : "ENREGISTREMENT"}</span>
    `;
    recordBtn.disabled = !entry.connected;
    recordBtn.setAttribute("aria-pressed", recording ? "true" : "false");
    recordBtn.addEventListener("click", () => toggleRecording(entry));
    actions.appendChild(recordBtn);

    const status = document.createElement("div");
    status.id = `status-${domId}`;
    status.className = `config-status ${draft.status ? draft.status.type : ""}`;
    status.textContent = draft.status ? draft.status.message : "";

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(fsUsage);
    card.appendChild(actions);
    card.appendChild(status);
    configList.appendChild(card);
  });
}

function renderViz(list) {
  vizList.innerHTML = "";

  if (list.length === 0) {
    vizEmpty.style.display = "block";
    return;
  }
  vizEmpty.style.display = "none";

  list.forEach((entry) => {
    if (entry.historyCollapsed === undefined) entry.historyCollapsed = true;
    const card = document.createElement("div");
    card.className = "device-card";

    const title = document.createElement("div");
    title.className = "device-title";
    title.innerHTML = `
      <h3>${entry.name}</h3>
      <span class="badge ${entry.connected ? "" : "offline"}">${entry.connected ? "Connecte" : "Deconnecte"}</span>
    `;

    const metricsGrid = document.createElement("div");
    metricsGrid.className = "metrics-grid";

    if (entry.sensor === "random") {
      entry.metricOrder = ["generic"];
      ensureMetric(entry, "generic");
    }

    let keys = entry.metricOrder || [];
    if (keys.length === 0 && entry.metrics) {
      keys = Object.keys(entry.metrics);
    }
    if (keys.length === 0) {
      const emptyState = document.createElement("div");
      emptyState.className = "muted";
      emptyState.textContent = "En attente de donnees...";
      metricsGrid.appendChild(emptyState);
    }

    keys.forEach((key) => {
      const metric = entry.metrics ? entry.metrics[key] : null;
      if (!metric) return;

      const metricCard = document.createElement("div");
      metricCard.className = "metric-card";

      const metricTitle = document.createElement("div");
      metricTitle.className = "metric-title";
      metricTitle.innerHTML = `
        <span>${metric.profile.label}</span>
        <span class="muted">${formatValue(metric.latest, metric.profile.unit)}</span>
      `;

      const chartWrap = document.createElement("div");
      chartWrap.className = "chart-wrap";

      const chartCanvas = document.createElement("canvas");
      chartCanvas.width = 520;
      chartCanvas.height = 180;
      chartCanvas.className = "chart-canvas";

      const gauge = document.createElement("div");
      gauge.className = "gauge";
      gauge.innerHTML = `
        <canvas width="120" height="120"></canvas>
        <div class="value">${formatValue(metric.latest, metric.profile.unit)}</div>
        <div class="muted">${metric.profile.label}</div>
      `;

      chartWrap.appendChild(chartCanvas);
      chartWrap.appendChild(gauge);
      metricCard.appendChild(metricTitle);
      metricCard.appendChild(chartWrap);
      metricsGrid.appendChild(metricCard);

      drawChart(chartCanvas, metric.values);
      if (metric.latest !== null) {
        drawGauge(gauge.querySelector("canvas"), metric.latest, metric.profile);
      }
    });

    card.appendChild(title);
    const vizActions = document.createElement("div");
    vizActions.className = "viz-actions";
    const loadHistoryBtn = document.createElement("button");
    loadHistoryBtn.type = "button";
    loadHistoryBtn.className = "btn small ghost";
    loadHistoryBtn.textContent = entry.historyLoading ? "Chargement..." : "Charger historique";
    loadHistoryBtn.disabled = !entry.connected || entry.historyLoading;
    loadHistoryBtn.addEventListener("click", () => startHistoryStream(entry));
    const downloadBtn = document.createElement("button");
    downloadBtn.type = "button";
    downloadBtn.className = "btn small ghost";
    downloadBtn.textContent = "Telecharger CSV";
    downloadBtn.disabled = !!entry.csvInProgress;
    downloadBtn.addEventListener("click", () => {
      const ok = downloadHistoryCsv(entry);
      if (ok) {
        setDraftStatus(entry, "ok", "CSV telecharge (historique).");
      } else {
        setDraftStatus(entry, "info", "Charge l'historique avant de telecharger.");
      }
    });
    vizActions.appendChild(loadHistoryBtn);
    vizActions.appendChild(downloadBtn);

    card.appendChild(metricsGrid);
    card.appendChild(vizActions);

    const historyWrap = document.createElement("div");
    historyWrap.className = `history-wrap ${entry.historyCollapsed ? "collapsed" : "expanded"}`;

    const historyHeader = document.createElement("div");
    historyHeader.className = "history-header";
    const historyTitle = document.createElement("div");
    historyTitle.className = "history-title";
    const liveStatus = entry.historyLoading ? "Live en pause" : "Live actif";
    const liveNote = !entry.connected ? " • Non connecte" : "";
    historyTitle.textContent = entry.historyLoading
      ? `Historique (chargement...) • ${liveStatus}${liveNote}`
      : `Historique • ${liveStatus}${liveNote}`;
    const historyToggle = document.createElement("button");
    historyToggle.type = "button";
    historyToggle.className = "btn small ghost history-toggle";
    historyToggle.textContent = entry.historyCollapsed ? "Afficher" : "Replier";
    historyToggle.addEventListener("click", () => {
      entry.historyCollapsed = !entry.historyCollapsed;
      renderAll();
    });
    historyHeader.appendChild(historyTitle);
    historyHeader.appendChild(historyToggle);
    historyWrap.appendChild(historyHeader);

    const historyScroll = document.createElement("div");
    historyScroll.className = "history-scroll";
    const historyTable = document.createElement("table");
    historyTable.className = "history-table";
    historyTable.innerHTML = `
      <thead>
        <tr><th>Heure</th><th>Valeur</th></tr>
      </thead>
    `;
    const historyBody = document.createElement("tbody");
    const rows = entry.historyRows || [];
    rows.forEach((row) => {
      const tr = document.createElement("tr");
      const tdTs = document.createElement("td");
      tdTs.textContent = row.timestamp || "--";
      const tdVal = document.createElement("td");
      tdVal.textContent = Number.isFinite(row.value) ? row.value.toFixed(2) : "--";
      tr.appendChild(tdTs);
      tr.appendChild(tdVal);
      historyBody.appendChild(tr);
    });
    historyTable.appendChild(historyBody);
    historyScroll.appendChild(historyTable);
    historyWrap.appendChild(historyScroll);
    card.appendChild(historyWrap);

    vizList.appendChild(card);
  });
}

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
}

function formatBytes(value) {
  if (!Number.isFinite(value)) return "--";
  const units = ["B", "KB", "MB", "GB"];
  let num = value;
  let idx = 0;
  while (num >= 1024 && idx < units.length - 1) {
    num /= 1024;
    idx += 1;
  }
  const rounded = num >= 10 || idx === 0 ? Math.round(num) : Math.round(num * 10) / 10;
  return `${rounded} ${units[idx]}`;
}

function getFlashPercent(flash) {
  if (!flash) return null;
  const percent = Number.isFinite(flash.percentUsed) ? flash.percentUsed : null;
  if (percent !== null) return percent;
  const total = Number.isFinite(flash.total) ? flash.total : null;
  const used = Number.isFinite(flash.used) ? flash.used : null;
  if (total && used !== null && total > 0) {
    return (used / total) * 100;
  }
  return null;
}

function formatFlashSummary(flash) {
  if (!flash) return "Indisponible";
  const total = Number.isFinite(flash.total) ? flash.total : null;
  const used = Number.isFinite(flash.used) ? flash.used : null;
  const percent = getFlashPercent(flash);
  const parts = [];
  if (percent !== null) parts.push(`${Math.round(percent)}%`);
  if (used !== null && total !== null) {
    parts.push(`${formatBytes(used)} / ${formatBytes(total)}`);
  }
  if (parts.length === 0) return "Indisponible";
  return parts.join(" · ");
}

function safeFileName(value) {
  const raw = String(value || "esp32").trim();
  const cleaned = raw.replace(/[^a-z0-9_-]+/gi, "_").replace(/^_+|_+$/g, "");
  return cleaned || "esp32";
}

function downloadCsv(entry, csvText) {
  if (!csvText) return;
  const blob = new Blob([csvText], { type: "text/csv" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${safeFileName(entry.name)}-flash.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function downloadHistoryCsv(entry) {
  if (!entry || !entry.historyAll || entry.historyAll.length === 0) return false;
  const lines = ["date_time,value1,value2"];
  entry.historyAll.forEach((row) => {
    const ts = row.timestamp || "";
    const val = Number.isFinite(row.value) ? row.value.toFixed(2) : "";
    lines.push(`${ts},${val},`);
  });
  downloadCsv(entry, lines.join("\n"));
  return true;
}

function drawChart(canvas, values) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  if (values.length < 2) return;

  const points = values.slice(-60);
  const ys = points.map((p) => p.value);
  const min = Math.min(...ys);
  const max = Math.max(...ys);
  const padding = 18;
  const range = max - min || 1;

  ctx.fillStyle = "#f5f0e6";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  ctx.strokeStyle = "rgba(21, 19, 15, 0.15)";
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(padding, canvas.height - padding);
  ctx.lineTo(canvas.width - padding, canvas.height - padding);
  ctx.stroke();

  ctx.strokeStyle = "#2f6f68";
  ctx.lineWidth = 2.5;
  ctx.beginPath();
  points.forEach((p, i) => {
    const x = padding + (i / (points.length - 1)) * (canvas.width - padding * 2);
    const y = padding + (1 - (p.value - min) / range) * (canvas.height - padding * 2);
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  });
  ctx.stroke();

  ctx.fillStyle = "rgba(47, 111, 104, 0.15)";
  ctx.lineTo(canvas.width - padding, canvas.height - padding);
  ctx.lineTo(padding, canvas.height - padding);
  ctx.closePath();
  ctx.fill();

  ctx.fillStyle = "#5c5a55";
  ctx.font = "12px 'IBM Plex Mono', monospace";
  ctx.fillText(max.toFixed(1), padding, padding - 4);
  ctx.fillText(min.toFixed(1), padding, canvas.height - 6);
}

function drawGauge(canvas, value, profile) {
  const ctx = canvas.getContext("2d");
  ctx.clearRect(0, 0, canvas.width, canvas.height);

  const min = Number.isFinite(profile.min) ? profile.min : 0;
  const max = Number.isFinite(profile.max) ? profile.max : 100;
  const safeMax = min >= max ? min + 1 : max;
  const ratio = Number.isFinite(value)
    ? Math.min(Math.max((value - min) / (safeMax - min || 1), 0), 1)
    : 0;

  const center = { x: canvas.width / 2, y: canvas.height / 2 };
  const radius = canvas.width / 2 - 12;
  const start = Math.PI * 0.75;
  const end = Math.PI * 2.25;
  const sweep = start + (end - start) * ratio;

  ctx.lineWidth = 10;
  ctx.strokeStyle = "rgba(21, 19, 15, 0.12)";
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, start, end);
  ctx.stroke();

  ctx.strokeStyle = "#f08a4b";
  ctx.beginPath();
  ctx.arc(center.x, center.y, radius, start, sweep);
  ctx.stroke();

  const needleAngle = sweep;
  const needleLength = radius - 6;
  ctx.strokeStyle = "#15130f";
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(center.x, center.y);
  ctx.lineTo(
    center.x + Math.cos(needleAngle) * needleLength,
    center.y + Math.sin(needleAngle) * needleLength
  );
  ctx.stroke();

  ctx.fillStyle = "#15130f";
  ctx.beginPath();
  ctx.arc(center.x, center.y, 4, 0, Math.PI * 2);
  ctx.fill();

  ctx.fillStyle = "#5c5a55";
  ctx.font = "11px 'IBM Plex Mono', monospace";
  ctx.fillText(min, 8, canvas.height - 8);
  ctx.fillText(safeMax, canvas.width - 26, canvas.height - 8);
}

updateControls();
