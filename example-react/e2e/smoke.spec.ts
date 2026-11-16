import { test, expect, type Page } from '@playwright/test'

// Two (or three) tabs on the same room, each with its own socket, the way two
// people would use the app.

async function tab(page: Page) {
  // every frame the room sends this tab, to prove what it was never sent
  const frames: string[] = []
  page.on('websocket', (ws) => ws.on('framereceived', (f) => void frames.push(String(f.payload))))
  await page.goto('/')
  await expect(page.getByText(/remaining/)).toBeVisible()
  return { page, commentFrames: () => frames.filter((f) => f.includes('"channel":"comments"')) }
}

async function addTodo(page: Page, text: string) {
  await page.getByPlaceholder('new todo').fill(text)
  await page.getByRole('button', { name: 'add' }).click()
}

test('a todo added in one tab appears in the other', async ({ context }) => {
  const a = await tab(await context.newPage())
  const b = await tab(await context.newPage())
  const text = `todo ${Date.now()}`
  await addTodo(a.page, text)
  await expect(b.page.getByText(text)).toBeVisible()
})

test('a comment reaches the tabs watching its thread, and no other tab', async ({ context }) => {
  const a = await tab(await context.newPage())
  const b = await tab(await context.newPage())
  const c = await tab(await context.newPage())
  const text = `todo ${Date.now()}`
  await addTodo(a.page, text)
  for (const t of [b, c]) await expect(t.page.getByText(text)).toBeVisible()

  const row = (page: Page) => page.locator('li', { hasText: text })
  await row(a.page).getByRole('button', { name: 'comments' }).click()
  await row(b.page).getByRole('button', { name: 'comments' }).click()
  await row(a.page).getByPlaceholder('comment').fill('hello from A')
  await row(a.page).getByRole('button', { name: 'post' }).click()

  await expect(row(b.page).getByText('hello from A')).toBeVisible()
  // the third tab never opened the thread, so the room never sent it a comment
  expect(c.commentFrames()).toEqual([])
})
