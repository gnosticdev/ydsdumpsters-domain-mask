import type { Context } from 'hono'
import { cache } from 'hono/cache'
import { cors } from 'hono/cors'
import { logger } from 'hono/logger'
import { prettyJSON } from 'hono/pretty-json'
import type { StatusCode } from 'hono/utils/http-status'
import kleur from 'kleur'
import { factory } from './utils'

const app = factory.createApp()

app.use(
	'*',
	logger(),
	cors({
		origin: (_origin, c: Context<{ Bindings: CloudflareBindings }>) =>
			c.env.ALLOWED_DOMAINS.includes(_origin as never) ? _origin : null,
	}),
	// csrf({
	// 	origin: (origin, c: Context<{ Bindings: CloudflareBindings }>) =>
	// 		c.env.ALLOWED_DOMAINS.includes(origin as never),
	// }),
	prettyJSON(),
	(c, next) => {
		if (c.env.ENVIRONMENT === 'development') {
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
		console.log(
			kleur.bgGreen(kleur.bold(kleur.blue('transforming originalUrl'))),
			originalUrl,
		)
		const absoluteUrl = originalUrl.startsWith('/')
			? `${maskedURL.protocol}://${maskedURL.hostname}${originalUrl}`
			: new URL(originalUrl).toString()

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
	if (!c.env.ALLOWED_DOMAINS.includes(requestURL.hostname as never)) {
		return c.text('Not allowed', 403)
	}

	/**
	 * The url we are masking to
	 *
	 */
	const maskedURL = new URL(c.env.MASK_DOMAIN)
	maskedURL.pathname = requestURL.pathname
	maskedURL.search = requestURL.search

	try {
		// Get the request body if it exists
		let body: BodyInit | null = null
		if (['POST', 'PUT', 'PATCH'].includes(c.req.method)) {
			body = await c.req.raw.clone().arrayBuffer()
		}

		// Forward all original headers except host
		const headers = new Headers()
		for (const [key, value] of c.req.raw.headers.entries()) {
			if (key.toLowerCase() !== 'host') {
				headers.set(key, value)
			}
		}

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
			console.log(
				kleur.bgYellow(kleur.bold(kleur.black('[image]'))),
				maskResponse.url,
			)
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

		console.log('response from maskUrl', maskResponse.status)

		return new HTMLRewriter()
			.on('*', {
				element: (el) => {
					// Handle href and src attributes
					for (const attr of [
						'href',

						'content',
					] as const) {
						const value = el.getAttribute(attr)
						if (!value?.includes(maskedURL.hostname)) continue

						const newValue = transformUrl(value, maskedURL, requestURL)
						if (newValue !== value) {
							el.setAttribute(attr, newValue)
						}

						console.log(kleur.bold(kleur.yellow(`[${attr}]`)), value, newValue)
					}
				},
				comments: (comment) => {
					comment.remove()
				},
				text: (txt) => {
					let newText = txt.text.replaceAll(
						`${maskedURL.protocol}//${maskedURL.hostname}`,
						`${requestURL.protocol}//${requestURL.host}`,
					)
					newText = newText.replaceAll(maskedURL.hostname, requestURL.hostname)
					if (newText !== txt.text) {
						txt.replace(newText, { html: false })
					}
				},
			})
			.on('img', {
				element: (el) => {
					for (const attr of [
						'src',
						'srcset',
						'data-src',
						'data-srcset',
					] as const) {
						const value = el.getAttribute(attr)
						if (!value) continue

						if (attr.endsWith('srcset')) {
							// Handle srcset format: "url size, url size, ..."
							const newSrcSet = value
								.split(',')
								.map((src) => {
									const [url, ...sizeParts] = src.trim().split(' ')
									const size = sizeParts.join(' ')

									// Decode the URL if it's encoded
									const decodedUrl = decodeURIComponent(url)

									if (!decodedUrl.includes(maskedURL.hostname)) {
										return `${decodedUrl} ${size}`.trim()
									}

									// Transform the URL
									const newUrl = transformUrl(decodedUrl, maskedURL, requestURL)
									return `${newUrl} ${size}`.trim()
								})
								.join(', ')

							el.setAttribute(attr, newSrcSet)
							console.log(kleur.magenta('[srcset]'), 'transformed:', newSrcSet)
						} else {
							// Handle regular src attributes
							const decodedValue = decodeURIComponent(value)
							if (decodedValue.includes(maskedURL.hostname)) {
								const newValue = transformUrl(
									decodedValue,
									maskedURL,
									requestURL,
								)
								el.setAttribute(attr, newValue)
							}
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

			.on('script', {
				element: (el) => {
					const src = el.getAttribute('src')
					if (src?.includes(maskedURL.hostname)) {
						const newValue = transformUrl(src, maskedURL, requestURL)
						if (newValue !== src) {
							el.setAttribute('src', newValue)
						}
					}
				},
				text: (txt) => {
					const maskedPattern = maskedURL.hostname.replace(/\./g, '\\.')

					// Patterns to match URLs with and without trailing slash
					const patterns = [
						new RegExp(`https?://${maskedPattern}/?`, 'g'), // Normal URL
						new RegExp(`https?:\\\\/\\\\/${maskedPattern}\\\\/?`, 'g'), // Escaped URL
						new RegExp(maskedPattern, 'g'), // Only the hostname
					]

					let newText = txt.text

					for (const pattern of patterns) {
						newText = newText.replace(pattern, (match) => {
							const isEscaped = match.includes('\\/')
							const protocol = requestURL.protocol.replace(':', '')
							const newURL = `${protocol}://${requestURL.host}/` // Always add trailing slash

							return isEscaped
								? newURL.replace(/\//g, '\\/') // Convert `/` to `\/` for escaping
								: newURL
						})
					}

					if (newText !== txt.text) {
						txt.replace(newText, { html: true })
						console.log('[script text] ', newText)
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
					const href = el.getAttribute('href')
					if (href?.includes(maskedURL.hostname)) {
						const decoded = decodeURIComponent(href)
						console.log(kleur.cyan('decoded URL'), decoded)
						el.setAttribute(
							'href',
							decoded.replaceAll(
								`${maskedURL.protocol}//${maskedURL.hostname}`,
								`${requestURL.protocol}//${requestURL.host}`,
							),
						)
					}
				},
			})
			.on('noscript', {
				text: (txt) => {
					const newText = txt.text
						.replaceAll(
							`${maskedURL.protocol}//${maskedURL.hostname}`,
							`${requestURL.protocol}//${requestURL.host}`,
						)
						.replaceAll(maskedURL.hostname, requestURL.host)
					if (newText !== txt.text) {
						txt.replace(newText, { html: false })
					}
				},
			})

			.transform(c.html(html))
	} catch (error) {
		console.error(`Error processing request: ${c.req.url}`, error)
		return c.text(
			`Failed to process request: ${error instanceof Error ? error.message : 'Unknown error'}`,
			502,
		)
	}
})

export default app
