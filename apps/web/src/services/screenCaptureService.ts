import type { CapturePreferences } from '../types/studio';

export type ScreenCaptureErrorCode =
  | 'SECURE_CONTEXT_REQUIRED'
  | 'API_UNAVAILABLE'
  | 'PERMISSION_DENIED'
  | 'NO_VIDEO_TRACK'
  | 'SOURCE_UNREADABLE'
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
  hasAudio: boolean;
  actualWidth: number | null;
  actualHeight: number | null;
  actualFrameRate: number | null;
  stop: () => void;
}

export function buildDisplayMediaConstraints(
  preferences: CapturePreferences
): DisplayMediaStreamOptions {
  const videoConstraints: MediaTrackConstraints = {
    frameRate: { ideal: preferences.targetFps },
  };

  if (preferences.resolution === '1080p') {
    videoConstraints.width = { ideal: 1920 };
    videoConstraints.height = { ideal: 1080 };
  } else if (preferences.resolution === '720p') {
    videoConstraints.width = { ideal: 1280 };
    videoConstraints.height = { ideal: 720 };
  }

  return {
    video: videoConstraints,
    audio: preferences.includeAudio,
  };
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

  const settings = videoTrack.getSettings();
  let intentionallyStopped = false;

  const handleTrackEnded = () => {
    if (intentionallyStopped) return;
    stopMediaStreamTracks(stream);
    params.onNativeEnded();
  };

  videoTrack.addEventListener('ended', handleTrackEnded);

  const stop = () => {
    if (intentionallyStopped) return;
    intentionallyStopped = true;
    videoTrack.removeEventListener('ended', handleTrackEnded);
    stopMediaStreamTracks(stream);
  };

  return {
    stream,
    videoTrack,
    hasAudio: stream.getAudioTracks().length > 0,
    actualWidth: typeof settings.width === 'number' ? settings.width : null,
    actualHeight: typeof settings.height === 'number' ? settings.height : null,
    actualFrameRate: typeof settings.frameRate === 'number' ? settings.frameRate : null,
    stop,
  };
}
