import { expect, test } from '@playwright/test';
import { createNamedContext, navigateTopBar, waitForServerConnected } from './helpers';

test.describe('1. Browser E2E — Startup, Rooms, Invitations, QR, Passwords, Device Ops & Host Transfer', () => {
  test('navigates dashboard, creates room with password & QR, validates invite/privacy modes, renames, removes, transfers host, and ends session safely', async ({
    browser,
    baseURL,
  }) => {
    const host = await createNamedContext(browser, 'Host Mac Studio');
    const rx1 = await createNamedContext(browser, 'Studio iPad Pro');
    const rx2 = await createNamedContext(browser, 'Living Room Display');

    try {
      // 1. Startup, light-theme UI & top navigation across all views
      await host.page.goto('/');
      await waitForServerConnected(host.page);
      await expect(host.page.getByRole('heading', { name: 'Castora Pro Workspace' })).toBeVisible();

      const bgColor = await host.page.evaluate(() => getComputedStyle(document.body).backgroundColor);
      expect(bgColor).not.toBe('rgb(0, 0, 0)');

      for (const tab of ['Rooms', 'Session', 'Devices', 'Screens', 'Settings', 'Home'] as const) {
        await navigateTopBar(host.page, tab);
      }

      // 2. Create password-protected Approval Required room via Session dashboard
      await navigateTopBar(host.page, 'Session');
      await host.page.locator('#session-create-name').fill('E2E Review Session');
      await host.page.locator('#session-create-password').fill('castora-pass-123');
      await host.page.getByRole('button', { name: 'Create Session Room' }).click();

      await expect(host.page.getByRole('heading', { name: 'E2E Review Session' })).toBeVisible();
      const roomIdText = (
        await host.page.locator('dd.font-mono').first().innerText()
      ).trim();
      expect(roomIdText).toMatch(/^[A-Z0-9]{6}$/);

      // Session overview metrics present (duration, room ID, host, capacity 0 / 6)
      await expect(host.page.getByText('Session Duration')).toBeVisible();
      await expect(host.page.getByText('0 / 6')).toBeVisible();

      // Prevent accidental duplicate room creation (Session create form no longer rendered while active)
      await expect(host.page.getByRole('button', { name: 'Create Session Room' })).toHaveCount(0);

      // Rename room
      await host.page.getByRole('button', { name: 'Rename Room' }).click();
      await host.page.locator('#session-rename-input').fill('E2E Renamed Studio');
      await host.page.getByRole('button', { name: 'Save Name' }).click();
      await expect(host.page.getByRole('heading', { name: 'E2E Renamed Studio' })).toBeVisible();

      // 3. QR code rendering + Invitation link without auth tokens or passwords
      const qrImg = host.page.locator(`img[alt="QR invitation for room ${roomIdText}"]`);
      await expect(qrImg).toBeVisible();
      const qrSrc = await qrImg.getAttribute('src');
      expect(qrSrc).toMatch(/^data:image\/png;base64,/);

      const inviteUrlText = (
        await host.page.locator('div.break-all.font-mono').innerText()
      ).trim();
      expect(inviteUrlText).toContain(`room=${roomIdText}`);
      expect(inviteUrlText).toContain('invite=');
      expect(inviteUrlText).not.toContain('hostToken');
      expect(inviteUrlText).not.toContain('memberToken');
      expect(inviteUrlText).not.toContain('castora-pass-123');

      await host.page.getByRole('button', { name: 'Copy Invitation' }).click();
      await expect(host.page.getByText('Invitation Copied')).toBeVisible();
      const clipboardText = await host.page.evaluate(() => navigator.clipboard.readText());
      expect(clipboardText).toBe(inviteUrlText);

      // Verify secret password never leaks into storage or visible page
      const hostStorage = await host.page.evaluate(() => JSON.stringify(window.localStorage));
      expect(hostStorage).not.toContain('castora-pass-123');

      // 4. Switch to Private mode and verify Rx1 cannot join WITHOUT invitation link
      await host.page.getByRole('button', { name: /Private/ }).click();
      await expect(host.page.getByText('Room privacy updated to Private.')).toBeVisible();

      await rx1.page.goto('/');
      await waitForServerConnected(rx1.page);
      await navigateTopBar(rx1.page, 'Rooms');
      await rx1.page.locator('#castora-room-code').fill(roomIdText);
      await rx1.page.locator('#castora-room-password').fill('castora-pass-123');
      await rx1.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx1.page.getByRole('alert')).toContainText(/invitation/i);

      // 5. Open real invitation URL in Rx1 context -> validates invite + tests wrong then valid password
      const parsedInvite = new URL(inviteUrlText);
      await rx1.page.goto(`${baseURL}${parsedInvite.pathname}${parsedInvite.search}`);
      await waitForServerConnected(rx1.page);
      await expect(rx1.page.locator('#castora-room-code')).toHaveValue(roomIdText);
      await expect(rx1.page.getByText('Invitation token attached for verification.')).toBeVisible();

      // Wrong password rejected
      await rx1.page.locator('#castora-room-password').fill('wrong-password-000');
      await rx1.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx1.page.getByRole('alert')).toContainText(/password/i);

      // Correct password submits pending request
      await rx1.page.locator('#castora-room-password').fill('castora-pass-123');
      await rx1.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx1.page.getByText(/Waiting for host approval/i)).toBeVisible();

      // 6. Host rejects Rx1 in Rooms -> Rx1 receives Rejected status
      await navigateTopBar(host.page, 'Rooms');
      await expect(host.page.getByRole('listitem').getByText('Studio iPad Pro')).toBeVisible();
      await host.page.getByRole('button', { name: 'Reject' }).click();
      await expect(rx1.page.getByText('Rejected')).toBeVisible();

      // Host changes privacy to Approval Required, changes password, and then removes password
      await navigateTopBar(host.page, 'Session');
      await host.page.getByRole('button', { name: /Approval Required/ }).click();
      await host.page.locator('#session-password-input').fill('rotated-secret-99');
      await host.page.getByRole('button', { name: 'Change Password' }).click();
      await expect(host.page.getByText(/Room password updated/i)).toBeVisible();

      await host.page.getByRole('button', { name: 'Remove Password' }).click();
      await expect(host.page.getByText('Room password removed.')).toBeVisible();

      // Rx1 rejoins via room code (no password needed now) -> Host approves Rx1
      await rx1.page.reload();
      await waitForServerConnected(rx1.page);
      await navigateTopBar(rx1.page, 'Rooms');
      await rx1.page.locator('#castora-room-code').fill(roomIdText);
      await rx1.page.getByRole('button', { name: 'Request to Join Room' }).click();

      await navigateTopBar(host.page, 'Rooms');
      await expect(host.page.getByRole('listitem').getByText('Studio iPad Pro')).toBeVisible();
      await host.page.getByRole('button', { name: 'Approve' }).click();
      await expect(host.page.getByText('1 / 6')).toBeVisible();
      await expect(rx1.page.getByText('Paired', { exact: true })).toBeVisible();

      // 7. Switch to Open mode -> Rx2 joins immediately without manual approval
      await navigateTopBar(host.page, 'Session');
      await host.page.getByRole('button', { name: /Open/ }).click();
      await expect(host.page.getByText('Room privacy updated to Open.')).toBeVisible();

      await rx2.page.goto('/');
      await waitForServerConnected(rx2.page);
      await navigateTopBar(rx2.page, 'Rooms');
      await rx2.page.locator('#castora-room-code').fill(roomIdText);
      await rx2.page.getByRole('button', { name: 'Request to Join Room' }).click();
      await expect(rx2.page.getByText(/immediately via Open access/i)).toBeVisible();
      await expect(host.page.getByText('2 / 6')).toBeVisible();

      // 8. Device renaming (Host renames Rx2 cleanly in Devices)
      await navigateTopBar(host.page, 'Devices');
      const rx2Article = host.page.locator('article').filter({ hasText: 'Living Room Display' });
      await rx2Article.getByRole('button', { name: 'Rename' }).click();
      await host.page.getByRole('textbox', { name: 'Rename Living Room Display' }).fill('Studio Reference OLED');
      await host.page.getByRole('button', { name: 'Save', exact: true }).click();
      await expect(host.page.getByRole('heading', { name: 'Studio Reference OLED' })).toBeVisible();

      // 9. Participant removal (Host removes Studio Reference OLED -> slot released)
      const renamedRx2Article = host.page
        .locator('article')
        .filter({ hasText: 'Studio Reference OLED' });
      await renamedRx2Article.getByRole('button', { name: 'Remove' }).click();
      await expect(host.page.getByText('1 / 6')).toBeVisible();
      await expect(rx2.page.getByText(/Standalone device profile/i)).toBeVisible();

      // 10. Host transfer to Rx1 (Studio iPad Pro accepts and gains host privileges)
      await navigateTopBar(host.page, 'Session');
      await host.page.getByRole('button', { name: 'Transfer Host' }).click();
      await expect(host.page.getByText(/Pending Host Transfer/i)).toBeVisible();

      await navigateTopBar(rx1.page, 'Session');
      await expect(rx1.page.getByRole('button', { name: 'Accept Host Role' })).toBeVisible();
      await rx1.page.getByRole('button', { name: 'Accept Host Role' }).click();
      await expect(rx1.page.getByText('You are now the authorized host of this room.')).toBeVisible();
      await expect(rx1.page.getByText('Your Role: Host')).toBeVisible();
      await expect(host.page.getByText('Your Role: Participant')).toBeVisible();

      // 11. Safe 2-step Session Termination by new Host (Rx1) -> disconnects former host cleanly
      await rx1.page.getByRole('button', { name: 'End Session' }).click();
      await rx1.page.getByRole('button', { name: 'Confirm End Session' }).click();

      await expect(rx1.page.getByRole('button', { name: 'Create Session Room' })).toBeVisible();
      await expect(host.page.getByRole('button', { name: 'Create Session Room' })).toBeVisible();
    } finally {
      await host.context.close();
      await rx1.context.close();
      await rx2.context.close();
    }
  });
});
