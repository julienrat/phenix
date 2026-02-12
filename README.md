# Phenix

Demo BLE + capteurs pour ESP32‑H2 avec interface Web.

## GitHub Pages
- https://julienrat.github.io/phenix/

## Structure
- `esp32_demo/` : firmware PlatformIO (ESP32‑H2)
- `docs/` : site statique déployé par GitHub Pages
- `index.html`, `app.js`, `styles.css` : sources locales du front (copiées dans `docs/`)

## Lancer en local (optionnel)
- Firmware: ouvrir `esp32_demo/` avec PlatformIO et flasher.
- Front: servir `index.html` en HTTPS (nécessaire pour Web Bluetooth).
