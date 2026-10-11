# Durable emergency notifications

`system.recovery.status` events carry event UUID, incident UUID, boot UUID,
positive persistent sequence, timestamp, status and bounded reason. The frame
authenticates through its existing token. Statuses: `recovering`,
`reboot-requested`, `verifying`, `recovered`, `failed`, `limited`.

The dedicated `/api/v1/frames/:frameId/recovery-events` route returns a versioned
ACK. Older central versions return 404, leaving the frame queue intact rather
than acknowledging an unhandled event through the generic event route.
The transaction recording a new device event also enqueues one
`telegram.recovery` job per configured administrator. Only then is the event
acknowledged. Event UUID deduplication prevents repeated queue creation.
An associated frame notification is updated by incident ID. No schema migration
is needed; this reuses the existing jobs and device-events tables.

The worker delivers persisted jobs before media jobs, in sequence per frame and
recipient. Telegram failures remain pending with backoff up to one hour (429
uses Telegram's retry-after); retries are not limited to three attempts.
Abandoned job locks use the existing worker recovery mechanism. One blocked
recipient/frame does not prevent another frame's eligible notification.

Delivery is at least once, **not exactly once**: if Telegram accepts a message
but its acknowledgement is lost, a retry may duplicate it. Messages include
incident identity and occurrence time, distinguishing historical delayed reports
from current state. Requested reboot, new boot and verified recovery are separate
events; none is silently presented as equivalent to the next.

Deploy this central receiver/worker before the baseline-17 frame package.
Keep it during a frame rollback so queued incident reports can still be delivered.
No bot token is installed on the frame. Other existing telemetry notification
paths are unchanged by this scoped feature.

Validation: run PostgreSQL tests against an isolated database with
`TEST_DATABASE_URL=... npm test -- --no-file-parallelism`. Fleet tests share
global worker queues and must not run concurrently in the same database.
