"use client";

import dynamic from "next/dynamic";
import "swagger-ui-react/swagger-ui.css";

/**
 * Swagger UI, loaded only in the browser.
 *
 * The library reaches for `window` while initialising and still uses legacy
 * React lifecycle methods, so rendering it on the server produces either a
 * crash or a hydration mismatch. `ssr: false` is therefore not an optimisation
 * here, it is the only way the component works — and it keeps several hundred
 * kilobytes of bundle off every other route.
 */
const SwaggerUI = dynamic(() => import("swagger-ui-react"), {
  ssr: false,
  loading: () => (
    <p className="p-6 text-sm text-muted-foreground" role="status">
      Loading the interactive API explorer…
    </p>
  ),
});

export interface ApiPlaygroundProps {
  /** Where the spec is served from. Same origin, so `Try it out` can use the session cookie. */
  specUrl: string;
}

export function ApiPlayground({ specUrl }: ApiPlaygroundProps) {
  return (
    // Swagger UI ships a light-only stylesheet, so the panel keeps a white
    // background of its own rather than inheriting the app's dark surface and
    // rendering grey-on-grey for anyone using the dark theme.
    <div className="rounded-xl border border-white/10 bg-white">
      {/*
        `persistAuthorization` is deliberately left off. It would keep whatever
        a developer types into the Authorize dialog in `localStorage`, where it
        outlives the tab and is readable by any script on this origin — a poor
        trade for saving one dialog, and a worse one in a security product.
        Re-authorizing per session costs a click; the session cookie that
        actually authenticates these requests is unaffected either way.
      */}
      <SwaggerUI
        url={specUrl}
        docExpansion="list"
        // Models are long and mostly noise on first load; the operations are
        // what a developer came here for.
        defaultModelsExpandDepth={-1}
        tryItOutEnabled
      />
    </div>
  );
}

export default ApiPlayground;
