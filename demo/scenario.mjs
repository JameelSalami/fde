import assert from 'node:assert/strict'

export const variants = [
  { id: 'reviewer-wide', role: 'reviewer', viewport: { width: 1280, height: 900 }, reducedMotion: 'no-preference' },
  { id: 'reviewer-compact', role: 'reviewer', viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' },
  { id: 'viewer-refusal', role: 'viewer', viewport: { width: 1280, height: 900 }, reducedMotion: 'reduce' },
]

export async function exercise({ page, variant, fixture, checkpoint }) {
  await page.getByText('Handwritten fixture · no vendor read', { exact: true }).waitFor()
  await page.getByText(`Signed in as demo-${variant.role} · ${variant.role}`, { exact: true }).waitFor()
  await page.locator('#review-currentness').filter({ hasText: 'review version 0' }).waitFor()
  assert.equal(await page.locator('#erp-reported').innerText(), '2.125')
  assert.equal(await page.locator('#mes-reported').innerText(), '3.250')
  assert.equal(await page.locator('#source-class').innerText(), 'HANDWRITTEN FIXTURE')
  await checkpoint('source-bound-fixture')

  const evidence = page.getByRole('button', { name: '02 Source evidence', exact: true })
  await evidence.focus()
  await page.keyboard.press('Enter')
  await page.waitForFunction(() => document.activeElement?.id === 'evidence-heading')
  await page.locator('#erp-details').getByText('QA-WO-41', { exact: true }).first().waitFor()
  await page.locator('#mes-details').getByText('419', { exact: true }).waitFor()
  assert.equal(await page.locator('#erp-details').getByText('not-covered', { exact: true }).count(), 3)
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false, 'evidence layout must fit the viewport')
  await checkpoint('native-identities-and-coverage')

  await page.getByRole('button', { name: '04 My workspace', exact: true }).click()
  await page.getByRole('textbox', { name: 'What are you trying to understand?' }).fill('Which source coverage remains unknown?')
  await page.getByRole('textbox', { name: 'What should the next engineer know?' }).fill('Synthetic browser-local note; no vendor change.')
  await page.reload()
  await page.getByText('Handwritten fixture · no vendor read', { exact: true }).waitFor()
  await page.getByRole('button', { name: '04 My workspace', exact: true }).click()
  assert.equal(await page.getByRole('textbox', { name: 'What should the next engineer know?' }).inputValue(), 'Synthetic browser-local note; no vendor change.')
  await page.getByRole('button', { name: '01 Case room', exact: true }).click()
  await page.locator('#review-currentness').filter({ hasText: 'review version 0' }).waitFor()
  if (variant.role === 'viewer') {
    assert.equal(await page.getByRole('button', { name: 'Save review', exact: true }).isDisabled(), true)
    assert.equal(await page.getByRole('textbox', { name: 'Investigation note', exact: true }).isDisabled(), true)
    await checkpoint('viewer-has-no-review-write')
    return ['handwritten source disclosure', 'exact native identities and uncovered evidence', 'keyboard navigation focus',
      'responsive evidence layout', 'browser-local note survives reload', 'viewer review controls refuse']
  }
  await page.getByRole('combobox', { name: 'Disposition', exact: true }).selectOption('reviewed')
  await page.getByRole('textbox', { name: 'Investigation note', exact: true }).fill('Reviewed the synthetic source receipts. Physical production remains unestablished.')
  await page.getByRole('button', { name: 'Save review', exact: true }).click()
  await page.locator('#review-currentness').filter({ hasText: 'review version 1' }).waitFor()
  await page.getByText('Review saved with your identity and evidence pin.', { exact: true }).waitFor()
  await page.getByRole('button', { name: 'Verify pinned replay', exact: true }).click()
  await page.getByText('Pinned evidence replay matched. No fresh source read was used.', { exact: true }).waitFor()
  await checkpoint('saved-human-review-and-real-replay')

  // Exercise the real source failure path; previous evidence stays explicitly historical.
  fixture.refuseSource()
  await page.getByRole('button', { name: 'Refresh evidence', exact: true }).click()
  await page.getByText('Read failed · previous observation shown', { exact: true }).waitFor()
  assert.equal(await page.locator('#erp-reported').innerText(), '2.125')
  await page.getByText('The host could not return a new verified source read. No data was fabricated.', { exact: true }).waitFor()
  await checkpoint('source-refusal-keeps-previous-evidence-explicit')
  return ['handwritten source disclosure', 'native identities and uncovered evidence', 'keyboard navigation focus',
    'responsive evidence layout', 'browser-local note persistence', 'real human-review version increment',
    'real pinned replay', 'source failure with explicit previous observation']
}
