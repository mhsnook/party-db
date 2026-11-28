import { test, expect, type Page } from '@playwright/test'

// Two tabs on the same room, each with its own party-db socket and its own
// Agents SDK socket, the way two people would use the app.

async function tab(page: Page) {
  // every frame each socket sends this tab, keyed by which protocol the socket is
  const partyDb: string[] = []
  const agents: string[] = []
  page.on('websocket', (ws) => {
    const sink = ws.url().includes('/parties/') ? partyDb : agents
    ws.on('framereceived', (f) => void sink.push(String(f.payload)))
  })
  await page.goto('/')
  await expect(page.getByText(/tasks ·/)).toBeVisible()
  return { page, partyDb, agents }
}

test('a task added in one tab is worked by the agent, and both tabs watch it', async ({ context }) => {
  const a = await tab(await context.newPage())
  const b = await tab(await context.newPage())
  const text = `task ${Date.now()}`
  await a.page.getByPlaceholder('new task').fill(text)
  await a.page.getByRole('button', { name: 'add' }).click()

  // the agent's notes are rows in the same collection the tabs read
  const row = (page: Page) => page.locator('ul > li', { hasText: text })
  for (const t of [a, b]) {
    await expect(row(t.page).getByText('Checked it off.')).toBeVisible({ timeout: 15_000 })
    await expect(row(t.page).locator('ol > li')).toHaveCount(3)
    await expect(row(t.page).getByText('done', { exact: true })).toBeVisible()
  }

  // the agent's own state rode the Agents SDK socket, and never the party-db one
  await expect(b.page.getByText(/1 triaged/)).toBeVisible()
  for (const t of [a, b]) {
    expect(t.agents.some((f) => f.includes('cf_agent_state'))).toBe(true)
    expect(t.partyDb.filter((f) => f.includes('cf_agent'))).toEqual([])
  }
})

test('a task deleted while the agent works it stops the agent', async ({ context }) => {
  const a = await tab(await context.newPage())
  const text = `task ${Date.now()}`
  await a.page.getByPlaceholder('new task').fill(text)
  await a.page.getByRole('button', { name: 'add' }).click()
  const row = a.page.locator('ul > li', { hasText: text })
  await expect(row.getByText('working', { exact: true })).toBeVisible()
  await row.getByRole('button', { name: '✕' }).click()
  await expect(row).toHaveCount(0)
  // the agent's next commit is a rejection (the note's FOREIGN KEY), so it reports idle
  await expect(a.page.getByText(/agent idle/)).toBeVisible({ timeout: 15_000 })
})
