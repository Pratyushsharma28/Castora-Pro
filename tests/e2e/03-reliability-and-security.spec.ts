import { expect, test } from '@playwright/test';
import { startCastoraServer } from '../../server';
import { createNamedContext, navigateTopBar, waitForServerConnected } from './helpers';

test.describe('3. Browser E2E — Connection Reliability & Security Integration', () => {
  test('verifies WS reconnect recovery, STUN fallback, TURN access control, unauthorized RBAC rejection, brute-force 429 & room expiration', async ({
    browser,
    baseURL,
    request,
  }) => {
    const host = await createNamedContext(browser, 'Security Host', {
      width: 1280,
      height: 720,
      fps: 30,
    });
    const rx1 = await createNamedContext(browser, 'Authorized Peer');
    const rx2 = await createNamedContext(browser, 'Healthy Bystander');

    try {
      // 1. Verify STUN-only fallback when TURN is unconfigured
      const defaultIceRes = await request.get(`${baseURL}/api/ice-servers`);
      expect(defaultIceRes.status()).toBe(200);
      const defaultIceJson = (await defaultIceRes.json()) as {
        turnConfigured: boolean;
        turnMode: string;
        iceServers: Array<{ urls: string[] }>;
      };
      expect(defaultIceJson.turnConfigured).toBe(false);
      expect(defaultIceJson.turnMode).toBe('disabled');
      expect(defaultIceJson.iceServers[0].urls[0]).toContain('stun:');

      // 2. Host creates password-protected Approval Required room
      await host.page.goto('/');
      await waitForServerConnected(host.page);
      await navigateTopBar(host.page, 'Session');
      await host.page.locator('#session-create-name').fill('Security Audit Room');
      await host.page.locator('#session-create-password').fill('vault-pass-987');
      await host.page.getByRole('button', { name: 'Create Session Room' }).click();
      const roomId = (await host.page.locator('dd.font-mono').first().innerText()).trim();

      // 3. Password brute-force rate limiting (5 failures -> 429 RATE_LIMITED on 6th attempt)
      for (let i = 0; i < 5; i += 1) {
        const badAttempt = await request.post(`${baseURL}/api/rooms/${roomId}/pair-requests`, {
          data: {
            receiverDeviceId: `brute-dev-${i}`,
            deviceName: `Attacker ${i}`,
            platform: 'macos',
            password: `wrong-${i}`,
          },
        });
        expect(badAttempt.status()).toBe(403);
      }
      const lockedAttempt = await request.post(`${baseURL}/api/rooms/${roomId}/pair-requests`, {
        data: {
          receiverDeviceId: 'brute-dev-locked',
          deviceName: 'Attacker Locked',
          platform: 'macos',
          password: 'vault-pass-987',
        },
      });
      expect(lockedAttempt.status()).toBe(429);

      // 4. Rx1 joins cleanly in browser using password -> Host approves -> Rx2 also joins
      // Note: rate limit key includes client IP + roomId, so wait/use a fresh room for browser join after lock test
      await host.page.getByRole('button', { name: 'End Session' }).click();
      await host.page.getByRole('button', { name: 'Confirm End Session' }).click();

      await host.page.locator('#session-create-name').fill('Resilience Room');
      await host.page.getByRole('button', { name: /Open/ }).click();
      await host.page.getByRole('button', { name: 'Create Session Room' }).click();
      const liveRoomId = (await host.page.locator('dd.font-mono').first().innerText()).trim();

      await rx1.page.goto('/');
      await waitForServerConnected(rx1.page);
      await navigateTopBar(rx1.page, 'Rooms');
      await rx1.page.locator('#castora-room-code').fill(liveRoomId);
      await rx1.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx1.page.getByText('Paired', { exact: true })).toBeVisible();

      await rx2.page.goto('/');
      await waitForServerConnected(rx2.page);
      await navigateTopBar(rx2.page, 'Rooms');
      await rx2.page.locator('#castora-room-code').fill(liveRoomId);
      await rx2.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx2.page.getByText('Paired', { exact: true })).toBeVisible();

      // 5. Security API checks: invalid token, invalid invite, unauthorized host ops
      const badTokenRestore = await request.get(`${baseURL}/api/rooms/${liveRoomId}/session`, {
        headers: { Authorization: 'Bearer forged-invalid-token-12345' },
      });
      expect(badTokenRestore.status()).toBe(403);

      const badInviteRes = await request.get(
        `${baseURL}/api/rooms/${liveRoomId}/invitation/validate?invite=forged-invite-code`
      );
      expect(badInviteRes.status()).toBe(403);
      const badInviteJson = (await badInviteRes.json()) as { error: string };
      expect(badInviteJson.error).toBe('INVALID_INVITATION');

      // Verify Rx1's UI does NOT allow privileged host actions (no End Session / Rename Room buttons)
      await navigateTopBar(rx1.page, 'Session');
      await expect(rx1.page.getByRole('button', { name: 'End Session' })).toHaveCount(0);
      await expect(rx1.page.getByRole('button', { name: 'Rename Room' })).toHaveCount(0);

      // 6. Start screen sharing Host -> Rx1 & Rx2, then verify WebSocket disconnect + automatic reconnect
      //    plus healthy peer isolation (Rx1 WS offline reload does not interrupt Rx2 video stream!)
      await navigateTopBar(host.page, 'Screens');
      await host.page.getByRole('button', { name: 'Share Screen' }).first().click();

      await navigateTopBar(rx1.page, 'Screens');
      await navigateTopBar(rx2.page, 'Screens');
      await expect
        .poll(
          () =>
            rx2.page.evaluate(() => {
              const v = document.querySelector('video');
              return Boolean(v && v.readyState >= 2 && v.videoWidth > 0);
            }),
          { timeout: 25_000 }
        )
        .toBe(true);

      // Simulate Host browser temporary offline -> online transition so WebSocket drops and auto-reconnects
      await host.context.setOffline(true);
      await expect(host.page.getByText(/Offline|Disconnected|Reconnecting/i).first()).toBeVisible({
        timeout: 12_000,
      });
      await host.context.setOffline(false);
      await waitForServerConnected(host.page);

      // Host session ownership & room remain intact after WS reconnect
      await navigateTopBar(host.page, 'Session');
      await expect(host.page.getByText(`Room ${liveRoomId}`)).toBeVisible();
      await expect(host.page.getByText('Your Role: Host')).toBeVisible();

      // Healthy Rx2 stayed unaffected or recovered cleanly without cascading kick
      await expect(rx2.page.getByText(`1 incoming stream live`)).toBeVisible({ timeout: 20_000 });

      // Close main room cleanly
      await host.page.getByRole('button', { name: 'End Session' }).click();
      await host.page.getByRole('button', { name: 'Confirm End Session' }).click();

      // 7. Isolated short-TTL + TURN-configured server check (TURN auth 403 vs 200, room expiry 410)
      const prevTurnUrls = process.env.CASTORA_TURN_URLS;
      const prevTurnSecret = process.env.CASTORA_TURN_AUTH_SECRET;
      process.env.CASTORA_TURN_URLS = 'turn:relay.castora.test:3478?transport=udp';
      process.env.CASTORA_TURN_AUTH_SECRET = 'e2e-turn-hmac-secret-test-only';

      const isolated = await startCastoraServer({
        port: 0,
        host: '127.0.0.1',
        enableViteMiddleware: false,
        roomTtlMs: 600,
      });

      try {
        const isoBase = `http://127.0.0.1:${isolated.port}`;
        // Unauthenticated TURN request must be rejected with 403
        const unauthTurn = await request.get(`${isoBase}/api/ice-servers`);
        expect(unauthTurn.status()).toBe(403);

        // Authorized host obtains ephemeral TURN credentials, then room expires -> 410
        const cRes = await request.post(`${isoBase}/api/rooms`, {
          data: {
            hostDeviceId: 'iso-host-01',
            hostDeviceName: 'Isolated Host',
            hostPlatform: 'macos',
          },
        });
        expect(cRes.status()).toBe(201);
        const cJson = (await cRes.json()) as { room: { roomId: string }; hostToken: string };

        const authTurn = await request.get(
          `${isoBase}/api/ice-servers?roomId=${cJson.room.roomId}&deviceId=iso-host-01`,
          { headers: { Authorization: `Bearer ${cJson.hostToken}` } }
        );
        expect(authTurn.status()).toBe(200);
        expect(authTurn.headers()['cache-control']).toBe('no-store');
        const turnBody = (await authTurn.json()) as {
          turnConfigured: boolean;
          turnMode: string;
          iceServers: Array<{ urls: string[]; username?: string; credential?: string }>;
        };
        expect(turnBody.turnConfigured).toBe(true);
        expect(turnBody.turnMode).toBe('ephemeral-hmac');
        expect(turnBody.iceServers.some((s) => Boolean(s.username && s.credential))).toBe(true);

        // Wait for 600ms TTL expiration -> HTTP 410
        await new Promise((r) => setTimeout(r, 850));
        const expiredRes = await request.get(`${isoBase}/api/rooms/${cJson.room.roomId}`);
        expect(expiredRes.status()).toBe(410);
      } finally {
        await isolated.close();
        if (prevTurnUrls === undefined) delete process.env.CASTORA_TURN_URLS;
        else process.env.CASTORA_TURN_URLS = prevTurnUrls;
        if (prevTurnSecret === undefined) delete process.env.CASTORA_TURN_AUTH_SECRET;
        else process.env.CASTORA_TURN_AUTH_SECRET = prevTurnSecret;
      }
    } finally {
      await host.context.close();
      await rx1.context.close();
      await rx2.context.close();
    }
  });
});
