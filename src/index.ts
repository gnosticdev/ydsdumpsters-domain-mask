import type { StatusCode } from 'hono/utils/http-status'
import { routeFactory } from './factory'
import { headersMiddleware } from './middleware'
import { createRewriter } from './rewriter'
import { transformUrl } from './transform-url'

const app = routeFactory.createApp()

app.use('*', headersMiddleware)

/**
 * Set the robots.txt file to block all crawlers
 */
app.get('/robots.txt', (c) => {
	return c.text('User-agent: *\nDisallow: /', {
		headers: {
			'content-type': 'text/plain',
			'cache-control': 'public, max-age=86400',
		},
	})
})

/**
 * Handle all requests
 */
app.all('*', async (c) => {
	const requestURL = c.get('requestURL')
	const maskedURL = c.get('maskedURL')

	console.log(`request from ${requestURL.href}`)
	// if (!c.env.ALLOWED_DOMAINS.includes(requestURL.hostname as never)) {
	// 	return c.text('Not allowed', 403)
	// }

	/**
	 * The url we are masking to
	 */

	try {
		// Get the request body if it exists
		let body: BodyInit | null = null

		if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
			body = await c.req.raw.clone().arrayBuffer()
		}

		// Forward all original headers except host
		const headers = new Headers(c.req.raw.headers)

		// Set the correct host and other required headers
		headers.set('Host', maskedURL.host)
		headers.set('Origin', maskedURL.origin)
		headers.set('Referer', maskedURL.origin)

		const maskResponse = await fetch(maskedURL, {
			method: c.req.method,
			headers,
			body,
			redirect: 'follow',
		})

		// For PHP responses that might return JSON or other content types
		const contentType = maskResponse.headers.get('content-type')

		// Handle JSON responses from PHP
		if (contentType?.includes('application/json')) {
			const jsonText = await maskResponse.text()
			const processedJson = jsonText
				.replaceAll(
					`${maskedURL.protocol}//${maskedURL.hostname}`,
					`${requestURL.protocol}//${requestURL.host}`,
				)
				.replaceAll(maskedURL.hostname, requestURL.hostname)

			return c.newResponse(processedJson, {
				status: maskResponse.status as StatusCode,
				headers: Object.fromEntries(maskResponse.headers.entries()),
			})
		}

		// send errors back to the origin server
		if (!maskResponse.ok) {
			c.executionCtx.passThroughOnException()
			const text = await maskResponse.text()
			console.error(
				maskResponse.headers.get('content-type'),
				text.substring(0, 1000),
			)
			throw new Error('Failed to fetch content from mask', {
				cause: maskResponse.statusText,
			})
		}

		// Handle CSS files specifically
		if (contentType?.includes('text/css')) {
			const cssText = await maskResponse.text()
			const processedCss = cssText.replace(
				/url\(['"]?(.*?)['"]?\)/g,
				(match, url) => {
					const newUrl = transformUrl(url, maskedURL, requestURL)
					return `url("${newUrl}")`
				},
			)

			return c.newResponse(processedCss, {
				status: maskResponse.status as StatusCode,
				headers: Object.fromEntries(maskResponse.headers.entries()),
			})
		}

		// handle js and replace the src with the requestURL
		if (contentType?.includes('javascript')) {
			const jsText = await maskResponse.text()
			// replace all occurences of the maskedURL with the requestURL
			let processedJs = jsText

			// first check for full url, then check for hostname only
			if (
				processedJs.includes(`${maskedURL.protocol}//${maskedURL.hostname}`)
			) {
				processedJs = processedJs.replaceAll(
					`${maskedURL.protocol}//${maskedURL.hostname}`,
					`${requestURL.protocol}//${requestURL.host}`,
				)
			}
			if (processedJs.includes(maskedURL.hostname)) {
				processedJs = processedJs.replaceAll(
					maskedURL.hostname,
					requestURL.hostname,
				)
			}

			return c.newResponse(processedJs, {
				status: maskResponse.status as StatusCode,
				headers: Object.fromEntries(maskResponse.headers.entries()),
			})
		}

		if (contentType?.includes('image/')) {
			return c.newResponse(maskResponse.body, {
				status: maskResponse.status as StatusCode,
				headers: Object.fromEntries(maskResponse.headers.entries()),
			})
		}

		// Handle non-HTML, non-CSS content
		if (!contentType?.includes('text/html')) {
			return c.newResponse(maskResponse.body, {
				status: maskResponse.status as StatusCode,
				headers: Object.fromEntries(maskResponse.headers.entries()),
			})
		}

		const html = await maskResponse.text()

		console.log(`response from ${maskedURL.href}: ${maskResponse.status}`)

		return createRewriter({
			maskedURL,
			requestURL,
		}).transform(c.html(html))
	} catch (error) {
		console.error(`Error processing request: ${c.req.url}`, error)
		return c.text(
			`Failed to process request: ${error instanceof Error ? error.message : 'Unknown error'}`,
			502,
		)
	}
})

export default app
