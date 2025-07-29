import type { Context } from 'hono'
import { cache } from 'hono/cache'
import { cors } from 'hono/cors'
import { createFactory } from 'hono/factory'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import kleur from 'kleur'

/**
 * Sets the base app with the following middleware:
 * - logger
 * - cors (using configured ALLOWED_DOMAINS env variable)
 * - prettyJSON
 * - cache
 */
export const routeFactory = createFactory<{
	Bindings: CloudflareBindings
	Variables: {
		attributeRewriter: HTMLRewriterElementContentHandlers
	}
}>({
	initApp: (app) => {
		app.use(
			'*',
			logger(),
			cors({
				origin: (_origin, c: Context<{ Bindings: CloudflareBindings }>) =>
					c.env.ALLOWED_DOMAINS.includes(_origin as never) ? _origin : null,
			}),
			prettyJSON(),
			(c, next) => {
				if (c.env.ENVIRONMENT === 'development') {
					console.log(kleur.bgGreen(kleur.black('development: skipping cache')))
					return next()
				}

				return cache({
					cacheName: 'mask-cache',
					wait: true,
					cacheControl: 'public, max-age=3600',
				})(c, next)
			},
		)

		app.onError((err, c) => {
			console.error(err)
			return c.text('Woops - something went wrong', 500)
		})
		app.notFound((c) => {
			console.error('not found', c.req.url)
			return c.text('Not found', 404)
		})

		return app
	},
})
