import { ErrorState } from "@/components/error-state";

/**
 * Branded 404 (#560).
 *
 * Replaces the default black-on-white Next.js page, which is jarring against
 * the rest of the product and offers no route back into the app. Reached by
 * unknown URLs and by any `notFound()` call.
 *
 * No `reset()` here: a 404 is not transient, so offering "Try again" would just
 * re-render the same 404.
 */
export default function NotFound() {
  return (
    <ErrorState
      code="404"
      title="Nothing at this address"
      description="This page does not exist, or the resource it pointed at has been removed. If you followed a shared link, the transmission may have expired."
      showHomeLink
    />
  );
}
