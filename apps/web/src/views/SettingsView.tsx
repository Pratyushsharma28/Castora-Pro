import { useState } from 'react';
import { RefreshCw, Save, ShieldCheck, ShieldAlert } from 'lucide-react';
import type {
  BrowserCapabilityReport,
  CapturePreferences,
  NetworkPreferences,
} from '../types/studio';
import { SignalBadge } from '../components/common/SignalBadge';

interface SettingsViewProps {
  deviceId: string;
  deviceName: string;
  onSaveDeviceName: (nextName: string) => void;
  preferences: CapturePreferences;
  onUpdatePreferences: (next: CapturePreferences) => void;
  networkPrefs: NetworkPreferences;
  onUpdateNetworkPrefs: (next: NetworkPreferences) => void;
  capabilities: BrowserCapabilityReport;
  onReprobeCapabilities: () => void;
  onLogEvent: (category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error', title: string, detail: string) => void;
}

export function SettingsView({
  deviceId,
  deviceName,
  onSaveDeviceName,
  preferences,
  onUpdatePreferences,
  networkPrefs,
  onUpdateNetworkPrefs,
  capabilities,
  onReprobeCapabilities,
  onLogEvent,
}: SettingsViewProps) {
  const [nameDraft, setNameDraft] = useState<string>(deviceName);
  const [savedNotice, setSavedNotice] = useState<string | null>(null);

  const handleSaveIdentity = (e: React.FormEvent) => {
    e.preventDefault();
    const trimmed = nameDraft.trim();
    if (!trimmed) {
      setSavedNotice('Device name cannot be empty.');
      return;
    }
    onSaveDeviceName(trimmed);
    setSavedNotice(`Saved local device name "${trimmed}".`);
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="font-display text-lg font-semibold tracking-tight text-[#F2F3F0]">
          Settings &amp; Environment Diagnostics
        </h1>
        <p className="text-xs text-[#929A9D]">
          Local device identity, Secure LAN HTTPS verification, ICE policy, and live browser WebRTC codec inspection.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column: Identity & Network */}
        <div className="space-y-6 lg:col-span-6">
          {/* Device Identity */}
          <form
            onSubmit={handleSaveIdentity}
            className="border border-[#252A2F] bg-[#191D20] p-4 space-y-4"
          >
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Device Identity
              </h2>
              <span className="font-mono text-[11px] text-[#929A9D] tabular-metrics">
                {deviceId}
              </span>
            </div>

            <div>
              <label
                htmlFor="castora-device-name"
                className="block text-[11px] font-medium uppercase tracking-[0.08em] text-[#929A9D]"
              >
                Local Display Name
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="castora-device-name"
                  type="text"
                  maxLength={48}
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="h-11 flex-1 border border-[#252A2F] bg-[#131619] px-3 text-xs text-[#F2F3F0] focus:border-[#FF7849] focus:outline-none"
                />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center gap-1.5 bg-[#FF7849] px-4 text-xs font-semibold text-[#101214] hover:opacity-90"
                >
                  <Save className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Save</span>
                </button>
              </div>
            </div>

            {savedNotice && (
              <p className="text-xs text-[#8BD7B0]">{savedNotice}</p>
            )}
          </form>

          {/* Default Capture & Progressive Scaling Note */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-3">
            <h2 className="border-b border-[#252A2F] pb-2.5 text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
              Default Capture &amp; Scaling Policy
            </h2>
            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-[#929A9D]">Default Resolution</dt>
                <dd className="font-mono text-[#F2F3F0]">{preferences.resolution.toUpperCase()}</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#929A9D]">Default Target Frame Rate</dt>
                <dd className="font-mono text-[#F2F3F0] tabular-metrics">{preferences.targetFps} FPS</dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#929A9D]">Codec Policy</dt>
                <dd className="font-mono text-[#F2F3F0]">{preferences.codecPreference}</dd>
              </div>
            </dl>
            <div className="pt-1">
              <button
                type="button"
                onClick={() => {
                  onUpdatePreferences({
                    resolution: '1080p',
                    targetFps: 60,
                    codecPreference: 'H264',
                    includeAudio: false,
                  });
                  onLogEvent('ui', 'Capture defaults restored', 'Reset capture defaults to 1080p @ 60 FPS target, H264 preferred.');
                }}
                className="min-h-[38px] border border-[#252A2F] bg-[#131619] px-3 text-xs font-medium text-[#F2F3F0] hover:border-[#FF7849]"
              >
                Restore 1080p60 / H.264 Defaults
              </button>
            </div>
            <p className="text-[11px] leading-relaxed text-[#929A9D]">
              Receivers are stress-tested progressively (1 → 2 → 3 → 6). Actual capture, encode, and decode FPS are always measured live — never assumed.
            </p>
          </div>

          {/* Network & ICE Policy */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Network &amp; ICE Policy
              </h2>
              <span className="font-mono text-[11px] text-[#929A9D]">Runtime Only</span>
            </div>

            <button
              type="button"
              onClick={() => {
                const next = !networkPrefs.preferLanDirectP2P;
                onUpdateNetworkPrefs({ ...networkPrefs, preferLanDirectP2P: next });
                onLogEvent('ui', 'LAN P2P preference changed', next ? 'Prefer LAN direct host candidates' : 'Allow full ICE relay negotiation');
              }}
              className="flex min-h-[44px] w-full items-center justify-between border border-[#252A2F] bg-[#131619] px-3 text-xs"
            >
              <span className="font-medium text-[#F2F3F0]">Prefer LAN Direct Host Candidates</span>
              <span className="font-mono text-[#FF7849]">
                {networkPrefs.preferLanDirectP2P ? 'ENABLED' : 'STANDARD ICE'}
              </span>
            </button>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="castora-stun-urls"
                  className="block text-[11px] uppercase tracking-[0.08em] text-[#929A9D]"
                >
                  STUN Server URLs (Comma-separated, Configurable)
                </label>
                <input
                  id="castora-stun-urls"
                  type="text"
                  value={networkPrefs.stunUrls}
                  onChange={(e) =>
                    onUpdateNetworkPrefs({ ...networkPrefs, stunUrls: e.target.value })
                  }
                  placeholder="stun:stun.l.google.com:19302"
                  className="mt-1 h-10 w-full border border-[#252A2F] bg-[#131619] px-3 font-mono text-xs text-[#F2F3F0] focus:border-[#FF7849] focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="castora-turn-url"
                  className="block text-[11px] uppercase tracking-[0.08em] text-[#929A9D]"
                >
                  TURN Server URL (Optional Cross-Network Relay)
                </label>
                <input
                  id="castora-turn-url"
                  type="text"
                  value={networkPrefs.turnUrl}
                  onChange={(e) =>
                    onUpdateNetworkPrefs({ ...networkPrefs, turnUrl: e.target.value })
                  }
                  placeholder="turn:relay.example.com:3478"
                  className="mt-1 h-10 w-full border border-[#252A2F] bg-[#131619] px-3 font-mono text-xs text-[#F2F3F0] focus:border-[#FF7849] focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="castora-turn-user"
                    className="block text-[11px] uppercase tracking-[0.08em] text-[#929A9D]"
                  >
                    TURN Username
                  </label>
                  <input
                    id="castora-turn-user"
                    type="text"
                    value={networkPrefs.turnUsername}
                    onChange={(e) =>
                      onUpdateNetworkPrefs({ ...networkPrefs, turnUsername: e.target.value })
                    }
                    className="mt-1 h-10 w-full border border-[#252A2F] bg-[#131619] px-3 font-mono text-xs text-[#F2F3F0] focus:border-[#FF7849] focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="castora-turn-cred"
                    className="block text-[11px] uppercase tracking-[0.08em] text-[#929A9D]"
                  >
                    TURN Credential
                  </label>
                  <input
                    id="castora-turn-cred"
                    type="password"
                    value={networkPrefs.turnCredential}
                    onChange={(e) =>
                      onUpdateNetworkPrefs({ ...networkPrefs, turnCredential: e.target.value })
                    }
                    className="mt-1 h-10 w-full border border-[#252A2F] bg-[#131619] px-3 font-mono text-xs text-[#F2F3F0] focus:border-[#FF7849] focus:outline-none"
                  />
                </div>
              </div>
              <p className="text-[11px] leading-relaxed text-[#929A9D]">
                STUN handles initial connectivity discovery on same-LAN and standard NATs. Networks using client isolation, strict corporate firewalls, or symmetric NAT require a TURN relay. Credentials remain in memory only and are never persisted to localStorage.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: Secure LAN HTTPS & Live Browser Capability Probe */}
        <div className="space-y-6 lg:col-span-6">
          {/* Secure LAN HTTPS Readiness */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <div className="flex items-center gap-2">
                {capabilities.isSecureContext ? (
                  <ShieldCheck className="h-4 w-4 text-[#8BD7B0]" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-[#F59E0B]" aria-hidden="true" />
                )}
                <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                  Secure LAN HTTPS Readiness
                </h2>
              </div>
              <SignalBadge
                label={capabilities.isSecureContext ? 'SECURE CONTEXT' : 'NON-SECURE ORIGIN'}
                tone={capabilities.isSecureContext ? 'active' : 'warn'}
              />
            </div>

            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">Active Origin</dt>
                <dd className="truncate font-mono text-[#F2F3F0]">{capabilities.origin || '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#929A9D]">window.isSecureContext</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {capabilities.isSecureContext ? 'true' : 'false'}
                </dd>
              </div>
            </dl>

            <div className="border border-[#252A2F] bg-[#131619] p-3 space-y-2 text-xs leading-relaxed text-[#929A9D]">
              <div className="font-semibold text-[#F2F3F0]">
                Mac Sender &amp; Android Chrome LAN Trust Checklist (docs/SECURE_LAN_HTTPS.md)
              </div>
              <ol className="list-decimal space-y-1 pl-4">
                <li>
                  Generate a trusted local CA and LAN IP certificate on macOS via{' '}
                  <code className="font-mono text-[#F2F3F0]">mkcert -install</code> and{' '}
                  <code className="font-mono text-[#F2F3F0]">mkcert localhost &lt;LAN-IP&gt;</code>.
                </li>
                <li>
                  Transfer <code className="font-mono text-[#F2F3F0]">rootCA.pem</code> to Android and install under{' '}
                  <span className="text-[#F2F3F0]">Settings → Security → Encryption &amp; credentials → Install a certificate → CA certificate</span>.
                </li>
                <li>
                  Open <code className="font-mono text-[#F2F3F0]">https://&lt;LAN-IP&gt;:3000</code> on Android Chrome (or use <code className="font-mono text-[#F2F3F0]">adb reverse tcp:3000 tcp:3000</code> over USB).
                </li>
              </ol>
            </div>
          </div>

          {/* Browser Hardware & Codec Inspector */}
          <div className="border border-[#252A2F] bg-[#191D20] p-4 space-y-4">
            <div className="flex items-center justify-between border-b border-[#252A2F] pb-2.5">
              <h2 className="text-xs font-semibold uppercase tracking-[0.08em] text-[#F2F3F0]">
                Browser Capability Inspector
              </h2>
              <button
                type="button"
                onClick={onReprobeCapabilities}
                className="inline-flex min-h-[32px] items-center gap-1.5 border border-[#252A2F] bg-[#131619] px-2.5 text-[11px] font-medium text-[#F2F3F0] hover:border-[#FF7849]"
              >
                <RefreshCw className="h-3 w-3" aria-hidden="true" />
                <span>Re-run Probe</span>
              </button>
            </div>

            <dl className="divide-y divide-[#252A2F] text-xs">
              <div className="flex items-center justify-between py-2">
                <dt className="text-[#929A9D]">Detected Runtime</dt>
                <dd className="text-[#F2F3F0]">{capabilities.userAgentSummary}</dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-[#929A9D]">getDisplayMedia()</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {capabilities.supportsDisplayMedia ? 'Available' : 'Unavailable'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-[#929A9D]">RTCPeerConnection</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {capabilities.supportsRtcPeerConnection ? 'Available' : 'Unavailable'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-[#929A9D]">H.264 Encode / Decode</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {capabilities.supportsVideoH264Encode ? 'ENC YES' : 'ENC NO'} ·{' '}
                  {capabilities.supportsVideoH264Decode ? 'DEC YES' : 'DEC NO'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-[#929A9D]">BarcodeDetector (QR)</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {capabilities.supportsBarcodeDetector ? 'Supported' : 'Fallback Input'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2">
                <dt className="text-[#929A9D]">Fullscreen API</dt>
                <dd className="font-mono text-[#F2F3F0]">
                  {capabilities.supportsFullscreen ? 'Supported' : 'Restricted'}
                </dd>
              </div>
              <div className="py-2">
                <dt className="text-[#929A9D]">Detected Video Codecs</dt>
                <dd className="mt-1 font-mono text-[11px] leading-relaxed text-[#F2F3F0]">
                  {capabilities.detectedVideoCodecs.length > 0
                    ? capabilities.detectedVideoCodecs.join(', ')
                    : 'None detected'}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>
    </div>
  );
}
