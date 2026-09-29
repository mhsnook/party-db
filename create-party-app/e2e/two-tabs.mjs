// Two signed-in tabs, one user: every write in tab A must reach tab B without tab B refetching.
// Run `pnpm dev` first, then `pnpm e2e`. Set CHROMIUM_PATH to use a browser Playwright didn't install.
import assert from 'node:assert/strict'
import { chromium } from 'playwright'

const BASE = process.env.BASE_URL ?? 'http://localhost:5173'
const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH })
const step = (name) => console.log(`✓ ${name}`)

try {
  const ctxA = await browser.newContext()
  const a = await ctxA.newPage()
  await a.goto(BASE)
  const email = `e2e-${Date.now()}@example.com`
  await a.getByRole('button', { name: 'I need an account' }).click()
  await a.getByPlaceholder('Email').fill(email)
  await a.getByPlaceholder('Password').fill('password123')
  await a.getByRole('button', { name: 'Create account' }).click()
  await a.getByText(`Signed in as ${email}`).waitFor()
  step('sign up')

  const ctxB = await browser.newContext({ storageState: await ctxA.storageState() })
  const b = await ctxB.newPage()
  let loadsInB = 0
  b.on('request', (r) => r.method() === 'GET' && r.url().endsWith('/api/todos') && loadsInB++)
  await b.goto(BASE)
  await b.getByText(`Signed in as ${email}`).waitFor()
  await b.waitForTimeout(300)

  await a.getByPlaceholder('What needs doing?').fill('from tab A')
  await a.getByRole('button', { name: 'Add todo' }).click()
  await b.getByText('from tab A').waitFor({ timeout: 3000 })
  step('insert reaches tab B')

  await a.getByRole('checkbox').check()
  await b.waitForFunction(() => document.querySelector('input[type=checkbox]')?.checked, null, { timeout: 3000 })
  step('update reaches tab B')

  await a.getByRole('button', { name: 'Delete todo' }).click()
  await b.getByText('from tab A').waitFor({ state: 'detached', timeout: 3000 })
  step('delete reaches tab B')
  assert.equal(loadsInB, 1, 'tab B refetched instead of applying pushed rows')
  step('tab B never refetched')

  const png = await a.evaluate(async () => {
    const canvas = Object.assign(document.createElement('canvas'), { width: 640, height: 480 })
    const g = canvas.getContext('2d')
    g.fillStyle = '#e07a5f'
    g.fillRect(0, 0, 640, 480)
    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/png'))
    return [...new Uint8Array(await blob.arrayBuffer())]
  })
  await a.locator('input[type=file]').setInputFiles({ name: 'sunset.png', mimeType: 'image/png', buffer: Buffer.from(png) })
  const thumb = b.getByRole('img', { name: 'sunset.png' })
  await thumb.waitFor({ timeout: 5000 })
  await b.waitForFunction(() => document.querySelector('img')?.naturalWidth > 0, null, { timeout: 10000 })
  assert.equal(await thumb.evaluate((el) => el.naturalWidth), 160)
  step('upload reaches tab B, resized by the Images binding')

  await ctxB.setOffline(true)
  await b.waitForTimeout(300)
  await a.getByPlaceholder('What needs doing?').fill('while B was away')
  await a.getByRole('button', { name: 'Add todo' }).click()
  await a.waitForTimeout(300)
  await ctxB.setOffline(false)
  await b.getByText('while B was away').waitFor({ timeout: 15000 })
  step('tab B catches up after reconnect')

  const userId = (await b.evaluate(() => fetch('/api/auth/get-session').then((r) => r.json()))).user.id
  await a.getByRole('button', { name: 'Sign out' }).click()
  await a.getByRole('button', { name: 'I need an account' }).click()
  await a.getByPlaceholder('Email').fill(`other-${email}`)
  await a.getByPlaceholder('Password').fill('password123')
  await a.getByRole('button', { name: 'Create account' }).click()
  await a.getByText(`Signed in as other-${email}`).waitFor()
  await a.waitForTimeout(500)
  assert.equal(await a.getByText('while B was away').count(), 0, "second user sees the first user's todos")
  step("a new user never sees the last user's rows")

  const socket = await a.evaluate(
    (room) =>
      new Promise((resolve) => {
        const ws = new WebSocket(`${location.origin.replace('http', 'ws')}/parties/realtime/${room}`)
        ws.onopen = () => resolve('opened')
        ws.onerror = () => resolve('refused')
      }),
    userId,
  )
  assert.equal(socket, 'refused')
  step("a socket for another user's room is refused")
} finally {
  await browser.close()
}
