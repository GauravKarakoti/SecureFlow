import { handlers } from "@/auth"
import { withRateLimit, TIERS } from "@/lib/middleware/rate-limit";

const { GET, POST: originalPost } = handlers;

export const POST = withRateLimit(originalPost as any, { ...TIERS.AUTH, keyPrefix: 'auth:post' });
export { GET };