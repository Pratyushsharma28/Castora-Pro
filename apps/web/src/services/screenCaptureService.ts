import type { AudioCaptureStatus, CapturePreferences } from '../types/studio';

export type ScreenCaptureErrorCode =
  | 'SECURE_CONTEXT_REQUIRED'
  | 'API_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'NO_VIDEO_TRACK'
  | 'SOURCE_UNREADABLE'
  | 'OVERCONSTRAINED'
  | 'ABORTED'
  | 'UNKNOWN';

export class ScreenCaptureError extends Error {
  readonly code: ScreenCaptureErrorCode;

  constructor(code: ScreenCaptureErrorCode, message: string) {
    super(message);
    this.name = 'ScreenCaptureError';
    this.code = code;
  }
}

export interface CapturedScreenSession {
  stream: MediaStream;
  videoTrack: MediaStreamTrack;
  audioTrack?: MediaStreamTrack | null;
  hasAudio: boolean;
  audioRequested?: boolean;
  audioCaptureStatus?: AudioCaptureStatus;
  audioNotice?: string | null;
  actualWidth: number | null;
  actualHeight: number | null;
  actualFrameRate: number | null;
  stop: () => void;
}

export function buildVideoTrackConstraints(
  preferences: CapturePreferences
): MediaTrackConstraints {
  const videoConstraints: MediaTrackConstraints = {
    frameRate: { ideal: preferences.targetFps, max: preferences.targetFps },
  };

  if (preferences.resolution === '4k') {
    videoConstraints.width = { ideal: 3840 };
    videoConstraints.height = { ideal: 2160 };
  } else if (preferences.resolution === '1440p') {
    videoConstraints.width = { ideal: 2560 };
    videoConstraints.height = { ideal: 1440 };
  } else if (preferences.resolution === '1080p') {
    videoConstraints.width = { ideal: 1920 };
    videoConstraints.height = { ideal: 1080 };
  } else if (preferences.resolution === '720p') {
    videoConstraints.width = { ideal: 1280 };
    videoConstraints.height = { ideal: 720 };
  }

  return videoConstraints;
}

export function buildDisplayMediaConstraints(
  preferences: CapturePreferences
): DisplayMediaStreamOptions {
  return {
    video: buildVideoTrackConstraints(preferences),
    audio: preferences.includeAudio,
  };
}

export async function applyCaptureTrackConstraints(
  session: CapturedScreenSession,
  nextPreferences: CapturePreferences
): Promise<{
  applied: boolean;
  actualWidth: number | null;
  actualHeight: number | null;
  actualFrameRate: number | null;
  errorMessage: string | null;
}> {
  const track = session.videoTrack;
  if (!track || typeof track.applyConstraints !== 'function') {
    const settings = track?.getSettings?.() ?? {};
    return {
      applied: false,
      actualWidth: typeof settings.width === 'number' ? settings.width : session.actualWidth,
      actualHeight: typeof settings.height === 'number' ? settings.height : session.actualHeight,
      actualFrameRate:
        typeof settings.frameRate === 'number' ? settings.frameRate : session.actualFrameRate,
      errorMessage: 'Track constraint updates are not supported in this browser.',
    };
  }

  try {
    await track.applyConstraints(buildVideoTrackConstraints(nextPreferences));
    const settings = track.getSettings();
    const actualWidth = typeof settings.width === 'number' ? settings.width : session.actualWidth;
    const actualHeight =
      typeof settings.height === 'number' ? settings.height : session.actualHeight;
    const actualFrameRate =
      typeof settings.frameRate === 'number' ? settings.frameRate : session.actualFrameRate;

    session.actualWidth = actualWidth;
    session.actualHeight = actualHeight;
    session.actualFrameRate = actualFrameRate;

    return {
      applied: true,
      actualWidth,
      actualHeight,
      actualFrameRate,
      errorMessage: null,
    };
  } catch (err) {
    const mapped = mapDisplayCaptureError(err);
    const settings = track.getSettings();
    return {
      applied: false,
      actualWidth: typeof settings.width === 'number' ? settings.width : session.actualWidth,
      actualHeight: typeof settings.height === 'number' ? settings.height : session.actualHeight,
      actualFrameRate:
        typeof settings.frameRate === 'number' ? settings.frameRate : session.actualFrameRate,
      errorMessage: mapped.message,
    };
  }
}

export function mapDisplayCaptureError(err: unknown): ScreenCaptureError {
  if (err instanceof ScreenCaptureError) {
    return err;
  }

  if (err && typeof err === 'object' && 'name' in err) {
    const name = String((err as { name: unknown }).name);
    const message = 'message' in err ? String((err as { message: unknown }).message) : '';

    if (name === 'NotAllowedError' || name === 'PermissionDeniedError') {
      return new ScreenCaptureError(
        'PERMISSION_DENIED',
        'Screen recording permission was denied or the screen picker was cancelled.'
      );
    }
    if (name === 'AbortError') {
      return new ScreenCaptureError(
        'ABORTED',
        'Screen selection was cancelled before starting capture.'
      );
    }
    if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
      return new ScreenCaptureError(
        'NO_VIDEO_TRACK',
        'No shareable display, window, or tab source was returned by the browser.'
      );
    }
    if (name === 'NotReadableError' || name === 'TrackStartError') {
      return new ScreenCaptureError(
        'SOURCE_UNREADABLE',
        'Browser could not read the selected screen source. Check macOS System Settings -> Privacy & Security -> Screen Recording.'
      );
    }
    if (name === 'OverconstrainedError' || name === 'ConstraintNotSatisfiedError') {
      return new ScreenCaptureError(
        'OVERCONSTRAINED',
        'The selected display or encoder cannot satisfy the requested resolution or frame rate. Previous working settings were kept.'
      );
    }
    if (name === 'SecurityError') {
      return new ScreenCaptureError(
        'SECURE_CONTEXT_REQUIRED',
        'Screen capture requires a trusted HTTPS origin or localhost.'
      );
    }
    return new ScreenCaptureError(
      'UNKNOWN',
      message || `Unable to start screen capture (${name}).`
    );
  }

  return new ScreenCaptureError(
    'UNKNOWN',
    err instanceof Error ? err.message : 'Unable to start screen capture.'
  );
}

export function stopMediaStreamTracks(stream: MediaStream | null): void {
  if (!stream) return;
  for (const track of stream.getTracks()) {
    try {
      track.stop();
    } catch {
      // Ignore already-stopped track errors
    }
  }
}

export async function startScreenCapture(params: {
  preferences: CapturePreferences;
  onNativeEnded: () => void;
  onAudioTrackStateChange?: (status: AudioCaptureStatus, notice: string | null) => void;
  env?: {
    isSecureContext?: boolean;
    mediaDevices?: Pick<MediaDevices, 'getDisplayMedia'> | undefined;
  };
}): Promise<CapturedScreenSession> {
  const isSecure =
    params.env?.isSecureContext ??
    (typeof window !== 'undefined' ? window.isSecureContext : false);

  if (!isSecure) {
    throw new ScreenCaptureError(
      'SECURE_CONTEXT_REQUIRED',
      'Screen capture blocked: open Castora Pro over HTTPS or localhost.'
    );
  }

  const mediaDevices =
    params.env?.mediaDevices ??
    (typeof navigator !== 'undefined' ? navigator.mediaDevices : undefined);

  if (!mediaDevices || typeof mediaDevices.getDisplayMedia !== 'function') {
    throw new ScreenCaptureError(
      'API_UNAVAILABLE',
      'navigator.mediaDevices.getDisplayMedia() is not supported in this browser.'
    );
  }

  let stream: MediaStream;
  try {
    stream = await mediaDevices.getDisplayMedia(
      buildDisplayMediaConstraints(params.preferences)
    );
  } catch (err) {
    throw mapDisplayCaptureError(err);
  }

  const videoTracks = stream.getVideoTracks();
  if (videoTracks.length === 0) {
    stopMediaStreamTracks(stream);
    throw new ScreenCaptureError(
      'NO_VIDEO_TRACK',
      'No video track was provided by getDisplayMedia().'
    );
  }

  const videoTrack = videoTracks[0];
  if ('contentHint' in videoTrack) {
    try {
      videoTrack.contentHint = 'detail';
    } catch {
      // Ignore unsupported contentHint assignment
    }
  }

  const audioTracks = stream.getAudioTracks();
  const audioTrack = audioTracks.find((t) => t.readyState !== 'ended') ?? audioTracks[0] ?? null;
  const hasAudio = Boolean(audioTrack && audioTrack.readyState !== 'ended');
  const audioRequested = Boolean(params.preferences.includeAudio);

  let audioCaptureStatus: AudioCaptureStatus;
  let audioNotice: string | null = null;
  if (hasAudio) {
    audioCaptureStatus = 'captured';
  } else if (audioRequested) {
    audioCaptureStatus = 'not-captured-no-source';
    audioNotice =
      'Audio was requested, but the browser returned video only. On macOS, select a Browser Tab with "Share tab audio" or Entire Screen with "Share system audio".';
  } else {
    audioCaptureStatus = 'not-requested';
  }

  const settings = videoTrack.getSettings();
  let intentionallyStopped = false;

  const handleTrackEnded = () => {
    if (intentionallyStopped) return;
    stopMediaStreamTracks(stream);
    params.onNativeEnded();
  };

  const handleAudioEnded = () => {
    if (intentionallyStopped) return;
    session.hasAudio = false;
    session.audioCaptureStatus = 'ended';
    session.audioNotice = 'Captured audio track ended while screen video remained active.';
    params.onAudioTrackStateChange?.('ended', session.audioNotice);
  };

  const handleAudioMuted = () => {
    if (intentionallyStopped) return;
    params.onAudioTrackStateChange?.(
      session.audioCaptureStatus ?? 'captured',
      'Captured audio track is temporarily muted.'
    );
  };

  const handleAudioUnmuted = () => {
    if (intentionallyStopped) return;
    if (audioTrack && audioTrack.readyState === 'live') {
      session.hasAudio = true;
      session.audioCaptureStatus = 'captured';
      session.audioNotice = null;
      params.onAudioTrackStateChange?.('captured', null);
    }
  };

  videoTrack.addEventListener('ended', handleTrackEnded);
  if (audioTrack && typeof audioTrack.addEventListener === 'function') {
    audioTrack.addEventListener('ended', handleAudioEnded);
    audioTrack.addEventListener('mute', handleAudioMuted);
    audioTrack.addEventListener('unmute', handleAudioUnmuted);
  }

  const stop = () => {
    if (intentionallyStopped) return;
    intentionallyStopped = true;
    videoTrack.removeEventListener('ended', handleTrackEnded);
    if (audioTrack && typeof audioTrack.removeEventListener === 'function') {
      audioTrack.removeEventListener('ended', handleAudioEnded);
      audioTrack.removeEventListener('mute', handleAudioMuted);
      audioTrack.removeEventListener('unmute', handleAudioUnmuted);
    }
    stopMediaStreamTracks(stream);
  };

  const session: CapturedScreenSession = {
    stream,
    videoTrack,
    audioTrack,
    hasAudio,
    audioRequested,
    audioCaptureStatus,
    audioNotice,
    actualWidth: typeof settings.width === 'number' ? settings.width : null,
    actualHeight: typeof settings.height === 'number' ? settings.height : null,
    actualFrameRate: typeof settings.frameRate === 'number' ? settings.frameRate : null,
    stop,
  };

  return session;
}
