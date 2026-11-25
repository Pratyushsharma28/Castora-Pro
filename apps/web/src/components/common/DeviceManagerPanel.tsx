import { useMemo, useState } from 'react';
import {
  Check,
  Edit3,
  Eye,
  Lock,
  Monitor,
  RefreshCw,
  RotateCcw,
  Search,
  ShieldCheck,
  Smartphone,
  Square,
  Trash2,
  Tv,
  Unlock,
  Users,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react';
import type { RoomSnapshot, SignalingSocketState } from '../../services/backendClient';
import { validateDeviceDisplayName } from '../../services/browserCapabilities';
import { evaluateConnectionQuality } from '../../services/streamingDiagnosticsService';
import type { WebRtcSessionSnapshot } from '../../services/webrtcSignalingBridge';
import type {
  BrowserCapabilityReport,
  CapturePreferences,
  DetectedDeviceType,
  DeviceManagerStatusFilter,
  ManagedDeviceRecord,
  StudioDestination,
} from '../../types/studio';
import { SignalBadge, type SignalTone } from './SignalBadge';

interface DeviceManagerPanelProps {
  deviceId: string;
  deviceName: string;
  capabilities: BrowserCapabilityReport;
  preferences: CapturePreferences;
  signalingState: SignalingSocketState;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  webrtcState: WebRtcSessionSnapshot;
  mutedByPeerId: Record<string, boolean>;
  isLoading?: boolean;
  onRenameDevice: (targetDeviceId: string, newName: string) => Promise<void>;
  onApproveReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onRejectReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onRemoveReceiver: (receiverDeviceId: string) => Promise<RoomSnapshot>;
  onStopDeviceStream: (
    targetDeviceId: string,
    mode: 'outbound-to-peer' | 'participant-room-stream'
  ) => Promise<void>;
  onReconnectDevice: (targetDeviceId: string) => Promise<void>;
  onToggleMutePeer: (peerDeviceId: string) => void;
  onToggleAdaptiveLock: (
    targetDeviceId: string,
    isSelf: boolean,
    nextLocked: boolean
  ) => Promise<void>;
  onViewStream?: (senderDeviceId: string) => void;
  onRefresh?: () => Promise<void> | void;
  onReconnectBackend?: () => void;
  lastSignalingActivityAt?: string | null;
  onNavigate?: (destination: StudioDestination) => void;
}

const FILTER_OPTIONS: { id: DeviceManagerStatusFilter; label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'connected', label: 'Connected' },
  { id: 'streaming', label: 'Streaming' },
  { id: 'attention', label: 'Needs Attention' },
  { id: 'disconnected', label: 'Disconnected' },
  { id: 'pending', label: 'Pending' },
];

function formatBitrate(kbps: number | null): string {
  if (kbps === null || !Number.isFinite(kbps)) return 'Unavailable';
  return kbps >= 1000 ? `${(kbps / 1000).toFixed(2)} Mbps` : `${Math.round(kbps)} kbps`;
}

function formatLastActivity(isoOrNull: string | null): string {
  if (!isoOrNull) return 'Unknown';
  const parsed = Date.parse(isoOrNull);
  if (!Number.isFinite(parsed)) return 'Unknown';
  const diffSec = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return new Date(parsed).toLocaleTimeString();
}

function latestIso(a?: string | null, bMs?: number | null): string | null {
  const aMs = a ? Date.parse(a) : NaN;
  const hasA = Number.isFinite(aMs);
  const hasB = typeof bMs === 'number' && Number.isFinite(bMs) && bMs > 0;
  if (hasA && hasB) return new Date(Math.max(aMs, bMs)).toISOString();
  if (hasB) return new Date(bMs).toISOString();
  if (hasA) return new Date(aMs).toISOString();
  return null;
}

function DeviceTypeIcon({ deviceType }: { deviceType: DetectedDeviceType }) {
  switch (deviceType) {
    case 'TV':
      return <Tv className="h-4 w-4 text-[#64748B]" aria-hidden="true" />;
    case 'iPhone':
    case 'iPad':
    case 'Android':
      return <Smartphone className="h-4 w-4 text-[#64748B]" aria-hidden="true" />;
    default:
      return <Monitor className="h-4 w-4 text-[#64748B]" aria-hidden="true" />;
  }
}

function connectionBadgeForRecord(rec: ManagedDeviceRecord): {
  label: string;
  tone: SignalTone;
  pulse?: boolean;
} {
  if (rec.role === 'pending') {
    return { label: 'Pending Approval', tone: 'signal', pulse: true };
  }
  if (!rec.connected && rec.connectionPhase === 'disconnected') {
    return { label: 'Disconnected', tone: 'warn' };
  }
  switch (rec.connectionPhase) {
    case 'connected':
      return {
        label: rec.isIncomingStreaming || rec.isOutgoingStreaming ? 'Connected · Live' : 'Connected',
        tone: 'active',
      };
    case 'connecting':
      return { label: 'Connecting', tone: 'signal', pulse: true };
    case 'reconnecting':
      return { label: 'Reconnecting', tone: 'warn', pulse: true };
    case 'failed':
      return { label: 'Failed', tone: 'fault' };
    case 'disconnected':
      return { label: 'Disconnected', tone: 'warn' };
    default:
      return rec.connected
        ? { label: 'Connected', tone: 'active' }
        : { label: 'Disconnected', tone: 'warn' };
  }
}

export function DeviceManagerPanel({
  deviceId,
  deviceName,
  capabilities,
  preferences,
  signalingState,
  activeRoom,
  activeRoomRole,
  webrtcState,
  mutedByPeerId,
  isLoading = false,
  onRenameDevice,
  onApproveReceiver,
  onRejectReceiver,
  onRemoveReceiver,
  onStopDeviceStream,
  onReconnectDevice,
  onToggleMutePeer,
  onToggleAdaptiveLock,
  onViewStream,
  onRefresh,
  onReconnectBackend,
  lastSignalingActivityAt = null,
  onNavigate,
}: DeviceManagerPanelProps) {
  const [searchQuery, setSearchQuery] = useState('');
  const [statusFilter, setStatusFilter] = useState<DeviceManagerStatusFilter>('all');
  const [editingDeviceId, setEditingDeviceId] = useState<string | null>(null);
  const [draftName, setDraftName] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [busyDeviceId, setBusyDeviceId] = useState<string | null>(null);
  const [refreshBusy, setRefreshBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ tone: 'info' | 'error'; text: string } | null>(null);

  const isHost = activeRoomRole === 'host';
  const maxReceivers = activeRoom?.maxReceivers ?? 15;
  const pairedReceivers = activeRoom?.pairedReceivers ?? [];
  const pendingRequests = activeRoom?.pendingRequests ?? [];
  const pairedCount = pairedReceivers.length;
  const availableSlots = Math.max(0, maxReceivers - pairedCount);
  const roomFull = pairedCount >= maxReceivers;

  const deviceRecords = useMemo<ManagedDeviceRecord[]>(() => {
    const serverStreams = activeRoom?.activeStreams ?? [];

    if (!activeRoom) {
      const localPhase =
        signalingState === 'connected'
          ? webrtcState.isSharingLocal
            ? 'connected'
            : 'idle'
          : signalingState === 'connecting'
            ? 'connecting'
            : signalingState === 'error'
              ? 'failed'
              : 'disconnected';
      const selfQuality =
        webrtcState.outboundPeers.length > 0
          ? evaluateConnectionQuality({
              phase: webrtcState.outboundPeers[0].phase,
              iceConnectionState: webrtcState.outboundPeers[0].iceConnectionState,
              telemetry: webrtcState.outboundPeers[0].telemetry,
              recovery: webrtcState.outboundPeers[0].recovery,
            })
          : signalingState === 'connected' && webrtcState.isSharingLocal
            ? { label: 'Local capture', tone: 'active' as const, detail: 'Capturing locally without remote peer.' }
            : { label: 'Unknown', tone: 'standby' as const, detail: 'No active WebRTC peer telemetry yet.' };

      const capW = webrtcState.localCaptureMeta?.width;
      const capH = webrtcState.localCaptureMeta?.height;
      const capFps = webrtcState.localCaptureMeta?.fps;
      const latestOutActivity = webrtcState.outboundPeers.reduce<number | null>(
        (max, o) => (o.lastActivityAt && (!max || o.lastActivityAt > max) ? o.lastActivityAt : max),
        null
      );

      return [
        {
          deviceId,
          deviceName,
          role: 'participant',
          isSelf: true,
          platform: capabilities.detectedPlatform,
          deviceType: capabilities.detectedDeviceType ?? 'Unknown',
          slotIndex: null,
          connected: signalingState === 'connected',
          connectionPhase: localPhase,
          connectionQualityLabel: selfQuality.label,
          connectionQualityTone: selfQuality.tone,
          connectionQualityDetail: selfQuality.detail,
          isIncomingStreaming: false,
          isOutgoingStreaming: webrtcState.isSharingLocal,
          resolution:
            webrtcState.outboundTelemetry.resolution ??
            (capW && capH ? `${capW}×${capH}` : null),
          fps: webrtcState.outboundTelemetry.encodedFps ?? capFps ?? null,
          bitrateKbps: webrtcState.outboundTelemetry.bitrateKbps,
          packetLossPct: webrtcState.outboundTelemetry.packetLossPct ?? null,
          audioStatus: webrtcState.isSharingLocal
            ? preferences.includeAudio || webrtcState.localCaptureMeta?.hasAudio
              ? 'Sharing audio'
              : 'Video only'
            : 'Off',
          hasIncomingAudioTrack: false,
          incomingMuted: true,
          adaptiveLocked: preferences.adaptiveBitrate === false,
          lastActivityAt: latestIso(lastSignalingActivityAt, latestOutActivity),
          canRetry: signalingState === 'disconnected' || signalingState === 'error',
          recoveryExhausted: false,
        },
      ];
    }

    const records: ManagedDeviceRecord[] = [];

    const buildRecord = (params: {
      id: string;
      name: string;
      role: 'host' | 'participant' | 'pending';
      platform: ManagedDeviceRecord['platform'];
      deviceType?: DetectedDeviceType;
      slotIndex: number | null;
      connected: boolean;
      serverLastSeenAt?: string;
    }): ManagedDeviceRecord => {
      const isSelf = params.id === deviceId;
      const incoming = !isSelf
        ? webrtcState.incomingStreams.find((s) => s.senderDeviceId === params.id) ?? null
        : null;
      const outbound = !isSelf
        ? webrtcState.outboundPeers.find((o) => o.targetDeviceId === params.id) ?? null
        : null;
      const serverPublishedStreams = serverStreams.filter((s) => s.publisherDeviceId === params.id);
      const primaryServerStream = serverPublishedStreams[0] ?? null;

      if (isSelf) {
        const localStreaming = webrtcState.isSharingLocal || serverPublishedStreams.length > 0;
        const capW = webrtcState.localCaptureMeta?.width;
        const capH = webrtcState.localCaptureMeta?.height;
        const capFps = webrtcState.localCaptureMeta?.fps;
        const primaryOut = webrtcState.outboundPeers[0] ?? null;
        const latestOutActivity = webrtcState.outboundPeers.reduce<number | null>(
          (max, o) => (o.lastActivityAt && (!max || o.lastActivityAt > max) ? o.lastActivityAt : max),
          null
        );
        const localPhase = primaryOut?.phase ?? (params.connected ? 'connected' : 'disconnected');
        const selfQuality = primaryOut
          ? evaluateConnectionQuality({
              phase: primaryOut.phase,
              iceConnectionState: primaryOut.iceConnectionState,
              telemetry: primaryOut.telemetry,
              recovery: primaryOut.recovery,
            })
          : {
              label: 'Unknown',
              tone: 'standby' as const,
              detail: params.connected
                ? 'Signaling connected; no active WebRTC peer telemetry yet.'
                : 'Signaling disconnected.',
            };

        const selfHasAudio =
          webrtcState.localCaptureMeta?.hasAudio ||
          preferences.includeAudio ||
          Boolean(primaryServerStream?.hasAudio);

        return {
          deviceId: params.id,
          deviceName: params.name,
          role: params.role,
          isSelf: true,
          platform: params.platform,
          deviceType:
            params.deviceType && params.deviceType !== 'Unknown'
              ? params.deviceType
              : capabilities.detectedDeviceType ?? 'Unknown',
          slotIndex: params.slotIndex,
          connected: params.connected,
          connectionPhase: localPhase,
          connectionQualityLabel: selfQuality.label,
          connectionQualityTone: selfQuality.tone,
          connectionQualityDetail: selfQuality.detail,
          isIncomingStreaming: false,
          isOutgoingStreaming: localStreaming,
          resolution:
            webrtcState.outboundTelemetry.resolution ??
            (capW && capH ? `${capW}×${capH}` : null) ??
            (primaryServerStream
              ? `${primaryServerStream.width}×${primaryServerStream.height}`
              : null),
          fps:
            webrtcState.outboundTelemetry.encodedFps ??
            webrtcState.outboundTelemetry.captureFps ??
            capFps ??
            primaryServerStream?.fps ??
            null,
          bitrateKbps: webrtcState.outboundTelemetry.bitrateKbps,
          packetLossPct: webrtcState.outboundTelemetry.packetLossPct ?? null,
          audioStatus: localStreaming ? (selfHasAudio ? 'Sharing audio' : 'Video only') : 'Off',
          hasIncomingAudioTrack: false,
          incomingMuted: true,
          adaptiveLocked: preferences.adaptiveBitrate === false,
          lastActivityAt: latestIso(
            params.serverLastSeenAt,
            latestOutActivity
          ),
          canRetry: signalingState !== 'connected',
          recoveryExhausted: false,
        };
      }

      const phase =
        incoming?.phase ??
        outbound?.phase ??
        (params.role === 'pending'
          ? 'connecting'
          : params.connected
            ? 'idle'
            : 'disconnected');
      const recovery = incoming?.recovery ?? outbound?.recovery ?? null;
      const telemetry = incoming?.telemetry ?? outbound?.telemetry ?? null;
      const iceState = incoming?.iceConnectionState ?? outbound?.iceConnectionState ?? null;
      const quality =
        incoming || outbound
          ? evaluateConnectionQuality({
              phase,
              iceConnectionState: iceState,
              telemetry,
              recovery,
            })
          : {
              label: 'Unknown',
              tone: 'standby' as const,
              detail: params.connected
                ? 'No active WebRTC telemetry session with this device yet.'
                : 'Device disconnected.',
            };

      const isIncomingStreaming =
        Boolean(incoming?.stream) ||
        serverPublishedStreams.some((s) => s.targetDeviceId === deviceId);
      const isOutgoingStreaming = Boolean(outbound);
      const hasIncomingAudioTrack = Boolean(incoming?.stream?.getAudioTracks().length);
      const incomingMuted = mutedByPeerId[params.id] ?? false;

      const resolution =
        incoming?.telemetry.resolution ??
        outbound?.telemetry.resolution ??
        (primaryServerStream
          ? `${primaryServerStream.width}×${primaryServerStream.height}`
          : null);
      const fps =
        incoming?.telemetry.decodedFps ??
        outbound?.telemetry.encodedFps ??
        incoming?.streamMeta?.fps ??
        primaryServerStream?.fps ??
        null;
      const bitrateKbps =
        incoming?.telemetry.bitrateKbps ?? outbound?.telemetry.bitrateKbps ?? null;
      const packetLossPct =
        incoming?.telemetry.packetLossPct ?? outbound?.telemetry.packetLossPct ?? null;

      let audioStatus: ManagedDeviceRecord['audioStatus'] = 'Off';
      if (isIncomingStreaming) {
        if (incoming?.stream) {
          audioStatus = hasIncomingAudioTrack ? 'Sharing audio' : 'Video only';
        } else if (typeof primaryServerStream?.hasAudio === 'boolean') {
          audioStatus = primaryServerStream.hasAudio ? 'Sharing audio' : 'Video only';
        } else {
          audioStatus = 'Unavailable';
        }
      } else if (serverPublishedStreams.length > 0) {
        audioStatus =
          typeof primaryServerStream?.hasAudio === 'boolean'
            ? primaryServerStream.hasAudio
              ? 'Sharing audio'
              : 'Video only'
            : 'Unavailable';
      } else if (isOutgoingStreaming) {
        audioStatus =
          preferences.includeAudio || webrtcState.localCaptureMeta?.hasAudio
            ? 'Sharing audio'
            : 'Video only';
      }

      const adaptiveLocked = outbound
        ? (outbound.qualityOverride?.adaptiveBitrate ?? preferences.adaptiveBitrate ?? true) === false
        : null;

      const canRetry =
        params.role !== 'pending' &&
        params.connected &&
        (phase === 'failed' ||
          phase === 'disconnected' ||
          Boolean(recovery?.exhausted) ||
          isHost);

      return {
        deviceId: params.id,
        deviceName: params.name,
        role: params.role,
        isSelf: false,
        platform: params.platform,
        deviceType: params.deviceType ?? 'Unknown',
        slotIndex: params.slotIndex,
        connected: params.connected,
        connectionPhase: phase,
        connectionQualityLabel: quality.label,
        connectionQualityTone: quality.tone,
        connectionQualityDetail: quality.detail,
        isIncomingStreaming,
        isOutgoingStreaming,
        resolution,
        fps,
        bitrateKbps,
        packetLossPct,
        audioStatus,
        hasIncomingAudioTrack,
        incomingMuted,
        adaptiveLocked,
        lastActivityAt: latestIso(
          params.serverLastSeenAt,
          incoming?.lastActivityAt ?? outbound?.lastActivityAt ?? null
        ),
        canRetry,
        recoveryExhausted: Boolean(recovery?.exhausted),
      };
    };

    records.push(
      buildRecord({
        id: activeRoom.hostDeviceId,
        name: activeRoom.hostDeviceName,
        role: 'host',
        platform: activeRoom.hostPlatform,
        deviceType: activeRoom.hostDeviceType,
        slotIndex: null,
        connected: activeRoom.hostConnected,
        serverLastSeenAt: activeRoom.hostLastSeenAt,
      })
    );

    for (const rx of pairedReceivers) {
      records.push(
        buildRecord({
          id: rx.deviceId,
          name: rx.deviceName,
          role: 'participant',
          platform: rx.platform,
          deviceType: rx.deviceType,
          slotIndex: rx.assignedSlotIndex,
          connected: rx.connected,
          serverLastSeenAt: rx.lastSeenAt ?? rx.pairedAt,
        })
      );
    }

    for (const req of pendingRequests) {
      records.push(
        buildRecord({
          id: req.deviceId,
          name: req.deviceName,
          role: 'pending',
          platform: req.platform,
          deviceType: req.deviceType,
          slotIndex: null,
          connected: req.connected,
          serverLastSeenAt: req.lastSeenAt ?? req.requestedAt,
        })
      );
    }

    return records;
  }, [
    activeRoom,
    capabilities.detectedDeviceType,
    capabilities.detectedPlatform,
    deviceId,
    deviceName,
    lastSignalingActivityAt,
    mutedByPeerId,
    pairedReceivers,
    pendingRequests,
    preferences.adaptiveBitrate,
    preferences.includeAudio,
    signalingState,
    webrtcState,
  ]);

  const connectedDevicesCount = useMemo(
    () =>
      activeRoom
        ? deviceRecords.filter((d) => d.role !== 'pending' && d.connected).length
        : signalingState === 'connected'
          ? 1
          : 0,
    [activeRoom, deviceRecords, signalingState]
  );

  const filteredDevices = useMemo(() => {
    const q = searchQuery.trim().toLowerCase();
    return deviceRecords.filter((rec) => {
      if (q) {
        const matchesQuery =
          rec.deviceName.toLowerCase().includes(q) ||
          rec.deviceId.toLowerCase().includes(q) ||
          rec.deviceType.toLowerCase().includes(q);
        if (!matchesQuery) return false;
      }

      switch (statusFilter) {
        case 'connected':
          return rec.role !== 'pending' && rec.connected;
        case 'streaming':
          return (
            rec.isIncomingStreaming ||
            rec.isOutgoingStreaming ||
            Boolean(activeRoom?.activeStreams?.some((s) => s.publisherDeviceId === rec.deviceId))
          );
        case 'attention':
          return (
            rec.connectionPhase === 'failed' ||
            rec.connectionPhase === 'reconnecting' ||
            rec.recoveryExhausted ||
            !rec.connected
          );
        case 'disconnected':
          return rec.role !== 'pending' && !rec.connected;
        case 'pending':
          return rec.role === 'pending';
        default:
          return true;
      }
    });
  }, [activeRoom?.activeStreams, deviceRecords, searchQuery, statusFilter]);

  const startEditingName = (rec: ManagedDeviceRecord) => {
    setEditingDeviceId(rec.deviceId);
    setDraftName(rec.deviceName);
    setRenameError(null);
    setFeedback(null);
  };

  const cancelEditingName = () => {
    setEditingDeviceId(null);
    setDraftName('');
    setRenameError(null);
  };

  const submitRename = async (targetDeviceId: string) => {
    const clientValidation = validateDeviceDisplayName(draftName);
    if (clientValidation) {
      setRenameError(clientValidation);
      return;
    }
    const cleaned = draftName.replace(/\s+/g, ' ').trim();
    setBusyDeviceId(targetDeviceId);
    setRenameError(null);
    try {
      await onRenameDevice(targetDeviceId, cleaned);
      setEditingDeviceId(null);
      setDraftName('');
      setFeedback({ tone: 'info', text: `Device renamed to "${cleaned}".` });
    } catch (err) {
      setRenameError(err instanceof Error ? err.message : 'Unable to rename device');
    } finally {
      setBusyDeviceId(null);
    }
  };

  const runAction = async (targetId: string, fn: () => Promise<void>, successMessage: string) => {
    setBusyDeviceId(targetId);
    setFeedback(null);
    try {
      await fn();
      setFeedback({ tone: 'info', text: successMessage });
    } catch (err) {
      setFeedback({
        tone: 'error',
        text: err instanceof Error ? err.message : 'Device control request failed',
      });
    } finally {
      setBusyDeviceId(null);
    }
  };

  const handleRefresh = async () => {
    if (!onRefresh) return;
    setRefreshBusy(true);
    try {
      await onRefresh();
    } finally {
      setRefreshBusy(false);
    }
  };

  return (
    <section
      data-castora-chrome
      aria-label="Advanced Device Management System"
      className="space-y-5"
    >
      {/* Top 4-Cell Capacity & Status Strip (zero pills, single level elevation) */}
      <div className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
        <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] px-5 py-4">
          <div className="flex items-center gap-2.5">
            <Users className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
            <div>
              <h2 className="font-display text-base font-semibold text-[#172033]">
                Device Manager
              </h2>
              <p className="text-xs text-[#64748B]">
                {activeRoom
                  ? `Room ${activeRoom.roomId} · Role: ${isHost ? 'Host (Full Control)' : 'Participant (Self Controls)'}`
                  : 'Standalone device profile — create or join a room to manage connected devices.'}
              </p>
            </div>
          </div>

          <div className="flex items-center gap-2">
            {onRefresh && (
              <button
                type="button"
                disabled={refreshBusy || isLoading}
                onClick={() => void handleRefresh()}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
              >
                <RefreshCw
                  className={`h-3.5 w-3.5 ${refreshBusy || isLoading ? 'animate-spin' : ''}`}
                  aria-hidden="true"
                />
                <span>Refresh</span>
              </button>
            )}
            {!activeRoom && onNavigate && (
              <button
                type="button"
                onClick={() => onNavigate('receivers')}
                className="inline-flex h-8 items-center gap-1.5 rounded-lg bg-[#2563EB] px-3 text-xs font-semibold text-white hover:bg-[#1D4ED8]"
              >
                <span>Open Rooms</span>
              </button>
            )}
          </div>
        </div>

        <div className="grid grid-cols-2 divide-x divide-y divide-[#E2E8F0] bg-[#F8FAFC] sm:grid-cols-4 sm:divide-y-0">
          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Connected Devices</div>
            <div className="mt-1 text-lg font-semibold text-[#172033] tabular-metrics">
              {connectedDevicesCount}
            </div>
          </div>
          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Paired Slots</div>
            <div className="mt-1 text-lg font-semibold text-[#172033] tabular-metrics">
              {activeRoom ? `${pairedCount} / ${maxReceivers}` : '0 / 15'}
            </div>
          </div>
          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Pending Requests</div>
            <div className="mt-1 text-lg font-semibold text-[#172033] tabular-metrics">
              {activeRoom ? pendingRequests.length : 0}
            </div>
          </div>
          <div className="px-5 py-3.5">
            <div className="text-xs font-medium text-[#64748B]">Available Slots</div>
            <div className="mt-1 text-lg font-semibold text-[#172033] tabular-metrics">
              {activeRoom ? (roomFull ? '0 (Full)' : availableSlots) : 15}
            </div>
          </div>
        </div>
      </div>

      {feedback && (
        <div
          role={feedback.tone === 'error' ? 'alert' : 'status'}
          className={`flex items-center justify-between gap-3 rounded-xl border px-4 py-3 text-xs ${
            feedback.tone === 'error'
              ? 'border-[#DC2626]/30 bg-[#FEF2F2] text-[#B91C1C]'
              : 'border-[#E2E8F0] bg-white text-[#172033]'
          }`}
        >
          <span>{feedback.text}</span>
          <button
            type="button"
            onClick={() => setFeedback(null)}
            aria-label="Dismiss notification"
            className="text-[#64748B] hover:text-[#172033]"
          >
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
      )}

      {/* Host Pending Requests Queue */}
      {activeRoom && (isHost || pendingRequests.length > 0) && (
        <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
          <div className="flex flex-wrap items-center justify-between gap-2 border-b border-[#E2E8F0] pb-3">
            <div className="flex items-center gap-2">
              <ShieldCheck className="h-4 w-4 text-[#2563EB]" aria-hidden="true" />
              <h3 className="text-sm font-semibold text-[#172033]">
                Pending Approval Requests
              </h3>
            </div>
            <span className="text-xs text-[#64748B] tabular-metrics">
              {pendingRequests.length} waiting · {availableSlots} slots free
            </span>
          </div>

          {pendingRequests.length === 0 ? (
            <p className="mt-3 text-xs leading-relaxed text-[#64748B]">
              No pending join requests. Devices requesting room code{' '}
              <span className="font-mono font-semibold text-[#172033]">{activeRoom.roomId}</span>{' '}
              appear here for explicit host approval.
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-[#E2E8F0]">
              {pendingRequests.map((req) => {
                const isBusy = busyDeviceId === req.deviceId;
                return (
                  <li
                    key={req.deviceId}
                    className="flex flex-col gap-3 py-3 sm:flex-row sm:items-center sm:justify-between"
                  >
                    <div className="min-w-0 space-y-0.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="truncate text-sm font-semibold text-[#172033]">
                          {req.deviceName}
                        </span>
                        <span className="text-xs text-[#64748B]">
                          Type: {req.deviceType ?? 'Unknown'}
                        </span>
                      </div>
                      <div className="text-xs text-[#64748B] tabular-metrics">
                        {req.deviceId} · Requested {new Date(req.requestedAt).toLocaleTimeString()} ·{' '}
                        {req.connected ? 'Socket active' : 'Socket disconnected'}
                      </div>
                    </div>

                    {isHost ? (
                      <div className="flex items-center gap-2 shrink-0">
                        <button
                          type="button"
                          disabled={isBusy || roomFull}
                          title={roomFull ? 'Room capacity (6 paired devices) reached' : 'Approve device'}
                          onClick={() =>
                            void runAction(
                              req.deviceId,
                              async () => {
                                await onApproveReceiver(req.deviceId);
                              },
                              `Approved ${req.deviceName} into room.`
                            )
                          }
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg bg-[#16A34A] px-3 text-xs font-semibold text-white hover:bg-[#15803D] disabled:opacity-50"
                        >
                          <Check className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>{roomFull ? 'Room Full' : 'Approve'}</span>
                        </button>
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction(
                              req.deviceId,
                              async () => {
                                await onRejectReceiver(req.deviceId);
                              },
                              `Rejected join request from ${req.deviceName}.`
                            )
                          }
                          className="inline-flex min-h-[36px] items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#172033] hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-50"
                        >
                          <X className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Reject</span>
                        </button>
                      </div>
                    ) : (
                      <span className="text-xs font-medium text-[#64748B]">
                        Host approval required
                      </span>
                    )}
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}

      {/* Search & Filter Toolbar + Device List */}
      <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-center lg:justify-between">
          <div className="relative flex-1 max-w-md">
            <Search
              className="pointer-events-none absolute left-3 top-1/2 h-4 w-4 -translate-y-1/2 text-[#94A3B8]"
              aria-hidden="true"
            />
            <label htmlFor="device-manager-search" className="sr-only">
              Search devices by name or ID
            </label>
            <input
              id="device-manager-search"
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by device name, ID, or type..."
              className="h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] pl-9 pr-8 text-sm text-[#172033] placeholder:text-[#94A3B8] focus:border-[#2563EB] focus:bg-white focus:outline-none"
            />
            {searchQuery && (
              <button
                type="button"
                aria-label="Clear search"
                onClick={() => setSearchQuery('')}
                className="absolute right-2.5 top-1/2 -translate-y-1/2 text-[#64748B] hover:text-[#172033]"
              >
                <X className="h-3.5 w-3.5" aria-hidden="true" />
              </button>
            )}
          </div>

          <div
            role="group"
            aria-label="Filter devices by connection status"
            className="flex flex-wrap items-center gap-1 rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] p-1"
          >
            {FILTER_OPTIONS.map((opt) => {
              const active = statusFilter === opt.id;
              return (
                <button
                  key={opt.id}
                  type="button"
                  onClick={() => setStatusFilter(opt.id)}
                  className={`min-h-[32px] rounded-lg px-2.5 text-xs font-medium transition-colors whitespace-nowrap ${
                    active
                      ? 'bg-white text-[#172033] shadow-xs'
                      : 'text-[#64748B] hover:text-[#172033]'
                  }`}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Loading State */}
        {isLoading ? (
          <div className="space-y-3 py-4" aria-busy="true" aria-label="Loading devices">
            {[1, 2, 3].map((row) => (
              <div
                key={row}
                className="h-20 animate-pulse rounded-lg border border-[#E2E8F0] bg-[#F8FAFC]"
              />
            ))}
          </div>
        ) : filteredDevices.length === 0 ? (
          <div className="rounded-lg border border-dashed border-[#E2E8F0] bg-[#F8FAFC] px-6 py-10 text-center">
            <p className="text-sm font-semibold text-[#172033]">
              No matching devices found
            </p>
            <p className="mt-1 text-xs text-[#64748B]">
              Try clearing your search term or switching the status filter.
            </p>
            {(searchQuery || statusFilter !== 'all') && (
              <button
                type="button"
                onClick={() => {
                  setSearchQuery('');
                  setStatusFilter('all');
                }}
                className="mt-4 inline-flex h-8 items-center rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
              >
                Reset Filters
              </button>
            )}
          </div>
        ) : (
          <div className="divide-y divide-[#E2E8F0]">
            {filteredDevices.map((rec) => {
              const badge = connectionBadgeForRecord(rec);
              const isEditing = editingDeviceId === rec.deviceId;
              const isBusy = busyDeviceId === rec.deviceId;
              const canRename = rec.isSelf || (Boolean(activeRoom) && isHost);
              const canViewIncoming =
                rec.isIncomingStreaming && Boolean(onViewStream) && !rec.isSelf;
              const isRemoteParticipantStreaming = Boolean(
                activeRoom?.activeStreams?.some((s) => s.publisherDeviceId === rec.deviceId)
              );
              const canStopOutbound = !rec.isSelf && rec.isOutgoingStreaming;
              const canStopParticipantStream =
                (!rec.isSelf && isHost && isRemoteParticipantStreaming) ||
                (rec.isSelf && webrtcState.isSharingLocal);
              const canReconnect =
                rec.role !== 'pending' &&
                ((rec.isSelf && rec.canRetry && Boolean(onReconnectBackend)) ||
                  (!rec.isSelf && rec.canRetry));
              const canToggleMute = !rec.isSelf && rec.isIncomingStreaming && rec.hasIncomingAudioTrack;
              const canToggleAdaptiveLock =
                (rec.isSelf && webrtcState.isSharingLocal) || rec.isOutgoingStreaming;
              const canRemove = Boolean(activeRoom) && isHost && rec.role === 'participant' && !rec.isSelf;

              return (
                <article
                  key={`${rec.role}-${rec.deviceId}`}
                  className="py-4 first:pt-1 last:pb-1 space-y-3"
                >
                  <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
                    {/* Left: Identity + Badges */}
                    <div className="min-w-0 space-y-1.5">
                      <div className="flex flex-wrap items-center gap-2">
                        <DeviceTypeIcon deviceType={rec.deviceType} />
                        {isEditing ? (
                          <div className="flex flex-wrap items-center gap-1.5">
                            <input
                              type="text"
                              value={draftName}
                              onChange={(e) => {
                                setDraftName(e.target.value);
                                if (renameError) setRenameError(null);
                              }}
                              onKeyDown={(e) => {
                                if (e.key === 'Enter') {
                                  e.preventDefault();
                                  void submitRename(rec.deviceId);
                                } else if (e.key === 'Escape') {
                                  cancelEditingName();
                                }
                              }}
                              maxLength={48}
                              aria-label={`Rename ${rec.deviceName}`}
                              className="h-8 rounded-lg border border-[#2563EB] bg-white px-2.5 text-sm font-medium text-[#172033] focus:outline-none"
                            />
                            <button
                              type="button"
                              disabled={isBusy}
                              onClick={() => void submitRename(rec.deviceId)}
                              className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#2563EB] px-2.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
                            >
                              <Check className="h-3.5 w-3.5" aria-hidden="true" />
                              <span>Save</span>
                            </button>
                            <button
                              type="button"
                              onClick={cancelEditingName}
                              className="inline-flex h-8 items-center rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#64748B] hover:text-[#172033]"
                            >
                              Cancel
                            </button>
                          </div>
                        ) : (
                          <>
                            <h3 className="text-sm font-semibold text-[#172033] truncate">
                              {rec.deviceName}
                              {rec.isSelf ? ' (You)' : ''}
                            </h3>
                            <span
                              className={`text-xs font-semibold ${
                                rec.role === 'host'
                                  ? 'text-[#2563EB]'
                                  : rec.role === 'pending'
                                    ? 'text-[#D97706]'
                                    : 'text-[#64748B]'
                              }`}
                            >
                              {rec.role === 'host'
                                ? 'Host'
                                : rec.role === 'pending'
                                  ? 'Pending'
                                  : rec.slotIndex !== null
                                    ? `Participant · Slot ${rec.slotIndex + 1}`
                                    : 'Participant'}
                            </span>
                          </>
                        )}
                        <SignalBadge label={badge.label} tone={badge.tone} pulse={badge.pulse} />
                      </div>

                      {isEditing && renameError && (
                        <p role="alert" className="text-xs text-[#DC2626]">
                          {renameError}
                        </p>
                      )}

                      <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs text-[#64748B] tabular-metrics">
                        <span>
                          Type:{' '}
                          <strong className="font-medium text-[#172033]">{rec.deviceType}</strong>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span className="font-mono">{rec.deviceId}</span>
                        <span aria-hidden="true">·</span>
                        <span title={rec.connectionQualityDetail}>
                          Quality:{' '}
                          <strong className="font-medium text-[#172033]">
                            {rec.connectionQualityLabel}
                          </strong>
                        </span>
                        <span aria-hidden="true">·</span>
                        <span>
                          Last activity:{' '}
                          <strong className="font-medium text-[#172033]">
                            {formatLastActivity(rec.lastActivityAt)}
                          </strong>
                        </span>
                      </div>
                    </div>

                    {/* Right: Authorized Individual Device Controls */}
                    <div className="flex flex-wrap items-center gap-1.5 shrink-0">
                      {canRename && !isEditing && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => startEditingName(rec)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
                        >
                          <Edit3 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Rename</span>
                        </button>
                      )}

                      {canViewIncoming && (
                        <button
                          type="button"
                          onClick={() => onViewStream?.(rec.deviceId)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#2563EB]/30 bg-[#EFF6FF] px-2.5 text-xs font-semibold text-[#2563EB] hover:bg-[#DBEAFE]"
                        >
                          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>View Stream</span>
                        </button>
                      )}

                      {canToggleMute && (
                        <button
                          type="button"
                          onClick={() => onToggleMutePeer(rec.deviceId)}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]"
                        >
                          {rec.incomingMuted ? (
                            <VolumeX className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Volume2 className="h-3.5 w-3.5 text-[#2563EB]" aria-hidden="true" />
                          )}
                          <span>{rec.incomingMuted ? 'Unmute' : 'Mute'}</span>
                        </button>
                      )}

                      {canStopOutbound && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction(
                              rec.deviceId,
                              async () => {
                                await onStopDeviceStream(rec.deviceId, 'outbound-to-peer');
                              },
                              `Stopped outgoing stream to ${rec.deviceName}.`
                            )
                          }
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] px-2.5 text-xs font-semibold text-[#DC2626] hover:bg-[#FEE2E2] disabled:opacity-50"
                        >
                          <Square className="h-3 w-3" aria-hidden="true" />
                          <span>Stop Outgoing</span>
                        </button>
                      )}

                      {canStopParticipantStream && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction(
                              rec.deviceId,
                              async () => {
                                await onStopDeviceStream(rec.deviceId, 'participant-room-stream');
                              },
                              rec.isSelf
                                ? 'Stopped your active screen share.'
                                : `Stopped ${rec.deviceName}'s active stream.`
                            )
                          }
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#DC2626]/30 bg-[#FEF2F2] px-2.5 text-xs font-semibold text-[#DC2626] hover:bg-[#FEE2E2] disabled:opacity-50"
                        >
                          <Square className="h-3 w-3" aria-hidden="true" />
                          <span>{rec.isSelf ? 'Stop Sharing' : 'Stop Stream'}</span>
                        </button>
                      )}

                      {canReconnect && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() => {
                            if (rec.isSelf) {
                              onReconnectBackend?.();
                              setFeedback({
                                tone: 'info',
                                text: 'Reconnecting signaling session...',
                              });
                              return;
                            }
                            void runAction(
                              rec.deviceId,
                              async () => {
                                await onReconnectDevice(rec.deviceId);
                              },
                              isHost
                                ? `Sent reconnection request to ${rec.deviceName}.`
                                : `Retried peer connection with ${rec.deviceName}.`
                            );
                          }}
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB] disabled:opacity-50"
                        >
                          <RotateCcw className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Reconnect</span>
                        </button>
                      )}

                      {canToggleAdaptiveLock && rec.adaptiveLocked !== null && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction(
                              rec.deviceId,
                              async () => {
                                await onToggleAdaptiveLock(
                                  rec.deviceId,
                                  rec.isSelf,
                                  !rec.adaptiveLocked
                                );
                              },
                              !rec.adaptiveLocked
                                ? `Locked auto quality mode for ${rec.deviceName}.`
                                : `Unlocked auto quality mode for ${rec.deviceName}.`
                            )
                          }
                          className={`inline-flex h-8 items-center gap-1.5 rounded-lg border px-2.5 text-xs font-medium ${
                            rec.adaptiveLocked
                              ? 'border-[#D97706]/40 bg-[#FFFBEB] text-[#B45309]'
                              : 'border-[#E2E8F0] bg-white text-[#172033] hover:border-[#2563EB] hover:text-[#2563EB]'
                          }`}
                        >
                          {rec.adaptiveLocked ? (
                            <Lock className="h-3.5 w-3.5" aria-hidden="true" />
                          ) : (
                            <Unlock className="h-3.5 w-3.5" aria-hidden="true" />
                          )}
                          <span>{rec.adaptiveLocked ? 'Unlock Auto' : 'Lock Quality'}</span>
                        </button>
                      )}

                      {canRemove && (
                        <button
                          type="button"
                          disabled={isBusy}
                          onClick={() =>
                            void runAction(
                              rec.deviceId,
                              async () => {
                                await onRemoveReceiver(rec.deviceId);
                              },
                              `Removed ${rec.deviceName} from room.`
                            )
                          }
                          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#64748B] hover:border-[#DC2626] hover:text-[#DC2626] disabled:opacity-50"
                        >
                          <Trash2 className="h-3.5 w-3.5" aria-hidden="true" />
                          <span>Remove</span>
                        </button>
                      )}
                    </div>
                  </div>

                  {/* Streaming Telemetry Summary Grid (strictly real measured or announced stats) */}
                  <dl className="grid grid-cols-2 gap-3 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 py-2.5 text-xs sm:grid-cols-3 lg:grid-cols-6 tabular-metrics">
                    <div>
                      <dt className="text-[#64748B]">Resolution</dt>
                      <dd className="mt-0.5 font-semibold text-[#172033]">
                        {rec.resolution ?? 'Unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[#64748B]">Actual FPS</dt>
                      <dd className="mt-0.5 font-semibold text-[#172033]">
                        {rec.fps !== null ? `${rec.fps.toFixed(1)} FPS` : 'Unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[#64748B]">Actual Bitrate</dt>
                      <dd className="mt-0.5 font-semibold text-[#172033]">
                        {formatBitrate(rec.bitrateKbps)}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[#64748B]">Packet Loss</dt>
                      <dd className="mt-0.5 font-semibold text-[#172033]">
                        {rec.packetLossPct !== null ? `${rec.packetLossPct.toFixed(1)}%` : 'Unavailable'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[#64748B]">Video Status</dt>
                      <dd className="mt-0.5 font-semibold text-[#172033]">
                        {rec.isOutgoingStreaming && rec.isIncomingStreaming
                          ? 'Sending & Receiving'
                          : rec.isOutgoingStreaming
                            ? 'Sending'
                            : rec.isIncomingStreaming
                              ? 'Receiving'
                              : rec.connected
                                ? 'Standby'
                                : 'Offline'}
                      </dd>
                    </div>
                    <div>
                      <dt className="text-[#64748B]">Audio Status</dt>
                      <dd className="mt-0.5 font-semibold text-[#172033]">{rec.audioStatus}</dd>
                    </div>
                  </dl>
                </article>
              );
            })}
            {activeRoom &&
              pairedReceivers.length === 0 &&
              pendingRequests.length === 0 &&
              !searchQuery &&
              statusFilter === 'all' && (
                <div className="pt-4 text-xs text-[#64748B]">
                  No paired participants yet. Share room code{' '}
                  <span className="font-mono font-semibold text-[#172033]">
                    {activeRoom.roomId}
                  </span>{' '}
                  in Rooms to connect up to {maxReceivers} devices.
                </div>
              )}
          </div>
        )}
      </div>
    </section>
  );
}
