import { AlertTriangle, RefreshCw } from 'lucide-react';
import type { RoomSnapshot, SignalingSocketState } from '../services/backendClient';
import type { WebRtcSessionSnapshot } from '../services/webrtcSignalingBridge';
import type {
  BrowserCapabilityReport,
  CapturePreferences,
  StudioDestination,
} from '../types/studio';
import { DeviceManagerPanel } from '../components/common/DeviceManagerPanel';

interface DevicesViewProps {
  deviceId: string;
  deviceName: string;
  capabilities: BrowserCapabilityReport;
  preferences: CapturePreferences;
  signalingState: SignalingSocketState;
  backendError?: string | null;
  isLoading?: boolean;
  lastSignalingActivityAt?: string | null;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  webrtcState: WebRtcSessionSnapshot;
  mutedByPeerId: Record<string, boolean>;
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
  onViewStream: (senderDeviceId: string) => void;
  onRefresh: () => Promise<void>;
  onReconnectBackend?: () => void;
  onNavigate: (destination: StudioDestination) => void;
}

export function DevicesView({
  deviceId,
  deviceName,
  capabilities,
  preferences,
  signalingState,
  backendError = null,
  isLoading = false,
  lastSignalingActivityAt = null,
  activeRoom,
  activeRoomRole,
  webrtcState,
  mutedByPeerId,
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
  onNavigate,
}: DevicesViewProps) {
  return (
    <div data-castora-chrome className="space-y-6">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-[#172033]">
            Device Management
          </h1>
          <p className="text-sm text-[#64748B]">
            Inspect connected participants, rename devices, manage approvals, and control per-device streaming and quality modes.
          </p>
        </div>
      </div>

      {(backendError || signalingState === 'error') && (
        <div
          role="alert"
          className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#DC2626]/30 bg-[#FEF2F2] px-4 py-3 text-xs text-[#B91C1C]"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[#DC2626]" aria-hidden="true" />
            <span>
              {backendError ?? 'Signaling connection error. Device status updates may be stale.'}
            </span>
          </div>
          {onReconnectBackend && (
            <button
              type="button"
              onClick={onReconnectBackend}
              className="inline-flex h-7 items-center gap-1.5 rounded-lg border border-[#DC2626]/30 bg-white px-2.5 text-xs font-semibold text-[#DC2626] hover:bg-[#FEE2E2]"
            >
              <RefreshCw className="h-3 w-3" aria-hidden="true" />
              <span>Reconnect</span>
            </button>
          )}
        </div>
      )}

      <DeviceManagerPanel
        deviceId={deviceId}
        deviceName={deviceName}
        capabilities={capabilities}
        preferences={preferences}
        signalingState={signalingState}
        activeRoom={activeRoom}
        activeRoomRole={activeRoomRole}
        webrtcState={webrtcState}
        mutedByPeerId={mutedByPeerId}
        isLoading={isLoading}
        lastSignalingActivityAt={lastSignalingActivityAt}
        onRenameDevice={onRenameDevice}
        onApproveReceiver={onApproveReceiver}
        onRejectReceiver={onRejectReceiver}
        onRemoveReceiver={onRemoveReceiver}
        onStopDeviceStream={onStopDeviceStream}
        onReconnectDevice={onReconnectDevice}
        onToggleMutePeer={onToggleMutePeer}
        onToggleAdaptiveLock={onToggleAdaptiveLock}
        onViewStream={onViewStream}
        onRefresh={onRefresh}
        onReconnectBackend={onReconnectBackend}
        onNavigate={onNavigate}
      />
    </div>
  );
}
