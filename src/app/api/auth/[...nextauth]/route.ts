import { handlers } from "@/auth"
import { withRateLimit } from "@/lib/middleware/rateLimit";

const { GET, POST: originalPost } = handlers;

export const POST = withRateLimit(originalPost as any, { limit: 10, windowSeconds: 60, keyPrefix: 'auth:post' });
export { GET };