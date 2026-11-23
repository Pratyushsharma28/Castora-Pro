import { useState } from 'react';
import { RefreshCw, Save, ShieldAlert, ShieldCheck } from 'lucide-react';
import type { BackendHealthResponse } from '../services/backendClient';
import type {
  ActivityEvent,
  BrowserCapabilityReport,
  CapturePreferences,
  NetworkPreferences,
} from '../types/studio';
import {
  QUALITY_PROFILE_ORDER,
  QUALITY_PROFILES,
  applyQualityProfileToPreferences,
  resolveProfileIdFromPreferences,
} from '../services/videoQualityService';
import { SignalBadge } from '../components/common/SignalBadge';
import { ActivityView } from './ActivityView';

interface SettingsViewProps {
  deviceId: string;
  deviceName: string;
  onSaveDeviceName: (nextName: string) => void;
  preferences: CapturePreferences;
  onUpdatePreferences: (next: CapturePreferences) => void;
  networkPrefs: NetworkPreferences;
  onUpdateNetworkPrefs: (next: NetworkPreferences) => void;
  backendHealth?: BackendHealthResponse | null;
  onRefreshIceConfig?: () => void;
  capabilities: BrowserCapabilityReport;
  onReprobeCapabilities: () => void;
  activityEvents?: ActivityEvent[];
  onClearActivityEvents?: () => void;
  onLogEvent: (
    category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error',
    title: string,
    detail: string
  ) => void;
}

export function SettingsView({
  deviceId,
  deviceName,
  onSaveDeviceName,
  preferences,
  onUpdatePreferences,
  networkPrefs,
  onUpdateNetworkPrefs,
  backendHealth = null,
  onRefreshIceConfig,
  capabilities,
  onReprobeCapabilities,
  activityEvents = [],
  onClearActivityEvents,
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
        <h1 className="font-display text-xl font-semibold tracking-tight text-[#172033]">
          Settings &amp; Diagnostics
        </h1>
        <p className="text-sm text-[#64748B]">
          Device identity, capture defaults, ICE server configuration, and browser compatibility checks.
        </p>
      </div>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
        {/* Left Column: Identity, Capture Defaults, Network */}
        <div className="space-y-6 lg:col-span-6">
          <form
            onSubmit={handleSaveIdentity}
            className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4"
          >
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2.5">
              <h2 className="text-sm font-semibold text-[#172033]">Device Identity</h2>
              <span className="font-mono text-xs text-[#64748B] tabular-metrics">{deviceId}</span>
            </div>

            <div>
              <label
                htmlFor="castora-device-name"
                className="block text-xs font-medium text-[#64748B]"
              >
                Display Name
              </label>
              <div className="mt-1.5 flex gap-2">
                <input
                  id="castora-device-name"
                  type="text"
                  maxLength={48}
                  value={nameDraft}
                  onChange={(e) => setNameDraft(e.target.value)}
                  className="h-11 flex-1 rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 text-sm text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  className="inline-flex min-h-[44px] items-center gap-1.5 rounded-[10px] bg-[#2563EB] px-4 text-sm font-semibold text-white hover:bg-[#1D4ED8]"
                >
                  <Save className="h-4 w-4" aria-hidden="true" />
                  <span>Save</span>
                </button>
              </div>
            </div>

            {savedNotice && <p className="text-xs font-medium text-[#15803D]">{savedNotice}</p>}
          </form>

          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2.5">
              <h2 className="text-sm font-semibold text-[#172033]">
                Default Capture Quality
              </h2>
              <div
                role="group"
                aria-label="Default Adaptive Mode"
                className="inline-flex rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-0.5"
              >
                <button
                  type="button"
                  onClick={() =>
                    onUpdatePreferences({ ...preferences, adaptiveBitrate: true })
                  }
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
                    preferences.adaptiveBitrate !== false
                      ? 'bg-white text-[#172033] shadow-xs'
                      : 'text-[#64748B] hover:text-[#172033]'
                  }`}
                >
                  Auto
                </button>
                <button
                  type="button"
                  onClick={() =>
                    onUpdatePreferences({ ...preferences, adaptiveBitrate: false })
                  }
                  className={`rounded-md px-2.5 py-1 text-[11px] font-medium ${
                    preferences.adaptiveBitrate === false
                      ? 'bg-white text-[#172033] shadow-xs'
                      : 'text-[#64748B] hover:text-[#172033]'
                  }`}
                >
                  Manual
                </button>
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2">
              {QUALITY_PROFILE_ORDER.map((profileId) => {
                const prof = QUALITY_PROFILES[profileId];
                const selected = resolveProfileIdFromPreferences(preferences) === profileId;
                return (
                  <button
                    key={profileId}
                    type="button"
                    onClick={() =>
                      onUpdatePreferences(applyQualityProfileToPreferences(preferences, profileId))
                    }
                    className={`rounded-lg border px-3 py-2 text-left transition-colors ${
                      selected
                        ? 'border-[#2563EB] bg-[#EFF6FF]'
                        : 'border-[#E2E8F0] bg-[#F8FAFC] hover:border-[#2563EB]/60'
                    }`}
                  >
                    <div className="flex items-center justify-between text-xs font-semibold text-[#172033]">
                      <span className={selected ? 'text-[#2563EB]' : ''}>{prof.label}</span>
                      {prof.isDefault && (
                        <span className="text-[10px] font-medium text-[#64748B]">Default</span>
                      )}
                    </div>
                    <div className="mt-0.5 text-[11px] text-[#64748B] tabular-metrics">
                      {prof.specLabel}
                    </div>
                  </button>
                );
              })}
            </div>

            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between">
                <dt className="text-[#64748B]">Default Resolution</dt>
                <dd className="font-mono font-medium text-[#172033]">
                  {preferences.resolution.toUpperCase()}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#64748B]">Default Target Frame Rate</dt>
                <dd className="font-mono font-medium text-[#172033] tabular-metrics">
                  {preferences.targetFps} FPS
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#64748B]">Target Max Bitrate</dt>
                <dd className="font-mono font-medium text-[#172033] tabular-metrics">
                  {((preferences.maxBitrateKbps ?? 10_000) / 1000).toFixed(1)} Mbps
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#64748B]">Quality Mode</dt>
                <dd className="font-mono font-medium text-[#172033]">
                  {preferences.adaptiveBitrate !== false ? 'Auto (Adaptive getStats)' : 'Manual (Locked)'}
                </dd>
              </div>
              <div className="flex items-center justify-between">
                <dt className="text-[#64748B]">Codec Policy</dt>
                <dd className="font-mono font-medium text-[#172033]">
                  {preferences.codecPreference}
                </dd>
              </div>
            </dl>
            <button
              type="button"
              onClick={() => {
                onUpdatePreferences({
                  resolution: '1080p',
                  targetFps: 60,
                  codecPreference: 'H264',
                  includeAudio: true,
                  maxBitrateKbps: 10_000,
                  adaptiveBitrate: true,
                });
                onLogEvent(
                  'ui',
                  'Capture defaults restored',
                  'Reset capture defaults to High (1080p @ 60 FPS target, 10 Mbps, Auto mode, H264).'
                );
              }}
              className="min-h-[38px] rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
            >
              Restore High (1080p60) Defaults
            </button>
          </div>

          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2.5">
              <h2 className="text-sm font-semibold text-[#172033]">Network &amp; ICE Servers</h2>
              <div className="flex items-center gap-2">
                <SignalBadge
                  label={
                    (networkPrefs.turnConfigured ?? backendHealth?.turnConfigured)
                      ? 'TURN Active'
                      : 'STUN Only'
                  }
                  tone={
                    (networkPrefs.turnConfigured ?? backendHealth?.turnConfigured)
                      ? 'active'
                      : 'standby'
                  }
                />
                {onRefreshIceConfig && (
                  <button
                    type="button"
                    onClick={onRefreshIceConfig}
                    className="inline-flex h-7 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2 text-[11px] font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                  >
                    <RefreshCw className="h-3 w-3" aria-hidden="true" />
                    <span>Refresh</span>
                  </button>
                )}
              </div>
            </div>

            <div className="rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-xs space-y-1.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-[#64748B]">Server Relay Provisioning</span>
                <span className="font-mono font-semibold text-[#172033]">
                  {(networkPrefs.turnMode ?? backendHealth?.turnMode ?? 'disabled') ===
                  'ephemeral-hmac'
                    ? 'Temporary HMAC Credentials'
                    : (networkPrefs.turnMode ?? backendHealth?.turnMode) === 'static'
                      ? 'Server Static TURN'
                      : 'Disabled (STUN Fallback)'}
                </span>
              </div>
              {networkPrefs.turnTransports && networkPrefs.turnTransports.length > 0 && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#64748B]">Configured Transports</span>
                  <span className="font-mono text-[#172033] uppercase">
                    {networkPrefs.turnTransports.join(', ')}
                  </span>
                </div>
              )}
              {networkPrefs.turnExpiresAt && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[#64748B]">Credential Expiry</span>
                  <span className="font-mono text-[#172033] tabular-metrics">
                    {new Date(networkPrefs.turnExpiresAt).toLocaleTimeString()}
                  </span>
                </div>
              )}
              <p className="pt-1 text-[11px] leading-relaxed text-[#64748B]">
                {(networkPrefs.turnConfigured ?? backendHealth?.turnConfigured)
                  ? 'Approved room members automatically receive short-lived TURN credentials from GET /api/ice-servers.'
                  : 'No backend TURN server is configured. Castora Pro uses STUN + LAN P2P fallback. See docs/TURN_SETUP.md to enable UDP/TCP/TLS TURN relay.'}
              </p>
            </div>

            <button
              type="button"
              onClick={() => {
                const next = !networkPrefs.preferLanDirectP2P;
                onUpdateNetworkPrefs({ ...networkPrefs, preferLanDirectP2P: next });
                onLogEvent(
                  'ui',
                  'LAN P2P preference changed',
                  next ? 'Prefer LAN direct host candidates' : 'Allow full ICE relay negotiation'
                );
              }}
              className="flex min-h-[44px] w-full items-center justify-between rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 text-xs"
            >
              <span className="font-medium text-[#172033]">Prefer LAN Direct Host Candidates</span>
              <span className="font-mono font-semibold text-[#2563EB]">
                {networkPrefs.preferLanDirectP2P ? 'ENABLED' : 'STANDARD ICE'}
              </span>
            </button>

            <div className="space-y-3">
              <div>
                <label
                  htmlFor="castora-stun-urls"
                  className="block text-xs font-medium text-[#64748B]"
                >
                  STUN Server URLs (comma-separated)
                </label>
                <input
                  id="castora-stun-urls"
                  type="text"
                  value={networkPrefs.stunUrls}
                  onChange={(e) =>
                    onUpdateNetworkPrefs({ ...networkPrefs, stunUrls: e.target.value })
                  }
                  placeholder="stun:stun.l.google.com:19302"
                  className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 font-mono text-xs text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                />
              </div>

              <div>
                <label
                  htmlFor="castora-turn-url"
                  className="block text-xs font-medium text-[#64748B]"
                >
                  TURN Server URL (optional cross-network relay)
                </label>
                <input
                  id="castora-turn-url"
                  type="text"
                  value={networkPrefs.turnUrl}
                  onChange={(e) =>
                    onUpdateNetworkPrefs({ ...networkPrefs, turnUrl: e.target.value })
                  }
                  placeholder="turn:relay.example.com:3478"
                  className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 font-mono text-xs text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                />
              </div>

              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                <div>
                  <label
                    htmlFor="castora-turn-user"
                    className="block text-xs font-medium text-[#64748B]"
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
                    className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 font-mono text-xs text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                  />
                </div>
                <div>
                  <label
                    htmlFor="castora-turn-cred"
                    className="block text-xs font-medium text-[#64748B]"
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
                    className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 font-mono text-xs text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                  />
                </div>
              </div>
              <p className="text-xs leading-relaxed text-[#64748B]">
                STUN supports standard NATs and LAN discovery. Networks with symmetric NAT or client isolation require a TURN relay. Credentials remain in memory only.
              </p>
            </div>
          </div>
        </div>

        {/* Right Column: HTTPS Readiness & Browser Inspector */}
        <div className="space-y-6 lg:col-span-6">
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2.5">
              <div className="flex items-center gap-2">
                {capabilities.isSecureContext ? (
                  <ShieldCheck className="h-4 w-4 text-[#16A34A]" aria-hidden="true" />
                ) : (
                  <ShieldAlert className="h-4 w-4 text-[#D97706]" aria-hidden="true" />
                )}
                <h2 className="text-sm font-semibold text-[#172033]">HTTPS &amp; LAN Trust</h2>
              </div>
              <SignalBadge
                label={capabilities.isSecureContext ? 'Secure Context' : 'Non-Secure Origin'}
                tone={capabilities.isSecureContext ? 'active' : 'warn'}
              />
            </div>

            <dl className="space-y-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#64748B]">Active Origin</dt>
                <dd className="truncate font-mono text-[#172033]">{capabilities.origin || '—'}</dd>
              </div>
              <div className="flex items-center justify-between gap-2">
                <dt className="text-[#64748B]">window.isSecureContext</dt>
                <dd className="font-mono text-[#172033]">
                  {capabilities.isSecureContext ? 'true' : 'false'}
                </dd>
              </div>
            </dl>

            <div className="rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-3.5 space-y-2 text-xs leading-relaxed text-[#64748B]">
              <div className="font-semibold text-[#172033]">
                Local LAN HTTPS Setup (docs/SECURE_LAN_HTTPS.md)
              </div>
              <ol className="list-decimal space-y-1 pl-4">
                <li>
                  Generate a local trusted certificate via{' '}
                  <code className="font-mono text-[#172033]">mkcert -install</code> and{' '}
                  <code className="font-mono text-[#172033]">mkcert localhost &lt;LAN-IP&gt;</code>.
                </li>
                <li>
                  Install <code className="font-mono text-[#172033]">rootCA.pem</code> on mobile devices when testing over local Wi-Fi.
                </li>
                <li>
                  Production deployments over HTTPS automatically use secure{' '}
                  <code className="font-mono text-[#172033]">wss://</code> signaling on{' '}
                  <code className="font-mono text-[#172033]">/castora</code>.
                </li>
              </ol>
            </div>
          </div>

          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4">
            <div className="flex items-center justify-between border-b border-[#E2E8F0] pb-2.5">
              <h2 className="text-sm font-semibold text-[#172033]">Browser Capabilities</h2>
              <button
                type="button"
                onClick={onReprobeCapabilities}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
              >
                <RefreshCw className="h-3.5 w-3.5" aria-hidden="true" />
                <span>Refresh</span>
              </button>
            </div>

            <dl className="divide-y divide-[#E2E8F0] text-xs">
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#64748B]">Browser Runtime</dt>
                <dd className="font-medium text-[#172033]">{capabilities.userAgentSummary}</dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#64748B]">getDisplayMedia()</dt>
                <dd className="font-mono text-[#172033]">
                  {capabilities.supportsDisplayMedia ? 'Available' : 'Unavailable'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#64748B]">RTCPeerConnection</dt>
                <dd className="font-mono text-[#172033]">
                  {capabilities.supportsRtcPeerConnection ? 'Available' : 'Unavailable'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#64748B]">H.264 Encode / Decode</dt>
                <dd className="font-mono text-[#172033]">
                  {capabilities.supportsVideoH264Encode ? 'ENC YES' : 'ENC NO'} ·{' '}
                  {capabilities.supportsVideoH264Decode ? 'DEC YES' : 'DEC NO'}
                </dd>
              </div>
              <div className="flex items-center justify-between py-2.5">
                <dt className="text-[#64748B]">Fullscreen API</dt>
                <dd className="font-mono text-[#172033]">
                  {capabilities.supportsFullscreen ? 'Supported' : 'Restricted'}
                </dd>
              </div>
              <div className="py-2.5">
                <dt className="text-[#64748B]">Detected Video Codecs</dt>
                <dd className="mt-1 font-mono text-xs leading-relaxed text-[#172033]">
                  {capabilities.detectedVideoCodecs.length > 0
                    ? capabilities.detectedVideoCodecs.join(', ')
                    : 'None detected'}
                </dd>
              </div>
            </dl>
          </div>
        </div>
      </div>

      {onClearActivityEvents && (
        <ActivityView
          events={activityEvents}
          onClearEvents={onClearActivityEvents}
          embedded
        />
      )}
    </div>
  );
}
