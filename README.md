# cameld

A self-hosted service that finds Strava activities recorded twice by two
devices for the same outing and merges them into one recording, without losing
a single sample from either source.

It backs up every activity first, matches pairs strictly, builds a merged FIT
file, uploads it with the original date and time, and only removes the
originals under strict, opt-in gates. A web UI covers review, history,
backfill, and settings.

Status: early skeleton (Node.js, TypeScript, Fastify, SQLite, Vue 3). See
[docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) for the design and
[CLAUDE.md](CLAUDE.md) for conventions.

## Develop

```
npm install
npm run dev        # server on :8080, web on :5173
npm test
npm run lint && npm run typecheck && npm run build
```

Requires Node 24 or newer (Node 26 recommended, see `.node-version`).

## Deploy

Copy `.env.example` to `.env`, fill it in on the host only, and use
[deploy/compose.example.yml](deploy/compose.example.yml). The image is
`ghcr.io/pmaxhogan/cameld`. See [SECURITY.md](SECURITY.md) before exposing it.

## License

MIT
