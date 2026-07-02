import { CLOBE_MCP_URL } from "./clobeConfig.ts";

// Minimal hand-rolled MCP JSON-RPC client: one `initialize` handshake per Edge
// Function invocation, then repeated `tools/call`. No MCP SDK dependency --
// the protocol surface actually needed here is narrow.
//
// NOTE: exact response shape (SSE vs plain JSON, presence of Mcp-Session-Id,
// the structure inside result.content[0].text) is confirmed against clobe's
// real server on the first live call after OAuth is connected -- see
// clobe-inspect-tool for the verification harness. This client is written
// defensively (branches on Content-Type, tries JSON.parse before falling back
// to raw text) so it should not need changes once verified, but treat the
// first real backfill run's logs as the actual confirmation.

let reqId = 1;

async function postJsonRpc(
  accessToken: string,
  body: unknown,
  sessionId?: string,
): Promise<{ json: any; sessionId?: string }> {
  const headers: Record<string, string> = {
    "Authorization": `Bearer ${accessToken}`,
    "Content-Type": "application/json",
    "Accept": "application/json, text/event-stream",
  };
  if (sessionId) headers["Mcp-Session-Id"] = sessionId;

  const res = await fetch(CLOBE_MCP_URL, {
    method: "POST",
    headers,
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30000),
  });

  const newSessionId = res.headers.get("Mcp-Session-Id") ?? sessionId;
  const contentType = res.headers.get("Content-Type") ?? "";

  if (contentType.includes("text/event-stream")) {
    const text = await res.text();
    const dataLines = text.split("\n").filter((l) => l.startsWith("data:"));
    const last = dataLines[dataLines.length - 1]?.slice(5).trim();
    if (!last) {
      throw new Error(`MCP SSE 응답을 파싱할 수 없습니다: ${text.slice(0, 500)}`);
    }
    return { json: JSON.parse(last), sessionId: newSessionId ?? undefined };
  }

  const json = await res.json();
  if (!res.ok) throw new Error(`MCP HTTP ${res.status}: ${JSON.stringify(json)}`);
  return { json, sessionId: newSessionId ?? undefined };
}

export async function mcpInitialize(accessToken: string): Promise<string | undefined> {
  const { json, sessionId } = await postJsonRpc(accessToken, {
    jsonrpc: "2.0",
    id: reqId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "clobe-viewer-sync", version: "1.0" },
    },
  });
  if (json.error) throw new Error(`MCP initialize 실패: ${JSON.stringify(json.error)}`);

  // Fire-and-forget notification per MCP spec -- no response expected.
  await fetch(CLOBE_MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});

  return sessionId;
}

export async function mcpToolsCall(
  accessToken: string,
  sessionId: string | undefined,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const { json } = await postJsonRpc(
    accessToken,
    { jsonrpc: "2.0", id: reqId++, method: "tools/call", params: { name, arguments: args } },
    sessionId,
  );

  if (json.error) throw new Error(`MCP tools/call(${name}) 실패: ${JSON.stringify(json.error)}`);
  const result = json.result;
  if (result?.isError) throw new Error(`MCP tool ${name} 에러: ${JSON.stringify(result.content)}`);

  const first = result?.content?.[0];
  if (!first) throw new Error(`MCP tool ${name} 응답에 content가 없습니다: ${JSON.stringify(result)}`);
  if (first.type === "text") {
    try {
      return JSON.parse(first.text);
    } catch {
      return first.text; // 일부 도구는 순수 텍스트를 반환할 수 있음
    }
  }
  return first;
}

// One-shot helper: initialize + single tools/call, for ad-hoc inspection calls
// where paying the initialize cost once per invocation is fine.
export async function mcpCallOnce(
  accessToken: string,
  name: string,
  args: Record<string, unknown>,
): Promise<any> {
  const sessionId = await mcpInitialize(accessToken);
  return await mcpToolsCall(accessToken, sessionId, name, args);
}

// Diagnostic helper: returns the full initialize result (protocolVersion,
// capabilities, serverInfo) plus the session id, instead of discarding it.
export async function mcpRawInitializeResult(
  accessToken: string,
): Promise<{ sessionId?: string; result: any }> {
  const { json, sessionId } = await postJsonRpc(accessToken, {
    jsonrpc: "2.0",
    id: reqId++,
    method: "initialize",
    params: {
      protocolVersion: "2024-11-05",
      capabilities: {},
      clientInfo: { name: "clobe-viewer-sync", version: "1.0" },
    },
  });
  if (json.error) throw new Error(`MCP initialize 실패: ${JSON.stringify(json.error)}`);

  await fetch(CLOBE_MCP_URL, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${accessToken}`,
      "Content-Type": "application/json",
      ...(sessionId ? { "Mcp-Session-Id": sessionId } : {}),
    },
    body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }),
  }).catch(() => {});

  return { sessionId, result: json.result };
}

// Diagnostic helper: lists the tools the server actually advertises, with
// their real input JSON schemas -- ground truth instead of guessing argument
// names from prose documentation.
export async function mcpToolsList(
  accessToken: string,
  sessionId: string | undefined,
): Promise<any> {
  const { json } = await postJsonRpc(
    accessToken,
    { jsonrpc: "2.0", id: reqId++, method: "tools/list", params: {} },
    sessionId,
  );
  if (json.error) throw new Error(`MCP tools/list 실패: ${JSON.stringify(json.error)}`);
  return json.result;
}
