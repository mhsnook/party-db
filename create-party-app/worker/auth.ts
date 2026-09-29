import { betterAuth } from 'better-auth'
import { env } from 'cloudflare:workers'

export const auth = betterAuth({
  database: env.DB,
  secret: env.BETTER_AUTH_SECRET,
  emailAndPassword: { enabled: true },
})

export type User = typeof auth.$Infer.Session.user
