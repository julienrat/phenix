#include <Arduino.h>
#include <math.h>
#include <Wire.h>
#include <NimBLEDevice.h>
#include <NimBLEAdvertisementData.h>
#include <Adafruit_BMP280.h>
#include <MS5611.h>

#if defined(ARDUINO_ARCH_ESP32)
#include "esp_system.h"
#include "esp_chip_info.h"
#endif

// Custom service/characteristic UUIDs (align with Web Bluetooth app)
static const char *UUID_SERVICE = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c01";
static const char *UUID_DATA    = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c02"; // notify
static const char *UUID_CONFIG  = "9d35a5d1-8e8a-4e6b-b44a-9f5bb48f7c03"; // write

static char bleName[32];
static char bleNameShort[16];
static const uint32_t HEARTBEAT_MS = 1000;
static const uint32_t SENSOR_INTERVAL_MS = 1000;
static const uint32_t RESCAN_INTERVAL_MS = 5000;
static const uint8_t I2C_ADDR_BMP280_A = 0x76;
static const uint8_t I2C_ADDR_BMP280_B = 0x77;
static const uint8_t I2C_ADDR_MS5611_A = 0x77;
static const uint8_t I2C_ADDR_MS5611_B = 0x76;

static NimBLECharacteristic *txChar = nullptr;
static NimBLEServer *bleServer = nullptr;
static uint8_t connectedCount = 0;
static uint32_t lastBeat = 0;
static uint32_t lastSensorMs = 0;
static uint32_t lastScanMs = 0;
static bool bleResetPending = false;
static uint32_t bleResetAt = 0;

static Adafruit_BMP280 *bmp280 = nullptr;
static MS5611 *ms5611 = nullptr;
static uint8_t bmpAddr = 0;
static uint8_t msAddr = 0;

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

static void sendSensorPayload(const char *sensor, uint8_t addr, float tempC, float pressHpa) {
  if (!txChar) return;
  char payload[160];
  snprintf(payload, sizeof(payload),
           "{\"sensor\":\"%s\",\"addr\":\"0x%02X\",\"temperature\":%.2f,\"pressure\":%.2f}",
           sensor, addr, tempC, pressHpa);
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
  }
};

class ServerCallbacks : public NimBLEServerCallbacks {
  void onConnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo) override {
    (void)pServer;
    (void)connInfo;
    connectedCount = bleServer ? bleServer->getConnectedCount() : 1;
    Serial.println("[BLE] Connected");
    Serial.print("[BLE] Connected count=");
    Serial.println(connectedCount);
    // Keep advertising to allow multiple centrals to connect
    NimBLEDevice::startAdvertising();
  }

  void onDisconnect(NimBLEServer *pServer, NimBLEConnInfo &connInfo, int reason) override {
    (void)pServer;
    (void)connInfo;
    Serial.print("[BLE] Disconnected, reason=");
    Serial.println(reason);
    connectedCount = bleServer ? bleServer->getConnectedCount() : 0;
    Serial.print("[BLE] Connected count=");
    Serial.println(connectedCount);
    const bool restarted = NimBLEDevice::startAdvertising();
    Serial.print("[BLE] Advertising restarted=");
    Serial.println(restarted ? "OK" : "FAIL");

    if (connectedCount == 0) {
      bleResetPending = true;
      bleResetAt = millis() + 200;
      Serial.println("[BLE] Reset scheduled");
    }
  }
};

static void bleInit() {
  NimBLEDevice::init("ESP32-H2");
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
  snprintf(bleName, sizeof(bleName), "ESP32-H2-%s", last6.c_str());
  snprintf(bleNameShort, sizeof(bleNameShort), "H2-%s", last4.c_str());
  NimBLEDevice::setDeviceName(bleName);

  Serial.print("[BLE] Init done, name=");
  Serial.println(bleName);

  bleServer = NimBLEDevice::createServer();
  bleServer->setCallbacks(new ServerCallbacks());

  NimBLEService *service = bleServer->createService(UUID_SERVICE);
  NimBLECharacteristic *rxChar = service->createCharacteristic(
      UUID_CONFIG, NIMBLE_PROPERTY::WRITE | NIMBLE_PROPERTY::WRITE_NR);
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
  printBootInfo();
  Serial.print("[I2C] SDA=");
  Serial.print(I2C_SDA);
  Serial.print(" SCL=");
  Serial.println(I2C_SCL);
  Wire.begin(I2C_SDA, I2C_SCL);
  Wire.setClock(400000);
  scanSensors();
  bleInit();
}

void loop() {
  if (bleResetPending && (int32_t)(millis() - bleResetAt) >= 0) {
    bleResetPending = false;
    bleReset();
  }

  const uint32_t now = millis();
  if (now - lastBeat >= HEARTBEAT_MS) {
    lastBeat = now;
    Serial.print("[ALIVE] ms=");
    Serial.println(now);
  }

  if (now - lastScanMs >= RESCAN_INTERVAL_MS) {
    lastScanMs = now;
    if (!bmp280 && !ms5611) {
      scanSensors();
    }
  }

  if (connectedCount > 0 && (now - lastSensorMs) >= SENSOR_INTERVAL_MS) {
    lastSensorMs = now;
    float tempC = 0.0f;
    float pressHpa = 0.0f;
    if (bmp280 && readBmp280(tempC, pressHpa)) {
      sendSensorPayload("bmp280", bmpAddr, tempC, pressHpa);
    }
    if (ms5611 && readMs5611(tempC, pressHpa)) {
      sendSensorPayload("gy63", msAddr, tempC, pressHpa);
    }
  }
  delay(10);
}
