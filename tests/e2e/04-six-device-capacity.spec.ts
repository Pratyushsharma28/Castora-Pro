import { expect, test } from '@playwright/test';
import { createNamedContext, navigateTopBar, waitForServerConnected } from './helpers';

test.describe('4. Browser E2E — Reproducible Six-Receiver Capacity & Isolation Scenario', () => {
  test('allocates 6 receiver slots across browser contexts, rejects 7th, handles concurrent joins, frees slot on removal, and isolates peer failure', async ({
    browser,
    baseURL,
    request,
  }) => {
    const host = await createNamedContext(browser, 'Six-Slot Host', {
      width: 1280,
      height: 720,
      fps: 30,
    });
    const receivers = await Promise.all(
      Array.from({ length: 7 }, (_, i) => createNamedContext(browser, `Browser Rx ${i + 1}`))
    );

    try {
      // Host creates an Approval Required room
      await host.page.goto('/');
      await waitForServerConnected(host.page);
      await navigateTopBar(host.page, 'Session');
      await host.page.locator('#session-create-name').fill('Six-Device Capacity Room');
      await host.page.getByRole('button', { name: 'Create Session Room' }).click();
      const roomId = (await host.page.locator('dd.font-mono').first().innerText()).trim();

      // Connect Receivers 1..6 via real browser pages and approve each into Slots 1..6
      await navigateTopBar(host.page, 'Rooms');
      for (let i = 0; i < 6; i += 1) {
        const rx = receivers[i];
        await rx.page.goto('/');
        await waitForServerConnected(rx.page);
        await navigateTopBar(rx.page, 'Rooms');
        await rx.page.locator('#castora-room-code').fill(roomId);
        await rx.page.getByRole('button', { name: 'Request to Join Room' }).click();

        const pendingRow = host.page.locator('li').filter({ hasText: `Browser Rx ${i + 1}` });
        await expect(pendingRow).toBeVisible();
        await pendingRow.getByRole('button', { name: 'Approve' }).click();
        await expect(rx.page.getByText('Paired', { exact: true })).toBeVisible();
      }

      // Verify all 6 slots are allocated and Available Slots = 0 (Full)
      await expect(host.page.getByText('6 / 6')).toBeVisible();
      await expect(host.page.getByText('0 (Full)')).toBeVisible();

      // Verify 7th browser receiver is safely rejected when attempting to join full room
      const rx7 = receivers[6];
      await rx7.page.goto('/');
      await waitForServerConnected(rx7.page);
      await navigateTopBar(rx7.page, 'Rooms');
      await rx7.page.locator('#castora-room-code').fill(roomId);
      await rx7.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx7.page.getByRole('alert')).toContainText(/full|6/i);

      // Remove Receiver #2 -> slot released (5 / 6)
      const rx2Article = host.page.locator('article').filter({ hasText: 'Browser Rx 2' });
      await rx2Article.getByRole('button', { name: 'Remove' }).click();
      await expect(host.page.getByText('5 / 6')).toBeVisible();

      // Simultaneous join race with only 1 slot left: fire 3 concurrent pair-request calls ->
      // at most 1 (Open) or bounded slots, wait: currently room is Approval Required, let's switch to Open
      // to verify atomic capacity enforcement under simultaneous auto-pair joins!
      await navigateTopBar(host.page, 'Session');
      await host.page.getByRole('button', { name: /Open/ }).click();
      await expect(host.page.getByText('Room privacy updated to Open.')).toBeVisible();

      const raceResults = await Promise.all(
        ['race-sim-a', 'race-sim-b', 'race-sim-c'].map((id) =>
          request.post(`${baseURL}/api/rooms/${roomId}/pair-requests`, {
            data: {
              receiverDeviceId: id,
              deviceName: `Concurrent Peer ${id}`,
              platform: 'android',
            },
          })
        )
      );
      const okCount = raceResults.filter((r) => r.status() === 200).length;
      const fullCount = raceResults.filter((r) => r.status() === 409).length;
      expect(okCount).toBe(1);
      expect(fullCount).toBe(2);

      // Remove the concurrent peer so Receiver 7 can claim the freed slot in UI
      await navigateTopBar(host.page, 'Devices');
      const raceArticle = host.page.locator('article').filter({ hasText: 'Concurrent Peer' });
      await raceArticle.getByRole('button', { name: 'Remove' }).click();
      await expect(host.page.getByText('5 / 6')).toBeVisible();

      await rx7.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx7.page.getByText('Paired', { exact: true })).toBeVisible();
      await expect(host.page.getByText('6 / 6')).toBeVisible();

      // Start Host WebRTC sharing across active browser peers and verify Receiver 1 & Receiver 7 both render <video>,
      // then abruptly close Receiver 3 context -> remaining peers stay healthy!
      await navigateTopBar(host.page, 'Screens');
      await host.page.getByRole('button', { name: 'Share Screen' }).first().click();

      await navigateTopBar(receivers[0].page, 'Screens');
      await navigateTopBar(rx7.page, 'Screens');

      await expect
        .poll(
          () =>
            receivers[0].page.evaluate(() => {
              const v = document.querySelector('video');
              return Boolean(v && v.readyState >= 2 && v.videoWidth > 0);
            }),
          { timeout: 25_000 }
        )
        .toBe(true);
      await expect
        .poll(
          () =>
            rx7.page.evaluate(() => {
              const v = document.querySelector('video');
              return Boolean(v && v.readyState >= 2 && v.videoWidth > 0);
            }),
          { timeout: 25_000 }
        )
        .toBe(true);

      // Abruptly terminate Receiver 3 context (simulates sudden peer crash/disconnect)
      await receivers[2].context.close();

      // Host stays streaming and Receiver 1 + Receiver 7 stay connected with live video
      await expect(host.page.getByText('Stop Sharing').first()).toBeVisible();
      await expect(receivers[0].page.getByText('1 incoming stream live')).toBeVisible();
      await expect(rx7.page.getByText('1 incoming stream live')).toBeVisible();
    } finally {
      await host.context.close().catch(() => {});
      await Promise.all(receivers.map((r) => r.context.close().catch(() => {})));
    }
  });
});
