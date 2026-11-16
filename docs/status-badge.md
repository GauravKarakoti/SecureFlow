# Status Badge

SecureFlow can serve a live SVG badge that reflects the latest scan status of
a repository. Embed it in your README to give contributors an at-a-glance
view of your project's security posture.

## Markdown snippet

```markdown
![SecureFlow](https://your-secureflow-instance.com/api/badge/OWNER/REPO)
```

Replace `OWNER/REPO` with the GitHub owner and repository name (e.g.
`acme-corp/web-app`).

## Badge states

| State               | Colour | Meaning                                          |
| ------------------- | ------ | ------------------------------------------------ |
| **passing**         | Green  | Latest PR scan passed with no policy violations. |
| **review required** | Yellow | Findings need manual review before merging.      |
| **blocked**         | Red    | Critical findings are blocking the merge.        |
| **unknown**         | Grey   | No scans found, or public badge is not enabled.  |

## Enabling the badge

By default, the badge returns **unknown** for every repository to prevent
leaking scan status from private repos. To enable it:

1. Navigate to **Integrations & Settings** in the SecureFlow dashboard (`/dashboard/settings`).
2. Scroll to the **Repository Status Badges** section.
3. Toggle **Public Badge** to enabled for the desired repository.
4. Copy the ready-to-use Markdown snippet and embed it into your repository's README.

> **Note:** Disabling the toggle immediately returns the badge to **unknown**.
> The endpoint caches responses for up to 5 minutes (`Cache-Control: public,
max-age=300`), so changes may take a few minutes to propagate through CDN
> caches.

## API details

```
GET /api/badge/:owner/:repo
```

- **Response:** `image/svg+xml`
- **Cache:** `public, max-age=300, s-maxage=300`
- **Rate limit:** Standard tier (120 req/min per IP)
- **Auth:** None required (public endpoint)

The route performs a single indexed database lookup and never returns
repository details beyond the badge state.
