# TURN Server Configuration Guide for Castora Pro

Castora Pro uses **STUN** by default (`stun:stun.l.google.com:19302`) for LAN and standard NAT traversal. When participants connect across **symmetric NATs**, **corporate/university firewalls**, or **client-isolated Wi-Fi networks**, WebRTC media requires a **TURN relay server**.

---

## 1. Security Model

- **Never hardcode TURN credentials** in frontend source files or `VITE_*` environment variables.
- **Keep secrets strictly server-side** in environment variables (`CASTORA_TURN_AUTH_SECRET`, or `CASTORA_TURN_USERNAME` / `CASTORA_TURN_CREDENTIAL`).
- When `CASTORA_TURN_URLS` and `CASTORA_TURN_AUTH_SECRET` are configured, Castora Pro generates **short-lived HMAC-SHA1 temporary credentials** (`username = "<unix_expiry>:<deviceId>"`) per authenticated room participant via `GET /api/ice-servers` (protected by the participant's room Bearer token and `Cache-Control: no-store`).
- If no TURN environment variables are set, Castora Pro safely falls back to **STUN-only** ICE negotiation.

---

## 2. Supported Environment Variables

Configure these variables on the Castora Pro Node.js server (`.env` locally or environment variables on Render / Fly.io / Railway / Docker):

| Variable | Description | Example |
| --- | --- | --- |
| `CASTORA_STUN_URLS` | Optional comma-separated STUN URLs (defaults to `stun:stun.l.google.com:19302`). | `stun:stun.l.google.com:19302` |
| `CASTORA_TURN_URLS` | Comma-separated TURN URLs supporting UDP, TCP, and TLS (`turns:`). | `turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp` |
| `CASTORA_TURN_AUTH_SECRET` | **Recommended.** Shared HMAC-SHA1 secret (`static-auth-secret` in Coturn) used to mint temporary credentials. | *(strong random 32+ byte secret)* |
| `CASTORA_TURN_TTL_SECONDS` | Optional lifetime in seconds for temporary TURN credentials (`60`–`86400`, default `3600`). | `3600` |
| `CASTORA_TURN_USERNAME` | Optional static username (only used if `CASTORA_TURN_AUTH_SECRET` is omitted). | `provider-username` |
| `CASTORA_TURN_CREDENTIAL` | Optional static credential (only used if `CASTORA_TURN_AUTH_SECRET` is omitted). | *(provider secret)* |

---

## 3. Provider Setup Examples

### Option A: Self-Hosted Coturn (Recommended for Ephemeral Credentials)

In `/etc/turnserver.conf`:

```ini
listening-port=3478
tls-listening-port=5349
fingerprint
use-auth-secret
static-auth-secret=REPLACE_WITH_LONG_RANDOM_SECRET
realm=turn.example.com
cert=/etc/letsencrypt/live/turn.example.com/fullchain.pem
pkey=/etc/letsencrypt/live/turn.example.com/privkey.pem
no-tlsv1
no-tlsv1_1
```

Then set on the Castora Pro server:

```env
CASTORA_TURN_URLS=turn:turn.example.com:3478?transport=udp,turn:turn.example.com:3478?transport=tcp,turns:turn.example.com:5349?transport=tcp
CASTORA_TURN_AUTH_SECRET=REPLACE_WITH_LONG_RANDOM_SECRET
CASTORA_TURN_TTL_SECONDS=3600
```

### Option B: Managed TURN Provider (Cloudflare Calls / Metered / Twilio)

If your provider issues a TURN REST shared secret, set `CASTORA_TURN_URLS` + `CASTORA_TURN_AUTH_SECRET`.  
If your provider only supplies static username/credential pairs, set:

```env
CASTORA_TURN_URLS=turn:global.turn.example.com:3478?transport=udp,turn:global.turn.example.com:3478?transport=tcp,turns:global.turn.example.com:443?transport=tcp
CASTORA_TURN_USERNAME=your-provider-username
CASTORA_TURN_CREDENTIAL=your-provider-credential
```

---

## 4. Verifying Configuration

1. Open `GET /api/health` (or **Settings → Network & ICE Servers** in Castora Pro).
2. `turnConfigured: true` and `turnMode: "ephemeral-hmac"` (or `"static"`) confirm the backend sees your TURN configuration without exposing any secret values.
3. In-browser testing: join a room from two devices on separate networks (or restrictive NATs) and verify `connected` state via WebRTC ICE negotiation.
