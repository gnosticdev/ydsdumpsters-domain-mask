import type { Context } from 'hono'
import { cache } from 'hono/cache'
import { cors } from 'hono/cors'
import { createFactory } from 'hono/factory'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'

/**
 * Sets the base app with the following middleware:
 * - logger
 * - cors (using configured ALLOWED_DOMAINS env variable)
 * - prettyJSON
 * - cache
 */
export const routeFactory = createFactory<{
	Bindings: Env
	Variables: {
		attributeRewriter: HTMLRewriterElementContentHandlers
		maskedURL: URL
		requestURL: URL
	}
}>({
	initApp: (app) => {
		app.use(
			'*',
			logger(),
			cors({
				origin: (_origin, c: Context<{ Bindings: Env }>) =>
					c.env.ALLOWED_DOMAINS.includes(_origin as never) ? _origin : null,
			}),
			prettyJSON(),
			(c, next) => {
				// skip caching in development
				if (c.env.ENVIRONMENT === 'development') {
					return next()
				}

				return cache({
					cacheName: 'mask-cache',
					wait: true,
					cacheControl: 'public, max-age=3600',
				})(c, next)
			},
			(c, next) => {
				const requestURL = new URL(c.req.url)
				const maskedURL = new URL(c.env.MASK_DOMAIN)
				maskedURL.pathname = requestURL.pathname
				maskedURL.search = requestURL.search
				c.set('maskedURL', maskedURL)
				c.set('requestURL', requestURL)
				return next()
			},
		)

		app.onError((err, c) => {
			console.error(err)
			return c.text('Woops - something went wrong', 500)
		})
		app.notFound((c) => {
			console.error('[Route] Not found', c.req.url)
			return c.text('[Route] Not found', 404)
		})
	},
})
