const SERVICE_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c01";
const DATA_CHAR_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c02";
const CONFIG_CHAR_UUID = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c03";

const MAX_CONNECTIONS = 4;
const AUTO_RECONNECT = true;
const RECONNECT_BASE_DELAY = 1000;
const RECONNECT_MAX_DELAY = 15000;
const RECONNECT_MAX_ATTEMPTS = 6;

const METRIC_PROFILES = {
  temperature: { label: "Temperature", unit: "°C", min: -10, max: 50 },
  pressure: { label: "Pression", unit: "hPa", min: 900, max: 1100 },
  humidity: { label: "Humidite", unit: "%", min: 0, max: 100 },
  generic: { label: "Valeur", unit: "", min: 0, max: 100 },
};

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

  const keys = Object.keys(parsed.metrics);
  if (keys.length === 0) return;

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
  const metrics = {};

  if (!raw) return { sensor, addr, metrics };

  if (raw.startsWith("{")) {
    try {
      const obj = JSON.parse(raw);
      if (obj.sensor) sensor = String(obj.sensor).toLowerCase();
      if (obj.type) sensor = String(obj.type).toLowerCase();
      if (obj.addr) addr = String(obj.addr);

      if (obj.temperature !== undefined) metrics.temperature = Number(obj.temperature);
      if (obj.temp !== undefined) metrics.temperature = Number(obj.temp);
      if (obj.pressure !== undefined) metrics.pressure = Number(obj.pressure);
      if (obj.press !== undefined) metrics.pressure = Number(obj.press);
      if (obj.humidity !== undefined) metrics.humidity = Number(obj.humidity);
      if (obj.value !== undefined) metrics.generic = Number(obj.value);

      return { sensor, addr, metrics };
    } catch (err) {
      // ignore
    }
  }

  const sensorMatch = raw.match(/"?(?:sensor|type|id)"?\s*[:=]\s*"?([a-z0-9_-]+)"?/i);
  if (sensorMatch) {
    sensor = sensorMatch[1].toLowerCase();
  }

  const addrMatch = raw.match(/"?(?:addr|i2c)"?\s*[:=]\s*"?(0x[0-9a-f]+)"?/i);
  if (addrMatch) {
    addr = addrMatch[1].toLowerCase();
  }

  const pairs = raw.split(/[;,\n]+/);
  pairs.forEach((part) => {
    const kv = part.match(/^\s*"?([a-z0-9_-]+)"?\s*[:=]\s*(-?\d+(?:\.\d+)?)/i);
    if (!kv) return;
    const key = kv[1].toLowerCase();
    const value = Number(kv[2]);
    metrics[key] = value;
  });

  return { sensor, addr, metrics };
}

function ensureMetric(entry, key) {
  if (!entry.metrics) entry.metrics = {};
  if (!entry.metricOrder) entry.metricOrder = [];
  if (!entry.metrics[key]) {
    const profile = METRIC_PROFILES[key] || { label: key, unit: "", min: 0, max: 100 };
    entry.metrics[key] = { key, profile, values: [], latest: null };
    entry.metricOrder.push(key);
  }
  return entry.metrics[key];
}

function renderAll() {
  const list = Array.from(devices.values());
  renderConfig(list);
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
    meta.innerHTML = `
      <div><strong>Capteur:</strong> ${entry.sensor || "Inconnu"}</div>
      <div><strong>Adresse:</strong> ${entry.address || "--"}</div>
    `;

    const chips = document.createElement("div");
    chips.className = "metric-chips";
    const keys = entry.metricOrder || [];
    if (keys.length > 0) {
      keys.forEach((key) => {
        const chip = document.createElement("span");
        const profile = (entry.metrics && entry.metrics[key]) ? entry.metrics[key].profile : null;
        chip.className = "chip";
        chip.textContent = profile ? profile.label : key;
        chips.appendChild(chip);
      });
    }

    card.appendChild(title);
    card.appendChild(meta);
    if (chips.childNodes.length > 0) card.appendChild(chips);
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

  const min = profile.min;
  const max = profile.max;
  const ratio = Number.isFinite(value) ? Math.min(Math.max((value - min) / (max - min || 1), 0), 1) : 0;

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
  ctx.fillText(max, canvas.width - 26, canvas.height - 8);
}

updateControls();
