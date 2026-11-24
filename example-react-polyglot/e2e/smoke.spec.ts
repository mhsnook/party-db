import { test, expect, type Page } from '@playwright/test'

// Two people in their own tabs: the catalog is shared, each deck is private.

async function signIn(page: Page, name: string) {
  await page.goto('/')
  await page.getByPlaceholder(/your name/).fill(name)
  await page.getByRole('button', { name: 'log in' }).click()
  await expect(page.getByText(name, { exact: true })).toBeVisible()
  return page
}

test('a phrase is shared with everyone, and a flashcard stays with its owner', async ({ context }) => {
  const alice = await signIn(await context.newPage(), 'alice')
  const bob = await signIn(await context.newPage(), 'bob')

  const phrase = `phrase ${Date.now()}`
  await alice.getByPlaceholder('phrase', { exact: true }).fill(phrase)
  await alice.getByPlaceholder('translation').fill('a translation')
  await alice.getByRole('button', { name: '+ add' }).click()
  const row = (page: Page) => page.locator('li', { hasText: phrase })
  await expect(row(bob)).toBeVisible()

  await row(alice).getByRole('button', { name: '+ deck' }).click()
  await expect(row(alice).locator('.status')).toHaveText('learning')
  // bob's view of the same phrase is his own status, and he has no card for it
  await expect(row(bob).locator('.status')).toHaveText('new')
})

test('switching user in the same tab reloads only what the new user may read, with no page reload', async ({ context }) => {
  const page = await signIn(await context.newPage(), 'carol')
  let navigations = 0
  page.on('framenavigated', (frame) => void (frame === page.mainFrame() && navigations++))

  const phrase = `switch ${Date.now()}`
  await page.getByPlaceholder('phrase', { exact: true }).fill(phrase)
  await page.getByPlaceholder('translation').fill('a translation')
  await page.getByRole('button', { name: '+ add' }).click()
  const row = page.locator('li', { hasText: phrase })
  await row.getByRole('button', { name: '+ deck' }).click()
  await expect(row.locator('.status')).toHaveText('learning')

  await page.getByRole('button', { name: 'log out' }).click()
  await expect(row.locator('.status')).toHaveText('new') // the public phrase stays; carol's card does not

  await page.getByPlaceholder(/your name/).fill('dave')
  await page.getByRole('button', { name: 'log in' }).click()
  await expect(page.getByText('dave', { exact: true })).toBeVisible()
  await expect(row.locator('.status')).toHaveText('new')

  await page.getByRole('button', { name: 'log out' }).click()
  await page.getByPlaceholder(/your name/).fill('carol')
  await page.getByRole('button', { name: 'log in' }).click()
  await expect(row.locator('.status')).toHaveText('learning')
  expect(navigations).toBe(0)
})
