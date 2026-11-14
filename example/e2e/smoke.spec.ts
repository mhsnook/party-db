import { test, expect, type Page } from '@playwright/test'

// Two tabs on the same room: the vanilla client, no framework.

async function tab(page: Page) {
  await page.goto('/')
  await expect(page.getByPlaceholder('new todo')).toBeVisible()
  return page
}

test('a todo added in one tab appears in the other, and a delete leaves both', async ({ context }) => {
  const a = await tab(await context.newPage())
  const b = await tab(await context.newPage())
  const text = `todo ${Date.now()}`
  await a.getByPlaceholder('new todo').fill(text)
  await a.getByRole('button', { name: 'add' }).click()
  await expect(b.getByText(text)).toBeVisible()

  await b.locator('li', { hasText: text }).getByRole('button', { name: '✕' }).click()
  await expect(a.getByText(text)).toHaveCount(0)
})
