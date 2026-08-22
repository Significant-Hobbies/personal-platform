# Personal Platform

Cloudflare synchronization and semantic APIs for Journal, Habits, Setline,
Kith, and Anchor. Hub consumes these APIs read-only and owns no domain data.
Live remains authoritative in Significant Hobbies D1 and Calorie remains
authoritative in its existing Worker and D1; both are accessed only through
typed service connectors.

## Local development

```bash
npm ci
npm run types
npm test
swift test
npm run check
```

The Worker fails closed for authenticated endpoints until an auth service or a
test-only local identity is supplied. No production resource is created by
these commands.

## Routes

- `GET /health`
- `POST /v1/sync/push`
- `GET /v1/sync/pull?domain=<domain>&cursor=<cursor>`
- `GET /v1/domains/:domain/summary`
- `POST /v1/domains/:domain/actions/:action`
- `GET /v1/life/today`
- `GET /v1/activity`
- `POST /v1/actions/:actionId/undo`

See [`docs/integration.md`](docs/integration.md) for the app-by-app boundary.
