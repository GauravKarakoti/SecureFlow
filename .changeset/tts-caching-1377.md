---
"secureflow": minor
---

feat(tts-cache): add database-backed persistence layer and rate limiting for ElevenLabs audio debriefs (#1377)

- Add `AudioDebriefCache` Prisma model for durable audio storage mapped to finding content hashes
- Implement `src/lib/findings/audio-debrief-db.ts` with multi-tier cache (in-memory -> Redis -> database)
- Upgrade `getCachedAudioDebrief` and `setCachedAudioDebrief` to support persistent DB cache fallback
- Add per-user rate limiting on `/api/voice-alerts/stream` to prevent reconnect quota exhaustion
- Add comprehensive test coverage in `src/app/api/findings/[id]/audio-debrief/route.test.ts` and `src/app/api/voice-alerts/stream/route.test.ts`
