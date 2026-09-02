import { FIXTURE_NICK_PREFIX } from '../playwright.config'
import { expect } from '@playwright/test'
import { STATE, directRequest, openAs, test, waitForScreen, SEED } from './fixtures'

/**
 * 대회 신청 — the round trip his `raceApply` screen performs.
 *
 * The claim under test is not "the form submits". It is that what a member
 * chose comes BACK: his form reads the stored entry to pre-fill itself and to
 * relabel its button 수정 완료, and that read-back is the whole difference
 * between this and `activities.details.participants`, which the legacy app
 * wrote and never read.
 */

const RACE = `${FIXTURE_NICK_PREFIX} 종목신청 대회`
const RELAYS = ['계영 200m', '혼계영 200m']

/** Two weeks out, so hasFinished cannot hide 신청 while this runs. */
function soon(): string {
  const d = new Date()
  d.setDate(d.getDate() + 14)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

test.describe('대회 신청', () => {
  test.use({ storageState: STATE.member })

  test('고른 종목이 저장되고, 다시 열면 그대로 채워져 있다', async ({ page, browser }) => {
    const staff = await openAs(browser, STATE.admin)
    let activityId = ''

    try {
      // A race, created through the real form.
      await staff.page.goto('/schedule/new')
      await waitForScreen(staff.page)
      await staff.page
        .getByRole('group', { name: '종류' })
        .getByRole('button', { name: '대회' })
        .click()
      await staff.page.getByLabel('제목').fill(RACE)
      await staff.page.getByLabel('날짜').fill(soon())
      await staff.page.getByLabel(/단체전 종목/).fill(RELAYS.join('\n'))
      await staff.page.getByRole('button', { name: '등록' }).click()
      await staff.page.waitForURL(/\/schedule\/[0-9a-f-]{36}$/, { timeout: 20_000 })
      activityId = new URL(staff.page.url()).pathname.split('/').pop() ?? ''
      expect(activityId, 'the new race id').toMatch(/^[0-9a-f-]{36}$/)

      // The relay events it opens, set through the staff form -- which is the
      // point of that field existing. An earlier version of this test PATCHed
      // `details` directly because no UI wrote it; now one does, and testing the
      // real path is what proves the picker downstream is reachable at all.

      // The member fills it in.
      await page.goto(`/schedule/${activityId}`)
      await waitForScreen(page)
      await expect(page.getByRole('heading', { name: '대회 신청' })).toBeVisible()
      // Before anything is stored the button offers to create, not to amend.
      await expect(page.getByRole('button', { name: '대회 신청하기' })).toBeVisible()

      await page.getByLabel('그룹').selectOption('여자 일반부')
      await page.getByLabel('개인종목 1').selectOption('배영 50m')
      await page.getByLabel('개인종목 2').selectOption('평영 50m')
      await page.getByRole('button', { name: RELAYS[0], exact: true }).click()
      await page.getByRole('button', { name: '대회 신청하기' }).click()
      await expect(page.getByText('저장됨')).toBeVisible({ timeout: 20_000 })

      // Reloaded, so nothing on screen can be a copy of what this tab just typed.
      await page.reload()
      await waitForScreen(page)
      await expect(page.getByLabel('그룹')).toHaveValue('여자 일반부')
      await expect(page.getByLabel('개인종목 1')).toHaveValue('배영 50m')
      await expect(page.getByLabel('개인종목 2')).toHaveValue('평영 50m')
      await expect(page.getByRole('button', { name: RELAYS[0], exact: true })).toHaveAttribute(
        'aria-pressed',
        'true',
      )
      // The label is the tell that the club already knows what they are swimming.
      await expect(page.getByRole('button', { name: '수정 완료' })).toBeVisible()
      await expect(page.getByRole('button', { name: '대회 신청하기' })).toHaveCount(0)

      // And the row itself says so -- asked of the server, not read off the form.
      const stored = await directRequest(page, {
        path: `/rest/v1/activity_applications?activity_id=eq.${activityId}&select=details`,
      })
      expect(stored.body, 'the stored entry').toContain('여자 일반부')
      expect(stored.body).toContain(RELAYS[0])
      // Not chosen, so it must not be there -- an absence asserted beside a
      // presence, so a wholesale failure cannot pass this.
      expect(stored.body).not.toContain(RELAYS[1])
    } finally {
      await staff.close()
    }
  })

  test('훈련에는 종목 신청이 없다', async ({ page }) => {
    // 0045 refuses a non-race outright; the screen simply never offers it, so
    // the refusal is not something a member can reach by accident.
    await page.goto(`/schedule/${SEED.activityId}`)
    await waitForScreen(page)
    await expect(page.getByRole('heading', { name: '대회 신청' })).toHaveCount(0)
    // A control that IS on this screen, so a page that failed to render cannot
    // pass the assertion above.
    await expect(page.getByRole('button', { name: /신청하기|신청 취소/ }).first()).toBeVisible()
  })
})
