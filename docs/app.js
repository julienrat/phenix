const SERVICE_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c01";
const DATA_CHAR_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c02";
const CONFIG_CHAR_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c03";

const MAX_CONNECTIONS = 4;
const AUTO_RECONNECT = true;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 15000;
const RECONNECT_MAX_ATTEMPTS = 6;

const I2C_PIN_OPTIONS = [
  { value: "auto", label: "Auto" },
  { value: "8", label: "GPIO8" },
  { value: "9", label: "GPIO9" },
];

const METRIC_PROFILES = {
  temperature: { label: "Temperature", unit: "°C", min: -10, max: 50 },
  pressure: { label: "Pression", unit: "hPa", min: 900, max: 1100 },
  humidity: { label: "Humidite", unit: "%", min: 0, max: 100 },
  generic: { label: "Valeur", unit: "", min: 0, max: 100 },
};

const RESERVED_KEYS = new Set([
  "sensor",
  "type",
  "id",
  "name",
  "addr",
  "i2c",
  "metrics",
  "values",
  "data",
  "profiles",
  "profile",
  "ranges",
  "range",
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

function normalizePin(value) {
  if (value === undefined || value === null) return null;
  const raw = String(value).trim().toLowerCase();
  if (!raw || raw === "auto") return null;
  const num = Number(raw);
  return Number.isInteger(num) ? num : null;
}

function fillPinOptions(select, current) {
  select.innerHTML = "";
  I2C_PIN_OPTIONS.forEach((option) => {
    const opt = document.createElement("option");
    opt.value = option.value;
    opt.textContent = option.label;
    if (String(option.value) === String(current)) {
      opt.selected = true;
    }
    select.appendChild(opt);
  });
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

function ensureConfigDraft(entry) {
  if (!entry.configDraft) {
    entry.configDraft = {
      name: entry.name || "",
      sda: "auto",
      scl: "auto",
      status: null,
      touched: false,
    };
  }

  const draft = entry.configDraft;
  if (!draft.name && entry.name) draft.name = entry.name;
  if (!draft.sda) draft.sda = "auto";
  if (!draft.scl) draft.scl = "auto";

  return draft;
}

function setDraftStatus(entry, type, message) {
  const draft = ensureConfigDraft(entry);
  draft.status = { type, message, ts: Date.now() };
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

  const sda = normalizePin(draft.sda);
  const scl = normalizePin(draft.scl);
  if (sda !== null || scl !== null) {
    payload.i2c = {};
    if (sda !== null) payload.i2c.sda = sda;
    if (scl !== null) payload.i2c.scl = scl;
  }

  if (!payload.name) {
    return { payload: null, warnings };
  }

  return { payload, warnings };
}

async function sendConfig(entry, draft, statusEl) {
  if (!entry.connected || !entry.configChar) {
    setDraftStatus(entry, "error", "ESP32 non connecte.");
    if (statusEl) {
      statusEl.textContent = entry.configDraft.status.message;
      statusEl.className = "config-status error";
    }
    return;
  }

  const { payload, warnings } = buildConfigPayload(entry, draft);
  if (!payload) {
    setDraftStatus(entry, "error", "Aucune configuration valide a envoyer.");
    if (statusEl) {
      statusEl.textContent = entry.configDraft.status.message;
      statusEl.className = "config-status error";
    }
    return;
  }

  try {
    const encoded = encoder.encode(JSON.stringify(payload));
    await entry.configChar.writeValue(encoded);

    if (payload.name) {
      entry.name = payload.name;
      draft.name = payload.name;
      draft.touched = false;
    }

    const warningSuffix = warnings.length ? ` (${warnings.length} avertissement(s))` : "";
    const message = `Config envoyee${warningSuffix}.`;
    setDraftStatus(entry, "ok", message);
    if (statusEl) {
      statusEl.textContent = message;
      statusEl.className = "config-status ok";
    }
    if (warnings.length) console.warn("Config warnings", warnings);
    renderAll();
  } catch (err) {
    console.error("Config write failed", err);
    setDraftStatus(entry, "error", "Erreur lors de l'envoi BLE.");
    if (statusEl) {
      statusEl.textContent = entry.configDraft.status.message;
      statusEl.className = "config-status error";
    }
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
  if (record.reconnectTimer) {
    clearTimeout(record.reconnectTimer);
    record.reconnectTimer = null;
  }
  devices.set(device.id, record);
  ensureDisconnectListener(record, device);
  renderAll();
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
  renderAll();
  scheduleReconnect(entry);
}

function handleNotification(deviceId, valueView) {
  const entry = devices.get(deviceId);
  if (!entry) return;

  const raw = decodeValue(valueView);
  const parsed = parsePayload(raw);

  if (parsed.sensor) entry.sensor = parsed.sensor;
  if (parsed.addr) entry.address = parsed.addr;
  if (parsed.name) {
    entry.name = parsed.name;
    if (entry.configDraft && !entry.configDraft.touched) {
      entry.configDraft.name = parsed.name;
    }
  }
  if (parsed.ack === "name") {
    const type = parsed.status === "ok" ? "ok" : "error";
    const message = parsed.message || (type === "ok" ? "Nom mis a jour." : "Erreur de configuration.");
    setDraftStatus(entry, type, message);
    updateConfigStatus(entry);
  }
  if (parsed.profiles && Object.keys(parsed.profiles).length > 0) {
    Object.entries(parsed.profiles).forEach(([key, profile]) => {
      const normalized = normalizeKey(key);
      if (!normalized) return;
      applyProfileUpdate(entry, normalized, profile);
    });
  }

  const keys = Object.keys(parsed.metrics);
  if (keys.length === 0) {
    if (parsed.name || parsed.ack) {
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
  });

  renderAll();
}

function decodeValue(view) {
  const slice = view.buffer.slice(view.byteOffset, view.byteOffset + view.byteLength);
  const text = decoder.decode(slice);
  return text.replace(/\u0000/g, "").trim();
}

function parsePayload(raw) {
  let sensor = null;
  let addr = null;
  let name = null;
  let ack = null;
  let status = null;
  let message = null;
  const metrics = {};
  const profiles = {};

  if (!raw) return { sensor, addr, name, ack, status, message, metrics, profiles };

  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (obj.sensor) sensor = String(obj.sensor).toLowerCase();
      if (obj.type) sensor = String(obj.type).toLowerCase();
      if (obj.name) name = String(obj.name);
      if (obj.addr) addr = String(obj.addr);
      if (obj.i2c) addr = String(obj.i2c);
      if (obj.ack) ack = String(obj.ack).toLowerCase();
      if (obj.status) status = String(obj.status).toLowerCase();
      if (obj.message) message = String(obj.message);
      if (obj.msg && !message) message = String(obj.msg);

      const metricSource = obj.metrics || obj.values || obj.data;
      if (metricSource && typeof metricSource === "object") {
        Object.entries(metricSource).forEach(([rawKey, value]) => {
          const key = normalizeKey(rawKey);
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

        Object.entries(obj).forEach(([rawKey, value]) => {
          const key = normalizeKey(rawKey);
          if (!key || RESERVED_KEYS.has(key)) return;
          const num = toNumber(value);
          if (num === null) return;
          metrics[key] = num;
        });
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

      return { sensor, addr, name, ack, status, message, metrics, profiles };
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
    const metricKey = metricMatch ? normalizeKey(metricMatch[1]) : key;
    if (!metricKey || RESERVED_KEYS.has(metricKey)) return;

    const value = toNumber(rawValue);
    if (value === null) return;
    metrics[metricKey] = value;
  });

  return { sensor, addr, name, ack, status, message, metrics, profiles };
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
    const sensorLabel = entry.sensor || "Inconnu";
    const addrLabel = entry.address || "--";
    meta.innerHTML = `
      <div><strong>Capteur:</strong> ${sensorLabel}</div>
      <div><strong>Adresse:</strong> ${addrLabel}</div>
    `;

    const form = document.createElement("form");
    form.className = "config-form";

    const grid = document.createElement("div");
    grid.className = "config-grid";

    const nameField = document.createElement("div");
    nameField.className = "field";
    const nameLabelEl = document.createElement("label");
    nameLabelEl.setAttribute("for", `name-${domId}`);
    nameLabelEl.textContent = "Nom BLE";
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.id = `name-${domId}`;
    nameInput.placeholder = "ESP32-Lab-01";
    nameInput.value = draft.name || "";
    nameInput.addEventListener("input", (event) => {
      draft.name = event.target.value;
      draft.touched = true;
    });
    nameField.appendChild(nameLabelEl);
    nameField.appendChild(nameInput);

    grid.appendChild(nameField);

    const sdaField = document.createElement("div");
    sdaField.className = "field";
    const sdaLabelEl = document.createElement("label");
    sdaLabelEl.setAttribute("for", `sda-${domId}`);
    sdaLabelEl.textContent = "Pin SDA";
    const sdaSelect = document.createElement("select");
    sdaSelect.id = `sda-${domId}`;
    fillPinOptions(sdaSelect, draft.sda);
    sdaSelect.addEventListener("change", (event) => {
      draft.sda = event.target.value;
      draft.touched = true;
    });
    sdaField.appendChild(sdaLabelEl);
    sdaField.appendChild(sdaSelect);

    const sclField = document.createElement("div");
    sclField.className = "field";
    const sclLabelEl = document.createElement("label");
    sclLabelEl.setAttribute("for", `scl-${domId}`);
    sclLabelEl.textContent = "Pin SCL";
    const sclSelect = document.createElement("select");
    sclSelect.id = `scl-${domId}`;
    fillPinOptions(sclSelect, draft.scl);
    sclSelect.addEventListener("change", (event) => {
      draft.scl = event.target.value;
      draft.touched = true;
    });
    sclField.appendChild(sclLabelEl);
    sclField.appendChild(sclSelect);

    grid.appendChild(sdaField);
    grid.appendChild(sclField);

    const actions = document.createElement("div");
    actions.className = "config-actions";
    const sendBtn = document.createElement("button");
    sendBtn.type = "submit";
    sendBtn.className = "btn small primary";
    sendBtn.textContent = "Envoyer la config";

    actions.appendChild(sendBtn);

    const status = document.createElement("div");
    status.id = `status-${domId}`;
    status.className = `config-status ${draft.status ? draft.status.type : ""}`;
    status.textContent = draft.status ? draft.status.message : "";

    form.appendChild(grid);
    form.appendChild(actions);
    form.appendChild(status);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      sendConfig(entry, draft, status);
    });

    card.appendChild(title);
    card.appendChild(meta);
    card.appendChild(form);
    configList.appendChild(card);
  });
}

function renderViz(list) {
  vizList.innerHTML = "";

  const withData = list.filter((entry) => {
    const keys = entry.metricOrder || [];
    return keys.some((key) => entry.metrics && entry.metrics[key] && entry.metrics[key].latest !== null);
  });

  if (withData.length === 0) {
    vizEmpty.style.display = "block";
    return;
  }
  vizEmpty.style.display = "none";

  withData.forEach((entry) => {
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

    (entry.metricOrder || []).forEach((key) => {
      const metric = entry.metrics ? entry.metrics[key] : null;
      if (!metric || metric.latest === null) return;

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
      drawGauge(gauge.querySelector("canvas"), metric.latest, metric.profile);
    });

    card.appendChild(title);
    card.appendChild(metricsGrid);
    vizList.appendChild(card);
  });
}

function formatValue(value, unit) {
  if (!Number.isFinite(value)) return "--";
  const rounded = Math.round(value * 10) / 10;
  return `${rounded}${unit}`;
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
