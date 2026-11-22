import { expect, test } from '@playwright/test';
import { createNamedContext, navigateTopBar, waitForServerConnected } from './helpers';

test.describe('2. Browser E2E — WebRTC Screen Sharing, Fullscreen, Audio & Quality Presets', () => {
  test('verifies bidirectional WebRTC streams, multi-stream grid, video-only fullscreen, audio mute, 1080p/1440p/4K presets, real getStats() & ABR lock', async ({
    browser,
  }) => {
    // Controlled synthetic <canvas>.captureStream + WebAudio fixture feeds real Chromium RTCPeerConnection
    const host = await createNamedContext(browser, 'Mac Sender Host', {
      width: 1920,
      height: 1080,
      fps: 30,
      includeAudioTone: true,
    });
    const rx1 = await createNamedContext(browser, 'Receiver Station 1', {
      width: 1920,
      height: 1080,
      fps: 30,
      includeAudioTone: true,
    });
    const rx2 = await createNamedContext(browser, 'Receiver Station 2', {
      width: 1280,
      height: 720,
      fps: 30,
      includeAudioTone: false,
    });

    try {
      // Boot Host, check 1080p60 default in Settings, and create Open room
      await host.page.goto('/');
      await waitForServerConnected(host.page);

      await navigateTopBar(host.page, 'Settings');
      await expect(host.page.getByText('1080P', { exact: true })).toBeVisible();
      await expect(host.page.getByText('60 FPS')).toBeVisible();
      await expect(host.page.getByText('Auto (Adaptive getStats)')).toBeVisible();

      await navigateTopBar(host.page, 'Session');
      await host.page.locator('#session-create-name').fill('Media Quality E2E Room');
      await host.page.getByRole('button', { name: /Open/ }).click();
      await host.page.getByRole('button', { name: 'Create Session Room' }).click();
      const roomId = (await host.page.locator('dd.font-mono').first().innerText()).trim();

      // Join Rx1 and Rx2 into the room
      for (const peer of [rx1, rx2]) {
        await peer.page.goto('/');
        await waitForServerConnected(peer.page);
        await navigateTopBar(peer.page, 'Rooms');
        await peer.page.locator('#castora-room-code').fill(roomId);
        await peer.page.getByRole('button', { name: 'Request to Join Room' }).click();
        await expect(peer.page.getByText('Paired', { exact: true })).toBeVisible();
      }

      // Host opens Screens -> Share Controls: verify 1080p60 defaults & enable Audio sharing
      await navigateTopBar(host.page, 'Screens');
      await host.page.getByRole('button', { name: 'Share Controls' }).click();
      await expect(host.page.getByText('1080p (1920 × 1080) @ 60 FPS')).toBeVisible();
      await host.page.locator('button[title="Include system or tab audio"]').click();

      // Start Host Screen Share
      await host.page.getByRole('button', { name: 'Share Screen' }).first().click();

      // Navigate receivers to Screens and verify live <video> playback + real decoded dimensions
      await navigateTopBar(rx1.page, 'Screens');
      await navigateTopBar(rx2.page, 'Screens');

      await expect
        .poll(
          async () =>
            rx1.page.evaluate(() => {
              const v = document.querySelector('video');
              return v ? { ready: v.readyState, w: v.videoWidth, h: v.videoHeight } : null;
            }),
          { timeout: 25_000 }
        )
        .toMatchObject({ ready: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });

      await expect
        .poll(
          async () =>
            rx1.page.evaluate(() => {
              const v = document.querySelector('video');
              return Boolean(v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
            }),
          { timeout: 25_000 }
        )
        .toBe(true);

      await expect
        .poll(
          async () =>
            rx2.page.evaluate(() => {
              const v = document.querySelector('video');
              return Boolean(v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
            }),
          { timeout: 25_000 }
        )
        .toBe(true);

      // Verify Rx1 audio mute toggle actually updates <video>.muted state
      const rx1MuteBtn = rx1.page.getByRole('button', { name: 'Toggle mute for Mac Sender Host' });
      await expect(rx1MuteBtn).toBeEnabled({ timeout: 15_000 });
      const initialMuted = await rx1.page.evaluate(() => document.querySelector('video')?.muted ?? true);
      expect(initialMuted).toBe(true);
      await rx1MuteBtn.click();
      await expect
        .poll(() => rx1.page.evaluate(() => document.querySelector('video')?.muted))
        .toBe(false);
      await rx1MuteBtn.click();
      await expect
        .poll(() => rx1.page.evaluate(() => document.querySelector('video')?.muted))
        .toBe(true);

      // Verify Video-Only Fullscreen behavior on Rx1
      const fsBtn = rx1.page.getByRole('button', { name: /Fullscreen Mac Sender Host/i });
      await fsBtn.click();
      await expect
        .poll(() => rx1.page.evaluate(() => Boolean(document.fullscreenElement)))
        .toBe(true);

      const fsAudit = await rx1.page.evaluate(() => {
        const fsEl = document.fullscreenElement;
        if (!fsEl) return { ok: false, chromeCount: -1, fsAttr: null };
        const chromeInside = fsEl.querySelectorAll('[data-castora-chrome]').length;
        const card = fsEl.closest('.castora-surface-card');
        const headerStyle = card?.querySelector('[data-castora-card-header]')
          ? getComputedStyle(card.querySelector('[data-castora-card-header]') as Element).display
          : null;
        const footerStyle = card?.querySelector('[data-castora-card-footer]')
          ? getComputedStyle(card.querySelector('[data-castora-card-footer]') as Element).display
          : null;
        return {
          ok: true,
          chromeCount: chromeInside,
          fsAttr: fsEl.getAttribute('data-castora-video-fullscreen'),
          headerStyle,
          footerStyle,
        };
      });
      expect(fsAudit.ok).toBe(true);
      expect(fsAudit.chromeCount).toBe(0);
      expect(fsAudit.fsAttr).toBe('true');
      expect(fsAudit.headerStyle).toBe('none');
      expect(fsAudit.footerStyle).toBe('none');

      // Exit fullscreen with Escape
      await rx1.page.keyboard.press('Escape');
      await expect
        .poll(() => rx1.page.evaluate(() => Boolean(document.fullscreenElement)))
        .toBe(false);

      // Bidirectional sharing + multiple incoming streams on Host:
      // Rx1 and Rx2 both start sharing while Host continues sharing
      await rx1.page.getByRole('button', { name: 'Share Screen' }).first().click();
      await rx2.page.getByRole('button', { name: 'Share Screen' }).first().click();

      await expect
        .poll(
          async () =>
            host.page.evaluate(
              () =>
                Array.from(document.querySelectorAll('video')).filter(
                  (v) => v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0
                ).length
            ),
          { timeout: 25_000 }
        )
        .toBeGreaterThanOrEqual(2);
      await expect(host.page.getByText('2 incoming streams live')).toBeVisible();

      // Independent stopping: Rx1 stops its own share while Host stays streaming and Rx2 keeps streaming to Host
      await rx1.page.getByRole('button', { name: 'Stop Sharing' }).first().click();
      await expect(host.page.getByText('1 incoming stream live')).toBeVisible({ timeout: 15_000 });
      await expect(rx1.page.getByText('1 incoming stream live')).toBeVisible();

      // Streaming Quality Diagnostics & Adaptive Quality verification (real RTCStatsReport polling runs every 2s)
      await expect
        .poll(
          async () => {
            const text = await host.page.getByLabel('Streaming Quality Diagnostics').innerText();
            return /kbps|Mbps/.test(text) && !/Unavailable\s+Unavailable\s+Unavailable/.test(text);
          },
          { timeout: 20_000 }
        )
        .toBe(true);

      // Switch Host preset to 1440p and 4K in Share Controls -> AdaptiveQualityPanel reflects requested preset
      await host.page.getByRole('button', { name: '1440p', exact: true }).first().click();
      await expect(host.page.getByText(/Ultra \(1440p60\)|2560×1440/i).first()).toBeVisible();

      await host.page.getByRole('button', { name: '4K', exact: true }).first().click();
      await expect(host.page.getByText(/Maximum \(4K60\)|3840×2160/i).first()).toBeVisible();

      // Per-peer quality independence & Manual lock: lock Rx1 peer independently while Rx2 stays Auto
      const adaptPanel = host.page.getByLabel('Adaptive Streaming Quality');
      const rx1Row = adaptPanel.locator('tr').filter({ hasText: 'Receiver Station 1' });
      const rx2Row = adaptPanel.locator('tr').filter({ hasText: 'Receiver Station 2' });
      await rx1Row.getByRole('button', { name: 'Lock Manual' }).click();
      await expect(rx1Row.getByText('Manual', { exact: true })).toBeVisible();
      await expect(rx2Row.getByText('Auto', { exact: true })).toBeVisible();

      // Global Manual mode lock
      await adaptPanel.getByRole('button', { name: 'Return to Manual' }).click();
      await expect(adaptPanel.getByText('Manual Mode')).toBeVisible();
      await expect(
        adaptPanel.getByText('Manual mode locked — automatic quality changes disabled.')
      ).toBeVisible();
    } finally {
      await host.context.close();
      await rx1.context.close();
      await rx2.context.close();
    }
  });
});
