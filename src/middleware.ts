import { routeFactory } from './factory'
import { createRewriter } from './rewriter'

export const headersMiddleware = routeFactory.createMiddleware((c, next) => {
	// Prevent search engines from indexing the masked domain
	c.header('X-Robots-Tag', 'noindex, nofollow')

	// Add Link header for canonical URL if it's an HTML response
	const contentType = c.req.header('content-type')
	if (contentType?.includes('text/html')) {
		const maskedURL = new URL(c.env.MASK_DOMAIN)
		maskedURL.pathname = new URL(c.req.url).pathname
		maskedURL.search = new URL(c.req.url).search
		c.header('Link', `<${maskedURL.toString()}>; rel="canonical"`)
	}

	return next()
})

export const rewriteContentMiddleware = routeFactory.createMiddleware(
	async (c, next) => {
		await next() // Process request and get response into c.res

		// Check if response exists and is HTML
		if (c.res.headers.get('content-type')?.includes('text/html')) {
			const response = c.res // Get the response potentially set by downstream handlers
			const requestURL = new URL(c.req.url)
			const maskedURL = new URL(c.env.MASK_DOMAIN)

			// Ensure the body is usable for the rewriter
			if (response?.body) {
				const rewriter = createRewriter({ maskedURL, requestURL })

				// Apply the rewriter to the response body
				// Hono automatically handles the stream transformation when you set c.res
				c.res = rewriter.transform(response)
			}
		}
		// No explicit return needed, modifying c.res modifies the final response
	},
)
