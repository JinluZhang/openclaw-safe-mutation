import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  handleAgent1024PreToolUse,
  type Agent1024PreToolUseHandlerDependencies
} from "./handlers/pre-tool-use.js";
import {
  handleAgent1024UserMessageReceived,
  type Agent1024UserMessageReceivedHandlerDependencies
} from "./handlers/user-message-received.js";
import type {
  Agent1024HookResponse,
  Agent1024PreToolUsePayload,
  Agent1024UserMessageReceivedPayload
} from "./response-types.js";

export interface Agent1024WebhookDependencies
  extends Agent1024PreToolUseHandlerDependencies,
    Agent1024UserMessageReceivedHandlerDependencies {}

export interface Agent1024WebhookServerOptions {
  pathPrefix?: string;
  maxBodyBytes?: number;
  failOpenOnError?: boolean;
  onError?: (error: unknown, context: Agent1024WebhookErrorContext) => void;
}

export interface Agent1024WebhookErrorContext {
  event: "PRE_TOOL_USE" | "USER_MESSAGE_RECEIVED" | "UNKNOWN";
  path: string;
}

export interface Agent1024WebhookServer {
  close(): Promise<void>;
  port(): number | undefined;
}

const DEFAULT_PATH_PREFIX = "/webhook/safe-mutation";
const DEFAULT_MAX_BODY_BYTES = 1024 * 1024;

function normalizePrefix(prefix: string): string {
  const withLeadingSlash = prefix.startsWith("/") ? prefix : `/${prefix}`;
  return withLeadingSlash.endsWith("/")
    ? withLeadingSlash.slice(0, -1)
    : withLeadingSlash;
}

function getPath(request: IncomingMessage): string {
  const url = new URL(request.url ?? "/", "http://localhost");
  return url.pathname;
}

function writeJson(
  response: ServerResponse,
  statusCode: number,
  body: unknown
): void {
  response.writeHead(statusCode, {
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify(body));
}

function methodNotAllowed(response: ServerResponse): void {
  response.writeHead(405, {
    Allow: "POST",
    "Content-Type": "application/json; charset=utf-8"
  });
  response.end(JSON.stringify({ error: "method_not_allowed" }));
}

async function readJsonBody(
  request: IncomingMessage,
  maxBodyBytes: number
): Promise<unknown> {
  const chunks: Buffer[] = [];
  let totalBytes = 0;

  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;

    if (totalBytes > maxBodyBytes) {
      throw new Error(`Webhook request body exceeds ${maxBodyBytes} bytes.`);
    }

    chunks.push(buffer);
  }

  const body = Buffer.concat(chunks).toString("utf8").trim();

  return body ? JSON.parse(body) : {};
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validatePayload<T>(
  value: unknown,
  expectedEvent: string
): T {
  if (!isRecord(value)) {
    throw new Error(`${expectedEvent} webhook payload must be a JSON object.`);
  }

  if (value.event !== undefined && value.event !== expectedEvent) {
    throw new Error(
      `Expected webhook event ${expectedEvent}, got ${String(value.event)}.`
    );
  }

  return value as T;
}

function errorResponse(
  error: unknown,
  context: Agent1024WebhookErrorContext,
  failOpenOnError: boolean
): Agent1024HookResponse {
  if (failOpenOnError) {
    return {
      decision: "allow"
    };
  }

  const message = error instanceof Error ? error.message : String(error);

  return {
    decision: "block",
    reason: `SAFE_MUTATION_WEBHOOK_ERROR event=${context.event}: ${message}`
  };
}

async function dispatchWebhook(params: {
  dependencies: Agent1024WebhookDependencies;
  options: Required<
    Pick<Agent1024WebhookServerOptions, "maxBodyBytes" | "failOpenOnError">
  > &
    Pick<Agent1024WebhookServerOptions, "onError">;
  request: IncomingMessage;
  response: ServerResponse;
  event: Agent1024WebhookErrorContext["event"];
  path: string;
}): Promise<void> {
  try {
    const body = await readJsonBody(
      params.request,
      params.options.maxBodyBytes
    );
    const result =
      params.event === "PRE_TOOL_USE"
        ? await handleAgent1024PreToolUse(
            params.dependencies,
            validatePayload<Agent1024PreToolUsePayload>(body, "PRE_TOOL_USE")
          )
        : await handleAgent1024UserMessageReceived(
            params.dependencies,
            validatePayload<Agent1024UserMessageReceivedPayload>(
              body,
              "USER_MESSAGE_RECEIVED"
            )
          );

    writeJson(params.response, 200, result);
  } catch (error) {
    const context = {
      event: params.event,
      path: params.path
    };
    params.options.onError?.(error, context);
    writeJson(
      params.response,
      200,
      errorResponse(error, context, params.options.failOpenOnError)
    );
  }
}

export function createAgent1024WebhookRequestHandler(
  dependencies: Agent1024WebhookDependencies,
  options: Agent1024WebhookServerOptions = {}
): (request: IncomingMessage, response: ServerResponse) => void {
  const pathPrefix = normalizePrefix(options.pathPrefix ?? DEFAULT_PATH_PREFIX);
  const resolvedOptions = {
    maxBodyBytes: options.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES,
    failOpenOnError: options.failOpenOnError ?? false,
    onError: options.onError
  };

  return (request, response) => {
    void (async () => {
      const path = getPath(request);

      if (path === `${pathPrefix}/healthz`) {
        writeJson(response, 200, { ok: true });
        return;
      }

      if (request.method !== "POST") {
        methodNotAllowed(response);
        return;
      }

      if (path === `${pathPrefix}/pre-tool-use`) {
        await dispatchWebhook({
          dependencies,
          options: resolvedOptions,
          request,
          response,
          event: "PRE_TOOL_USE",
          path
        });
        return;
      }

      if (path === `${pathPrefix}/user-message-received`) {
        await dispatchWebhook({
          dependencies,
          options: resolvedOptions,
          request,
          response,
          event: "USER_MESSAGE_RECEIVED",
          path
        });
        return;
      }

      writeJson(response, 404, { error: "not_found" });
    })().catch((error: unknown) => {
      const path = getPath(request);
      const context = {
        event: "UNKNOWN" as const,
        path
      };
      resolvedOptions.onError?.(error, context);
      writeJson(response, 200, errorResponse(error, context, false));
    });
  };
}

export function startAgent1024WebhookServer(
  dependencies: Agent1024WebhookDependencies,
  options: Agent1024WebhookServerOptions & {
    host?: string;
    port?: number;
  } = {}
): Promise<Agent1024WebhookServer> {
  const server = createServer(
    createAgent1024WebhookRequestHandler(dependencies, options)
  );
  const host = options.host ?? "0.0.0.0";
  const port = options.port ?? 0;

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      server.off("error", reject);
      resolve({
        close: () =>
          new Promise<void>((closeResolve, closeReject) => {
            server.close((error) =>
              error ? closeReject(error) : closeResolve()
            );
          }),
        port: () => {
          const address = server.address();

          return typeof address === "object" && address
            ? (address as AddressInfo).port
            : undefined;
        }
      });
    });
  });
}
