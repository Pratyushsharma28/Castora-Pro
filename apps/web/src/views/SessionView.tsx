import type {
  BackendHealthResponse,
  RoomSnapshot,
  SignalingSocketState,
} from '../services/backendClient';
import type { WebRtcSessionSnapshot } from '../services/webrtcSignalingBridge';
import type { RoomPrivacyMode, StudioDestination } from '../types/studio';
import { SessionManagementDashboard } from '../components/common/SessionManagementDashboard';

interface SessionViewProps {
  deviceId: string;
  activeRoom: RoomSnapshot | null;
  activeRoomRole: 'host' | 'receiver' | null;
  inviteCode: string | null;
  signalingState: SignalingSocketState;
  backendHealth: BackendHealthResponse | null;
  webrtcState: WebRtcSessionSnapshot;
  onCreateRoom: (options?: {
    roomName?: string;
    privacyMode?: RoomPrivacyMode;
    password?: string;
  }) => Promise<RoomSnapshot>;
  onRenameRoom: (roomName: string) => Promise<RoomSnapshot>;
  onUpdatePrivacyMode: (privacyMode: RoomPrivacyMode) => Promise<RoomSnapshot>;
  onUpdateRoomPassword: (password: string | null) => Promise<RoomSnapshot>;
  onRotateInvitation: () => Promise<string>;
  onInitiateHostTransfer: (targetDeviceId: string) => Promise<RoomSnapshot>;
  onCancelHostTransfer: () => Promise<RoomSnapshot>;
  onRespondHostTransfer: (accept: boolean) => Promise<void>;
  onRestoreSession: () => Promise<void>;
  onCloseRoom: () => Promise<void>;
  onLeaveRoom: () => Promise<void>;
  onNavigate: (destination: StudioDestination) => void;
}

export function SessionView(props: SessionViewProps) {
  return <SessionManagementDashboard {...props} />;
}
