import {
  AlertTriangle,
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  Edit3,
  Film,
  GripVertical,
  HardDrive,
  Image as ImageIcon,
  KeyRound,
  ListVideo,
  Monitor,
  Pause,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Square,
  Trash2,
  Tv,
  Upload,
  X,
} from 'lucide-react';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { RoomSnapshot } from '../services/backendClient';
import {
  assignSignagePlaylist,
  bootstrapSignageWorkspace,
  buildAuthenticatedMediaUrl,
  controlSignageScreens,
  createSignagePlaylist,
  createSignageScreen,
  deleteSignageMedia,
  deleteSignagePlaylist,
  deleteSignageScreen,
  fetchSignageMedia,
  fetchSignagePlaylists,
  fetchSignageScreens,
  loadSavedWorkspaceCredentials,
  probeMediaFileMetadata,
  recoverSignageWorkspace,
  renameSignageMedia,
  subscribeSignageEvents,
  updateSignagePlaylist,
  updateSignageScreen,
  uploadSignageMediaFiles,
} from '../services/signageApiClient';
import {
  MAX_SIGNAGE_SCREENS,
  type SignageMediaAsset,
  type SignagePlaybackCommand,
  type SignagePlaylist,
  type SignageScreen,
  type SignageStorageStatus,
} from '../types/signage';
import type { StudioDestination } from '../types/studio';
import { PWAInstallButton } from '../components/common/PWAInstallButton';
import { SignalBadge, type SignalTone } from '../components/common/SignalBadge';

type SignageTab = 'screens' | 'media' | 'playlists';
type SlotFilter = 'all' | 'registered' | 'online' | 'unassigned';

interface DraftPlaylistItem {
  localKey: string;
  id?: string;
  mediaId: string;
  imageDurationSec: number;
  repeatCount: number;
  playUntilEnd: boolean;
}

interface DigitalSignageViewProps {
  activeRoom: RoomSnapshot | null;
  onNavigate: (destination: StudioDestination) => void;
  onOpenLocalPlayer: (screenCode?: string) => void;
  onLogEvent?: (
    category: 'ui' | 'capability' | 'signaling' | 'webrtc' | 'error',
    title: string,
    detail: string
  ) => void;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let val = bytes;
  let idx = 0;
  while (val >= 1024 && idx < units.length - 1) {
    val /= 1024;
    idx += 1;
  }
  return `${val >= 100 || idx === 0 ? Math.round(val) : val.toFixed(1)} ${units[idx]}`;
}

function formatDuration(sec: number | null | undefined): string {
  if (typeof sec !== 'number' || !Number.isFinite(sec) || sec <= 0) return '—';
  const rounded = Math.round(sec);
  const h = Math.floor(rounded / 3600);
  const m = Math.floor((rounded % 3600) / 60);
  const s = rounded % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'Never synced';
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return 'Never synced';
  const diffSec = Math.max(0, Math.round((Date.now() - ms) / 1000));
  if (diffSec < 10) return 'Just now';
  if (diffSec < 60) return `${diffSec}s ago`;
  if (diffSec < 3600) return `${Math.floor(diffSec / 60)}m ago`;
  return `${Math.floor(diffSec / 3600)}h ago`;
}

function getScreenStateTone(screen: SignageScreen): { label: string; tone: SignalTone; pulse?: boolean } {
  if (screen.onlineStatus === 'offline' && screen.claimed) {
    return { label: 'Offline (local cache)', tone: 'warn' };
  }
  switch (screen.playbackState) {
    case 'playing':
      return { label: 'Playing', tone: 'active', pulse: true };
    case 'syncing':
      return { label: 'Syncing cache', tone: 'signal', pulse: true };
    case 'paused':
      return { label: 'Paused', tone: 'warn' };
    case 'stopped':
      return { label: 'Stopped', tone: 'standby' };
    case 'error':
      return { label: 'Playback error', tone: 'fault' };
    default:
      return { label: screen.claimed ? 'Standby' : 'Awaiting TV pairing', tone: 'standby' };
  }
}

export function DigitalSignageView({
  activeRoom,
  onOpenLocalPlayer,
  onLogEvent,
}: DigitalSignageViewProps) {
  const [activeTab, setActiveTab] = useState<SignageTab>('screens');
  const [workspaceId, setWorkspaceId] = useState<string | null>(null);
  const [hostToken, setHostToken] = useState<string | null>(null);
  const [recoveryCode, setRecoveryCode] = useState<string | null>(null);
  const [storageStatus, setStorageStatus] = useState<SignageStorageStatus | null>(null);
  const [accessKeyPrompt, setAccessKeyPrompt] = useState(false);
  const [accessKeyInput, setAccessKeyInput] = useState('');

  const [media, setMedia] = useState<SignageMediaAsset[]>([]);
  const [playlists, setPlaylists] = useState<SignagePlaylist[]>([]);
  const [screens, setScreens] = useState<SignageScreen[]>([]);

  const [loading, setLoading] = useState(true);
  const [errorBanner, setErrorBanner] = useState<string | null>(null);
  const [statusNotice, setStatusNotice] = useState<string | null>(null);

  // Screen registration & selection
  const [newScreenName, setNewScreenName] = useState('');
  const [selectedScreenIds, setSelectedScreenIds] = useState<Set<string>>(new Set());
  const [slotFilter, setSlotFilter] = useState<SlotFilter>('all');
  const [bulkPlaylistId, setBulkPlaylistId] = useState<string>('');
  const [screenActionBusy, setScreenActionBusy] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [editingScreenId, setEditingScreenId] = useState<string | null>(null);
  const [editingScreenName, setEditingScreenName] = useState('');

  // Media upload & preview
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const [dragActive, setDragActive] = useState(false);
  const [uploadPct, setUploadPct] = useState<number | null>(null);
  const [uploadingFilesLabel, setUploadingFilesLabel] = useState<string | null>(null);
  const [previewMedia, setPreviewMedia] = useState<SignageMediaAsset | null>(null);
  const [renamingMediaId, setRenamingMediaId] = useState<string | null>(null);
  const [renamingMediaDraft, setRenamingMediaDraft] = useState('');

  // Playlist builder state
  const [editingPlaylistId, setEditingPlaylistId] = useState<string | null>(null);
  const [plName, setPlName] = useState('');
  const [plDescription, setPlDescription] = useState('');
  const [plLoop, setPlLoop] = useState(true);
  const [plItems, setPlItems] = useState<DraftPlaylistItem[]>([]);
  const [savingPlaylist, setSavingPlaylist] = useState(false);
  const [dragIndex, setDragIndex] = useState<number | null>(null);

  // Workspace recovery modal
  const [showWorkspaceModal, setShowWorkspaceModal] = useState(false);
  const [recoverWsId, setRecoverWsId] = useState('');
  const [recoverKey, setRecoverKey] = useState('');

  const mediaById = useMemo(() => new Map(media.map((m) => [m.id, m])), [media]);

  const refreshWorkspaceData = useCallback(async (token: string) => {
    const [mediaRes, playlistsRes, screensRes] = await Promise.all([
      fetchSignageMedia(token),
      fetchSignagePlaylists(token),
      fetchSignageScreens(token),
    ]);
    setMedia(mediaRes.items);
    setStorageStatus(mediaRes.storageStatus);
    setPlaylists(playlistsRes);
    setScreens(screensRes);
    const activeIds = new Set(screensRes.map((s) => s.id));
    setSelectedScreenIds((prev) => {
      const filtered = new Set(Array.from(prev).filter((id) => activeIds.has(id)));
      return filtered.size === prev.size ? prev : filtered;
    });
    setBulkPlaylistId((prev) =>
      prev && playlistsRes.some((p) => p.id === prev) ? prev : (playlistsRes[0]?.id ?? '')
    );
  }, []);

  const initWorkspace = useCallback(
    async (explicitAccessKey?: string) => {
      setLoading(true);
      setErrorBanner(null);
      try {
        const saved = loadSavedWorkspaceCredentials();
        const creds = await bootstrapSignageWorkspace({
          existingHostToken: saved.hostToken,
          accessKey: explicitAccessKey,
        });
        setWorkspaceId(creds.workspaceId);
        setHostToken(creds.hostToken);
        setRecoveryCode(creds.recoveryCode ?? saved.recoveryCode ?? null);
        setStorageStatus(creds.storageStatus);
        setAccessKeyPrompt(false);
        await refreshWorkspaceData(creds.hostToken);
      } catch (error) {
        const msg = error instanceof Error ? error.message : 'Unable to initialize Digital Signage workspace';
        if (msg.toLowerCase().includes('access_key') || msg.includes('CASTORA_SIGNAGE_ACCESS_KEY')) {
          setAccessKeyPrompt(true);
        }
        setErrorBanner(msg);
      } finally {
        setLoading(false);
      }
    },
    [refreshWorkspaceData]
  );

  useEffect(() => {
    void initWorkspace();
  }, [initWorkspace]);

  // Live SSE updates + background refresh
  useEffect(() => {
    if (!hostToken) return;
    const unsub = subscribeSignageEvents(hostToken, (event) => {
      if (
        event === 'screens_updated' ||
        event === 'playlists_updated' ||
        event === 'media_updated'
      ) {
        void refreshWorkspaceData(hostToken).catch(() => {});
      }
    });
    const pollTimer = window.setInterval(() => {
      void fetchSignageScreens(hostToken)
        .then((next) => setScreens(next))
        .catch(() => {});
    }, 10_000);
    return () => {
      unsub();
      window.clearInterval(pollTimer);
    };
  }, [hostToken, refreshWorkspaceData]);

  // Load playlist into builder when selecting
  const loadPlaylistIntoBuilder = useCallback((pl: SignagePlaylist) => {
    setEditingPlaylistId(pl.id);
    setPlName(pl.name);
    setPlDescription(pl.description);
    setPlLoop(pl.loopPlaylist);
    setPlItems(
      pl.items.map((item, idx) => ({
        localKey: `${item.id}-${idx}`,
        id: item.id,
        mediaId: item.mediaId,
        imageDurationSec: item.imageDurationSec,
        repeatCount: item.repeatCount,
        playUntilEnd: item.playUntilEnd,
      }))
    );
  }, []);

  const resetBuilderNew = useCallback(() => {
    setEditingPlaylistId(null);
    setPlName('');
    setPlDescription('');
    setPlLoop(true);
    setPlItems([]);
  }, []);

  const handleUploadFiles = async (fileList: FileList | File[]) => {
    if (!hostToken) return;
    const files = Array.from(fileList);
    if (files.length === 0) return;

    const maxBytes = storageStatus?.maxFileSizeBytes ?? 250 * 1024 * 1024;
    const allowedExt = /\.(jpe?g|png|webp|gif|mp4|webm|mov|m4v)$/i;
    const validFiles: File[] = [];
    const clientErrors: string[] = [];

    for (const file of files) {
      if (!allowedExt.test(file.name) && !file.type.startsWith('image/') && !file.type.startsWith('video/')) {
        clientErrors.push(`Unsupported format: ${file.name}`);
        continue;
      }
      if (file.size <= 0) {
        clientErrors.push(`Empty file: ${file.name}`);
        continue;
      }
      if (file.size > maxBytes) {
        clientErrors.push(`${file.name} exceeds ${formatBytes(maxBytes)} limit`);
        continue;
      }
      validFiles.push(file);
    }

    if (validFiles.length === 0) {
      setErrorBanner(clientErrors.join(' · ') || 'No supported media files selected');
      return;
    }

    setErrorBanner(clientErrors.length > 0 ? clientErrors.join(' · ') : null);
    setUploadPct(0);
    setUploadingFilesLabel(
      validFiles.length === 1 ? validFiles[0].name : `${validFiles.length} media files`
    );

    try {
      const metadata = await Promise.all(validFiles.map((f) => probeMediaFileMetadata(f)));
      const res = await uploadSignageMediaFiles({
        hostToken,
        files: validFiles,
        metadata,
        onProgress: (pct) => setUploadPct(pct),
      });

      if (res.errors.length > 0) {
        setErrorBanner(res.errors.map((e) => e.message).join(' · '));
      }
      if (res.uploaded.length > 0) {
        setStatusNotice(`Uploaded ${res.uploaded.length} media asset${res.uploaded.length > 1 ? 's' : ''}.`);
        onLogEvent?.('ui', 'Signage media uploaded', `${res.uploaded.length} asset(s) added to library.`);
      }
      await refreshWorkspaceData(hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Media upload failed');
    } finally {
      setUploadPct(null);
      setUploadingFilesLabel(null);
      if (fileInputRef.current) {
        fileInputRef.current.value = '';
      }
    }
  };

  const handleRenameMediaSubmit = async (mediaId: string) => {
    if (!hostToken || !renamingMediaDraft.trim()) return;
    try {
      await renameSignageMedia({
        hostToken,
        mediaId,
        displayName: renamingMediaDraft.trim(),
      });
      setRenamingMediaId(null);
      await refreshWorkspaceData(hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Failed to rename media');
    }
  };

  const handleDeleteMedia = async (asset: SignageMediaAsset) => {
    if (!hostToken) return;
    try {
      await deleteSignageMedia({ hostToken, mediaId: asset.id });
      if (previewMedia?.id === asset.id) setPreviewMedia(null);
      setStatusNotice(`Deleted "${asset.displayName}".`);
      await refreshWorkspaceData(hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Failed to delete media');
    }
  };

  const handleSavePlaylist = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!hostToken) return;
    if (!plName.trim()) {
      setErrorBanner('Playlist name is required.');
      return;
    }

    setSavingPlaylist(true);
    setErrorBanner(null);
    try {
      const payloadItems = plItems.map((item) => ({
        id: item.id,
        mediaId: item.mediaId,
        imageDurationSec: item.imageDurationSec,
        repeatCount: item.repeatCount,
        playUntilEnd: item.playUntilEnd,
      }));

      let saved: SignagePlaylist;
      if (editingPlaylistId) {
        saved = await updateSignagePlaylist({
          hostToken,
          playlistId: editingPlaylistId,
          name: plName.trim(),
          description: plDescription.trim(),
          loopPlaylist: plLoop,
          items: payloadItems,
        });
        setStatusNotice(`Updated playlist "${saved.name}". Assigned screens are syncing updates.`);
      } else {
        saved = await createSignagePlaylist({
          hostToken,
          name: plName.trim(),
          description: plDescription.trim(),
          loopPlaylist: plLoop,
          items: payloadItems,
        });
        setStatusNotice(`Created playlist "${saved.name}".`);
      }

      await refreshWorkspaceData(hostToken);
      loadPlaylistIntoBuilder(saved);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Failed to save playlist');
    } finally {
      setSavingPlaylist(false);
    }
  };

  const handleDeletePlaylist = async (pl: SignagePlaylist) => {
    if (!hostToken) return;
    try {
      await deleteSignagePlaylist({ hostToken, playlistId: pl.id });
      if (editingPlaylistId === pl.id) {
        resetBuilderNew();
      }
      setStatusNotice(`Deleted playlist "${pl.name}".`);
      await refreshWorkspaceData(hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Failed to delete playlist');
    }
  };

  const handleAddMediaToBuilder = (asset: SignageMediaAsset) => {
    setPlItems((prev) => [
      ...prev,
      {
        localKey: `${asset.id}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        mediaId: asset.id,
        imageDurationSec: 10,
        repeatCount: 1,
        playUntilEnd: asset.mediaKind === 'video',
      },
    ]);
  };

  const handleMovePlaylistItem = (fromIndex: number, toIndex: number) => {
    if (toIndex < 0 || toIndex >= plItems.length || fromIndex === toIndex) return;
    setPlItems((prev) => {
      const next = [...prev];
      const [moved] = next.splice(fromIndex, 1);
      next.splice(toIndex, 0, moved);
      return next;
    });
  };

  const handleCreateScreen = async (params?: {
    name?: string;
    slotNumber?: number;
    platform?: SignageScreen['platform'];
    deviceType?: SignageScreen['deviceType'];
    deviceId?: string;
    pairedFromRoomId?: string;
  }) => {
    if (!hostToken) return;
    const screenName =
      params?.name ||
      newScreenName.trim() ||
      (params?.slotNumber ? `Google TV ${params.slotNumber}` : `Google TV ${screens.length + 1}`);
    setScreenActionBusy(params?.slotNumber ? `create-slot-${params.slotNumber}` : 'create');
    setErrorBanner(null);
    try {
      const created = await createSignageScreen({
        hostToken,
        name: screenName,
        slotNumber: params?.slotNumber,
        platform: params?.platform ?? 'android-tv',
        deviceType: params?.deviceType ?? 'TV',
        deviceId: params?.deviceId ?? null,
        pairedFromRoomId: params?.pairedFromRoomId ?? null,
      });
      if (!params?.name) setNewScreenName('');
      setStatusNotice(
        `Registered ${created.name} in Slot S${created.slotNumber} (Pairing Code: ${created.screenCode}).`
      );
      await refreshWorkspaceData(hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Unable to register screen');
    } finally {
      setScreenActionBusy(null);
    }
  };

  const handleAssignToTargets = async (targetIds: string[], playlistId: string | null) => {
    if (!hostToken || targetIds.length === 0) return;
    setScreenActionBusy('assign');
    setErrorBanner(null);
    try {
      await assignSignagePlaylist({
        hostToken,
        screenIds: targetIds,
        playlistId,
        autoPlay: true,
      });
      setStatusNotice(
        playlistId
          ? `Assigned playlist to ${targetIds.length} screen${targetIds.length > 1 ? 's' : ''}. TVs will cache media locally.`
          : `Cleared playlist and stopped ${targetIds.length} screen${targetIds.length > 1 ? 's' : ''}.`
      );
      await refreshWorkspaceData(hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Failed to assign playlist');
    } finally {
      setScreenActionBusy(null);
    }
  };

  const handleControlTargets = async (targetIds: string[], command: SignagePlaybackCommand) => {
    if (!hostToken || targetIds.length === 0) return;
    setScreenActionBusy(`ctrl-${command}`);
    setErrorBanner(null);
    try {
      await controlSignageScreens({
        hostToken,
        screenIds: targetIds,
        command,
      });
      await refreshWorkspaceData(hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Failed to send playback command');
    } finally {
      setScreenActionBusy(null);
    }
  };

  const handleCopyPlayerLink = async (screen: SignageScreen) => {
    const url = `${window.location.origin}/?view=signage-player&screen=${encodeURIComponent(screen.screenCode)}`;
    try {
      await navigator.clipboard.writeText(url);
      setCopiedId(screen.id);
      window.setTimeout(() => setCopiedId((prev) => (prev === screen.id ? null : prev)), 2000);
    } catch {
      setStatusNotice(`Player URL: ${url}`);
    }
  };

  const handleToggleSelectAll = () => {
    if (selectedScreenIds.size === screens.length) {
      setSelectedScreenIds(new Set());
    } else {
      setSelectedScreenIds(new Set(screens.map((s) => s.id)));
    }
  };

  const handleRecoverSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const recovered = await recoverSignageWorkspace({
        workspaceId: recoverWsId.trim(),
        recoveryCode: recoverKey.trim().toUpperCase(),
      });
      setWorkspaceId(recovered.workspaceId);
      setHostToken(recovered.hostToken);
      setShowWorkspaceModal(false);
      setStatusNotice(`Restored Signage Studio workspace ${recovered.workspaceId}.`);
      await refreshWorkspaceData(recovered.hostToken);
    } catch (error) {
      setErrorBanner(error instanceof Error ? error.message : 'Workspace recovery failed');
    }
  };

  // Paired room devices not yet enrolled into Digital Signage
  const roomEnrolCandidates = useMemo(() => {
    if (!activeRoom) return [];
    const existingDeviceIds = new Set(screens.map((s) => s.deviceId).filter(Boolean));
    return activeRoom.pairedReceivers.filter((rx) => !existingDeviceIds.has(rx.deviceId));
  }, [activeRoom, screens]);

  // All 15 screen slots mapped sequentially S1..S15
  const allScreenSlots = useMemo(() => {
    const bySlot = new Map(screens.map((s) => [s.slotNumber, s]));
    return Array.from({ length: MAX_SIGNAGE_SCREENS }, (_, idx) => {
      const slotNumber = idx + 1;
      return {
        slotNumber,
        screen: bySlot.get(slotNumber) ?? null,
      };
    });
  }, [screens]);

  const slotMetrics = useMemo(() => {
    let onlineCount = 0;
    let playingCount = 0;
    let unassignedOrFreeCount = 0;
    for (const slot of allScreenSlots) {
      if (!slot.screen) {
        unassignedOrFreeCount += 1;
        continue;
      }
      if (slot.screen.onlineStatus === 'online') onlineCount += 1;
      if (slot.screen.playbackState === 'playing') playingCount += 1;
      if (!slot.screen.assignedPlaylistId) unassignedOrFreeCount += 1;
    }
    return {
      onlineCount,
      playingCount,
      unassignedOrFreeCount,
      availableSlots: MAX_SIGNAGE_SCREENS - screens.length,
    };
  }, [allScreenSlots, screens.length]);

  const visibleScreenSlots = useMemo(() => {
    return allScreenSlots.filter((slot) => {
      switch (slotFilter) {
        case 'registered':
          return slot.screen !== null;
        case 'online':
          return Boolean(
            slot.screen &&
              (slot.screen.onlineStatus === 'online' || slot.screen.playbackState === 'playing')
          );
        case 'unassigned':
          return !slot.screen || !slot.screen.assignedPlaylistId;
        default:
          return true;
      }
    });
  }, [allScreenSlots, slotFilter]);

  if (accessKeyPrompt && !hostToken) {
    return (
      <div className="mx-auto max-w-md rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-xs">
        <h1 className="font-display text-lg font-semibold text-[#172033]">
          Signage Studio Access Key
        </h1>
        <p className="mt-1 text-xs text-[#64748B]">
          This server requires the configured operator access key (`CASTORA_SIGNAGE_ACCESS_KEY`) to initialize a Digital Signage workspace.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void initWorkspace(accessKeyInput);
          }}
          className="mt-4 space-y-3"
        >
          <input
            type="password"
            value={accessKeyInput}
            onChange={(e) => setAccessKeyInput(e.target.value)}
            placeholder="Enter operator access key"
            className="h-11 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3.5 text-sm text-[#172033]"
          />
          {errorBanner && <p className="text-xs text-[#DC2626]">{errorBanner}</p>}
          <button
            type="submit"
            className="h-11 w-full rounded-[10px] bg-[#2563EB] text-sm font-semibold text-white hover:bg-[#1D4ED8]"
          >
            Unlock Digital Signage
          </button>
        </form>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex flex-col gap-4 lg:flex-row lg:items-center lg:justify-between">
        <div>
          <h1 className="font-display text-xl font-semibold tracking-tight text-[#172033]">
            Digital Signage &amp; Independent TV Playback
          </h1>
          <p className="text-sm text-[#64748B]">
            Upload media, build mixed image/video playlists, and sync up to {MAX_SIGNAGE_SCREENS} screens for continuous unattended playback without WebRTC or host uptime.
          </p>
        </div>

        <div className="flex flex-wrap items-center gap-2.5">
          <PWAInstallButton compact />
          <button
            type="button"
            onClick={() => setShowWorkspaceModal(true)}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#172033] hover:bg-[#F8FAFC]"
          >
            <KeyRound className="h-3.5 w-3.5 text-[#64748B]" aria-hidden="true" />
            <span>Workspace Key</span>
          </button>
          <button
            type="button"
            onClick={() => onOpenLocalPlayer()}
            className="inline-flex h-9 items-center gap-1.5 rounded-[10px] bg-[#172033] px-3.5 text-xs font-semibold text-white hover:bg-[#0F172A]"
          >
            <Tv className="h-3.5 w-3.5" aria-hidden="true" />
            <span>Launch TV Player Mode</span>
          </button>
        </div>
      </div>

      {/* Storage & Persistence Integrity Notice */}
      {storageStatus && (
        <div
          className={`flex flex-col gap-2 rounded-xl border px-4 py-3 text-xs sm:flex-row sm:items-center sm:justify-between ${
            storageStatus.persistentObjectStorage
              ? 'border-[#E2E8F0] bg-white text-[#475569]'
              : 'border-[#D97706]/30 bg-[#FFFBEB] text-[#92400E]'
          }`}
        >
          <div className="flex items-center gap-2.5">
            <HardDrive
              className={`h-4 w-4 shrink-0 ${
                storageStatus.persistentObjectStorage ? 'text-[#16A34A]' : 'text-[#D97706]'
              }`}
              aria-hidden="true"
            />
            <span>
              <strong>Storage:</strong>{' '}
              {storageStatus.storageProvider === 's3'
                ? `S3-compatible object storage (${storageStatus.bucketName})`
                : storageStatus.storageProvider === 'local-dev'
                  ? 'Local preview object storage'
                  : 'Unconfigured in production'}
              {' · '}
              <strong>Database:</strong> {storageStatus.dbProvider === 'postgres' ? 'PostgreSQL' : 'SQLite'}
              {storageStatus.warning ? ` — ${storageStatus.warning}` : ''}
            </span>
          </div>
          <span className="font-mono text-[11px] tabular-metrics shrink-0">
            {screens.length}/{MAX_SIGNAGE_SCREENS} screens · {media.length} media · {playlists.length} playlists
          </span>
        </div>
      )}

      {errorBanner && (
        <div
          role="alert"
          className="flex items-center justify-between gap-3 rounded-xl border border-[#DC2626]/30 bg-[#FEF2F2] px-4 py-3 text-xs text-[#B91C1C]"
        >
          <div className="flex items-center gap-2">
            <AlertTriangle className="h-4 w-4 shrink-0 text-[#DC2626]" aria-hidden="true" />
            <span>{errorBanner}</span>
          </div>
          <button type="button" onClick={() => setErrorBanner(null)} aria-label="Dismiss error">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {statusNotice && (
        <div
          role="status"
          className="flex items-center justify-between gap-3 rounded-xl border border-[#2563EB]/25 bg-[#EFF6FF] px-4 py-2.5 text-xs text-[#1E40AF]"
        >
          <span>{statusNotice}</span>
          <button type="button" onClick={() => setStatusNotice(null)} aria-label="Dismiss notice">
            <X className="h-4 w-4" />
          </button>
        </div>
      )}

      {/* Workspace Sub-Navigation Tabs */}
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] pb-3">
        <div className="flex items-center gap-1.5">
          <button
            type="button"
            onClick={() => setActiveTab('screens')}
            className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${
              activeTab === 'screens'
                ? 'bg-[#2563EB] text-white'
                : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:text-[#172033]'
            }`}
          >
            <Monitor className="h-4 w-4" aria-hidden="true" />
            <span>Screens ({screens.length}/{MAX_SIGNAGE_SCREENS})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('media')}
            className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${
              activeTab === 'media'
                ? 'bg-[#2563EB] text-white'
                : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:text-[#172033]'
            }`}
          >
            <Film className="h-4 w-4" aria-hidden="true" />
            <span>Media Library ({media.length})</span>
          </button>
          <button
            type="button"
            onClick={() => setActiveTab('playlists')}
            className={`inline-flex h-10 items-center gap-2 rounded-lg px-4 text-sm font-medium transition-colors ${
              activeTab === 'playlists'
                ? 'bg-[#2563EB] text-white'
                : 'bg-white text-[#64748B] border border-[#E2E8F0] hover:text-[#172033]'
            }`}
          >
            <ListVideo className="h-4 w-4" aria-hidden="true" />
            <span>Playlists ({playlists.length})</span>
          </button>
        </div>

        {hostToken && (
          <button
            type="button"
            onClick={() => void refreshWorkspaceData(hostToken)}
            className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-white px-3 text-xs font-medium text-[#475569] hover:bg-[#F8FAFC]"
          >
            <RefreshCw className={`h-3.5 w-3.5 ${loading ? 'animate-spin' : ''}`} aria-hidden="true" />
            <span>Refresh Sync</span>
          </button>
        )}
      </div>

      {/* TAB 1: SCREENS & ASSIGNMENT */}
      {activeTab === 'screens' && (
        <div className="space-y-5">
          {/* Register Screen & Connected Room Import Bar */}
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4">
            <div className="flex flex-col gap-3 md:flex-row md:items-center md:justify-between">
              <div>
                <h2 className="text-sm font-semibold text-[#172033]">
                  Register Displays (Up to {MAX_SIGNAGE_SCREENS} Screens)
                </h2>
                <p className="text-xs text-[#64748B]">
                  Each screen gets a 6-character pairing code. Open TV Player mode on your Haier Google TV and enter the code once to cache playlists locally.
                </p>
              </div>
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  void handleCreateScreen();
                }}
                className="flex flex-wrap items-center gap-2"
              >
                <input
                  type="text"
                  maxLength={48}
                  value={newScreenName}
                  onChange={(e) => setNewScreenName(e.target.value)}
                  placeholder={`Screen ${screens.length + 1} (e.g., Lobby Haier TV)`}
                  className="h-10 w-60 rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                />
                <button
                  type="submit"
                  disabled={screens.length >= MAX_SIGNAGE_SCREENS || screenActionBusy === 'create'}
                  className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-[#2563EB] px-4 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
                >
                  <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                  <span>Add Screen</span>
                </button>
              </form>
            </div>

            {roomEnrolCandidates.length > 0 && screens.length < MAX_SIGNAGE_SCREENS && (
              <div className="flex flex-wrap items-center gap-2 border-t border-[#E2E8F0] pt-3">
                <span className="text-xs font-medium text-[#64748B]">
                  Enroll from active room:
                </span>
                {roomEnrolCandidates.map((rx) => (
                  <button
                    key={rx.deviceId}
                    type="button"
                    onClick={() =>
                      void handleCreateScreen({
                        name: rx.deviceName,
                        platform: rx.platform,
                        deviceType: rx.deviceType ?? 'TV',
                        deviceId: rx.deviceId,
                        pairedFromRoomId: activeRoom?.roomId,
                      })
                    }
                    className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#172033] hover:bg-[#EFF6FF] hover:border-[#2563EB]/40"
                  >
                    <Plus className="h-3 w-3 text-[#2563EB]" />
                    <span>{rx.deviceName}</span>
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Bulk Selection & Assignment Controls */}
          {screens.length > 0 && (
            <div className="flex flex-col gap-3 rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] lg:flex-row lg:items-center lg:justify-between">
              <div className="flex flex-wrap items-center gap-3">
                <button
                  type="button"
                  onClick={handleToggleSelectAll}
                  className="inline-flex h-9 items-center gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#172033] hover:bg-[#F1F5F9]"
                >
                  <span>
                    {selectedScreenIds.size === screens.length ? 'Deselect All' : `Select All (${screens.length})`}
                  </span>
                </button>
                <span className="text-xs text-[#64748B] tabular-metrics">
                  {selectedScreenIds.size} selected
                </span>
              </div>

              <div className="flex flex-wrap items-center gap-2">
                <select
                  aria-label="Select playlist for bulk assignment"
                  value={bulkPlaylistId}
                  onChange={(e) => setBulkPlaylistId(e.target.value)}
                  className="h-9 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs text-[#172033]"
                >
                  <option value="">Choose playlist...</option>
                  {playlists.map((pl) => (
                    <option key={pl.id} value={pl.id}>
                      {pl.name} ({pl.items.length} items)
                    </option>
                  ))}
                </select>

                <button
                  type="button"
                  disabled={!bulkPlaylistId || selectedScreenIds.size === 0 || Boolean(screenActionBusy)}
                  onClick={() =>
                    void handleAssignToTargets(Array.from(selectedScreenIds), bulkPlaylistId)
                  }
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg bg-[#2563EB] px-3.5 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-45"
                >
                  <span>Assign to Selected</span>
                </button>

                <button
                  type="button"
                  disabled={!bulkPlaylistId || screens.length === 0 || Boolean(screenActionBusy)}
                  onClick={() =>
                    void handleAssignToTargets(
                      screens.map((s) => s.id),
                      bulkPlaylistId
                    )
                  }
                  className="inline-flex h-9 items-center gap-1.5 rounded-lg border border-[#2563EB]/30 bg-[#EFF6FF] px-3.5 text-xs font-semibold text-[#2563EB] hover:bg-[#DBEAFE] disabled:opacity-45"
                >
                  <span>Assign to All ({screens.length})</span>
                </button>

                {selectedScreenIds.size > 0 && (
                  <>
                    <button
                      type="button"
                      onClick={() =>
                        void handleControlTargets(Array.from(selectedScreenIds), 'play')
                      }
                      className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#16A34A] hover:bg-[#F0FDF4]"
                    >
                      <Play className="h-3.5 w-3.5" />
                      <span>Play</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleControlTargets(Array.from(selectedScreenIds), 'pause')
                      }
                      className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#D97706] hover:bg-[#FFFBEB]"
                    >
                      <Pause className="h-3.5 w-3.5" />
                      <span>Pause</span>
                    </button>
                    <button
                      type="button"
                      onClick={() =>
                        void handleControlTargets(Array.from(selectedScreenIds), 'stop')
                      }
                      className="inline-flex h-9 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#DC2626] hover:bg-[#FEF2F2]"
                    >
                      <Square className="h-3.5 w-3.5" />
                      <span>Stop</span>
                    </button>
                  </>
                )}
              </div>
            </div>
          )}

          {/* 15-Slot Overview Strip & Filter Controls */}
          <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-3">
            <div className="flex flex-col gap-2.5 sm:flex-row sm:items-center sm:justify-between">
              <div className="flex flex-wrap items-center gap-1.5">
                {(
                  [
                    { id: 'all', label: `All ${MAX_SIGNAGE_SCREENS} Slots` },
                    { id: 'registered', label: `Registered (${screens.length})` },
                    { id: 'online', label: `Online (${slotMetrics.onlineCount})` },
                    { id: 'unassigned', label: `Unassigned / Free (${slotMetrics.unassignedOrFreeCount})` },
                  ] as const
                ).map((item) => (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setSlotFilter(item.id)}
                    className={`inline-flex h-8 items-center rounded-lg px-2.5 text-xs font-medium transition-colors ${
                      slotFilter === item.id
                        ? 'bg-[#172033] text-white'
                        : 'border border-[#E2E8F0] bg-[#F8FAFC] text-[#475569] hover:text-[#172033]'
                    }`}
                  >
                    {item.label}
                  </button>
                ))}
              </div>
              <span className="font-mono text-[11px] text-[#64748B] tabular-metrics">
                {screens.length}/{MAX_SIGNAGE_SCREENS} active · {slotMetrics.playingCount} playing ·{' '}
                {slotMetrics.availableSlots} free
              </span>
            </div>

            {/* Compact 15-Slot Occupancy Matrix */}
            <div className="grid grid-cols-5 gap-1.5 sm:grid-cols-8 lg:grid-cols-15">
              {allScreenSlots.map(({ slotNumber, screen }) => {
                const isPlaying = screen?.playbackState === 'playing';
                const isOnline = screen?.onlineStatus === 'online';
                const isSelected = screen ? selectedScreenIds.has(screen.id) : false;
                return (
                  <button
                    key={slotNumber}
                    type="button"
                    title={
                      screen
                        ? `Slot S${slotNumber}: ${screen.name} (${screen.playbackState})`
                        : `Slot S${slotNumber}: Available — click to register`
                    }
                    onClick={() => {
                      if (screen) {
                        setSelectedScreenIds((prev) => {
                          const next = new Set(prev);
                          if (next.has(screen.id)) next.delete(screen.id);
                          else next.add(screen.id);
                          return next;
                        });
                      } else {
                        void handleCreateScreen({ slotNumber });
                      }
                    }}
                    className={`flex items-center justify-between rounded-md border px-2 py-1 text-[11px] font-mono tabular-metrics transition-colors ${
                      isSelected
                        ? 'border-[#2563EB] bg-[#EFF6FF] text-[#1D4ED8]'
                        : screen
                          ? 'border-[#CBD5E1] bg-white text-[#172033] hover:border-[#94A3B8]'
                          : 'border-dashed border-[#CBD5E1] bg-[#F8FAFC] text-[#64748B] hover:border-[#2563EB] hover:text-[#2563EB]'
                    }`}
                  >
                    <span>S{slotNumber}</span>
                    <span
                      className={`h-1.5 w-1.5 rounded-full ${
                        isPlaying
                          ? 'bg-[#16A34A]'
                          : isOnline
                            ? 'bg-[#2563EB]'
                            : screen
                              ? 'bg-[#94A3B8]'
                              : 'bg-[#CBD5E1]'
                      }`}
                    />
                  </button>
                );
              })}
            </div>
          </div>

          {/* 15-Screen Responsive Grid */}
          {visibleScreenSlots.length === 0 ? (
            <div className="rounded-xl border border-dashed border-[#CBD5E1] bg-white p-8 text-center">
              <Tv className="mx-auto h-7 w-7 text-[#94A3B8]" aria-hidden="true" />
              <p className="mt-2.5 text-sm font-semibold text-[#172033]">
                No screen slots match this filter
              </p>
              <button
                type="button"
                onClick={() => setSlotFilter('all')}
                className="mt-3 inline-flex h-8 items-center rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs font-medium text-[#172033] hover:bg-[#F1F5F9]"
              >
                Show All {MAX_SIGNAGE_SCREENS} Slots
              </button>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
              {visibleScreenSlots.map(({ slotNumber, screen }) => {
                if (!screen) {
                  const busyThisSlot = screenActionBusy === `create-slot-${slotNumber}`;
                  return (
                    <div
                      key={`empty-slot-${slotNumber}`}
                      className="rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC]/80 p-4 flex flex-col justify-between gap-4 min-h-[220px]"
                    >
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-center gap-2">
                          <span className="font-mono text-[11px] font-semibold text-[#64748B] tabular-metrics">
                            S{slotNumber}
                          </span>
                          <h3 className="text-sm font-semibold text-[#475569]">
                            Screen Slot {slotNumber}
                          </h3>
                        </div>
                        <SignalBadge label="Available" tone="standby" />
                      </div>

                      <div className="rounded-lg border border-[#E2E8F0]/80 bg-white/70 p-3 text-xs text-[#64748B]">
                        <p>
                          Empty signage slot ready for a TV pairing code, independent playlist, and unattended local cache playback.
                        </p>
                      </div>

                      <button
                        type="button"
                        disabled={Boolean(screenActionBusy)}
                        onClick={() => void handleCreateScreen({ slotNumber })}
                        className="inline-flex h-9 w-full items-center justify-center gap-1.5 rounded-[10px] border border-[#2563EB]/30 bg-white px-3 text-xs font-semibold text-[#2563EB] hover:bg-[#EFF6FF] disabled:opacity-50"
                      >
                        <Plus className="h-3.5 w-3.5" aria-hidden="true" />
                        <span>{busyThisSlot ? `Registering S${slotNumber}...` : `Register Slot S${slotNumber}`}</span>
                      </button>
                    </div>
                  );
                }

                const isSelected = selectedScreenIds.has(screen.id);
                const stateBadge = getScreenStateTone(screen);
                return (
                  <div
                    key={screen.id}
                    className={`rounded-xl border bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] flex flex-col justify-between gap-4 transition-colors ${
                      isSelected ? 'border-[#2563EB]' : 'border-[#E2E8F0]'
                    }`}
                  >
                    {/* Card Header */}
                    <div className="space-y-3">
                      <div className="flex items-start justify-between gap-2">
                        <div className="flex items-start gap-2.5 min-w-0">
                          <input
                            type="checkbox"
                            aria-label={`Select ${screen.name}`}
                            checked={isSelected}
                            onChange={() => {
                              setSelectedScreenIds((prev) => {
                                const next = new Set(prev);
                                if (next.has(screen.id)) next.delete(screen.id);
                                else next.add(screen.id);
                                return next;
                              });
                            }}
                            className="mt-1 h-4 w-4 rounded border-[#CBD5E1] text-[#2563EB]"
                          />
                          <div className="min-w-0">
                            {editingScreenId === screen.id ? (
                              <form
                                onSubmit={(e) => {
                                  e.preventDefault();
                                  if (!hostToken || !editingScreenName.trim()) return;
                                  void updateSignageScreen({
                                    hostToken,
                                    screenId: screen.id,
                                    name: editingScreenName.trim(),
                                  }).then(() => {
                                    setEditingScreenId(null);
                                    void refreshWorkspaceData(hostToken);
                                  });
                                }}
                                className="flex items-center gap-1"
                              >
                                <input
                                  type="text"
                                  value={editingScreenName}
                                  onChange={(e) => setEditingScreenName(e.target.value)}
                                  className="h-7 w-36 rounded border border-[#2563EB] px-2 text-xs"
                                />
                                <button
                                  type="submit"
                                  className="rounded bg-[#2563EB] px-2 py-1 text-[11px] font-semibold text-white"
                                >
                                  Save
                                </button>
                              </form>
                            ) : (
                              <div className="flex items-center gap-1.5">
                                <span className="font-mono text-[11px] font-semibold text-[#64748B] tabular-metrics">
                                  S{screen.slotNumber}
                                </span>
                                <h3 className="truncate text-sm font-semibold text-[#172033]">
                                  {screen.name}
                                </h3>
                                <button
                                  type="button"
                                  aria-label={`Rename ${screen.name}`}
                                  onClick={() => {
                                    setEditingScreenId(screen.id);
                                    setEditingScreenName(screen.name);
                                  }}
                                  className="text-[#94A3B8] hover:text-[#172033]"
                                >
                                  <Edit3 className="h-3 w-3" />
                                </button>
                              </div>
                            )}
                            <div className="mt-1 flex flex-wrap items-center gap-2 text-[11px] text-[#64748B]">
                              <span className="font-mono font-semibold text-[#172033] tabular-metrics">
                                Code: {screen.screenCode}
                              </span>
                              <button
                                type="button"
                                onClick={() => void handleCopyPlayerLink(screen)}
                                className="inline-flex items-center gap-1 text-[#2563EB] hover:underline"
                              >
                                {copiedId === screen.id ? (
                                  <>
                                    <Check className="h-3 w-3" />
                                    <span>Copied URL</span>
                                  </>
                                ) : (
                                  <>
                                    <Copy className="h-3 w-3" />
                                    <span>Copy TV URL</span>
                                  </>
                                )}
                              </button>
                            </div>
                          </div>
                        </div>

                        <SignalBadge
                          label={stateBadge.label}
                          tone={stateBadge.tone}
                          pulse={stateBadge.pulse}
                        />
                      </div>

                      {/* Sync & Cache Metrics */}
                      <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 space-y-2 text-xs">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#64748B]">Connection</span>
                          <span className="font-medium text-[#172033]">
                            {screen.claimed
                              ? screen.onlineStatus === 'online'
                                ? 'Connected'
                                : 'Offline'
                              : 'Unpaired'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#64748B]">Playlist</span>
                          <span className="font-medium text-[#172033] truncate max-w-[180px]">
                            {screen.assignedPlaylistName ?? 'Unassigned'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#64748B]">Now Playing</span>
                          <span className="font-medium text-[#172033] truncate max-w-[180px]">
                            {screen.currentMediaName ?? '—'}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#64748B]">Playback Duration</span>
                          <span className="font-mono text-[#172033] tabular-metrics">
                            {formatDuration(screen.totalPlaybackSec)}
                          </span>
                        </div>
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-[#64748B]">Last Sync</span>
                          <span className="text-[#475569]">{formatRelativeTime(screen.lastSyncAt)}</span>
                        </div>

                        {screen.assignedPlaylistId && (
                          <div className="pt-1 space-y-1">
                            <div className="flex items-center justify-between text-[11px]">
                              <span className="text-[#64748B]">
                                Local Cache ({screen.cachedMediaCount}/{screen.totalMediaCount} files)
                              </span>
                              <span className="font-mono font-semibold text-[#172033] tabular-metrics">
                                {screen.cacheProgressPct}% ({formatBytes(screen.cachedBytes)} / {formatBytes(screen.totalBytes)})
                              </span>
                            </div>
                            <div className="h-1.5 w-full overflow-hidden rounded-full bg-[#E2E8F0]">
                              <div
                                className={`h-full transition-all ${
                                  screen.cacheProgressPct >= 100 ? 'bg-[#16A34A]' : 'bg-[#2563EB]'
                                }`}
                                style={{ width: `${Math.min(100, Math.max(0, screen.cacheProgressPct))}%` }}
                              />
                            </div>
                          </div>
                        )}

                        {screen.lastSyncError && (
                          <p className="text-[11px] text-[#DC2626]">{screen.lastSyncError}</p>
                        )}
                      </div>
                    </div>

                    {/* Individual Assignment & Playback Controls */}
                    <div className="space-y-2.5 border-t border-[#E2E8F0] pt-3">
                      <div className="flex items-center gap-2">
                        <select
                          aria-label={`Assign playlist to ${screen.name}`}
                          value={screen.assignedPlaylistId ?? ''}
                          onChange={(e) =>
                            void handleAssignToTargets(
                              [screen.id],
                              e.target.value ? e.target.value : null
                            )
                          }
                          className="h-9 flex-1 min-w-0 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-2.5 text-xs text-[#172033]"
                        >
                          <option value="">Unassigned (Stop)</option>
                          {playlists.map((pl) => (
                            <option key={pl.id} value={pl.id}>
                              {pl.name} ({pl.items.length})
                            </option>
                          ))}
                        </select>
                        <button
                          type="button"
                          onClick={() => onOpenLocalPlayer(screen.screenCode)}
                          title="Open this screen in local TV Player view"
                          className="inline-flex h-9 shrink-0 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#172033] hover:bg-[#F8FAFC]"
                        >
                          <Tv className="h-3.5 w-3.5 text-[#2563EB]" />
                          <span>Preview</span>
                        </button>
                      </div>

                      <div className="flex items-center justify-between gap-2">
                        <div className="flex items-center gap-1.5">
                          <button
                            type="button"
                            disabled={!screen.assignedPlaylistId}
                            onClick={() => void handleControlTargets([screen.id], 'play')}
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#16A34A] hover:bg-[#F0FDF4] disabled:opacity-40"
                          >
                            <Play className="h-3 w-3" />
                            <span>Play</span>
                          </button>
                          <button
                            type="button"
                            disabled={!screen.assignedPlaylistId}
                            onClick={() => void handleControlTargets([screen.id], 'pause')}
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#D97706] hover:bg-[#FFFBEB] disabled:opacity-40"
                          >
                            <Pause className="h-3 w-3" />
                            <span>Pause</span>
                          </button>
                          <button
                            type="button"
                            disabled={!screen.assignedPlaylistId}
                            onClick={() => void handleControlTargets([screen.id], 'stop')}
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E2E8F0] bg-white px-2.5 text-xs font-medium text-[#DC2626] hover:bg-[#FEF2F2] disabled:opacity-40"
                          >
                            <Square className="h-3 w-3" />
                            <span>Stop</span>
                          </button>
                        </div>

                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            title="Regenerate pairing code & unbind current TV"
                            onClick={() => {
                              if (!hostToken) return;
                              void updateSignageScreen({
                                hostToken,
                                screenId: screen.id,
                                regenerateCode: true,
                              }).then(() => refreshWorkspaceData(hostToken));
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#64748B] hover:bg-[#F8FAFC] hover:text-[#172033]"
                          >
                            <RotateCcw className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label={`Remove ${screen.name}`}
                            onClick={() => {
                              if (!hostToken) return;
                              void deleteSignageScreen({ hostToken, screenId: screen.id }).then(() => {
                                setSelectedScreenIds((prev) => {
                                  const next = new Set(prev);
                                  next.delete(screen.id);
                                  return next;
                                });
                                return refreshWorkspaceData(hostToken);
                              });
                            }}
                            className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#DC2626] hover:bg-[#FEF2F2]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 2: MEDIA LIBRARY */}
      {activeTab === 'media' && (
        <div className="space-y-5">
          <div
            onDragOver={(e) => {
              e.preventDefault();
              setDragActive(true);
            }}
            onDragLeave={() => setDragActive(false)}
            onDrop={(e) => {
              e.preventDefault();
              setDragActive(false);
              if (e.dataTransfer.files.length > 0) {
                void handleUploadFiles(e.dataTransfer.files);
              }
            }}
            className={`rounded-xl border-2 border-dashed p-6 text-center transition-colors ${
              dragActive
                ? 'border-[#2563EB] bg-[#EFF6FF]'
                : 'border-[#CBD5E1] bg-white hover:border-[#94A3B8]'
            }`}
          >
            <Upload className="mx-auto h-7 w-7 text-[#2563EB]" aria-hidden="true" />
            <p className="mt-2 text-sm font-semibold text-[#172033]">
              Upload Signage Images &amp; Videos
            </p>
            <p className="mt-1 text-xs text-[#64748B]">
              Drag and drop multiple files or browse. Supported: JPG, JPEG, PNG, WebP, GIF, MP4, WebM, MOV (up to{' '}
              {formatBytes(storageStatus?.maxFileSizeBytes ?? 250 * 1024 * 1024)} each).
            </p>
            <input
              ref={fileInputRef}
              type="file"
              multiple
              accept="image/jpeg,image/png,image/webp,image/gif,video/mp4,video/webm,video/quicktime"
              onChange={(e) => {
                if (e.target.files) {
                  void handleUploadFiles(e.target.files);
                }
              }}
              className="hidden"
            />
            <button
              type="button"
              disabled={uploadPct !== null}
              onClick={() => fileInputRef.current?.click()}
              className="mt-4 inline-flex h-10 items-center gap-2 rounded-[10px] bg-[#2563EB] px-4 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
            >
              <Upload className="h-3.5 w-3.5" aria-hidden="true" />
              <span>{uploadPct !== null ? `Uploading ${uploadPct}%...` : 'Select Media Files'}</span>
            </button>

            {uploadPct !== null && (
              <div className="mx-auto mt-4 max-w-md space-y-1.5 text-left">
                <div className="flex items-center justify-between text-xs text-[#475569]">
                  <span className="truncate">{uploadingFilesLabel}</span>
                  <span className="font-mono tabular-metrics">{uploadPct}%</span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[#E2E8F0]">
                  <div
                    className="h-full bg-[#2563EB] transition-all"
                    style={{ width: `${uploadPct}%` }}
                  />
                </div>
              </div>
            )}
          </div>

          {media.length === 0 ? (
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-10 text-center">
              <ImageIcon className="mx-auto h-8 w-8 text-[#94A3B8]" />
              <p className="mt-3 text-sm font-semibold text-[#172033]">Media Library is empty</p>
              <p className="mt-1 text-xs text-[#64748B]">
                Upload images or MP4 videos above to start building signage playlists.
              </p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4">
              {media.map((asset) => {
                const mediaUrl = hostToken ? buildAuthenticatedMediaUrl(asset.id, hostToken) : '';
                return (
                  <div
                    key={asset.id}
                    className="overflow-hidden rounded-xl border border-[#E2E8F0] bg-white shadow-[0_1px_2px_rgba(15,23,42,0.04)] flex flex-col"
                  >
                    <button
                      type="button"
                      onClick={() => setPreviewMedia(asset)}
                      className="relative aspect-video w-full bg-[#0F172A] overflow-hidden text-left group"
                    >
                      {asset.mediaKind === 'image' ? (
                        <img
                          src={mediaUrl}
                          alt={asset.displayName}
                          className="h-full w-full object-contain"
                          loading="lazy"
                        />
                      ) : (
                        <video
                          src={mediaUrl}
                          muted
                          playsInline
                          preload="metadata"
                          className="h-full w-full object-contain"
                        />
                      )}
                      <span className="absolute bottom-2 right-2 rounded bg-black/75 px-2 py-0.5 font-mono text-[10px] font-semibold text-white">
                        {asset.format}
                        {asset.durationSec ? ` · ${formatDuration(asset.durationSec)}` : ''}
                      </span>
                    </button>

                    <div className="p-3.5 space-y-2.5 flex-1 flex flex-col justify-between">
                      <div>
                        {renamingMediaId === asset.id ? (
                          <form
                            onSubmit={(e) => {
                              e.preventDefault();
                              void handleRenameMediaSubmit(asset.id);
                            }}
                            className="flex items-center gap-1"
                          >
                            <input
                              type="text"
                              value={renamingMediaDraft}
                              onChange={(e) => setRenamingMediaDraft(e.target.value)}
                              className="h-8 flex-1 rounded border border-[#2563EB] px-2 text-xs"
                            />
                            <button
                              type="submit"
                              className="h-8 rounded bg-[#2563EB] px-2.5 text-xs font-semibold text-white"
                            >
                              Save
                            </button>
                          </form>
                        ) : (
                          <h3 className="truncate text-sm font-semibold text-[#172033]">
                            {asset.displayName}
                          </h3>
                        )}
                        <p className="mt-1 font-mono text-[11px] text-[#64748B] tabular-metrics">
                          {formatBytes(asset.sizeBytes)}
                          {asset.width && asset.height ? ` · ${asset.width}×${asset.height}` : ''}
                          {' · '}
                          {asset.uploadStatus === 'ready' ? 'Ready' : asset.uploadStatus}
                        </p>
                      </div>

                      <div className="flex items-center justify-between gap-2 border-t border-[#E2E8F0] pt-2.5">
                        <div className="flex items-center gap-1">
                          <button
                            type="button"
                            onClick={() => {
                              setRenamingMediaId(asset.id);
                              setRenamingMediaDraft(asset.displayName);
                            }}
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E2E8F0] px-2.5 text-xs font-medium text-[#475569] hover:bg-[#F8FAFC]"
                          >
                            <Edit3 className="h-3 w-3" />
                            <span>Rename</span>
                          </button>
                          <button
                            type="button"
                            onClick={() => {
                              handleAddMediaToBuilder(asset);
                              setActiveTab('playlists');
                              setStatusNotice(`Added "${asset.displayName}" to playlist builder.`);
                            }}
                            className="inline-flex h-8 items-center gap-1 rounded-lg border border-[#E2E8F0] px-2.5 text-xs font-medium text-[#2563EB] hover:bg-[#EFF6FF]"
                          >
                            <Plus className="h-3 w-3" />
                            <span>Queue</span>
                          </button>
                        </div>
                        <button
                          type="button"
                          aria-label={`Delete ${asset.displayName}`}
                          onClick={() => void handleDeleteMedia(asset)}
                          className="inline-flex h-8 w-8 items-center justify-center rounded-lg border border-[#E2E8F0] text-[#DC2626] hover:bg-[#FEF2F2]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {/* TAB 3: PLAYLIST BUILDER */}
      {activeTab === 'playlists' && (
        <div className="grid grid-cols-1 gap-6 lg:grid-cols-12">
          {/* Left: Saved Playlists */}
          <div className="lg:col-span-4 space-y-3">
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-3">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-semibold text-[#172033]">Saved Playlists</h2>
                <button
                  type="button"
                  onClick={resetBuilderNew}
                  className="inline-flex h-8 items-center gap-1 rounded-lg bg-[#2563EB] px-3 text-xs font-semibold text-white hover:bg-[#1D4ED8]"
                >
                  <Plus className="h-3.5 w-3.5" />
                  <span>New</span>
                </button>
              </div>

              {playlists.length === 0 ? (
                <p className="py-4 text-center text-xs text-[#64748B]">
                  No playlists saved yet. Build one on the right.
                </p>
              ) : (
                <div className="space-y-2">
                  {playlists.map((pl) => {
                    const active = editingPlaylistId === pl.id;
                    return (
                      <div
                        key={pl.id}
                        className={`flex items-center justify-between gap-2 rounded-lg border p-3 transition-colors ${
                          active
                            ? 'border-[#2563EB] bg-[#EFF6FF]'
                            : 'border-[#E2E8F0] bg-[#F8FAFC] hover:bg-white'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => loadPlaylistIntoBuilder(pl)}
                          className="min-w-0 flex-1 text-left"
                        >
                          <p className="truncate text-xs font-semibold text-[#172033]">{pl.name}</p>
                          <p className="mt-0.5 text-[11px] text-[#64748B] tabular-metrics">
                            {pl.items.length} item{pl.items.length === 1 ? '' : 's'} ·{' '}
                            {pl.loopPlaylist ? 'Loops continuously' : 'Single pass'}
                          </p>
                        </button>
                        <button
                          type="button"
                          aria-label={`Delete playlist ${pl.name}`}
                          onClick={() => void handleDeletePlaylist(pl)}
                          className="inline-flex h-7 w-7 items-center justify-center rounded text-[#DC2626] hover:bg-[#FEE2E2]"
                        >
                          <Trash2 className="h-3.5 w-3.5" />
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            {/* Quick Media Adder */}
            <div className="rounded-xl border border-[#E2E8F0] bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-3">
              <h3 className="text-xs font-semibold uppercase tracking-wide text-[#64748B]">
                Add from Media Library
              </h3>
              {media.length === 0 ? (
                <p className="text-xs text-[#64748B]">
                  Upload images or videos in Media Library first.
                </p>
              ) : (
                <div className="max-h-72 space-y-1.5 overflow-y-auto pr-1">
                  {media.map((asset) => (
                    <button
                      key={asset.id}
                      type="button"
                      onClick={() => handleAddMediaToBuilder(asset)}
                      className="flex w-full items-center justify-between gap-2 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 py-2 text-left text-xs hover:border-[#2563EB]/40 hover:bg-[#EFF6FF]"
                    >
                      <span className="truncate font-medium text-[#172033]">
                        {asset.displayName}
                      </span>
                      <span className="shrink-0 font-mono text-[10px] text-[#2563EB]">
                        + Add ({asset.format})
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          </div>

          {/* Right: Playlist Editor & Drag-and-Drop Queue */}
          <form
            onSubmit={handleSavePlaylist}
            className="lg:col-span-8 rounded-xl border border-[#E2E8F0] bg-white p-5 shadow-[0_1px_2px_rgba(15,23,42,0.04)] space-y-4"
          >
            <div className="flex flex-wrap items-center justify-between gap-3 border-b border-[#E2E8F0] pb-3">
              <h2 className="text-sm font-semibold text-[#172033]">
                {editingPlaylistId ? 'Edit Playlist' : 'Create New Playlist'}
              </h2>
              <button
                type="submit"
                disabled={savingPlaylist}
                className="inline-flex h-10 items-center gap-1.5 rounded-[10px] bg-[#2563EB] px-4 text-xs font-semibold text-white hover:bg-[#1D4ED8] disabled:opacity-50"
              >
                <span>{savingPlaylist ? 'Saving...' : editingPlaylistId ? 'Save Changes' : 'Create Playlist'}</span>
              </button>
            </div>

            <div className="grid grid-cols-1 gap-4 sm:grid-cols-2">
              <div>
                <label htmlFor="pl-name" className="block text-xs font-medium text-[#64748B]">
                  Playlist Name
                </label>
                <input
                  id="pl-name"
                  type="text"
                  maxLength={80}
                  value={plName}
                  onChange={(e) => setPlName(e.target.value)}
                  placeholder="Lobby Morning Loop"
                  className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-sm text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                />
              </div>
              <div>
                <label htmlFor="pl-desc" className="block text-xs font-medium text-[#64748B]">
                  Notes (optional)
                </label>
                <input
                  id="pl-desc"
                  type="text"
                  maxLength={160}
                  value={plDescription}
                  onChange={(e) => setPlDescription(e.target.value)}
                  placeholder="Continuous 7-hour reception signage"
                  className="mt-1 h-10 w-full rounded-[10px] border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-sm text-[#172033] focus:border-[#2563EB] focus:bg-white focus:outline-none"
                />
              </div>
            </div>

            <label className="flex items-center gap-2.5 text-xs font-medium text-[#172033]">
              <input
                type="checkbox"
                checked={plLoop}
                onChange={(e) => setPlLoop(e.target.checked)}
                className="h-4 w-4 rounded border-[#CBD5E1] text-[#2563EB]"
              />
              <span>Loop whole playlist continuously (required for 6–7+ hour unattended signage)</span>
            </label>

            <div className="space-y-2 pt-2">
              <div className="flex items-center justify-between text-xs text-[#64748B]">
                <span>Playlist Order (drag rows or use arrows to reorder)</span>
                <span className="font-mono tabular-metrics">{plItems.length} item(s)</span>
              </div>

              {plItems.length === 0 ? (
                <div className="rounded-xl border border-dashed border-[#CBD5E1] bg-[#F8FAFC] p-8 text-center text-xs text-[#64748B]">
                  Click items from the Media Library panel on the left to add images or videos to this playlist.
                </div>
              ) : (
                <div className="space-y-2">
                  {plItems.map((item, idx) => {
                    const asset = mediaById.get(item.mediaId);
                    const isImage = asset?.mediaKind === 'image';
                    return (
                      <div
                        key={item.localKey}
                        draggable
                        onDragStart={() => setDragIndex(idx)}
                        onDragOver={(e) => e.preventDefault()}
                        onDrop={() => {
                          if (dragIndex !== null) {
                            handleMovePlaylistItem(dragIndex, idx);
                          }
                          setDragIndex(null);
                        }}
                        className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3"
                      >
                        <div className="flex items-center gap-2.5 min-w-0">
                          <GripVertical className="h-4 w-4 shrink-0 text-[#94A3B8] cursor-grab" />
                          <span className="font-mono text-xs font-semibold text-[#64748B] tabular-metrics">
                            #{idx + 1}
                          </span>
                          <div className="min-w-0">
                            <p className="truncate text-xs font-semibold text-[#172033]">
                              {asset?.displayName ?? 'Missing media'}
                            </p>
                            <p className="font-mono text-[11px] text-[#64748B]">
                              {asset?.format ?? 'UNKNOWN'}
                              {asset?.durationSec ? ` · ${formatDuration(asset.durationSec)}` : ''}
                            </p>
                          </div>
                        </div>

                        <div className="flex flex-wrap items-center gap-2">
                          {isImage ? (
                            <label className="flex items-center gap-1.5 text-[11px] text-[#475569]">
                              <span>Duration (s)</span>
                              <input
                                type="number"
                                min={1}
                                max={3600}
                                value={item.imageDurationSec}
                                onChange={(e) => {
                                  const val = Math.max(1, Math.min(3600, Number(e.target.value) || 10));
                                  setPlItems((prev) =>
                                    prev.map((p, i) =>
                                      i === idx ? { ...p, imageDurationSec: val } : p
                                    )
                                  );
                                }}
                                className="h-8 w-16 rounded border border-[#E2E8F0] bg-white px-2 font-mono text-xs tabular-metrics"
                              />
                            </label>
                          ) : (
                            <span className="rounded border border-[#E2E8F0] bg-white px-2 py-1 text-[11px] text-[#475569]">
                              Play to completion
                            </span>
                          )}

                          <label className="flex items-center gap-1.5 text-[11px] text-[#475569]">
                            <span>Repeat ×</span>
                            <input
                              type="number"
                              min={1}
                              max={100}
                              value={item.repeatCount}
                              onChange={(e) => {
                                const val = Math.max(1, Math.min(100, Number(e.target.value) || 1));
                                setPlItems((prev) =>
                                  prev.map((p, i) => (i === idx ? { ...p, repeatCount: val } : p))
                                );
                              }}
                              className="h-8 w-14 rounded border border-[#E2E8F0] bg-white px-2 font-mono text-xs tabular-metrics"
                            />
                          </label>

                          <button
                            type="button"
                            disabled={idx === 0}
                            aria-label="Move item up"
                            onClick={() => handleMovePlaylistItem(idx, idx - 1)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#E2E8F0] bg-white text-[#475569] disabled:opacity-35"
                          >
                            <ArrowUp className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            disabled={idx === plItems.length - 1}
                            aria-label="Move item down"
                            onClick={() => handleMovePlaylistItem(idx, idx + 1)}
                            className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#E2E8F0] bg-white text-[#475569] disabled:opacity-35"
                          >
                            <ArrowDown className="h-3.5 w-3.5" />
                          </button>
                          <button
                            type="button"
                            aria-label="Remove item from playlist"
                            onClick={() =>
                              setPlItems((prev) => prev.filter((_, i) => i !== idx))
                            }
                            className="inline-flex h-8 w-8 items-center justify-center rounded border border-[#E2E8F0] bg-white text-[#DC2626] hover:bg-[#FEF2F2]"
                          >
                            <Trash2 className="h-3.5 w-3.5" />
                          </button>
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>
          </form>
        </div>
      )}

      {/* Media Preview Modal */}
      {previewMedia && hostToken && (
        <div
          className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 p-4"
          onClick={() => setPreviewMedia(null)}
        >
          <div
            className="w-full max-w-4xl overflow-hidden rounded-xl bg-white shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            <div className="flex items-center justify-between border-b border-[#E2E8F0] px-4 py-3">
              <div>
                <h3 className="text-sm font-semibold text-[#172033]">
                  {previewMedia.displayName}
                </h3>
                <p className="font-mono text-[11px] text-[#64748B] tabular-metrics">
                  {previewMedia.format} · {formatBytes(previewMedia.sizeBytes)}
                  {previewMedia.durationSec ? ` · ${formatDuration(previewMedia.durationSec)}` : ''}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setPreviewMedia(null)}
                className="rounded-lg p-1.5 text-[#64748B] hover:bg-[#F1F5F9]"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="bg-black flex items-center justify-center max-h-[75vh]">
              {previewMedia.mediaKind === 'image' ? (
                <img
                  src={buildAuthenticatedMediaUrl(previewMedia.id, hostToken)}
                  alt={previewMedia.displayName}
                  className="max-h-[75vh] w-full object-contain"
                />
              ) : (
                <video
                  src={buildAuthenticatedMediaUrl(previewMedia.id, hostToken)}
                  controls
                  autoPlay
                  className="max-h-[75vh] w-full object-contain"
                />
              )}
            </div>
          </div>
        </div>
      )}

      {/* Workspace Recovery / Key Modal */}
      {showWorkspaceModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
          <div className="w-full max-w-md rounded-xl border border-[#E2E8F0] bg-white p-6 shadow-xl space-y-4">
            <div className="flex items-center justify-between">
              <h3 className="font-display text-base font-semibold text-[#172033]">
                Signage Studio Workspace
              </h3>
              <button type="button" onClick={() => setShowWorkspaceModal(false)}>
                <X className="h-4 w-4 text-[#64748B]" />
              </button>
            </div>

            <div className="rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] p-3 text-xs space-y-1.5">
              <p>
                <span className="text-[#64748B]">Workspace ID:</span>{' '}
                <span className="font-mono font-semibold text-[#172033]">{workspaceId ?? '—'}</span>
              </p>
              {recoveryCode && (
                <p>
                  <span className="text-[#64748B]">Recovery Key:</span>{' '}
                  <span className="font-mono font-semibold text-[#2563EB]">{recoveryCode}</span>
                </p>
              )}
              <p className="text-[11px] text-[#64748B]">
                Save these credentials if you switch browsers or clear site data. TVs remain cached and playing independently either way.
              </p>
            </div>

            <form onSubmit={handleRecoverSubmit} className="space-y-2.5 border-t border-[#E2E8F0] pt-3">
              <p className="text-xs font-semibold text-[#172033]">Switch / Restore Another Workspace</p>
              <input
                type="text"
                value={recoverWsId}
                onChange={(e) => setRecoverWsId(e.target.value)}
                placeholder="Workspace ID (e.g., ws-...)"
                className="h-9 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 text-xs"
              />
              <input
                type="text"
                value={recoverKey}
                onChange={(e) => setRecoverKey(e.target.value)}
                placeholder="Recovery Key (XXXXXX-XXXXXX)"
                className="h-9 w-full rounded-lg border border-[#E2E8F0] bg-[#F8FAFC] px-3 font-mono text-xs uppercase"
              />
              <button
                type="submit"
                className="h-9 w-full rounded-lg bg-[#2563EB] text-xs font-semibold text-white hover:bg-[#1D4ED8]"
              >
                Restore Workspace
              </button>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
