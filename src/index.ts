import type { Context } from 'hono'
import { cache } from 'hono/cache'
import { cors } from 'hono/cors'
import { csrf } from 'hono/csrf'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import { appendTrailingSlash } from 'hono/trailing-slash'
import type { StatusCode } from 'hono/utils/http-status'
import { factory } from './utils'

type AllowedHosts = CloudflareBindings['ALLOWED_DOMAINS'][number]
const app = factory.createApp()

app.use(
	'*',
	logger(),
	appendTrailingSlash(),
	cors({
		origin: (_origin, c: Context<{ Bindings: CloudflareBindings }>) =>
			c.env.ALLOWED_DOMAINS.includes(_origin as AllowedHosts) ? _origin : null,
	}),
	csrf({
		origin: (origin, c: Context<{ Bindings: CloudflareBindings }>) =>
			c.env.ALLOWED_DOMAINS.includes(origin as AllowedHosts),
	}),
	cache({
		cacheName: 'mask-cache',
		wait: true,
		cacheControl: 'public, max-age=3600',
	}),
	prettyJSON(),
)

app.onError((err, c) => {
	console.error(err)
	return c.text('Woops - something went wrong', 500)
})

// block robots
app.get('/robots.txt', (c) => {
	return c.text('User-agent: *\nDisallow: /', {
		headers: {
			'content-type': 'text/plain',
			'cache-control': 'public, max-age=86400',
		},
	})
})

function transformUrl(
	originalUrl: string,
	maskedURL: URL,
	requestURL: URL,
): string {
	try {
		// Skip data URLs and non-http(s) URLs
		if (
			originalUrl.startsWith('data:') ||
			!originalUrl.match(/^(https?:)?\/\//)
		) {
			return originalUrl
		}

		// Convert to absolute URL
		const absoluteUrl = originalUrl.startsWith('/')
			? `https://${maskedURL.hostname}${originalUrl}`
			: originalUrl.startsWith('http')
				? originalUrl
				: new URL(originalUrl, maskedURL.toString()).toString()

		// Only transform URLs that contain our masked domain
		if (absoluteUrl.includes(maskedURL.hostname)) {
			const newUrl = new URL(absoluteUrl)
			newUrl.hostname = requestURL.hostname

			// Handle localhost special case
			if (requestURL.hostname === 'localhost') {
				newUrl.protocol = requestURL.protocol
				newUrl.port = requestURL.port
			}

			return newUrl.toString()
		}

		return originalUrl
	} catch (e) {
		console.error('Error transforming URL:', originalUrl, e)
		return originalUrl
	}
}

app.all('*', async (c) => {
	const requestURL = new URL(c.req.url)

	console.log('request from ', requestURL.href)
	if (!c.env.ALLOWED_DOMAINS.includes(requestURL.hostname as AllowedHosts)) {
		return c.text('Not allowed', 403)
	}

	/**
	 * The url we are masking to
	 *
	 */
	const maskedURL = new URL(c.env.MASK_DOMAIN)
	maskedURL.pathname = requestURL.pathname
	maskedURL.search = requestURL.search

	console.log('maskUrl', maskedURL)

	try {
		/**
		 * The response from the masked url
		 */
		const maskResponse = await fetch(maskedURL, {
			headers: {
				'User-Agent':
					'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
				Connection: 'keep-alive',
				Referer: maskedURL.origin,
				Host: maskedURL.host,
			},
			redirect: 'follow',
			method: c.req.method,
		})

		// send errors back to the origin server
		if (!maskResponse.ok) {
			c.executionCtx.passThroughOnException()
			throw new Error('Failed to fetch content from mask', {
				cause: maskResponse.statusText,
			})
		}

		const contentType = maskResponse.headers.get('content-type')
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
		if (contentType?.includes('text/javascript')) {
			const jsText = await maskResponse.text()
			// replace all occurences of the requestURL with the maskURL
			const processedJs = jsText.replace(
				new RegExp(requestURL.hostname, 'g'),
				maskedURL.hostname,
			)

			return c.newResponse(processedJs, {
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

		console.log('response from maskUrl', maskResponse.status)

		return new HTMLRewriter()
			.on('*', {
				element: (el) => {
					// Handle href and src attributes
					for (const attr of ['href', 'src', 'content']) {
						const value = el.getAttribute(attr)
						if (value) {
							const newValue = transformUrl(value, maskedURL, requestURL)
							if (newValue !== value) {
								el.setAttribute(attr, newValue)
							}
						}
					}
				},
				text: (txt) => {
					if (requestURL.hostname === 'localhost') {
						txt.text.replace(new RegExp(maskedURL.host, 'g'), requestURL.host)
					}
				},
			})
			.on('img', {
				element: (el) => {
					const src = el.getAttribute('src')
					if (src) {
						try {
							const absoluteUrl = src.startsWith('http')
								? src
								: new URL(src, maskedURL.toString()).toString()
							if (absoluteUrl.includes(maskedURL.hostname)) {
								const newSrc = new URL(absoluteUrl)
								newSrc.hostname = requestURL.hostname
								// also make sure port and porotocol are updated for localhost
								if (requestURL.hostname === 'localhost') {
									newSrc.protocol = requestURL.protocol
									newSrc.port = requestURL.port
								}
								console.log(`updated src from ${src} to ${newSrc}`)
								el.setAttribute('src', newSrc.toString())
							}
						} catch (e) {
							console.error('Error processing img src:', src, e)
						}
					}
				},
			})
			.on('meta', {
				element: (el) => {
					const content = el.getAttribute('content')
					if (content) {
						try {
							// Handle both absolute URLs and protocol-relative URLs
							if (
								content.match(/^(https?:)?\/\//) ||
								!content.startsWith('data:')
							) {
								const absoluteContent = content.startsWith('//')
									? `https:${content}`
									: content.startsWith('http')
										? content
										: new URL(content, maskedURL.toString()).toString()

								if (absoluteContent.includes(maskedURL.hostname)) {
									const newContent = new URL(absoluteContent)
									newContent.hostname = requestURL.hostname
									if (requestURL.hostname === 'localhost') {
										newContent.protocol = requestURL.protocol
										newContent.port = requestURL.port
									}
									el.setAttribute('content', newContent.toString())
								}
							}

							// Handle og:url and twitter:url specifically
							const property = el.getAttribute('property')
							if (property === 'og:url' || property === 'twitter:url') {
								el.setAttribute('content', requestURL.toString())
							}
						} catch (e) {
							console.error('Error processing meta content:', content, e)
						}
					}
				},
			})
			.on('link', {
				element: (el) => {
					// Handle canonical URLs and other link tags
					const rel = el.getAttribute('rel')
					if (rel === 'canonical') {
						el.setAttribute('href', requestURL.toString())
					}
				},
			})
			.transform(c.html(html))
	} catch (error) {
		console.error('Proxy error:', error)
		return c.text(
			`Failed to fetch content: ${error instanceof Error ? error.message : 'Unknown error'}`,
			502,
		)
	}
})

export default app
