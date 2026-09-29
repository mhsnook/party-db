import { routePartykitRequest } from 'partyserver'
import { app } from './api'
import { auth } from './auth'

export { Realtime } from './realtime'

export default {
  async fetch(req, env, ctx) {
    const party = await routePartykitRequest(req, env, {
      // a user's room is named by their user id, so the socket only ever hears their own rows
      onBeforeConnect: async (req, lobby) => {
        const session = await auth.api.getSession({ headers: req.headers })
        if (!session) return new Response('Sign in to continue.', { status: 401 })
        if (session.user.id !== lobby.name) return new Response('Not your room.', { status: 403 })
      },
      onBeforeRequest: () => new Response('Not found.', { status: 404 }),
    })
    return party ?? app.fetch(req, env, ctx)
  },
} satisfies ExportedHandler<Env>
