import { describe, expect, it } from "vitest";

import {
  AmbiguousCompletionError,
  mapUpstreamError,
  toMcpToolError,
  UpstreamApiError,
} from "../../src/client/errors.ts";

describe("upstream error mapping", () => {
  it("maps vendor JSON safely without headers, body dumps, or secrets", async () => {
    const response = new Response(
      JSON.stringify({
        code: "INVALID_CONTACT_TYPE",
        errors: ["Title contacts can't be added to a commercial lease."],
        message: "Validation failed",
        traceId: "trace-123",
        Authorization: "ss leaked",
        Session: "session-leaked",
      }),
      {
        status: 422,
        headers: {
          "Content-Type": "application/json",
          Authorization: "ss should-not-appear",
          Session: "session-should-not-appear",
          "x-trace-id": "header-trace",
        },
      },
    );

    const error = await mapUpstreamError(response);
    expect(error).toBeInstanceOf(UpstreamApiError);
    expect(error.details).toEqual({
      httpStatus: 422,
      code: "INVALID_CONTACT_TYPE",
      message: "Validation failed",
      errors: ["Title contacts can't be added to a commercial lease."],
      traceId: "trace-123",
      retryable: false,
      ambiguous: false,
    });

    const serialized = JSON.stringify(error.details);
    expect(serialized).not.toContain("ss ");
    expect(serialized).not.toContain("session-");
    expect(serialized).not.toContain("should-not-appear");

    const mcp = toMcpToolError(error);
    expect(mcp.isError).toBe(true);
    expect(mcp.structuredContent.httpStatus).toBe(422);
    expect(mcp.structuredContent.code).toBe("INVALID_CONTACT_TYPE");
    expect(mcp.structuredContent.traceId).toBe("trace-123");
  });

  it("marks retryable statuses and ambiguous completion for MCP results", async () => {
    const retryable = await mapUpstreamError(
      new Response(JSON.stringify({ code: "RATE", message: "slow down" }), {
        status: 429,
        headers: { "Content-Type": "application/json" },
      }),
    );
    expect(retryable.details.retryable).toBe(true);

    const ambiguous = toMcpToolError(
      new AmbiguousCompletionError(
        "Request timed out; write completion is ambiguous — read the current resource state before retrying",
      ),
    );
    expect(ambiguous.structuredContent.ambiguous).toBe(true);
    expect(ambiguous.structuredContent.retryable).toBe(false);
    expect(ambiguous.content[0]?.text).toMatch(/read the current resource state/i);
  });

  it("caps oversized error bodies and never leaks secret material", async () => {
    const secret = "ss leaked-secret-material-should-not-appear";
    const oversized = `${JSON.stringify({ message: "too big", secret })}${"x".repeat(70_000)}`;
    const response = new Response(oversized, {
      status: 500,
      headers: { "Content-Type": "application/json" },
    });

    const error = await mapUpstreamError(response);
    expect(error).toBeInstanceOf(UpstreamApiError);
    expect(error.details.httpStatus).toBe(500);
    const serialized = JSON.stringify(toMcpToolError(error));
    expect(serialized).not.toContain(secret);
    expect(serialized).not.toContain("leaked-secret");
  });
});
