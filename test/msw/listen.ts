import type { SetupServer } from "msw/node";

/**
 * Start MSW while allowing local MCP HTTP contract traffic to bypass the interceptor.
 */
export function listenWithLocalBypass(server: SetupServer): void {
  server.listen({
    onUnhandledRequest(request, print) {
      const hostname = new URL(request.url).hostname;
      if (hostname === "127.0.0.1" || hostname === "localhost" || hostname === "::1") {
        return;
      }
      print.error();
    },
  });
}
