# Carenuity C3-Mini Wireless Flasher

Flash any app from the [Carenuity Solution Builder](https://solutions.carenuity.com) onto a
C3-Mini (ESP32-C3) **over Bluetooth LE, from an Android phone or an iPhone**. No cable, no
computer, no Wi-Fi router.

- **Web app:** <https://mergenth.github.io/carenuity-c3-ble-ota/> (Chrome on Android, [Bluefy](https://apps.apple.com/app/bluefy-web-ble-browser/id1492822055) on the iPhone)
- **Android app:** [carenuity-flasher.apk](https://github.com/Mergenth/carenuity-c3-ble-ota/releases/tag/android-latest)
- **Board firmware:** [`firmware/release/Carenuity-BLE-OTA-Loader-C3-Mini.ino.bin`](firmware/release), also in the Solution Builder as *Carenuity-BLE-OTA-Loader*

## How it works

```
 once, by USB                       every time, wireless
┌─────────────────────┐   ┌──────────────────────────────────────────────┐
│ Solution Builder    │   │ phone: pick a solution ─► download its .bin  │
│ "Install" the       │   │        cut out the app image ─► Bluetooth LE │
│ BLE-OTA loader      │   │ board: loader writes it to flash ─► restarts │
└─────────────────────┘   └──────────────────────────────────────────────┘
```

The board is prepared **once** with a small base firmware. It has two parts:

| Part | Where | What it does |
| --- | --- | --- |
| Bootloader | `0x0` | After a **hard reset** (power-up, RESET button, USB reset) it starts the loader. After any other reset (software restart, deep-sleep wake-up, watchdog) it starts the installed app. |
| BLE-OTA loader | factory partition, `0x10000` | Advertises as `Carenuity-OTA-XXXX` for **8 seconds**. If a phone connects, it receives an app and writes it to the `app0` partition. Otherwise it restarts into the installed app. |

Because the way back into update mode lives in the bootloader, the installed app needs **no OTA
code at all**. Unmodified Solution Builder apps work.

The Solution Builder serves merged flash images (bootloader + partition table + app, from `0x0`).
Only the app can be written over the air, so the phone finds the app image inside the download
(partition table at `0x8000`, usually `0x10000`), checks that it was built for the ESP32-C3,
verifies its SHA-256 and sends just that part.

## Use it

1. **Prepare the board (once).** On a computer, open the Solution Builder, choose
   *Carenuity-BLE-OTA-Loader* for the C3-Mini and press **Install** with the board on USB.
   Or flash `firmware/release/*.ino.bin` to offset `0x0` with any ESP flashing tool.
2. **Open the app** on the phone and tap **Connect board**. Press **RESET** on the C3-Mini and
   pick `Carenuity-OTA-XXXX` in the list.
3. **Choose a solution, tap Flash.** A typical app (900 KB) takes about half a minute.

To flash something else later, press RESET again and reconnect. Need more than 8 seconds? Press
RESET, then hold **BOOT** for a moment: the board stays in update mode until the next reset.

## Good to know

- **Anyone nearby can flash the board during the update window.** There is no pairing. Do not use
  this base firmware on devices that run unattended in places you do not control.
- Every power-up takes 8 seconds longer, because the update window comes first.
- Apps see a *software* reset as their reset reason after power-up.
- App size limit is 3 MB. A 384 KB `spiffs` partition exists for apps that use SPIFFS/LittleFS;
  file-system images contained in a download are not transferred.
- Apps that update themselves (ArduinoOTA and similar) cannot do so on this layout, because
  there is only one app slot. Use this flasher instead.
- Installing any app from the Solution Builder **by USB** replaces the base firmware. Prepare the
  board again afterwards if you want wireless flashing back.
- Built for boards with 4 MB flash (LOLIN / Wemos C3-Mini).

## Status

Version 1.0.0. Checked so far: the firmware builds with ESP-IDF v5.4.3; the bootloader's reset
policy and the update window were run in Espressif's QEMU; the transfer logic of the app is
covered by tests against a model of the loader (lossy link, small MTU, damaged data); the image
finder is tested against real ESP-IDF images. **The Bluetooth transfer has not yet been run on
a physical C3-Mini** by the author of this version. Please report results as issues.

## Repository

```
firmware/   ESP-IDF project: custom bootloader + BLE-OTA loader (ESP32-C3)
app/        the flasher: TypeScript, one code base for web, Android and iOS (Capacitor)
docs/       PROTOCOL.md, the Bluetooth protocol between app and loader
```

### Build the firmware

```sh
# ESP-IDF v5.4.x, target esp32c3
cd firmware
idf.py build
cd build && python -m esptool --chip esp32c3 merge-bin -o loader.ino.bin @flash_args
```

Settings (update window, BOOT button pin, Bluetooth name) are under
*Carenuity BLE-OTA loader* in `idf.py menuconfig`.

### Build the app

```sh
cd app
npm ci
npm test            # protocol and image tests
npm run dev         # web app on http://localhost:5173 (Web Bluetooth needs localhost or https)
npm run build       # static site in app/dist

npm run native:android   # creates app/android; then: cd android && ./gradlew assembleDebug
npm run native:ios       # creates app/ios; open ios/App in Xcode on a Mac, set your team, run
```

The Android APK is built by GitHub Actions on every change. An iPhone build has to be signed
with an Apple Developer account; until then the web app in Bluefy does the same job.

## License

Apache-2.0. The bootloader is derived from the ESP-IDF bootloader (Apache-2.0, Espressif Systems).
