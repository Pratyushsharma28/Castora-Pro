# Castora Pro — Secure LAN HTTPS & Certificate Trust Guide

Modern browsers enforce **Secure Context (`window.isSecureContext === true`)** rules for WebRTC screen capture and mobile media APIs:

| Origin | Mac Browser (`getDisplayMedia` Sender) | Android Chrome (WebRTC Receiver) |
| :--- | :--- | :--- |
| `http://localhost:3000` | Allowed (loopback exception) | Cannot reach Mac's `localhost` from Android |
| `http://<mac-lan-ip>:3000` | **Blocked** (`getDisplayMedia` undefined/denied) | **Unreliable / restricted** (no camera QR scan, restricted media permissions, non-secure WebSocket `ws://`) |
| `https://<mac-lan-ip>:3000` (with trusted local CA) | **Allowed** | **Allowed** (WebRTC, camera QR scanner, `wss://` signaling, full MediaStream playback) |

Because both the Mac sender and Android receiver must access Castora Pro on the local network over **HTTPS (`https://` + `wss://`)**, Stage 2+ local development uses a trusted local certificate authority (`mkcert`).

---

## 1. Generating a Local Trusted CA and LAN Certificate on macOS (`mkcert`)

1. **Install `mkcert` via Homebrew on your Mac:**
   ```bash
   brew install mkcert nss
   ```
2. **Create and install the local Root CA into macOS System Keychain:**
   ```bash
   mkcert -install
   ```
   *(This automatically trusts certificates generated on this Mac in Safari, Chrome, and Edge on macOS.)*
3. **Find your Mac's LAN IP address (Wi-Fi or Ethernet):**
   ```bash
   ipconfig getifaddr en0
   ```
   *(Use `en1` or check System Settings → Network if `en0` is empty.)*
4. **Generate a certificate covering `localhost`, `127.0.0.1`, your Mac hostname, and your LAN IP** (stored outside git in `.certs/`, ignored by `.gitignore` or gitignored cert rules):
   ```bash
   mkdir -p .certs
   mkcert -cert-file .certs/castora-lan.pem -key-file .certs/castora-lan-key.pem \
     localhost 127.0.0.1 ::1 "$(scutil --get LocalHostName).local" 192.168.1.42
   ```
   Replace `192.168.1.42` with your actual Mac LAN IP. Never commit private `.pem`/`.key` files to GitHub.

---

## 2. Installing & Trusting the Root CA on Android (Required for Android Chrome)

Android Chrome does **not** trust self-signed leaf certificates cleanly for WebRTC/camera APIs unless your local `mkcert` **Root CA** is installed as a trusted **CA certificate** on Android:

1. **Locate your `mkcert` Root CA file on macOS:**
   ```bash
   echo "$(mkcert -CAROOT)/rootCA.pem"
   ```
2. **Copy `rootCA.pem` to your Android device** (via AirDrop/Android File Transfer, USB cable, or a temporary one-time local download) and rename it to `castora-rootCA.crt` if Android requires a `.crt`/`.pem` extension.
3. **Install the CA Certificate on Android (Android 11–15+):**
   - Open **Settings → Security & privacy** (or **Settings → Security**).
   - Tap **More security & privacy → Encryption & credentials → Install a certificate → CA certificate**.
   - Tap **Install anyway** on the warning dialog, verify with PIN/biometrics, and select `castora-rootCA.crt`.
4. **Verify on Android Chrome:**
   - Open `https://<mac-lan-ip>:3000` in Android Chrome.
   - Confirm the lock icon shows a trusted HTTPS connection without certificate warnings and Castora Pro Settings reports **Secure Context: Verified (`https:`)**.

> **Important Security Note:** Keep `rootCA-key.pem` strictly on your development Mac and never share it. Remove the custom CA from Android **User credentials** when development testing is finished.

---

## 3. Alternative for Quick Testing Without Manual Android CA Install

If a specific Android device locks down user CA installation, use **ADB reverse port forwarding** over USB (`adb reverse tcp:3000 tcp:3000`) and open `http://localhost:3000` on Android Chrome (`localhost` is treated as a secure context by Chrome), or use a trusted HTTPS tunnel on the local machine. For normal wireless LAN multi-device testing across 1–6 receivers, the `mkcert` Root CA workflow above is recommended.
