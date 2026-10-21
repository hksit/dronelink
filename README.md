# DroneLink

**Full user manual:** [docs/MANUAL.md](docs/MANUAL.md) (printable: [docs/MANUAL.pdf](docs/MANUAL.pdf))

Receive a DJI drone's live video on a Windows or Mac computer and show it in OBS, in any browser on the same Wi-Fi, record it, or send it straight to YouTube or Facebook. A built-in **test drone** lets you check the whole setup without flying.

## For users

1. Install and open DroneLink. There's nothing to configure.
2. DroneLink shows a **drone address**, for example `rtmp://192.168.1.20/live/drone`.
3. In DJI Fly, tap **···** → **Transmission** → **Live Streaming Platforms** → **RTMP**, paste the address, and tap **Start Live**.
4. The picture appears in DroneLink. Then use the tabs:
   - **Show in OBS**: add a Browser source with the address shown (it survives drone reconnects).
   - **Watch on other devices**: a link or QR code anyone on the same Wi-Fi can open.
   - **Record**: saves MP4 files to `Videos/DroneLink`.
   - **Go live**: paste your YouTube or Facebook stream key.

The phone running DJI Fly and the computer must be on the same Wi-Fi. If a venue network blocks devices from seeing each other, use the phone's hotspot.

### Which drones work

| App | Drones | How |
|---|---|---|
| DJI Fly | Mini 2/3/4/5, Air 2S/3/3S, Mavic 3 series, Avata, FPV, Neo, Flip | Transmission → Live Streaming Platforms → RTMP |
| DJI GO 4 | Phantom 4, Mavic 2, Mavic Air, Spark | Live streaming → Custom RTMP |
| DJI Pilot 2 | Matrice, Mavic 3 Enterprise | RTMP, or RTSP via “Drone app gives you an rtsp:// address instead?” |
| Goggles-only flights | Avata / FPV without a phone | Not possible over Wi-Fi. Use controller HDMI out and a capture card into OBS. |

### What you receive

- The **same live view the phone or controller shows**, re-encoded by the drone app (usually 720p). Full-quality footage still records to the drone's SD card.
- **Range** is limited by the drone-to-controller radio, not by DroneLink. When the drone is far away and the controller's picture turns blocky or freezes, DroneLink shows exactly that. It can't be better than what the controller receives.
- When the signal drops, OBS, viewers, recording and Go Live **stay connected for 30 seconds and continue automatically** when DJI Fly reconnects.
- DJI's live stream carries **no flight data** (altitude, GPS, battery). That would need a custom Android app built on the DJI Mobile SDK.

### Test drone

**Fly a test drone** (top right) streams a simulated flight with a DJI-style HUD to this computer, or to DroneLink on another computer by IP. While flying you can:
- **Simulate weak signal**: blocky, juddery picture with short freezes, like long range.
- **Simulate signal loss**: cuts the feed for 6 s, then reconnects like DJI Fly does.

Use it to check OBS scenes, recording and Go Live before the real flight.

## Install notes

- **Windows**: run `DroneLink-Setup-1.0.0.exe`. The installer adds a firewall rule so drones can connect without a prompt. The build is unsigned, so SmartScreen may show “More info → Run anyway” until you sign it.
- **Mac**: open the DMG and drag DroneLink to Applications. The build is unsigned, so the first time, right-click the app → Open. Allow incoming connections and local network access when macOS asks.

## Making it install without "unsafe" warnings

Windows and macOS warn about any app that isn't code-signed. The app itself is fine. Signing proves who published it.

| Platform | Route | Cost | Result |
|---|---|---|---|
| Windows | **Microsoft Store** (recommended) | Free for individuals; ID check with passport/licence + selfie | Store signs the package. No SmartScreen warning, installs in one click. Run `npm run dist:store`, upload the `.appx` in Partner Center. |
| Windows | **OV code-signing certificate** (DigiCert, Sectigo, SSL.com…) for the direct-download `.exe` | about US$150–300/year | Shows your name instead of "Unknown publisher". SmartScreen may still warn on the first releases until reputation builds. Key must be on a cloud HSM or USB token. |
| Windows | Azure Artifact Signing | US$9.99/month | Not available in Australia yet (USA, Canada, EU, UK organisations only). |
| Mac | **Apple Developer Program** + notarization | A$149/year | No warning at all. |

**Microsoft Store setup (once):** register at partner.microsoft.com, reserve the name "DroneLink", and copy *Package/Identity/Name*, *Publisher* and *Publisher display name* from Product identity into `build.appx` in `package.json` (replace the `FILL-FROM-PARTNER-CENTER` values). Build with `npm run dist:store` on Windows and upload. Store installs can't run the installer's firewall rule, so Windows asks "Allow access?" the first time. Users click **Allow**.

## For developers

```bash
npm install          # also copies the browser player into web/vendor
npm start            # run the app
npm test             # end-to-end: receiver + test drone + recording
npm run drone -- rtmp://192.168.1.20/live/drone   # headless test drone to any receiver
```

Build installers:

```bash
npm run dist:win     # on Windows (or Linux with wine + wine32)
npm run dist:mac     # on a Mac; run on Apple Silicon and Intel for both builds
```

### How it fits together

```
DJI Fly ──RTMP──▶ DroneLink receiver (Node-Media-Server, port 1935)
                      ├─ HTTP-FLV ─▶ app preview / OBS Browser source / LAN viewers (port 8000)
                      ├─ ffmpeg -c copy ─▶ MP4 recording
                      └─ ffmpeg -c copy ─▶ YouTube / Facebook / custom RTMP(S)
Test drone: canvas renderer ─raw frames─▶ ffmpeg (H.264 + silent AAC) ─RTMP─▶ receiver
DJI Pilot 2 RTSP ─▶ ffmpeg pull ─▶ receiver
```

| Path | What |
|---|---|
| `src/main/main.js` | App window, IPC, wiring |
| `src/main/media-server.js` | RTMP receiver, stream stats, safe port selection |
| `src/main/outputs.js` | Recorder, Go Live, RTSP pull (auto-retry) |
| `src/main/network.js` | Picks the Wi-Fi address to show; free-port finder |
| `src/drone/*` | Test drone: terrain, flight path, HUD, encoder/pusher |
| `src/renderer/*` | The app UI |
| `web/index.html` | Viewer page for OBS and devices on the Wi-Fi |
| `web/overlay.js` | On-screen info (LIVE badge, clock, title, details), shared by app, OBS and viewers |
| `docs/` | User manual (Markdown + PDF) and screenshots |

Ports: RTMP 1935 (falls back to 1936+ if busy, and the address updates), HTTP 8000 (falls back to 8001+). Streams on the local network are not password protected, so use it on networks you trust.

Third-party: Node-Media-Server (Apache-2.0), mpegts.js (Apache-2.0), FFmpeg (LGPL/GPL build from @ffmpeg-installer), @napi-rs/canvas (MIT), DejaVu fonts (free license, `assets/fonts`).
