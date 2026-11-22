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
  onNavigate: (destination: StudioDestination) => void;
}

export function DevicesView({
  deviceId,
  deviceName,
  capabilities,
  preferences,
  signalingState,
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
        onNavigate={onNavigate}
      />
    </div>
  );
}
