# Cloudflare Domain Masking Proxy

This is a simple way to mask a domain by proxying requests to a different domain, without changing the URL.

The main goal is to be able to use a separate domain for email addresses, or a bunch of different domains, but still have those point to the main site. However, with redirects, if the email domain were to be blacklisted, it could hurt the main site in both email and SEO. By using a masking proxy, you go to `https;//my-masked-domain.com` and it would show all the same content as `https;//my-main-domain.com` but the URL would remain `https;//my-masked-domain.com`, and there would be no trace of the main domain in the request headers or source code.

Features:

- Swaps out all ocurrences of the masked domain with the target domain
- Maintains site functionality
- Keeps the same URL structure
- Keeps the same content
- Keeps the same SEO
- Keeps the same email links
- Keeps the same social links
- Keeps the same tracking links

## How it works

This is a simple Cloudflare worker that responds to all requests and does the swapping on the server before anything reaches the client.
