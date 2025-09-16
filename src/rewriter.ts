import { transformUrl } from './transform-url'

const IGNORE_DOMAINS = ['google-analytics.com', 'googletagmanager.com']

/**
 * Uses Cloudflare's HTMLRewriter to rewrite the HTML content
 *
 * Handles the following:
 * - href and src attributes
 * - img src and srcset attributes
 * - meta content
 * - script src attributes
 * - link canonical URLs
 * - noscript text
 * @param maskedURL - The masked URL
 * @param requestURL - The request URL
 * @param transformUrl - The transform URL function
 * @returns The HTMLRewriter instance
 */
export function createRewriter({
	maskedURL,
	requestURL,
}: {
	maskedURL: URL
	requestURL: URL
}) {
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
					} else {
						// Handle regular src attributes
						const decodedValue = decodeURIComponent(value)
						if (decodedValue.includes(maskedURL.hostname)) {
							const newValue = transformUrl(decodedValue, maskedURL, requestURL)
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
				for (const attr of ['src', 'srcset']) {
					const value = el.getAttribute(attr)
					if (!value) continue

					if (IGNORE_DOMAINS.some((domain) => value.includes(domain))) {
						el.remove()
						return
					}

					// Existing src transformation logic
					if (value.includes(maskedURL.hostname)) {
						const newValue = transformUrl(value, maskedURL, requestURL)
						if (newValue !== value) {
							el.setAttribute(attr, newValue)
						}
					}
				}
			},
			text: (txt) => {
				const maskedPattern = maskedURL.hostname.replace(/\\./g, '\\\\.')

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
				}
			},
		})
		.on('link', {
			element: (el) => {
				// remove the analytics prefetch links
				for (const attr of ['href', 'rel']) {
					const value = el.getAttribute(attr)
					if (IGNORE_DOMAINS.some((domain) => value?.includes(domain))) {
						el.remove()
						return
					}
				}

				// Handle canonical URLs and other link tags
				const rel = el.getAttribute('rel')
				if (rel === 'canonical') {
					el.setAttribute('href', requestURL.toString())
				}
				const href = el.getAttribute('href')
				if (href?.includes(maskedURL.hostname)) {
					const decoded = decodeURIComponent(href)
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
}
