#include <Arduino.h>
#include <math.h>
#include <Wire.h>
#include <NimBLEDevice.h>
#include <NimBLEAdvertisementData.h>
#include <Adafruit_BMP280.h>
#include <Adafruit_NeoPixel.h>
#include <MS5611.h>
#include <Preferences.h>
#include <LittleFS.h>
#include <CsvLogger.h>
#include <OneWire.h>
#include <DallasTemperature.h>
#include <ctype.h>
#include <time.h>

#if defined(ARDUINO_ARCH_ESP32)
#include "esp_system.h"
#include "esp_chip_info.h"
#endif

#if defined(USE_UART0_LOG)
#undef Serial
#define Serial Serial0
#endif

// Custom service/characteristic UUIDs (align with Web Bluetooth app)
static const char *UUID_SERVICE = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c01";
static const char *UUID_DATA    = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c02"; // notify
static const char *UUID_CONFIG  = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c03"; // write

static char bleName[32];
static char bleNameShort[16];
static const uint32_t HEARTBEAT_MS = 1000;
static const uint32_t RESCAN_INTERVAL_MS = 5000;
static const uint8_t I2C_ADDR_BMP280_A = 0x76;
static const uint8_t I2C_ADDR_BMP280_B = 0x77;
static const uint8_t I2C_ADDR_MS5611_A = 0x77;
static const uint8_t I2C_ADDR_MS5611_B = 0x76;
static const char *LOG_PATH = "/log.csv";
static const char *LOG_HEADER = "date_time,value1,value2";
static const bool DEBUG_VERBOSE = true;
static const uint8_t NEOPIXEL_COUNT = 1;
static const uint8_t NEOPIXEL_BRIGHTNESS = 64;

#define LOGVLN(msg) do { if (DEBUG_VERBOSE) { Serial.println(msg); } } while (0)

static NimBLECharacteristic *txChar = nullptr;
static NimBLEServer *bleServer = nullptr;
static uint8_t connectedCount = 0;
static uint16_t bleMtu = 23;
static uint32_t lastBeat = 0;
static uint32_t lastSensorMs = 0;
static uint32_t lastScanMs = 0;
static bool bleResetPending = false;
static uint32_t bleResetAt = 0;
static bool csvExportInProgress = false;
static uint32_t csvExportId = 0;
static uint32_t csvExportStartedAt = 0;
static File csvStreamFile;
static bool csvStreamActive = false;
static bool csvAwaitAck = false;
static uint32_t csvStreamId = 0;
static uint32_t csvStreamSeq = 0;
static uint32_t csvStreamLastSent = 0;
static uint32_t csvStreamLastAck = 0;
static bool csvStreamAllSent = false;
static bool csvHasPendingLine = false;
static std::string csvPendingLine;
static uint32_t csvStreamLastActivityMs = 0;

static const uint8_t CSV_ACK_WINDOW = 1;
static bool serialDumpInProgress = false;
static CsvLogger csvLogger(LittleFS, LOG_PATH, LOG_HEADER);

#ifndef USE_COMPACT_METRICS
#define USE_COMPACT_METRICS 1
#endif

static Adafruit_BMP280 *bmp280 = nullptr;
static MS5611 *ms5611 = nullptr;
static OneWire *oneWire = nullptr;
static DallasTemperature *ds18b20 = nullptr;
static uint8_t bmpAddr = 0;
static uint8_t msAddr = 0;
static Preferences prefs;
static bool prefsReady = false;
static uint32_t sensorIntervalMs = 1000;
static bool littlefsReady = false;
static Adafruit_NeoPixel *neoPixel = nullptr;
static int neoPixelPin = -1;
static int buttonStableState = HIGH;
static int buttonLastRead = HIGH;
static uint32_t buttonLastChangeMs = 0;
static const uint32_t BUTTON_DEBOUNCE_MS = 40;

struct DeviceConfig {
  std::string name;
  std::string sensor;
  int i2cSda = -1;
  int i2cScl = -1;
  int onewirePin = -1;
  int analogPin = -1;
  int digitalPin = -1;
  int buttonPin = -1;
  int neopixelPin = -1;
  uint32_t frequencyMs = 1000;
  bool storeFlash = false;
};

struct ConfigUpdate {
  bool hasName = false;
  std::string name;
  bool hasSensor = false;
  std::string sensor;
  bool hasI2c = false;
  int i2cSda = -1;
  int i2cScl = -1;
  bool hasOneWire = false;
  int onewirePin = -1;
  bool hasAnalog = false;
  int analogPin = -1;
  bool hasDigital = false;
  int digitalPin = -1;
  bool hasButton = false;
  int buttonPin = -1;
  bool hasNeoPixel = false;
  int neopixelPin = -1;
  bool hasFrequency = false;
  uint32_t frequencyMs = 0;
  bool hasStoreFlash = false;
  bool storeFlash = false;
  bool hasAction = false;
  std::string action;
  std::string format;
  bool hasEpochMs = false;
  uint64_t epochMs = 0;
  bool hasTzOffset = false;
  int32_t tzOffsetMin = 0;
  bool hasCsvAck = false;
  uint32_t csvAckId = 0;
  uint32_t csvAckSeq = 0;
};

static DeviceConfig deviceConfig;
static bool timeSynced = false;
static int64_t epochOffsetMs = 0;
static int32_t tzOffsetMin = 0;


static void clearSensors();
static void scanSensors();
static size_t estimateLineBytes();
static void applyTimeSync(uint64_t epochMs);
static void applyTzOffset(int32_t offsetMin);
static uint64_t currentEpochMs();
static uint64_t currentLocalMs();
static void formatTimestamp(uint64_t epochMs, char *out, size_t outLen);
static void applyUserIo();
static void updateRecordingLed();
static void handleButtonInput();
static bool getFlashStats(size_t &total, size_t &used, size_t &freeSpace, size_t &logBytes);
static bool buildFlashJson(std::string &out, bool withEstimates);
static void sendFlashStatus();
static size_t csvChunkBytes();
static void sendCsvChunk(uint32_t exportId, uint32_t seq, uint32_t totalBytes, bool last, const std::string &chunk);
static void endCsvStream();
static void sendNextCsvBlock();
static void sendCsvFromFlash();
static void handleSerialCommands();
static void dumpCsvToSerial();

static std::string trimCopy(const std::string &input) {
  size_t start = 0;
  while (start < input.size() && isspace((unsigned char)input[start])) start++;
  size_t end = input.size();
  while (end > start && isspace((unsigned char)input[end - 1])) end--;
  return input.substr(start, end - start);
}

static std::string sanitizeName(const std::string &input) {
  std::string trimmed = trimCopy(input);
  if (trimmed.empty()) return "";
  std::string out;
  out.reserve(trimmed.size());
  for (char c : trimmed) {
    if (!isprint((unsigned char)c)) continue;
    if (c == '"' || c == '\\') continue;
    out.push_back(c);
  }
  if (out.size() > 31) out.resize(31);
  return out;
}

static std::string lowerCopy(const std::string &input) {
  std::string out = input;
  for (char &c : out) c = (char)tolower((unsigned char)c);
  return out;
}

static std::string normalizeSensor(const std::string &input) {
  const std::string raw = lowerCopy(trimCopy(input));
  if (raw.empty()) return "i2c";
  if (raw.find("i2c") != std::string::npos) return "i2c";
  if (raw.find("onewire") != std::string::npos || raw.find("one-wire") != std::string::npos || raw.find("1wire") != std::string::npos) {
    return "onewire";
  }
  if (raw.find("analog") != std::string::npos || raw.find("adc") != std::string::npos) return "analog";
  if (raw.find("digital") != std::string::npos || raw.find("gpio") != std::string::npos) return "digital";
  if (raw.find("random") != std::string::npos) return "random";
  return raw;
}

static std::string escapeJson(const std::string &input) {
  std::string out;
  out.reserve(input.size() + 8);
  for (char c : input) {
    switch (c) {
      case '\\': out += "\\\\"; break;
      case '"': out += "\\\""; break;
      case '\n': out += "\\n"; break;
      case '\r': out += "\\r"; break;
      case '\t': out += "\\t"; break;
      default: out.push_back(c); break;
    }
  }
  return out;
}

static void setBleNameBuffers(const std::string &fullName) {
  snprintf(bleName, sizeof(bleName), "%s", fullName.c_str());
  std::string shortName = fullName;
  if (shortName.size() >= sizeof(bleNameShort)) {
    shortName = shortName.substr(0, sizeof(bleNameShort) - 1);
  }
  snprintf(bleNameShort, sizeof(bleNameShort), "%s", shortName.c_str());
}

static void refreshAdvertising() {
  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  if (!adv) return;
  NimBLEDevice::stopAdvertising();
  NimBLEAdvertisementData advData;
  advData.setFlags(0x06);
  advData.addServiceUUID(UUID_SERVICE);
  advData.setPreferredParams(24, 40);
  advData.setName(bleNameShort);
  advData.addTxPower();

  NimBLEAdvertisementData scanData;
  scanData.setName(bleName);
  scanData.addTxPower();

  adv->setAdvertisementData(advData);
  adv->setScanResponseData(scanData);
  adv->enableScanResponse(true);
  adv->start();
}

#ifndef I2C_SDA
#if defined(SDA)
#define I2C_SDA SDA
#else
#define I2C_SDA 8
#endif
#endif

#ifndef I2C_SCL
#if defined(SCL)
#define I2C_SCL SCL
#else
#define I2C_SCL 9
#endif
#endif

static void ensurePrefs() {
  if (prefsReady) return;
  prefsReady = prefs.begin("blecfg", false);
  if (!prefsReady) {
    Serial.println("[NVS] Init failed");
  }
}

static bool ensureLittleFS() {
  if (littlefsReady) return true;
  littlefsReady = LittleFS.begin(true);
  if (!littlefsReady) {
    Serial.println("[LFS] Mount failed");
  } else {
    Serial.print("[LFS] Total=");
    Serial.print(LittleFS.totalBytes());
    Serial.print(" Used=");
    Serial.println(LittleFS.usedBytes());
    LOGVLN("[LFS] Mount ok");
  }
  return littlefsReady;
}

static bool getFlashStats(size_t &total, size_t &used, size_t &freeSpace, size_t &logBytes) {
  if (!ensureLittleFS()) return false;
  total = LittleFS.totalBytes();
  used = LittleFS.usedBytes();
  freeSpace = total > used ? total - used : 0;
  logBytes = 0;
  if (LittleFS.exists(LOG_PATH)) {
    File file = LittleFS.open(LOG_PATH, "r");
    if (file) {
      logBytes = file.size();
      file.close();
    }
  }
  return true;
}

static bool buildFlashJson(std::string &out, bool withEstimates) {
  size_t total = 0;
  size_t used = 0;
  size_t freeSpace = 0;
  size_t logBytes = 0;
  if (!getFlashStats(total, used, freeSpace, logBytes)) return false;
  const unsigned long percentUsed = total ? (unsigned long)((used * 100UL) / total) : 0;
  size_t estSamples = 0;
  uint64_t estSeconds = 0;
  if (withEstimates) {
    const size_t lineBytes = estimateLineBytes();
    estSamples = lineBytes > 0 ? (freeSpace / lineBytes) : 0;
    estSeconds = deviceConfig.frequencyMs
      ? (uint64_t)estSamples * (uint64_t)deviceConfig.frequencyMs / 1000ULL
      : 0;
  }
  char buf[240];
  if (withEstimates) {
    snprintf(buf, sizeof(buf),
             "\"flash\":{\"total\":%lu,\"used\":%lu,\"free\":%lu,"
             "\"percent_used\":%lu,\"log_bytes\":%lu,"
             "\"est_samples\":%lu,\"est_seconds\":%lu}",
             (unsigned long)total,
             (unsigned long)used,
             (unsigned long)freeSpace,
             percentUsed,
             (unsigned long)logBytes,
             (unsigned long)estSamples,
             (unsigned long)estSeconds);
  } else {
    snprintf(buf, sizeof(buf),
             "\"flash\":{\"total\":%lu,\"used\":%lu,\"free\":%lu,"
             "\"percent_used\":%lu,\"log_bytes\":%lu}",
             (unsigned long)total,
             (unsigned long)used,
             (unsigned long)freeSpace,
             percentUsed,
             (unsigned long)logBytes);
  }
  out.assign(buf);
  return true;
}

static void loadConfig() {
  ensurePrefs();
  if (!prefsReady) return;
  deviceConfig.name = std::string(prefs.getString("name", "").c_str());
  deviceConfig.sensor = normalizeSensor(std::string(prefs.getString("sensor", "i2c").c_str()));
  deviceConfig.i2cSda = prefs.getInt("i2c_sda", I2C_SDA);
  deviceConfig.i2cScl = prefs.getInt("i2c_scl", I2C_SCL);
  deviceConfig.onewirePin = prefs.getInt("onewire_pin", -1);
  deviceConfig.analogPin = prefs.getInt("analog_pin", -1);
  deviceConfig.digitalPin = prefs.getInt("digital_pin", -1);
  deviceConfig.buttonPin = prefs.getInt("button_pin", -1);
  deviceConfig.neopixelPin = prefs.getInt("neopixel_pin", -1);
  deviceConfig.frequencyMs = prefs.getUInt("freq_ms", 1000);
  deviceConfig.storeFlash = prefs.getBool("store_flash", false);
  sensorIntervalMs = deviceConfig.frequencyMs ? deviceConfig.frequencyMs : 1000;
}

static void saveConfig() {
  ensurePrefs();
  if (!prefsReady) return;
  prefs.putString("name", deviceConfig.name.c_str());
  prefs.putString("sensor", deviceConfig.sensor.c_str());
  prefs.putInt("i2c_sda", deviceConfig.i2cSda);
  prefs.putInt("i2c_scl", deviceConfig.i2cScl);
  prefs.putInt("onewire_pin", deviceConfig.onewirePin);
  prefs.putInt("analog_pin", deviceConfig.analogPin);
  prefs.putInt("digital_pin", deviceConfig.digitalPin);
  prefs.putInt("button_pin", deviceConfig.buttonPin);
  prefs.putInt("neopixel_pin", deviceConfig.neopixelPin);
  prefs.putUInt("freq_ms", deviceConfig.frequencyMs);
  prefs.putBool("store_flash", deviceConfig.storeFlash);
}

static void sendNameAck(const char *status, const std::string &name, const char *message) {
  if (!txChar) return;
  char payload[200];
  if (message && message[0]) {
    snprintf(payload, sizeof(payload),
             "{\"ack\":\"name\",\"status\":\"%s\",\"message\":\"%s\"}",
             status, message);
  } else {
    snprintf(payload, sizeof(payload),
             "{\"ack\":\"name\",\"status\":\"%s\",\"name\":\"%s\"}",
             status, name.c_str());
  }
  Serial.print("[BLE] ACK: ");
  Serial.println(payload);
  if (DEBUG_VERBOSE) {
    Serial.print("[ACK] name status=");
    Serial.print(status);
    Serial.print(" name=");
    Serial.println(name.c_str());
  }
  txChar->setValue(payload);
  txChar->notify();
}

static void sendConfigAck(const char *status, const char *message) {
  if (!txChar) return;
  char payload[200];
  if (message && message[0]) {
    snprintf(payload, sizeof(payload),
             "{\"ack\":\"config\",\"status\":\"%s\",\"message\":\"%s\"}",
             status, message);
  } else {
    snprintf(payload, sizeof(payload),
             "{\"ack\":\"config\",\"status\":\"%s\"}",
             status);
  }
  Serial.print("[BLE] ACK: ");
  Serial.println(payload);
  txChar->setValue(payload);
  txChar->notify();
}

static void sendFlashAck(const char *action, const char *status, const char *message) {
  if (!txChar) return;
  char payload[220];
  if (message && message[0]) {
    snprintf(payload, sizeof(payload),
             "{\"ack\":\"%s\",\"status\":\"%s\",\"message\":\"%s\"}",
             action, status, message);
  } else {
    snprintf(payload, sizeof(payload),
             "{\"ack\":\"%s\",\"status\":\"%s\"}",
             action, status);
  }
  Serial.print("[BLE] ACK: ");
  Serial.println(payload);
  txChar->setValue(payload);
  txChar->notify();
}

static bool extractJsonStringField(const std::string &json, const char *key, std::string &out) {
  if (!key || !key[0]) return false;
  const std::string pattern = std::string("\"") + key + "\"";
  size_t pos = json.find(pattern);
  if (pos == std::string::npos) return false;
  pos = json.find(':', pos + pattern.size());
  if (pos == std::string::npos) return false;
  pos++;
  while (pos < json.size() && isspace((unsigned char)json[pos])) pos++;
  if (pos >= json.size()) return false;
  const char quote = json[pos];
  if (quote == '"' || quote == '\'') {
    pos++;
    size_t end = json.find(quote, pos);
    if (end == std::string::npos) return false;
    out = json.substr(pos, end - pos);
    return !out.empty();
  }
  size_t end = pos;
  while (end < json.size() && json[end] != ',' && json[end] != '}' && !isspace((unsigned char)json[end])) end++;
  out = json.substr(pos, end - pos);
  return !out.empty();
}

static bool extractJsonNumberField(const std::string &json, const char *key, int &out) {
  std::string temp;
  if (!extractJsonStringField(json, key, temp)) return false;
  out = atoi(temp.c_str());
  return true;
}

static bool extractJsonNumberFieldU32(const std::string &json, const char *key, uint32_t &out) {
  std::string temp;
  if (!extractJsonStringField(json, key, temp)) return false;
  long val = atol(temp.c_str());
  if (val < 0) return false;
  out = (uint32_t)val;
  return true;
}

static bool extractJsonNumberFieldU64(const std::string &json, const char *key, uint64_t &out) {
  std::string temp;
  if (!extractJsonStringField(json, key, temp)) return false;
  unsigned long long val = strtoull(temp.c_str(), nullptr, 10);
  out = (uint64_t)val;
  return true;
}

static bool extractJsonBoolField(const std::string &json, const char *key, bool &out) {
  std::string temp;
  if (!extractJsonStringField(json, key, temp)) return false;
  std::string raw = lowerCopy(trimCopy(temp));
  if (raw == "true" || raw == "1" || raw == "yes" || raw == "on") {
    out = true;
    return true;
  }
  if (raw == "false" || raw == "0" || raw == "no" || raw == "off") {
    out = false;
    return true;
  }
  return false;
}

static bool extractJsonObjectField(const std::string &json, const char *key, std::string &out) {
  if (!key || !key[0]) return false;
  const std::string pattern = std::string("\"") + key + "\"";
  size_t pos = json.find(pattern);
  if (pos == std::string::npos) return false;
  pos = json.find(':', pos + pattern.size());
  if (pos == std::string::npos) return false;
  pos++;
  while (pos < json.size() && isspace((unsigned char)json[pos])) pos++;
  if (pos >= json.size() || json[pos] != '{') return false;
  size_t start = pos;
  int depth = 0;
  for (; pos < json.size(); pos++) {
    if (json[pos] == '{') depth++;
    else if (json[pos] == '}') {
      depth--;
      if (depth == 0) {
        out = json.substr(start, pos - start + 1);
        return true;
      }
    }
  }
  return false;
}

static bool extractNameFromConfig(const std::string &value, std::string &out) {
  std::string trimmed = trimCopy(value);
  if (trimmed.empty()) return false;
  if (trimmed.front() == '{') {
    if (extractJsonStringField(trimmed, "name", out)) return true;
  }

  size_t pos = trimmed.find("name");
  if (pos != std::string::npos) {
    size_t sep = trimmed.find_first_of("=:", pos + 4);
    if (sep != std::string::npos) {
      sep++;
      while (sep < trimmed.size() && isspace((unsigned char)trimmed[sep])) sep++;
      size_t end = sep;
      while (end < trimmed.size() && trimmed[end] != ';' && trimmed[end] != ',' && trimmed[end] != '\n') end++;
      out = trimCopy(trimmed.substr(sep, end - sep));
      if (!out.empty()) {
        if (out.size() >= 2 && ((out.front() == '"' && out.back() == '"') || (out.front() == '\'' && out.back() == '\''))) {
          out = out.substr(1, out.size() - 2);
        }
        return !out.empty();
      }
    }
  }

  out = trimmed;
  if (out.size() >= 2 && ((out.front() == '"' && out.back() == '"') || (out.front() == '\'' && out.back() == '\''))) {
    out = out.substr(1, out.size() - 2);
  }
  return !out.empty();
}

static bool applyBleNameUpdate(const std::string &requested, std::string &applied) {
  std::string clean = sanitizeName(requested);
  if (clean.empty()) {
    Serial.println("[BLE] Name ignore (vide ou invalide)");
    return false;
  }
  setBleNameBuffers(clean);
  NimBLEDevice::setDeviceName(bleName);
  refreshAdvertising();
  deviceConfig.name = clean;
  saveConfig();
  applied = clean;
  Serial.print("[BLE] Name updated=");
  Serial.println(bleName);
  return true;
}

static std::string buildConfigJson() {
  std::string out = "{\"config\":{";
  bool first = true;
  auto addField = [&](const char *key, const std::string &value) {
    if (value.empty()) return;
    if (!first) out += ",";
    out += "\"";
    out += key;
    out += "\":\"";
    out += escapeJson(value);
    out += "\"";
    first = false;
  };
  auto addNum = [&](const char *key, int value) {
    if (!first) out += ",";
    char buf[24];
    snprintf(buf, sizeof(buf), "%d", value);
    out += "\"";
    out += key;
    out += "\":";
    out += buf;
    first = false;
  };
  auto addNumU32 = [&](const char *key, uint32_t value) {
    if (!first) out += ",";
    char buf[24];
    snprintf(buf, sizeof(buf), "%u", (unsigned int)value);
    out += "\"";
    out += key;
    out += "\":";
    out += buf;
    first = false;
  };
  auto addBool = [&](const char *key, bool value) {
    if (!first) out += ",";
    out += "\"";
    out += key;
    out += "\":";
    out += value ? "true" : "false";
    first = false;
  };

  addField("name", deviceConfig.name);
  addField("sensor", deviceConfig.sensor);
  addNumU32("frequency", deviceConfig.frequencyMs);
  addBool("store_flash", deviceConfig.storeFlash);

  if (deviceConfig.i2cSda >= 0 || deviceConfig.i2cScl >= 0) {
    if (!first) out += ",";
    out += "\"i2c\":{";
    bool innerFirst = true;
    if (deviceConfig.i2cSda >= 0) {
      if (!innerFirst) out += ",";
      out += "\"sda\":";
      out += String(deviceConfig.i2cSda).c_str();
      innerFirst = false;
    }
    if (deviceConfig.i2cScl >= 0) {
      if (!innerFirst) out += ",";
      out += "\"scl\":";
      out += String(deviceConfig.i2cScl).c_str();
      innerFirst = false;
    }
    out += "}";
    first = false;
  }

  if (deviceConfig.onewirePin >= 0) {
    if (!first) out += ",";
    out += "\"onewire\":{\"pin\":";
    out += String(deviceConfig.onewirePin).c_str();
    out += "}";
    first = false;
  }
  if (deviceConfig.analogPin >= 0) {
    if (!first) out += ",";
    out += "\"analog\":{\"pin\":";
    out += String(deviceConfig.analogPin).c_str();
    out += "}";
    first = false;
  }
  if (deviceConfig.digitalPin >= 0) {
    if (!first) out += ",";
    out += "\"digital\":{\"pin\":";
    out += String(deviceConfig.digitalPin).c_str();
    out += "}";
    first = false;
  }
  if (deviceConfig.buttonPin >= 0) {
    if (!first) out += ",";
    out += "\"button\":{\"pin\":";
    out += String(deviceConfig.buttonPin).c_str();
    out += "}";
    first = false;
  }
  if (deviceConfig.neopixelPin >= 0) {
    if (!first) out += ",";
    out += "\"neopixel\":{\"pin\":";
    out += String(deviceConfig.neopixelPin).c_str();
    out += "}";
    first = false;
  }

  std::string flashJson;
  if (buildFlashJson(flashJson, true)) {
    if (!first) out += ",";
    out += flashJson;
    first = false;
  }

  out += "}}";
  return out;
}

static void sendConfigPayload() {
  if (!txChar) return;
  const std::string payload = buildConfigJson();
  Serial.print("[BLE] TX: ");
  Serial.println(payload.c_str());
  txChar->setValue(payload);
  txChar->notify();
}

static void sendFlashStatus() {
  if (!txChar) return;
  std::string flashJson;
  if (!buildFlashJson(flashJson, false)) {
    sendFlashAck("flash_status", "error", "Flash indisponible");
    return;
  }
  std::string payload = "{";
  payload += flashJson;
  payload += "}";
  Serial.print("[BLE] TX: ");
  Serial.println(payload.c_str());
  if (DEBUG_VERBOSE) {
    Serial.print("[FLASH] Status bytes=");
    Serial.println((unsigned int)payload.size());
  }
  txChar->setValue(payload);
  txChar->notify();
}

static void sendCsvPayload(const std::string &csv) {
  if (!txChar) return;
  std::string payload = "{\"csv\":\"";
  payload += escapeJson(csv);
  payload += "\"}";
  Serial.print("[BLE] TX CSV bytes=");
  Serial.println(payload.size());
  if (DEBUG_VERBOSE) {
    Serial.print("[CSV] Inline payload bytes=");
    Serial.print((unsigned int)payload.size());
    Serial.print(" data=");
    Serial.println((unsigned int)csv.size());
  }
  txChar->setValue(payload);
  txChar->notify();
}

static void sendProfilesForSensor(const std::string &sensor) {
  if (!txChar) return;
  std::string payload = "{\"profiles\":{";
  bool first = true;
  auto addProfile = [&](const char *key, const char *label, const char *unit, int minVal, int maxVal) {
    if (!first) payload += ",";
    payload += "\"";
    payload += key;
    payload += "\":{\"label\":\"";
    payload += label;
    payload += "\",\"unit\":\"";
    payload += unit;
    payload += "\",\"min\":";
    payload += std::to_string(minVal);
    payload += ",\"max\":";
    payload += std::to_string(maxVal);
    payload += "}";
    first = false;
  };

  if (sensor == "i2c") {
    addProfile("temperature", "Temperature", "C", -10, 50);
    addProfile("pressure", "Pression", "hPa", 900, 1100);
  } else if (sensor == "onewire") {
    addProfile("temperature", "Temperature", "C", -10, 50);
  } else {
    addProfile("generic", "Valeur", "", 0, 100);
  }
  payload += "}}";
  Serial.print("[BLE] TX: ");
  Serial.println(payload.c_str());
  txChar->setValue(payload);
  txChar->notify();
}

static bool ensureLogFile() {
  if (!ensureLittleFS()) return false;
  const bool ok = csvLogger.begin(true);
  if (DEBUG_VERBOSE && ok) {
    Serial.print("[FLASH] Log ready at ");
    Serial.println(LOG_PATH);
  }
  return ok;
}

static void flashClear() {
  if (!ensureLittleFS()) return;
  if (LittleFS.exists(LOG_PATH)) {
    LittleFS.remove(LOG_PATH);
    if (DEBUG_VERBOSE) {
      Serial.print("[FLASH] Log file cleared (");
      Serial.print(LOG_PATH);
      Serial.println(")");
    }
  } else {
    if (DEBUG_VERBOSE) {
      Serial.print("[FLASH] Log file not found (");
      Serial.print(LOG_PATH);
      Serial.println(")");
    }
  }
}

static size_t estimateLineBytes() {
  const std::string sensor = normalizeSensor(deviceConfig.sensor);
  if (sensor == "i2c") return 32;
  return 24;
}

static void applyTimeSync(uint64_t epochMs) {
  epochOffsetMs = (int64_t)epochMs - (int64_t)millis();
  timeSynced = true;
  if (DEBUG_VERBOSE) {
    Serial.print("[TIME] Sync epoch_ms=");
    Serial.print((unsigned long long)epochMs);
    Serial.print(" offset=");
    Serial.println((long long)epochOffsetMs);
  }
}

static void applyTzOffset(int32_t offsetMin) {
  tzOffsetMin = offsetMin;
  if (DEBUG_VERBOSE) {
    Serial.print("[TIME] TZ offset min=");
    Serial.println(tzOffsetMin);
  }
}

static uint64_t currentEpochMs() {
  if (!timeSynced) return (uint64_t)millis();
  int64_t now = epochOffsetMs + (int64_t)millis();
  if (now < 0) return 0;
  return (uint64_t)now;
}

static uint64_t currentLocalMs() {
  int64_t local = (int64_t)currentEpochMs() - (int64_t)tzOffsetMin * 60000LL;
  if (local < 0) return 0;
  return (uint64_t)local;
}

static void formatTimestamp(uint64_t epochMs, char *out, size_t outLen) {
  if (!out || outLen == 0) return;
  time_t seconds = (time_t)(epochMs / 1000ULL);
  struct tm tmInfo;
  gmtime_r(&seconds, &tmInfo);
  int year = (tmInfo.tm_year + 1900) % 100;
  snprintf(out, outLen, "%02d/%02d/%02d %02d:%02d:%02d",
           tmInfo.tm_mday, tmInfo.tm_mon + 1, year,
           tmInfo.tm_hour, tmInfo.tm_min, tmInfo.tm_sec);
}

static void flashLog(float v1, float v2) {
  if (!deviceConfig.storeFlash) return;
  if (csvExportInProgress) return;
  if (!ensureLogFile()) return;
  char tsBuf[24];
  char v1buf[16];
  char v2buf[16];
  formatTimestamp(currentLocalMs(), tsBuf, sizeof(tsBuf));
  snprintf(v1buf, sizeof(v1buf), "%.2f", v1);
  if (isfinite(v2)) {
    snprintf(v2buf, sizeof(v2buf), "%.2f", v2);
  } else {
    v2buf[0] = '\0';
  }
  csvLogger.appendRow(tsBuf, v1buf, v2buf);
  if (DEBUG_VERBOSE) {
    Serial.print("[FLASH] Log ts=");
    Serial.print(tsBuf);
    Serial.print(" v1=");
    Serial.print(v1, 2);
    Serial.print(" v2=");
    if (isfinite(v2)) {
      Serial.println(v2, 2);
    } else {
      Serial.println("nan");
    }
  }
}

static std::string readFlashCsv() {
  if (!ensureLittleFS()) return std::string(LOG_HEADER) + "\n";
  if (!LittleFS.exists(LOG_PATH)) return std::string(LOG_HEADER) + "\n";
  File file = LittleFS.open(LOG_PATH, "r");
  if (!file) return std::string(LOG_HEADER) + "\n";
  std::string out;
  out.reserve(file.size() + 16);
  while (file.available()) {
    out.push_back((char)file.read());
  }
  file.close();
  return out;
}

static size_t csvChunkBytes() {
  const uint16_t mtu = bleMtu ? bleMtu : NimBLEDevice::getMTU();
  const size_t maxPayload = mtu > 3 ? (size_t)(mtu - 3) : 20;
  // Conservative overhead to avoid MTU overflow with JSON + escaping.
  const size_t overhead = 90;
  if (maxPayload <= overhead + 8) return 0;
  size_t chunk = maxPayload - overhead;
  if (chunk > 96) chunk = 96;
  return chunk;
}

static void sendCsvChunk(uint32_t exportId, uint32_t seq, uint32_t totalBytes, bool last, const std::string &chunk) {
  if (!txChar) return;
  std::string payload = "{\"csv_chunk\":{\"seq\":";
  payload += std::to_string(seq);
  payload += ",\"id\":";
  payload += std::to_string(exportId);
  payload += ",\"total\":";
  payload += std::to_string(totalBytes);
  payload += ",\"last\":";
  payload += last ? "true" : "false";
  payload += ",\"data\":\"";
  payload += escapeJson(chunk);
  payload += "\"}}";
  Serial.print("[BLE] TX CSV chunk=");
  Serial.print(seq);
  Serial.print(" bytes=");
  Serial.println(payload.size());
  if (DEBUG_VERBOSE) {
    Serial.print("[CSV] Chunk seq=");
    Serial.print((unsigned long)seq);
    Serial.print(" last=");
    Serial.print(last ? "true" : "false");
    Serial.print(" data=");
    Serial.print((unsigned int)chunk.size());
    Serial.print(" total=");
    Serial.print((unsigned long)totalBytes);
    Serial.print(" id=");
    Serial.print((unsigned long)exportId);
    Serial.print(" payload=");
    Serial.println((unsigned int)payload.size());
  }
  txChar->setValue(payload);
  txChar->notify();
}

static void sendCsvFromFlash() {
  LOGVLN("[CSV] Export requested");
  if (csvStreamActive) return;
  csvExportInProgress = true;
  csvExportStartedAt = millis();
  csvStreamId = ++csvExportId;
  csvStreamSeq = 0;
  csvStreamLastSent = 0;
  csvStreamLastAck = 0;
  csvStreamAllSent = false;
  csvAwaitAck = false;
  csvStreamLastActivityMs = millis();

  if (!ensureLogFile()) {
    sendFlashAck("flash_export", "error", "Flash indisponible");
    endCsvStream();
    return;
  }
  File sizeFile = LittleFS.open(LOG_PATH, "r");
  size_t totalBytes = 0;
  if (sizeFile) {
    totalBytes = sizeFile.size();
    sizeFile.close();
  }
  const uint16_t mtu = bleMtu ? bleMtu : NimBLEDevice::getMTU();
  const size_t maxPayload = mtu > 3 ? (size_t)(mtu - 3) : 20;
  if (totalBytes > 0 && totalBytes <= 900) {
    File inlineFile = LittleFS.open(LOG_PATH, "r");
    if (inlineFile) {
      std::string csv;
      csv.reserve(totalBytes + 8);
      while (inlineFile.available()) {
        csv.push_back((char)inlineFile.read());
      }
      inlineFile.close();
      std::string payload = "{\"csv\":\"";
      payload += escapeJson(csv);
      payload += "\"}";
      if (payload.size() <= maxPayload) {
        if (DEBUG_VERBOSE) {
          Serial.print("[CSV] Inline send bytes=");
          Serial.println((unsigned int)payload.size());
        }
        sendCsvPayload(csv);
        endCsvStream();
        return;
      }
    }
  }

  csvStreamFile = LittleFS.open(LOG_PATH, "r");
  if (!csvStreamFile) {
    sendFlashAck("flash_export", "error", "Lecture flash impossible");
    endCsvStream();
    return;
  }
  if (DEBUG_VERBOSE) {
    Serial.print("[CSV] Stream start id=");
    Serial.println((unsigned long)csvStreamId);
  }
  csvStreamActive = true;
  sendNextCsvBlock();
}

static void sendNextCsvBlock() {
  if (!csvStreamActive || csvAwaitAck || !txChar) return;
  if (!csvStreamFile) {
    endCsvStream();
    return;
  }
  if (!csvStreamFile.available() && !csvHasPendingLine) {
    endCsvStream();
    return;
  }
  const uint16_t mtu = bleMtu ? bleMtu : NimBLEDevice::getMTU();
  const size_t maxPayload = mtu > 3 ? (size_t)(mtu - 3) : 20;
  std::string block;
  bool last = false;
  while (csvStreamFile.available() || csvHasPendingLine) {
    std::string line;
    if (csvHasPendingLine) {
      line = csvPendingLine;
      csvPendingLine.clear();
      csvHasPendingLine = false;
    } else {
      String raw = csvStreamFile.readStringUntil('\n');
      raw.trim();
      if (raw.length() == 0) {
        if (!csvStreamFile.available()) last = true;
        if (last && block.empty()) break;
        if (last) break;
        continue;
      }
      line = std::string(raw.c_str());
    }

    std::string candidate = block.empty() ? line : block + "\n" + line;
    const bool candidateLast = !csvStreamFile.available() && !csvHasPendingLine;
    std::string payload = "{\"csv_block\":{\"id\":";
    payload += std::to_string(csvStreamId);
    payload += ",\"seq\":";
    payload += std::to_string(csvStreamSeq);
    payload += ",\"last\":";
    payload += candidateLast ? "true" : "false";
    payload += ",\"data\":\"";
    payload += escapeJson(candidate);
    payload += "\"}}";

    if (payload.size() <= maxPayload) {
      block = candidate;
      last = candidateLast;
      if (candidateLast) break;
      continue;
    }

    if (block.empty()) {
      block = candidate;
      last = candidateLast;
    } else {
      csvPendingLine = line;
      csvHasPendingLine = true;
      last = false;
    }
    break;
  }

  if (block.empty()) {
    endCsvStream();
    return;
  }

  std::string payload = "{\"csv_block\":{\"id\":";
  payload += std::to_string(csvStreamId);
  payload += ",\"seq\":";
  payload += std::to_string(csvStreamSeq);
  payload += ",\"last\":";
  payload += last ? "true" : "false";
  payload += ",\"data\":\"";
  payload += escapeJson(block);
  payload += "\"}}";
  Serial.print("[BLE] TX CSV block=");
  Serial.print(csvStreamSeq);
  Serial.print(" bytes=");
  Serial.println(payload.size());
  txChar->setValue(payload);
  txChar->notify();
  csvStreamLastActivityMs = millis();
  csvStreamLastSent = csvStreamSeq;
  csvStreamSeq++;
  if (last) {
    csvStreamAllSent = true;
  }
  if (csvStreamAllSent || (csvStreamLastSent - csvStreamLastAck + 1) >= CSV_ACK_WINDOW) {
    csvAwaitAck = true;
  } else {
    // Send next block immediately if window allows.
    sendNextCsvBlock();
  }
}

static void endCsvStream() {
  if (csvStreamFile) {
    csvStreamFile.close();
  }
  csvStreamActive = false;
  csvAwaitAck = false;
  csvExportInProgress = false;
  csvExportStartedAt = 0;
  csvHasPendingLine = false;
  csvPendingLine.clear();
  csvStreamLastAck = 0;
  csvStreamAllSent = false;
  csvStreamLastActivityMs = 0;
}

static void dumpCsvToSerial() {
  if (serialDumpInProgress) return;
  serialDumpInProgress = true;
  csvExportInProgress = true;
  if (!ensureLogFile()) {
    Serial.println("CSV_ERROR");
    serialDumpInProgress = false;
    csvExportInProgress = false;
    return;
  }
  File file = LittleFS.open(LOG_PATH, "r");
  if (!file) {
    Serial.println("CSV_ERROR");
    serialDumpInProgress = false;
    csvExportInProgress = false;
    return;
  }
  Serial.println("CSV_BEGIN");
  Serial.print("CSV_SIZE:");
  Serial.println((unsigned long)file.size());
  char buf[128];
  while (file.available()) {
    size_t n = file.readBytes(buf, sizeof(buf));
    if (n > 0) Serial.write((uint8_t *)buf, n);
  }
  file.close();
  Serial.println();
  Serial.println("CSV_END");
  serialDumpInProgress = false;
  csvExportInProgress = false;
}

static void handleSerialCommands() {
  static String cmd;
  while (Serial.available()) {
    char c = (char)Serial.read();
    if (c == '\n' || c == '\r') {
      cmd.trim();
      if (cmd.length() > 0) {
        if (cmd == "CSV_DUMP") {
          dumpCsvToSerial();
        }
      }
      cmd = "";
    } else {
      if (cmd.length() < 64) {
        cmd += c;
      }
    }
  }
}

static void applyI2cConfig() {
  int sda = deviceConfig.i2cSda >= 0 ? deviceConfig.i2cSda : I2C_SDA;
  int scl = deviceConfig.i2cScl >= 0 ? deviceConfig.i2cScl : I2C_SCL;
  Wire.begin(sda, scl);
  Wire.setClock(400000);
  scanSensors();
}

static void clearOneWire() {
  if (ds18b20) {
    delete ds18b20;
    ds18b20 = nullptr;
  }
  if (oneWire) {
    delete oneWire;
    oneWire = nullptr;
  }
}

static void initOneWire() {
  clearOneWire();
  if (deviceConfig.onewirePin < 0) return;
  oneWire = new OneWire(deviceConfig.onewirePin);
  ds18b20 = new DallasTemperature(oneWire);
  ds18b20->begin();
}

static void applySensorMode() {
  const std::string sensor = normalizeSensor(deviceConfig.sensor);
  if (sensor == "i2c") {
    clearOneWire();
    applyI2cConfig();
    return;
  }
  clearSensors();
  if (sensor == "onewire") {
    initOneWire();
  } else {
    clearOneWire();
  }
  if (sensor == "digital" && deviceConfig.digitalPin >= 0) {
    pinMode(deviceConfig.digitalPin, INPUT);
  }
}

static void updateRecordingLed() {
  if (!neoPixel) return;
  if (deviceConfig.storeFlash) {
    neoPixel->setPixelColor(0, neoPixel->Color(255, 0, 0));
  } else {
    neoPixel->setPixelColor(0, 0);
  }
  neoPixel->show();
}

static void applyUserIo() {
  if (deviceConfig.buttonPin >= 0) {
    pinMode(deviceConfig.buttonPin, INPUT_PULLUP);
    buttonLastRead = digitalRead(deviceConfig.buttonPin);
    buttonStableState = buttonLastRead;
    buttonLastChangeMs = millis();
  } else {
    buttonLastRead = HIGH;
    buttonStableState = HIGH;
    buttonLastChangeMs = millis();
  }

  if (neoPixel) {
    neoPixel->clear();
    neoPixel->show();
    delete neoPixel;
    neoPixel = nullptr;
  }
  neoPixelPin = -1;
  if (deviceConfig.neopixelPin >= 0) {
    neoPixel = new Adafruit_NeoPixel(NEOPIXEL_COUNT, deviceConfig.neopixelPin, NEO_GRB + NEO_KHZ800);
    neoPixel->begin();
    neoPixel->setBrightness(NEOPIXEL_BRIGHTNESS);
    neoPixel->clear();
    neoPixel->show();
    neoPixelPin = deviceConfig.neopixelPin;
  }
  updateRecordingLed();
}

static void handleButtonInput() {
  if (deviceConfig.buttonPin < 0) return;
  const uint32_t now = millis();
  int reading = digitalRead(deviceConfig.buttonPin);
  if (reading != buttonLastRead) {
    buttonLastChangeMs = now;
    buttonLastRead = reading;
  }
  if ((now - buttonLastChangeMs) > BUTTON_DEBOUNCE_MS && reading != buttonStableState) {
    buttonStableState = reading;
    if (buttonStableState == LOW) {
      deviceConfig.storeFlash = !deviceConfig.storeFlash;
      saveConfig();
      updateRecordingLed();
      if (connectedCount > 0) {
        sendConfigPayload();
        sendFlashStatus();
      }
    }
  }
}

static bool applyConfigUpdate(const ConfigUpdate &update) {
  bool changed = false;
  bool modeTouched = false;
  bool ioTouched = false;

  if (update.hasName) {
    std::string applied;
    if (applyBleNameUpdate(update.name, applied)) {
      deviceConfig.name = applied;
      changed = true;
    }
  }
  if (update.hasSensor) {
    deviceConfig.sensor = normalizeSensor(update.sensor);
    changed = true;
    modeTouched = true;
  }
  if (update.hasI2c) {
    if (update.i2cSda >= 0) deviceConfig.i2cSda = update.i2cSda;
    if (update.i2cScl >= 0) deviceConfig.i2cScl = update.i2cScl;
    changed = true;
    modeTouched = true;
  }
  if (update.hasOneWire) {
    deviceConfig.onewirePin = update.onewirePin;
    changed = true;
    modeTouched = true;
  }
  if (update.hasAnalog) {
    deviceConfig.analogPin = update.analogPin;
    changed = true;
    modeTouched = true;
  }
  if (update.hasDigital) {
    deviceConfig.digitalPin = update.digitalPin;
    changed = true;
    modeTouched = true;
  }
  if (update.hasButton) {
    deviceConfig.buttonPin = update.buttonPin;
    changed = true;
    ioTouched = true;
  }
  if (update.hasNeoPixel) {
    deviceConfig.neopixelPin = update.neopixelPin;
    changed = true;
    ioTouched = true;
  }
  if (update.hasFrequency) {
    deviceConfig.frequencyMs = update.frequencyMs ? update.frequencyMs : 1000;
    sensorIntervalMs = deviceConfig.frequencyMs;
    changed = true;
  }
  if (update.hasStoreFlash) {
    deviceConfig.storeFlash = update.storeFlash;
    changed = true;
    updateRecordingLed();
  }

  if (modeTouched) {
    applySensorMode();
    if (connectedCount > 0) {
      sendProfilesForSensor(normalizeSensor(deviceConfig.sensor));
    }
  }
  if (ioTouched) {
    applyUserIo();
  }

  if (changed) saveConfig();
  return changed;
}

static ConfigUpdate parseConfigUpdate(const std::string &value) {
  ConfigUpdate update;
  const std::string trimmed = trimCopy(value);
  if (trimmed.empty()) return update;

  if (!trimmed.empty() && trimmed.front() == '{') {
    std::string action;
    if (extractJsonStringField(trimmed, "action", action)) {
      update.hasAction = true;
      update.action = lowerCopy(action);
      extractJsonStringField(trimmed, "format", update.format);
    }

    uint64_t epochMs = 0;
    if (extractJsonNumberFieldU64(trimmed, "epoch_ms", epochMs)
        || extractJsonNumberFieldU64(trimmed, "epoch", epochMs)
        || extractJsonNumberFieldU64(trimmed, "time_ms", epochMs)
        || extractJsonNumberFieldU64(trimmed, "timestamp", epochMs)) {
      update.hasEpochMs = true;
      update.epochMs = epochMs;
    }

    int tzMin = 0;
    if (extractJsonNumberField(trimmed, "tz_offset_min", tzMin)
        || extractJsonNumberField(trimmed, "tzOffsetMin", tzMin)
        || extractJsonNumberField(trimmed, "tz", tzMin)) {
      update.hasTzOffset = true;
      update.tzOffsetMin = tzMin;
    }

    if (update.hasAction && update.action == "csv_ack") {
      uint32_t ackId = 0;
      uint32_t ackSeq = 0;
      bool got = false;
      if (extractJsonNumberFieldU32(trimmed, "id", ackId)
          || extractJsonNumberFieldU32(trimmed, "export_id", ackId)
          || extractJsonNumberFieldU32(trimmed, "exportId", ackId)) {
        update.csvAckId = ackId;
        got = true;
      }
      if (extractJsonNumberFieldU32(trimmed, "seq", ackSeq)) {
        update.csvAckSeq = ackSeq;
        got = true;
      }
      update.hasCsvAck = got;
    }

    if (extractJsonStringField(trimmed, "name", update.name)) update.hasName = true;

    std::string sensor;
    if (extractJsonStringField(trimmed, "sensor", sensor) || extractJsonStringField(trimmed, "type", sensor)) {
      update.hasSensor = true;
      update.sensor = sensor;
    }

    uint32_t freq = 0;
    if (extractJsonNumberFieldU32(trimmed, "frequency", freq)
        || extractJsonNumberFieldU32(trimmed, "freq", freq)
        || extractJsonNumberFieldU32(trimmed, "interval", freq)
        || extractJsonNumberFieldU32(trimmed, "period", freq)) {
      update.hasFrequency = true;
      update.frequencyMs = freq;
    }

    bool storeFlash = false;
    if (extractJsonBoolField(trimmed, "store_flash", storeFlash)
        || extractJsonBoolField(trimmed, "storeFlash", storeFlash)
        || extractJsonBoolField(trimmed, "save", storeFlash)
        || extractJsonBoolField(trimmed, "flash", storeFlash)) {
      update.hasStoreFlash = true;
      update.storeFlash = storeFlash;
    }

    std::string i2cObj;
    if (extractJsonObjectField(trimmed, "i2c", i2cObj)) {
      int sda = -1;
      int scl = -1;
      bool has = false;
      if (extractJsonNumberField(i2cObj, "sda", sda)) {
        update.i2cSda = sda;
        has = true;
      }
      if (extractJsonNumberField(i2cObj, "scl", scl)) {
        update.i2cScl = scl;
        has = true;
      }
      if (has) update.hasI2c = true;
    } else {
      int sda = -1;
      int scl = -1;
      bool has = false;
      if (extractJsonNumberField(trimmed, "sda", sda)) {
        update.i2cSda = sda;
        has = true;
      }
      if (extractJsonNumberField(trimmed, "scl", scl)) {
        update.i2cScl = scl;
        has = true;
      }
      if (has) update.hasI2c = true;
    }

    std::string oneObj;
    if (extractJsonObjectField(trimmed, "onewire", oneObj) || extractJsonObjectField(trimmed, "one_wire", oneObj)) {
      int pin = -1;
      if (extractJsonNumberField(oneObj, "pin", pin)) {
        update.hasOneWire = true;
        update.onewirePin = pin;
      }
    } else {
      int pin = -1;
      if (extractJsonNumberField(trimmed, "onewire", pin) || extractJsonNumberField(trimmed, "one_wire", pin)) {
        update.hasOneWire = true;
        update.onewirePin = pin;
      }
    }

    std::string analogObj;
    if (extractJsonObjectField(trimmed, "analog", analogObj)) {
      int pin = -1;
      if (extractJsonNumberField(analogObj, "pin", pin)) {
        update.hasAnalog = true;
        update.analogPin = pin;
      }
    } else {
      int pin = -1;
      if (extractJsonNumberField(trimmed, "analog", pin)) {
        update.hasAnalog = true;
        update.analogPin = pin;
      }
    }

    std::string digitalObj;
    if (extractJsonObjectField(trimmed, "digital", digitalObj)) {
      int pin = -1;
      if (extractJsonNumberField(digitalObj, "pin", pin)) {
        update.hasDigital = true;
        update.digitalPin = pin;
      }
    } else {
      int pin = -1;
      if (extractJsonNumberField(trimmed, "digital", pin)) {
        update.hasDigital = true;
        update.digitalPin = pin;
      }
    }

    std::string buttonObj;
    if (extractJsonObjectField(trimmed, "button", buttonObj)) {
      int pin = -1;
      if (extractJsonNumberField(buttonObj, "pin", pin)) {
        update.hasButton = true;
        update.buttonPin = pin;
      }
    } else {
      int pin = -1;
      if (extractJsonNumberField(trimmed, "button", pin)
          || extractJsonNumberField(trimmed, "button_pin", pin)) {
        update.hasButton = true;
        update.buttonPin = pin;
      }
    }

    std::string neoObj;
    if (extractJsonObjectField(trimmed, "neopixel", neoObj) || extractJsonObjectField(trimmed, "neo", neoObj)) {
      int pin = -1;
      if (extractJsonNumberField(neoObj, "pin", pin)) {
        update.hasNeoPixel = true;
        update.neopixelPin = pin;
      }
    } else {
      int pin = -1;
      if (extractJsonNumberField(trimmed, "neopixel", pin)
          || extractJsonNumberField(trimmed, "neopixel_pin", pin)
          || extractJsonNumberField(trimmed, "neo", pin)) {
        update.hasNeoPixel = true;
        update.neopixelPin = pin;
      }
    }

    return update;
  }

  std::string name;
  if (extractNameFromConfig(trimmed, name)) {
    update.hasName = true;
    update.name = name;
  }

  return update;
}

static void printBootInfo() {
  Serial.println();
  Serial.println("[BOOT] Minimal debug + BLE UART");

#if defined(ARDUINO_ARCH_ESP32)
  esp_chip_info_t chipInfo;
  esp_chip_info(&chipInfo);
  Serial.print("[CHIP] Cores=");
  Serial.print(chipInfo.cores);
  Serial.print(" Features=0x");
  Serial.println((unsigned int)chipInfo.features, HEX);

  Serial.print("[CHIP] Revision=");
  Serial.println(chipInfo.revision);

  Serial.print("[RESET] Reason=");
  Serial.println((int)esp_reset_reason());
#endif

  Serial.print("[HEAP] Free=");
  Serial.println(ESP.getFreeHeap());
}

static bool i2cPresent(uint8_t addr) {
  Wire.beginTransmission(addr);
  return Wire.endTransmission() == 0;
}

static void i2cScan() {
  Serial.println("[I2C] Scan...");
  int found = 0;
  for (uint8_t addr = 0x03; addr < 0x78; addr++) {
    if (i2cPresent(addr)) {
      Serial.print("[I2C] Found 0x");
      if (addr < 16) Serial.print("0");
      Serial.println(addr, HEX);
      found++;
    }
  }
  if (found == 0) {
    Serial.println("[I2C] Aucun peripherique detecte");
  }
}

static void clearSensors() {
  if (bmp280) {
    delete bmp280;
    bmp280 = nullptr;
  }
  if (ms5611) {
    delete ms5611;
    ms5611 = nullptr;
  }
  bmpAddr = 0;
  msAddr = 0;
}

static bool tryMs5611(uint8_t addr) {
  if (!i2cPresent(addr) || ms5611) return false;
  ms5611 = new MS5611(addr);
  if (ms5611->begin()) {
    msAddr = addr;
    Serial.print("[I2C] MS5611 (GY63) detecte a 0x");
    if (addr < 16) Serial.print("0");
    Serial.println(addr, HEX);
    return true;
  }
  delete ms5611;
  ms5611 = nullptr;
  return false;
}

static bool tryBmp280(uint8_t addr) {
  if (!i2cPresent(addr) || bmp280 || msAddr == addr) return false;
  bmp280 = new Adafruit_BMP280();
  if (bmp280->begin(addr)) {
    bmpAddr = addr;
    Serial.print("[I2C] BMP280 detecte a 0x");
    if (addr < 16) Serial.print("0");
    Serial.println(addr, HEX);
    bmp280->setSampling(
      Adafruit_BMP280::MODE_NORMAL,
      Adafruit_BMP280::SAMPLING_X2,
      Adafruit_BMP280::SAMPLING_X16,
      Adafruit_BMP280::FILTER_X16,
      Adafruit_BMP280::STANDBY_MS_500
    );
    return true;
  }
  delete bmp280;
  bmp280 = nullptr;
  return false;
}

static void scanSensors() {
  clearSensors();
  i2cScan();

  // Try MS5611 first on both possible addresses (0x77, sometimes 0x76)
  tryMs5611(I2C_ADDR_MS5611_A);
  tryMs5611(I2C_ADDR_MS5611_B);

  // Then try BMP280 on both addresses if not already taken by MS5611
  tryBmp280(I2C_ADDR_BMP280_A);
  tryBmp280(I2C_ADDR_BMP280_B);

  if (!bmp280 && !ms5611) {
    Serial.println("[I2C] Aucun capteur reconnu");
  }
}

static bool readBmp280(float &tempC, float &pressHpa) {
  if (!bmp280) return false;
  tempC = bmp280->readTemperature();
  pressHpa = bmp280->readPressure() / 100.0f;
  return isfinite(tempC) && isfinite(pressHpa);
}

static bool readMs5611(float &tempC, float &pressHpa) {
  if (!ms5611) return false;
  ms5611->read();
  tempC = ms5611->getTemperature();
  pressHpa = ms5611->getPressure();
  return isfinite(tempC) && isfinite(pressHpa);
}

static bool readOneWire(float &tempC) {
  if (!ds18b20) return false;
  ds18b20->requestTemperatures();
  float value = ds18b20->getTempCByIndex(0);
  if (value == DEVICE_DISCONNECTED_C || !isfinite(value)) return false;
  tempC = value;
  return true;
}

static const char *compactMetricKey(const char *key) {
  if (!key || !key[0]) return "";
  if (strcmp(key, "generic") == 0) return "g";
  if (strcmp(key, "temperature") == 0) return "t";
  if (strcmp(key, "pressure") == 0) return "p";
  if (strcmp(key, "humidity") == 0) return "h";
  return key;
}

static void sendMetricPayload(const char *sensor, const char *addr, const char *key1, float v1, const char *key2, float v2) {
  if (!txChar) return;
  char payload[220];
#if USE_COMPACT_METRICS
  const char *k1 = compactMetricKey(key1);
  const char *k2 = compactMetricKey(key2);
  char tsBuf[24] = {0};
  const bool haveTs = timeSynced;
  if (haveTs) {
    formatTimestamp(currentLocalMs(), tsBuf, sizeof(tsBuf));
  }
  if (key2) {
    if (haveTs) {
      snprintf(payload, sizeof(payload),
               "{\"m\":{\"%s\":%.2f,\"%s\":%.2f},\"ts\":\"%s\"}",
               k1, v1, k2, v2, tsBuf);
    } else {
      snprintf(payload, sizeof(payload),
               "{\"m\":{\"%s\":%.2f,\"%s\":%.2f}}",
               k1, v1, k2, v2);
    }
  } else {
    if (haveTs) {
      snprintf(payload, sizeof(payload),
               "{\"m\":{\"%s\":%.2f},\"ts\":\"%s\"}",
               k1, v1, tsBuf);
    } else {
      snprintf(payload, sizeof(payload),
               "{\"m\":{\"%s\":%.2f}}",
               k1, v1);
    }
  }
#else
  if (key2) {
    snprintf(payload, sizeof(payload),
             "{\"sensor\":\"%s\",\"addr\":\"%s\",\"name\":\"%s\",\"metrics\":{\"%s\":%.2f,\"%s\":%.2f}}",
             sensor, addr ? addr : "", bleName, key1, v1, key2, v2);
  } else {
    snprintf(payload, sizeof(payload),
             "{\"sensor\":\"%s\",\"addr\":\"%s\",\"name\":\"%s\",\"metrics\":{\"%s\":%.2f}}",
             sensor, addr ? addr : "", bleName, key1, v1);
  }
#endif
  Serial.print("[BLE] TX: ");
  Serial.println(payload);
  txChar->setValue(payload);
  txChar->notify();
}

class RxCallbacks : public NimBLECharacteristicCallbacks {
  void onWrite(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override {
    (void)connInfo;
    std::string value = pCharacteristic->getValue();
    if (value.empty()) return;
    Serial.print("[BLE] RX: ");
    Serial.println(value.c_str());
    ConfigUpdate update = parseConfigUpdate(value);

    if (update.hasAction) {
      if (update.action == "time_sync") {
        if (update.hasTzOffset) {
          applyTzOffset(update.tzOffsetMin);
        }
        if (update.hasEpochMs) {
          applyTimeSync(update.epochMs);
          sendFlashAck("time_sync", "ok", "Heure synchronisee");
        } else {
          sendFlashAck("time_sync", "error", "Timestamp manquant");
        }
        return;
      }
      if (update.action == "config_get") {
        sendConfigPayload();
        return;
      }
      if (update.action == "flash_clear") {
        flashClear();
        sendFlashAck("flash_clear", "ok", "Flash videe");
        sendFlashStatus();
        return;
      }
      if (update.action == "flash_export") {
        if (csvExportInProgress) {
          sendFlashAck("flash_export", "error", "Export en cours");
          return;
        }
        sendFlashAck("flash_export", "ok", "Export CSV");
        sendFlashStatus();
        sendCsvFromFlash();
        return;
      }
      if (update.action == "flash_stream") {
        if (csvExportInProgress) {
          sendFlashAck("flash_stream", "error", "Export en cours");
          return;
        }
        sendFlashAck("flash_stream", "ok", "Stream CSV");
        sendFlashStatus();
        sendCsvFromFlash();
        return;
      }
      if (update.action == "flash_stream_stop") {
        endCsvStream();
        sendFlashAck("flash_stream_stop", "ok", "Stream stop");
        return;
      }
      if (update.action == "csv_ack") {
        if (update.hasCsvAck && csvStreamActive && csvAwaitAck
            && update.csvAckId == csvStreamId
            && update.csvAckSeq == csvStreamLastSent) {
          if (update.csvAckSeq >= csvStreamLastAck) {
            csvStreamLastAck = update.csvAckSeq;
          }
          csvStreamLastActivityMs = millis();
          if (csvStreamAllSent && csvStreamLastAck >= csvStreamLastSent) {
            endCsvStream();
          } else {
            csvAwaitAck = false;
            sendNextCsvBlock();
          }
        }
        return;
      }
      if (update.action == "flash_status") {
        sendFlashStatus();
        sendConfigPayload();
        return;
      }
    }

    if (update.hasEpochMs) {
      applyTimeSync(update.epochMs);
    }
    if (update.hasTzOffset) {
      applyTzOffset(update.tzOffsetMin);
    }

    bool nameHandled = false;
    if (update.hasName) {
      std::string applied;
      if (applyBleNameUpdate(update.name, applied)) {
        deviceConfig.name = applied;
        sendNameAck("ok", applied, "");
      } else {
        sendNameAck("error", "", "Nom invalide");
      }
      update.hasName = false;
      nameHandled = true;
    }

    if (applyConfigUpdate(update)) {
      sendConfigAck("ok", "Config mise a jour");
      return;
    }

    if (nameHandled) return;
    sendConfigAck("error", "Config ignoree");
  }

  void onRead(NimBLECharacteristic *pCharacteristic, NimBLEConnInfo &connInfo) override {
    (void)connInfo;
    const std::string payload = buildConfigJson();
    pCharacteristic->setValue(payload);
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override {
    (void)pServer;
    connectedCount = bleServer ? bleServer->getConnectedCount() : 1;
    Serial.println("[BLE] Connected");
    bleMtu = connInfo.getMTU();
    Serial.print("[BLE] MTU=");
    Serial.println(bleMtu);
    Serial.print("[BLE] Connected count=");
    Serial.println(connectedCount);
    // Keep advertising to allow multiple centrals to connect
    NimBLEDevice::startAdvertising();
    sendProfilesForSensor(normalizeSensor(deviceConfig.sensor));
  }

  void onDisconnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo, int reason) override {
    (void)pServer;
    (void)connInfo;
    Serial.print("[BLE] Disconnected, reason=");
    Serial.println(reason);
    connectedCount = bleServer ? bleServer->getConnectedCount() : 0;
    bleMtu = 23;
    Serial.print("[BLE] Connected count=");
    Serial.println(connectedCount);
    const bool restarted = NimBLEDevice::startAdvertising();
    Serial.print("[BLE] Advertising restarted=");
    Serial.println(restarted ? "OK" : "FAIL");

    if (connectedCount == 0) {
      csvExportInProgress = false;
      csvExportStartedAt = 0;
      endCsvStream();
      bleResetPending = true;
      bleResetAt = millis() + 200;
      Serial.println("[BLE] Reset scheduled");
    }
  }

  void onMTUChange(uint16_t MTU, NimBLEConnInfo &connInfo) override {
    (void)connInfo;
    bleMtu = MTU;
    Serial.print("[BLE] MTU update=");
    Serial.println(bleMtu);
  }
};

static void bleInit() {
  NimBLEDevice::init("ESP32-H2");
  NimBLEDevice::setMTU(185);
  NimBLEDevice::setPower(ESP_PWR_LVL_P9);
  NimBLEAddress addr = NimBLEDevice::getAddress();
  std::string macStr = addr.toString(); // e.g. "aa:bb:cc:dd:ee:ff"
  std::string macHex;
  macHex.reserve(12);
  for (char c : macStr) {
    if (c != ':') macHex.push_back((char)toupper((unsigned char)c));
  }
  const size_t n = macHex.size();
  const std::string last6 = n >= 6 ? macHex.substr(n - 6) : macHex;
  const std::string last4 = n >= 4 ? macHex.substr(n - 4) : macHex;
  const std::string defaultName = std::string("ESP32-H2-") + last6;
  const std::string storedName = deviceConfig.name;
  if (!storedName.empty()) {
    setBleNameBuffers(storedName);
  } else {
    setBleNameBuffers(defaultName);
    deviceConfig.name = defaultName;
    saveConfig();
  }
  const std::string shortName = std::string("H2-") + last4;
  snprintf(bleNameShort, sizeof(bleNameShort), "%s", shortName.c_str());
  NimBLEDevice::setDeviceName(bleName);

  Serial.print("[BLE] Init done, name=");
  Serial.println(bleName);

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  NimBLEService *service = bleServer->createService(UUID_SERVICE);
  NimBLECharacteristic *rxChar = service->createCharacteristic(
      UUID_CONFIG, NIMBLE_PROPERTY::READ | NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
  txChar = service->createCharacteristic(
      UUID_DATA, NIMBLE_PROPERTY::NOTIFY);

  rxChar->setCallbacks(new RxCallbacks());
  service->start();
  Serial.println("[BLE] Service started");

  NimBLEAdvertising *adv = NimBLEDevice::getAdvertising();
  adv->setMinInterval(48); // 30 ms (0.625 ms units)
  adv->setMaxInterval(96); // 60 ms (0.625 ms units)
  NimBLEAdvertisementData advData;
  advData.setFlags(0x06); // LE General Discoverable + BR/EDR not supported
  advData.addServiceUUID(UUID_SERVICE);
  advData.setPreferredParams(24, 40); // 30-50 ms (1.25 ms units)
  advData.setName(bleNameShort);
  advData.addTxPower();

  NimBLEAdvertisementData scanData;
  scanData.setName(bleName);
  scanData.addTxPower();

  const bool advOk = adv->setAdvertisementData(advData);
  const bool scanOk = adv->setScanResponseData(scanData);
  adv->enableScanResponse(true);

  Serial.print("[BLE] Adv data set=");
  Serial.print(advOk ? "OK" : "FAIL");
  Serial.print(" ScanRsp set=");
  Serial.println(scanOk ? "OK" : "FAIL");

  const bool started = adv->start();
  Serial.print("[BLE] Advertising start=");
  Serial.println(started ? "OK" : "FAIL");
}

static void bleReset() {
  Serial.println("[BLE] Resetting stack...");
  NimBLEDevice::stopAdvertising();
  NimBLEDevice::deinit(true);
  delay(50);
  txChar = nullptr;
  bleServer = nullptr;
  connectedCount = 0;
  bleInit();
}

void setup() {
  Serial.begin(115200);
  delay(200);
#if defined(ARDUINO_USB_CDC_ON_BOOT) && ARDUINO_USB_CDC_ON_BOOT
  unsigned long start = millis();
  while (!Serial && (millis() - start) < 2000) {
    delay(10);
  }
#endif
  printBootInfo();
  ensureLittleFS();
  loadConfig();
  if (deviceConfig.i2cSda < 0) deviceConfig.i2cSda = I2C_SDA;
  if (deviceConfig.i2cScl < 0) deviceConfig.i2cScl = I2C_SCL;
  if (deviceConfig.sensor.empty()) deviceConfig.sensor = "i2c";
  sensorIntervalMs = deviceConfig.frequencyMs ? deviceConfig.frequencyMs : 1000;
#if defined(ARDUINO_ARCH_ESP32)
  randomSeed(esp_random());
#else
  randomSeed(micros());
#endif
  Serial.print("[I2C] SDA=");
  Serial.print(deviceConfig.i2cSda);
  Serial.print(" SCL=");
  Serial.println(deviceConfig.i2cScl);
  applySensorMode();
  applyUserIo();
  bleInit();
}

void loop() {
  handleSerialCommands();
  handleButtonInput();
  if (bleResetPending && (int32_t)(millis() - bleResetAt) >= 0) {
    bleResetPending = false;
    bleReset();
  }

  const uint32_t now = millis();
  if (!serialDumpInProgress && now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    Serial.print("[ALIVE] ms=");
    Serial.println(now);
  }

  if (csvStreamActive && csvStreamLastActivityMs && (now - csvStreamLastActivityMs) > 5000) {
    Serial.println("[CSV] Stream timeout, closing.");
    endCsvStream();
  }

  if (csvExportInProgress && connectedCount == 0 && csvExportStartedAt) {
    if (now - csvExportStartedAt > 5000) {
      csvExportInProgress = false;
      csvExportStartedAt = 0;
      Serial.println("[CSV] Export timeout (no connection).");
    }
  }

  if (now - lastScanMs >= RESCAN_INTERVAL_MS) {
    lastScanMs = now;
    if (!bmp280 && !ms5611 && deviceConfig.sensor == "i2c") {
      scanSensors();
    }
  }

  if (!csvExportInProgress
      && (connectedCount > 0 || deviceConfig.storeFlash)
      && (now - lastSensorMs) >= sensorIntervalMs) {
    lastSensorMs = now;
    const std::string sensor = normalizeSensor(deviceConfig.sensor);
    if (sensor == "i2c") {
      float tempC = 0.0f;
      float pressHpa = 0.0f;
      if (bmp280 && readBmp280(tempC, pressHpa)) {
        char addr[8];
        snprintf(addr, sizeof(addr), "0x%02X", bmpAddr);
        if (connectedCount > 0) {
          sendMetricPayload("bmp280", addr, "temperature", tempC, "pressure", pressHpa);
        }
        flashLog(tempC, pressHpa);
      }
      if (ms5611 && readMs5611(tempC, pressHpa)) {
        char addr[8];
        snprintf(addr, sizeof(addr), "0x%02X", msAddr);
        if (connectedCount > 0) {
          sendMetricPayload("gy63", addr, "temperature", tempC, "pressure", pressHpa);
        }
        flashLog(tempC, pressHpa);
      }
    } else if (sensor == "analog" && deviceConfig.analogPin >= 0) {
      int raw = analogRead(deviceConfig.analogPin);
      float value = (float)raw;
      if (connectedCount > 0) {
        sendMetricPayload("analog", "", "generic", value, nullptr, 0.0f);
      }
      flashLog(value, NAN);
    } else if (sensor == "digital" && deviceConfig.digitalPin >= 0) {
      int raw = digitalRead(deviceConfig.digitalPin);
      float value = (float)(raw ? 1 : 0);
      if (connectedCount > 0) {
        sendMetricPayload("digital", "", "generic", value, nullptr, 0.0f);
      }
      flashLog(value, NAN);
    } else if (sensor == "onewire" && deviceConfig.onewirePin >= 0) {
      float value = 0.0f;
      if (readOneWire(value)) {
        if (connectedCount > 0) {
          sendMetricPayload("onewire", "", "temperature", value, nullptr, 0.0f);
        }
        flashLog(value, NAN);
      }
    } else if (sensor == "random") {
      float value = (float)(random(0, 1000)) / 10.0f;
      if (connectedCount > 0) {
        sendMetricPayload("random", "", "generic", value, nullptr, 0.0f);
      }
      flashLog(value, NAN);
    }
  }
  delay(10);
}
