import type {
	Element,
	HTMLRewriterElementContentHandlers,
} from '@cloudflare/workers-types'
import type { Context } from 'hono'
import { createFactory } from 'hono/factory'

export const factory = createFactory<{
	Bindings: CloudflareBindings
	Variables: {
		attributeRewriter: HTMLRewriterElementContentHandlers
	}
}>()
