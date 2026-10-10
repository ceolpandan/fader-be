# Pause the whole Discogs queue and retry on Discogs errors

An overnight index of a big seller must survive Discogs hiccups instead of failing every job in an outage (fader-ui#41, which superseded aborting a run on a 429).

On a 429, 5xx or network failure the Discogs queue pauses and retries the same job after 1, 2, 4, 8, then 10 minutes (the cap), or after `Retry-After` when that is longer. A paused retry does not use up the job's attempts, and a success resets the backoff. A 404 stays a permanent per-job failure. The 1.1s pacing between jobs is separate.

- **State is in memory.** After a restart stuck jobs return to `pending` and the backoff starts over.
- **Inline requests fail fast** with 503 "Discogs unavailable, retrying" while paused, instead of waiting and timing out with 504.
- **The queue gives up after about 65 minutes of continuous failure** (1 + 2 + 4 + 8 minutes, then five retries at the 10-minute cap; `MAX_CAP_RETRIES`). It then fails all unfinished work, so each affected seller ends in `error`. This is shorter than the roughly 8 hours the issue recommended, so an outage of an hour or more during a long overnight run still ends it. Revisit if that bites.
- **A 401/403 token refusal is not transient.** It fails that run at once with the Discogs message, with no retry. (The pagination 403 is the exception, see ADR 0001.)
- `retryingAt` and `backoffMs` on `GET /sellers/{username}` expose the pause, and the ETA adds the remaining pause time.
