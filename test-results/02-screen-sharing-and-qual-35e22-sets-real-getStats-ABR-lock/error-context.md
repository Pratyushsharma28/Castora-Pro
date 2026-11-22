# Instructions

- Following Playwright test failed.
- Explain why, be concise, respect Playwright best practices.
- Provide a snippet of code with the fix, if possible.

# Test info

- Name: 02-screen-sharing-and-quality.spec.ts >> 2. Browser E2E — WebRTC Screen Sharing, Fullscreen, Audio & Quality Presets >> verifies bidirectional WebRTC streams, multi-stream grid, video-only fullscreen, audio mute, 1080p/1440p/4K presets, real getStats() & ABR lock
- Location: tests/e2e/02-screen-sharing-and-quality.spec.ts:5:3

# Error details

```
Error: expect(received).toBe(expected) // Object.is equality

Expected: true
Received: false

Call Log:
- Timeout 25000ms exceeded while waiting on the predicate
```

# Test source

```ts
  1   | import { expect, test } from '@playwright/test';
  2   | import { createNamedContext, navigateTopBar, waitForServerConnected } from './helpers';
  3   | 
  4   | test.describe('2. Browser E2E — WebRTC Screen Sharing, Fullscreen, Audio & Quality Presets', () => {
  5   |   test('verifies bidirectional WebRTC streams, multi-stream grid, video-only fullscreen, audio mute, 1080p/1440p/4K presets, real getStats() & ABR lock', async ({
  6   |     browser,
  7   |   }) => {
  8   |     // Controlled synthetic <canvas>.captureStream + WebAudio fixture feeds real Chromium RTCPeerConnection
  9   |     const host = await createNamedContext(browser, 'Mac Sender Host', {
  10  |       width: 1920,
  11  |       height: 1080,
  12  |       fps: 30,
  13  |       includeAudioTone: true,
  14  |     });
  15  |     const rx1 = await createNamedContext(browser, 'Receiver Station 1', {
  16  |       width: 1920,
  17  |       height: 1080,
  18  |       fps: 30,
  19  |       includeAudioTone: true,
  20  |     });
  21  |     const rx2 = await createNamedContext(browser, 'Receiver Station 2', {
  22  |       width: 1280,
  23  |       height: 720,
  24  |       fps: 30,
  25  |       includeAudioTone: false,
  26  |     });
  27  | 
  28  |     try {
  29  |       // Boot Host, check 1080p60 default in Settings, and create Open room
  30  |       await host.page.goto('/');
  31  |       await waitForServerConnected(host.page);
  32  | 
  33  |       await navigateTopBar(host.page, 'Settings');
  34  |       await expect(host.page.getByText('1080P', { exact: true })).toBeVisible();
  35  |       await expect(host.page.getByText('60 FPS')).toBeVisible();
  36  |       await expect(host.page.getByText('Auto (Adaptive getStats)')).toBeVisible();
  37  | 
  38  |       await navigateTopBar(host.page, 'Session');
  39  |       await host.page.locator('#session-create-name').fill('Media Quality E2E Room');
  40  |       await host.page.getByRole('button', { name: /Open/ }).click();
  41  |       await host.page.getByRole('button', { name: 'Create Session Room' }).click();
  42  |       const roomId = (await host.page.locator('dd.font-mono').first().innerText()).trim();
  43  | 
  44  |       // Join Rx1 and Rx2 into the room
  45  |       for (const peer of [rx1, rx2]) {
  46  |         await peer.page.goto('/');
  47  |         await waitForServerConnected(peer.page);
  48  |         await navigateTopBar(peer.page, 'Rooms');
  49  |         await peer.page.locator('#castora-room-code').fill(roomId);
  50  |         await peer.page.getByRole('button', { name: 'Request to Join Room' }).click();
  51  |         await expect(peer.page.getByText('Paired', { exact: true })).toBeVisible();
  52  |       }
  53  | 
  54  |       // Host opens Screens -> Share Controls: verify 1080p60 defaults & enable Audio sharing
  55  |       await navigateTopBar(host.page, 'Screens');
  56  |       await host.page.getByRole('button', { name: 'Share Controls' }).click();
  57  |       await expect(host.page.getByText('1080p (1920 × 1080) @ 60 FPS')).toBeVisible();
  58  |       await host.page.locator('button[title="Include system or tab audio"]').click();
  59  | 
  60  |       // Start Host Screen Share
  61  |       await host.page.getByRole('button', { name: 'Share Screen' }).first().click();
  62  | 
  63  |       // Navigate receivers to Screens and verify live <video> playback + real decoded dimensions
  64  |       await navigateTopBar(rx1.page, 'Screens');
  65  |       await navigateTopBar(rx2.page, 'Screens');
  66  | 
  67  |       await expect
  68  |         .poll(
  69  |           async () =>
  70  |             rx1.page.evaluate(() => {
  71  |               const v = document.querySelector('video');
  72  |               return v ? { ready: v.readyState, w: v.videoWidth, h: v.videoHeight } : null;
  73  |             }),
  74  |           { timeout: 25_000 }
  75  |         )
  76  |         .toMatchObject({ ready: expect.any(Number), w: expect.any(Number), h: expect.any(Number) });
  77  | 
  78  |       await expect
  79  |         .poll(
  80  |           async () =>
  81  |             rx1.page.evaluate(() => {
  82  |               const v = document.querySelector('video');
  83  |               return Boolean(v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
  84  |             }),
  85  |           { timeout: 25_000 }
  86  |         )
> 87  |         .toBe(true);
      |          ^ Error: expect(received).toBe(expected) // Object.is equality
  88  | 
  89  |       await expect
  90  |         .poll(
  91  |           async () =>
  92  |             rx2.page.evaluate(() => {
  93  |               const v = document.querySelector('video');
  94  |               return Boolean(v && v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0);
  95  |             }),
  96  |           { timeout: 25_000 }
  97  |         )
  98  |         .toBe(true);
  99  | 
  100 |       // Verify Rx1 audio mute toggle actually updates <video>.muted state
  101 |       const rx1MuteBtn = rx1.page.getByRole('button', { name: 'Toggle mute for Mac Sender Host' });
  102 |       await expect(rx1MuteBtn).toBeEnabled({ timeout: 15_000 });
  103 |       const initialMuted = await rx1.page.evaluate(() => document.querySelector('video')?.muted ?? true);
  104 |       expect(initialMuted).toBe(true);
  105 |       await rx1MuteBtn.click();
  106 |       await expect
  107 |         .poll(() => rx1.page.evaluate(() => document.querySelector('video')?.muted))
  108 |         .toBe(false);
  109 |       await rx1MuteBtn.click();
  110 |       await expect
  111 |         .poll(() => rx1.page.evaluate(() => document.querySelector('video')?.muted))
  112 |         .toBe(true);
  113 | 
  114 |       // Verify Video-Only Fullscreen behavior on Rx1
  115 |       const fsBtn = rx1.page.getByRole('button', { name: /Fullscreen Mac Sender Host/i });
  116 |       await fsBtn.click();
  117 |       await expect
  118 |         .poll(() => rx1.page.evaluate(() => Boolean(document.fullscreenElement)))
  119 |         .toBe(true);
  120 | 
  121 |       const fsAudit = await rx1.page.evaluate(() => {
  122 |         const fsEl = document.fullscreenElement;
  123 |         if (!fsEl) return { ok: false, chromeCount: -1, fsAttr: null };
  124 |         const chromeInside = fsEl.querySelectorAll('[data-castora-chrome]').length;
  125 |         const card = fsEl.closest('.castora-surface-card');
  126 |         const headerStyle = card?.querySelector('[data-castora-card-header]')
  127 |           ? getComputedStyle(card.querySelector('[data-castora-card-header]') as Element).display
  128 |           : null;
  129 |         const footerStyle = card?.querySelector('[data-castora-card-footer]')
  130 |           ? getComputedStyle(card.querySelector('[data-castora-card-footer]') as Element).display
  131 |           : null;
  132 |         return {
  133 |           ok: true,
  134 |           chromeCount: chromeInside,
  135 |           fsAttr: fsEl.getAttribute('data-castora-video-fullscreen'),
  136 |           headerStyle,
  137 |           footerStyle,
  138 |         };
  139 |       });
  140 |       expect(fsAudit.ok).toBe(true);
  141 |       expect(fsAudit.chromeCount).toBe(0);
  142 |       expect(fsAudit.fsAttr).toBe('true');
  143 |       expect(fsAudit.headerStyle).toBe('none');
  144 |       expect(fsAudit.footerStyle).toBe('none');
  145 | 
  146 |       // Exit fullscreen with Escape
  147 |       await rx1.page.keyboard.press('Escape');
  148 |       await expect
  149 |         .poll(() => rx1.page.evaluate(() => Boolean(document.fullscreenElement)))
  150 |         .toBe(false);
  151 | 
  152 |       // Bidirectional sharing + multiple incoming streams on Host:
  153 |       // Rx1 and Rx2 both start sharing while Host continues sharing
  154 |       await rx1.page.getByRole('button', { name: 'Share Screen' }).first().click();
  155 |       await rx2.page.getByRole('button', { name: 'Share Screen' }).first().click();
  156 | 
  157 |       await expect
  158 |         .poll(
  159 |           async () =>
  160 |             host.page.evaluate(
  161 |               () =>
  162 |                 Array.from(document.querySelectorAll('video')).filter(
  163 |                   (v) => v.readyState >= 2 && v.videoWidth > 0 && v.videoHeight > 0
  164 |                 ).length
  165 |             ),
  166 |           { timeout: 25_000 }
  167 |         )
  168 |         .toBeGreaterThanOrEqual(2);
  169 |       await expect(host.page.getByText('2 incoming streams live')).toBeVisible();
  170 | 
  171 |       // Independent stopping: Rx1 stops its own share while Host stays streaming and Rx2 keeps streaming to Host
  172 |       await rx1.page.getByRole('button', { name: 'Stop Sharing' }).first().click();
  173 |       await expect(host.page.getByText('1 incoming stream live')).toBeVisible({ timeout: 15_000 });
  174 |       await expect(rx1.page.getByText('1 incoming stream live')).toBeVisible();
  175 | 
  176 |       // Streaming Quality Diagnostics & Adaptive Quality verification (real RTCStatsReport polling runs every 2s)
  177 |       await expect
  178 |         .poll(
  179 |           async () => {
  180 |             const text = await host.page.getByLabel('Streaming Quality Diagnostics').innerText();
  181 |             return /kbps|Mbps/.test(text) && !/Unavailable\s+Unavailable\s+Unavailable/.test(text);
  182 |           },
  183 |           { timeout: 20_000 }
  184 |         )
  185 |         .toBe(true);
  186 | 
  187 |       // Switch Host preset to 1440p and 4K in Share Controls -> AdaptiveQualityPanel reflects requested preset
```