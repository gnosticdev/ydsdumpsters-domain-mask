/**
 * Transform the URL to the request URL
 * @param originalUrl - The original URL
 * @param maskedURL - The masked URL
 * @param requestURL - The request URL
 * @returns The transformed URL
 */
export function transformUrl(
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
