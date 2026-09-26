#!/usr/bin/env tsx
/**
 * ============================================================================
 *  HumanGate MCP server (T-3.4)
 * ============================================================================
 *
 *   npm run mcp                      # stdio, for any MCP client
 *   HUMANGATE_AGENT_TOKEN=... npm run mcp
 *
 * Why this exists: `agent/runner.ts` proves the flow works, but it is *our*
 * client. This exposes the same three operations over MCP so any agent host can
 * participate. It changes no business logic — every tool is a thin wrapper that
 * calls the same `lib/` function the HTTP route calls.
 *
 * ── The transport-layer enforcement point ──────────────────────────────────
 *
 * `slot.claim` REQUIRES an `approval` argument. A model can absolutely call it
 * without one — and that is the point. The tool does not fail because the schema
 * forbids it; it fails because the server, at execution time, finds no approval
 * in its own state. Official guidance:
 *
 *   "A required `approval` input is **not proof of authorization** — tool inputs
 *    are **LLM-generated**."
 *
 * So the requirement is expressed twice, deliberately:
 *   · in the schema, so a well-behaved host knows what is expected
 *   · at the gate, so a misbehaving one gets nowhere
 *
 * Only the second one is a security control. The first is documentation.
 *
 * ── On the protocol layer ──────────────────────────────────────────────────
 *
 * `@modelcontextprotocol/sdk` handles JSON-RPC, capabilities and stdio. Nothing
 * here hand-rolls framing. The plan is explicit: "use the official MCP TypeScript
 * SDK, don't hand-roll JSON-RPC".
 *
 * ── On authorization ───────────────────────────────────────────────────────
 *
 * The sandbox docs describe an MCP OAuth surface (RFC 9728 protected resource
 * metadata at `/.well-known/oauth-protected-resource/mcp`) for connecting *to
 * World ID's own MCP*. That is not the same thing as protecting ours: as the
 * `getting-started` guide puts it, "An upstream World ID login alone does not
 * implement MCP authorization." So this server authenticates callers with the
 * relying party's own scoped credential (T-5.2), which is exactly what the
 * `oidc` guide says the RP must do — "your backend issues the agent's
 * credential". See docs/SPIKE_NOTES.md S-11.
 */
import { Server } from '@modelcontextprotocol/sdk/server/index.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { CallToolRequestSchema, ListToolsRequestSchema } from '@modelcontextprotocol/sdk/types.js';
import { AgentClient, AgentHttpError } from '../agent/client';
import { env } from '../lib/env';

const BASE = env('BASE_URL') ?? 'http://localhost:3000';
const TOKEN = env('AGENT_TOKEN') ?? '';
/**
 * The event this agent acts in.
 *
 * The agent is a separate process talking to the server over HTTP, so it does
 * not inherit the caller's private event — an HTTP request is a new request, and
 * on the public site each new request without a cookie gets a new event. The
 * spawning server therefore names the event explicitly, and every tool call
 * defaults to it. Unset (the terminal, `npm run mcp` by hand), the server
 * resolves the event itself, which is what it did before private events existed.
 */
const EVENT_ID = env('EVENT_ID') ?? '';

const client = new AgentClient(BASE);
if (TOKEN) client.setBearer(TOKEN);

/**
 * A refusal, returned as a *successful* tool result carrying `isError: true`.
 *
 * This matters for the demo: a model that calls `slot.claim` without an approval
 * must receive a readable, structured explanation it can act on, not a transport
 * failure. "The action did not happen, and here is precisely why" is the correct
 * outcome for a failed authorization, and it is what the track's requirement 3
 * asks to see demonstrated.
 */
function refusal(err: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  if (err instanceof AgentHttpError) {
    return {
      isError: true,
      content: [
        {
          type: 'text',
          text: JSON.stringify(
            {
              httpStatus: err.status,
              ...err.body,
              ok: false,
              note: 'The protected action did NOT execute.',
            },
            null,
            2,
          ),
        },
      ],
    };
  }
  return {
    isError: true,
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            ok: false,
            code: 'transport_error',
            message: err instanceof Error ? err.message : String(err),
            hint: `Is the HumanGate server running at ${BASE}? Start it with: ENABLE_DEV_ROUTES=1 npm run dev`,
          },
          null,
          2,
        ),
      },
    ],
  };
}

function ok(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] };
}

// ── Server ──────────────────────────────────────────────────────────────────

const server = new Server(
  { name: 'humangate', version: '1.0.0' },
  {
    capabilities: { tools: {} },
    instructions: [
      'HumanGate is an event queue where a human must be present at the moment a slot is handed over.',
      '',
      'queue.join   — enter the queue. No approval needed.',
      'queue.status — see the draw rank, any slot allocated to you, and its countdown.',
      'slot.claim   — take the slot. REQUIRES an `approval` argument.',
      '',
      'About slot.claim: an `approval` value is NOT proof of anything by itself. Tool inputs are',
      'generated by you, and the server knows that. It looks the value up in its own state, re-checks',
      'that the approval is bound to this exact action and this exact slot, re-checks that the human',
      'authenticated recently enough, and consumes it exactly once. A fabricated or reused value will',
      'be refused, and the refusal will tell you which check failed.',
      '',
      'An approval can only be created by asking the human: POST /api/slot/claim/request, then have',
      'them approve on their own device. You cannot mint one, and you should not try to work around',
      'that — it is the entire design.',
      '',
      'If slot.claim returns `deferred_to_next_candidate`, the human missed the window and the slot',
      'has moved to someone else. That is a product behaviour, not an error: do not retry.',
    ].join('\n'),
  },
);

server.setRequestHandler(ListToolsRequestSchema, async () => ({
  tools: [
    {
      name: 'queue.join',
      description:
        'Join the event queue as the human this credential represents. Idempotent: calling it again ' +
        'returns the existing entry rather than a second one, so refreshing cannot improve your odds. ' +
        'No approval is required — joining is not a protected action.',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Optional event id; defaults to the active event.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'queue.status',
      description:
        'Report your position: draw rank, whether a slot is currently allocated to you, how long is ' +
        'left in that window, and which slots you hold. Read-only.',
      inputSchema: {
        type: 'object',
        properties: {
          eventId: { type: 'string', description: 'Optional event id; defaults to the active event.' },
        },
        additionalProperties: false,
      },
    },
    {
      name: 'slot.claim',
      description:
        'Claim the slot currently allocated to this human. REQUIRES `approval`: a server-issued ' +
        'reference proving that a human authorized this exact operation, obtained by asking them ' +
        '(POST /api/slot/claim/request). The server verifies it independently — presence of the ' +
        'argument is not sufficient, and a fabricated, reused, expired, or differently-bound value ' +
        'is refused with a structured reason.',
      inputSchema: {
        type: 'object',
        properties: {
          approval: {
            type: 'string',
            description:
              'Server-issued approval reference for this operation. The server re-verifies the ' +
              'binding, the freshness of the human authentication, and one-time consumption.',
          },
          eventId: { type: 'string', description: 'Optional event id; defaults to the active event.' },
        },
        // `approval` is intentionally NOT in `required`. Forbidding the call in
        // the schema would hide the interesting failure; allowing it and refusing
        // it at the gate demonstrates the actual security property.
        additionalProperties: false,
      },
    },
  ],
}));

server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const { name, arguments: rawArgs } = request.params;
  const args = (rawArgs ?? {}) as { eventId?: string; approval?: string };

  // The caller may name an event; otherwise this process's own scope answers,
  // and only if neither exists does the server fall back to its default.
  const eventId = args.eventId ?? EVENT_ID;
  const query = eventId ? `?eventId=${encodeURIComponent(eventId)}` : '';

  try {
    switch (name) {
      case 'queue.join': {
        const result = await client.call(`/api/queue/join${query}`, { body: {} });
        return ok(result);
      }

      case 'queue.status': {
        const result = await client.call(`/api/queue/status${query}`);
        return ok(result);
      }

      case 'slot.claim': {
        // The only job of this branch is to forward what the caller presented.
        // Every decision is made by `executeClaim` on the server, which the HTTP
        // route calls too — there is no second implementation of the gate.
        const result = await client.call('/api/slot/claim', {
          body: { eventId: eventId || undefined, approval: args.approval },
        });
        return ok(result);
      }

      default:
        return {
          isError: true,
          content: [{ type: 'text' as const, text: `unknown tool: ${name}` }],
        };
    }
  } catch (err) {
    return refusal(err);
  }
});

// ── Start ───────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  // Diagnostics go to stderr: stdout belongs to the JSON-RPC stream and a stray
  // console.log there corrupts the protocol.
  console.error(`[humangate-mcp] stdio server · target ${BASE}`);
  console.error(
    EVENT_ID
      ? `[humangate-mcp] scoped to event ${EVENT_ID}`
      : '[humangate-mcp] no HUMANGATE_EVENT_ID — the server resolves the event per call',
  );
  console.error(
    TOKEN
      ? '[humangate-mcp] using HUMANGATE_AGENT_TOKEN'
      : '[humangate-mcp] no HUMANGATE_AGENT_TOKEN set — calls will be refused with not_authenticated. ' +
          'Enroll one with: curl -sX POST localhost:3000/api/agent/enroll',
  );
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('[humangate-mcp] fatal:', err);
  process.exit(1);
});
