import type { HTMLRewriterElementContentHandlers } from '@cloudflare/workers-types'
import { createFactory } from 'hono/factory'

export const factory = createFactory<{
	Bindings: CloudflareBindings
	Variables: {
		attributeRewriter: HTMLRewriterElementContentHandlers
	}
}>()
