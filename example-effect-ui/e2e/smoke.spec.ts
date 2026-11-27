import { test, expect, type Page } from '@playwright/test'

// Two tabs on the same room, rendered by Effect UI. `done` is a boolean in the
// Effect Schema and an INTEGER in the table, so the toggle crossing tabs shows
// the server read the Struct's columns and decoded the 0/1 back.

async function tab(page: Page) {
  await page.goto('/')
  await expect(page.getByPlaceholder('new todo')).toBeVisible()
  await expect(page.getByText('Loading todos…')).toHaveCount(0)
  return page
}

test('a todo added, checked and deleted in one tab does the same in the other', async ({ context }) => {
  const a = await tab(await context.newPage())
  const b = await tab(await context.newPage())
  const text = `todo ${Date.now()}`
  await a.getByPlaceholder('new todo').fill(text)
  await a.getByRole('button', { name: 'add' }).click()
  await expect(b.getByText(text)).toBeVisible()

  // `click`, not `check`: the box is controlled, so it shows the new state once
  // the write comes back through the list query, after `check` has looked.
  await b.getByRole('checkbox', { name: `Done: ${text}` }).click()
  await expect(b.getByRole('checkbox', { name: `Done: ${text}` })).toBeChecked()
  await expect(a.getByRole('checkbox', { name: `Done: ${text}` })).toBeChecked()

  await a.reload()
  await expect(a.getByRole('checkbox', { name: `Done: ${text}` })).toBeChecked()

  await b.getByRole('button', { name: `Delete ${text}` }).click()
  await expect(a.getByText(text)).toHaveCount(0)
})
