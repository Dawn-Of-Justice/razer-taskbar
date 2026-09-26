# razer-taskbar

## Summary

Display the battery state of Razer products using log messages from Razer Synapse.
Inspired by [Tekk-Know/RazerBatteryTaskbar](https://github.com/Tekk-Know/RazerBatteryTaskbar), instead of USB communication this app uses Razer Synapse logs to get the latest battery status of Razer wireless devices. This has the advantage to support more devices (headsets, mice, keyboard, etc.) without extra configuration, but also requires Razer Synapse 3 or 4 to be running.  
  
![Screenshot of razer-taskbar battery icon and its menu showing its connected to a Razer headset.](docs/screenshot.png)  

### Features

* **Windows 11 style tray icon**, drawn at runtime for every DPI (100%–200%) and matched to your taskbar's light/dark mode.
  Choose between a battery glyph or the exact percentage with a level bar. Low battery turns red.
* **Charging and powered-off states.** A headset that is switched off while its dongle stays plugged in shows a crossed-out battery instead of a stale percentage.
* **Notifications** for low battery, critical battery and fully charged (thresholds configurable, each fires once per crossing).
* **Tooltip** with device name, state and when Synapse last reported a change.
* **Modern settings window** (Mica on Windows 11, Razer green accent, follows system light/dark mode) with a live battery card.
* Left-click the tray icon to open settings; launching the app again focuses the running instance.

## Requirements

* Windows (tested on Windows 10 & 11)
* `Razer Synapse 3` or `Razer Synapse 4` running in the background
* _Optional: node.js (compile time)_

## Installation

Run the setup exe. After installation the app will show its icon on the taskbar. Use the Settings menu to configure automatic startup if needed.

## Supported Hardware

* Potentially any wireless Razer device compatible with Razer Synapse 3 or 4.
* tested with Razer Blackshark V2 Pro (2023) and Razer Barracuda X Chroma (HyperSpeed dongle)

## Compiling

* `npm install`
* `npm run make`
* Setup exe will be created in the `out\make` directory.

## How it works

The app monitors the logs of Razer Synapse:

* `%LOCALAPPDATA%\Razer\Synapse3\Log\Razer Synapse 3.log` for Razer Synapse 3
* `%LOCALAPPDATA%\Razer\RazerAppEngine\User Data\Logs\systray_systrayv2*.log` for Razer Synapse 4

Synapse 4 writes a `connectingDeviceData: [...]` line whenever a device connects or its battery changes, and rotates the log
at about 5 MB (`systray_systrayv2.log`, `systray_systrayv23.log`, ...). The watcher follows the newest file, reads only the bytes
appended since the last check, and falls back to older rotated files when the newest one has no battery line yet.
Parsing lives in [`synapse4_parser.ts`](src/watcher/synapse4_parser.ts); if Synapse changes its log format, that is the file to update.

Synapse 4 power states seen in the logs:

| `chargingStatus` | `level` | Meaning |
|---|---|---|
| `NoCharge_BatteryFull` | 0–100 | On battery (despite the name) |
| `Charging` | 0–100 | Charging |
| `off` | last level | Device powered off, receiver still plugged in |
| any | `-1` | Unknown (briefly, while turning on / reconnecting); the last known level is kept |

## Attributions

* RazerBatteryTaskbar: <https://github.com/Tekk-Know/RazerBatteryTaskbar>
* Battery icons are made by me. Design is based on [Dreamstale - Flaticon](https://www.flaticon.com/free-icons/battery)
