import { test, expect, type Page } from '@playwright/test'

// Writes need the demo password; reads don't. Two tabs on the same room.

async function tab(page: Page) {
  await page.goto('/')
  await expect(page.getByPlaceholder('new todo')).toBeVisible()
  return page
}

async function addTodo(page: Page, text: string) {
  await page.getByPlaceholder('new todo').fill(text)
  await page.getByRole('button', { name: 'add' }).click()
}

test('refuses a signed-out write, and syncs a signed-in one', async ({ context }) => {
  const a = await tab(await context.newPage())
  const b = await tab(await context.newPage())

  const refused = `refused ${Date.now()}`
  await addTodo(a, refused)
  await expect(a.locator('.error')).toBeVisible()
  // the optimistic row rolls back, and the other tab never sees it
  await expect(a.getByText(refused)).toHaveCount(0)
  await expect(b.getByText(refused)).toHaveCount(0)

  await a.getByPlaceholder(/password/).fill('s3cret')
  await a.getByRole('button', { name: 'log in' }).click()
  const accepted = `accepted ${Date.now()}`
  await addTodo(a, accepted)
  await expect(b.getByText(accepted)).toBeVisible()
})
