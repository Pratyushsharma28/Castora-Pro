import type { Browser, BrowserContext, Page } from '@playwright/test';

export interface SyntheticMediaOptions {
  label: string;
  width?: number;
  height?: number;
  fps?: number;
  includeAudioTone?: boolean;
}

/**
 * Installs a deterministic, clearly-marked simulated `navigator.mediaDevices.getDisplayMedia`
 * fixture for headless Linux sandboxes where no physical X11/Wayland display exists.
 *
 * IMPORTANT: Only display surface selection is simulated via animated <canvas>.captureStream()
 * (plus optional WebAudio 440Hz oscillator track). The returned MediaStreamTrack feeds
 * real Chromium RTCPeerConnection, real DTLS-SRTP/ICE, real VP8/H264 encoding & decoding,
 * real HTMLVideoElement playback, and real Chromium RTCStatsReport getStats().
 */
export async function installSyntheticDisplayMediaFixture(
  page: Page,
  options: SyntheticMediaOptions
): Promise<void> {
  await page.addInitScript((opts: SyntheticMediaOptions) => {
    const win = window as unknown as {
      __castoraFakeShareLabel?: string;
      __castoraFakeCaptureSize?: { width: number; height: number; fps: number };
      __castoraFakeWithAudio?: boolean;
    };
    win.__castoraFakeShareLabel = opts.label;
    win.__castoraFakeCaptureSize = {
      width: opts.width ?? 1920,
      height: opts.height ?? 1080,
      fps: opts.fps ?? 30,
    };
    win.__castoraFakeWithAudio = opts.includeAudioTone ?? false;

    const createSyntheticStream = (constraints?: DisplayMediaStreamOptions): MediaStream => {
      const targetSize = win.__castoraFakeCaptureSize ?? { width: 1920, height: 1080, fps: 30 };
      const videoConstraint =
        constraints?.video && typeof constraints.video === 'object' ? constraints.video : {};
      const widthObj = videoConstraint.width as { ideal?: number; max?: number } | number | undefined;
      const heightObj = videoConstraint.height as { ideal?: number; max?: number } | number | undefined;
      const requestedW =
        typeof widthObj === 'number'
          ? widthObj
          : widthObj?.ideal ?? widthObj?.max ?? targetSize.width;
      const requestedH =
        typeof heightObj === 'number'
          ? heightObj
          : heightObj?.ideal ?? heightObj?.max ?? targetSize.height;

      const canvas = document.createElement('canvas');
      canvas.width = Math.max(640, Math.min(3840, requestedW));
      canvas.height = Math.max(360, Math.min(2160, requestedH));
      canvas.style.cssText =
        'position:fixed;left:-9999px;top:-9999px;width:4px;height:4px;opacity:0.01;pointer-events:none;';
      const hostNode = document.body ?? document.documentElement;
      if (hostNode) {
        hostNode.appendChild(canvas);
      }
      const ctx = canvas.getContext('2d');
      let frame = 0;

      const drawFrame = () => {
        frame += 1;
        if (!ctx) return;
        ctx.fillStyle = '#0F172A';
        ctx.fillRect(0, 0, canvas.width, canvas.height);

        // Moving gradient bar so Chromium VP8/H264 encoder produces real continuous keyframes & P-frames
        const barX = (frame * 18) % Math.max(1, canvas.width - 220);
        ctx.fillStyle = '#2563EB';
        ctx.fillRect(barX, 80, 220, 48);

        ctx.fillStyle = '#F8FAFC';
        ctx.font = 'bold 42px sans-serif';
        ctx.fillText(`CASTORA TEST FIXTURE: ${win.__castoraFakeShareLabel ?? 'Peer'}`, 60, 220);
        ctx.font = '28px monospace';
        ctx.fillText(
          `SIMULATED SURFACE ${canvas.width}x${canvas.height} · FRAME ${frame}`,
          60,
          290
        );
      };
      drawFrame();
      const timer = window.setInterval(drawFrame, Math.round(1000 / Math.max(10, targetSize.fps)));

      const stream = canvas.captureStream(targetSize.fps);
      const vTrack = stream.getVideoTracks()[0];
      if (vTrack) {
        const origStop = vTrack.stop.bind(vTrack);
        vTrack.stop = () => {
          window.clearInterval(timer);
          canvas.remove();
          origStop();
        };
        const origGetSettings = vTrack.getSettings.bind(vTrack);
        vTrack.getSettings = () => ({
          ...origGetSettings(),
          width: canvas.width,
          height: canvas.height,
          frameRate: targetSize.fps,
          displaySurface: 'monitor',
        });
      }

      const wantAudio = Boolean(constraints?.audio) || Boolean(win.__castoraFakeWithAudio);
      if (wantAudio && typeof AudioContext !== 'undefined') {
        try {
          const audioCtx = new AudioContext();
          void audioCtx.resume().catch(() => {});
          const osc = audioCtx.createOscillator();
          const gain = audioCtx.createGain();
          gain.gain.value = 0.02;
          osc.frequency.value = 440;
          const dest = audioCtx.createMediaStreamDestination();
          osc.connect(gain);
          gain.connect(dest);
          osc.start();
          const audioTrack = dest.stream.getAudioTracks()[0];
          if (audioTrack) {
            const origAudioStop = audioTrack.stop.bind(audioTrack);
            audioTrack.stop = () => {
              try {
                osc.stop();
                void audioCtx.close();
              } catch {
                // ignore
              }
              origAudioStop();
            };
            stream.addTrack(audioTrack);
          }
        } catch {
          // AudioContext may fail if suspended without gesture
        }
      }

      return stream;
    };

    const mediaDevices = navigator.mediaDevices;
    if (mediaDevices) {
      mediaDevices.getDisplayMedia = async (constraints?: DisplayMediaStreamOptions) => {
        return createSyntheticStream(constraints);
      };
    }
  }, options);
}

export async function createNamedContext(
  browser: Browser,
  deviceName: string,
  syntheticMedia?: Omit<SyntheticMediaOptions, 'label'>
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({
    permissions: ['clipboard-read', 'clipboard-write'],
  });
  await context.addInitScript((name: string) => {
    window.localStorage.setItem('castora.web.deviceName', name);
  }, deviceName);
  const page = await context.newPage();
  if (syntheticMedia) {
    await installSyntheticDisplayMediaFixture(page, {
      ...syntheticMedia,
      label: deviceName,
    });
  }
  return { context, page };
}

export async function waitForServerConnected(page: Page): Promise<void> {
  await page.getByText('Connected', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
}

export async function navigateTopBar(
  page: Page,
  label: 'Home' | 'Rooms' | 'Session' | 'Devices' | 'Screens' | 'Settings'
): Promise<void> {
  await page.getByRole('navigation', { name: 'Primary Navigation' }).getByRole('button', { name: label }).click();
}
