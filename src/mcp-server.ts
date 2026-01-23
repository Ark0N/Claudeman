#!/usr/bin/env node

/**
 * @fileoverview MCP Server for Claudeman Spawn1337 protocol.
 *
 * Exposes spawn capabilities as native MCP tools that Claude Code can call
 * directly, replacing the terminal-tag-parsing approach (SpawnDetector).
 *
 * Tools:
 * - spawn_agent: Spawn a new autonomous agent
 * - list_agents: List all agents (active + completed)
 * - get_agent_status: Get detailed agent status
 * - get_agent_result: Read a completed agent's result
 * - send_agent_message: Send a message to a running agent
 * - cancel_agent: Cancel a running agent
 *
 * Environment:
 * - CLAUDEMAN_API_URL: Base URL for the Claudeman API (default: http://localhost:3000)
 * - CLAUDEMAN_SESSION_ID: Session ID of the calling Claude session
 *
 * @module mcp-server
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

// ========== Configuration ==========

const API_URL = process.env.CLAUDEMAN_API_URL || 'http://localhost:3000';
const SESSION_ID = process.env.CLAUDEMAN_SESSION_ID || '';

// ========== API Helper ==========

/**
 * Make an HTTP request to the Claudeman API.
 */
async function apiRequest(method: string, path: string, body?: unknown): Promise<{ status: number; data: unknown }> {
  const url = `${API_URL}${path}`;
  const options: RequestInit = {
    method,
    headers: { 'Content-Type': 'application/json' },
  };
  if (body !== undefined) {
    options.body = JSON.stringify(body);
  }

  const response = await fetch(url, options);
  const data = await response.json();
  return { status: response.status, data };
}

// ========== YAML Construction ==========

/**
 * Build a YAML frontmatter + body task spec from structured parameters.
 */
export function buildTaskSpec(params: {
  agentId: string;
  name: string;
  instructions: string;
  type?: string;
  priority?: string;
  maxTokens?: number;
  maxCost?: number;
  timeoutMinutes?: number;
  canModifyParentFiles?: boolean;
  contextFiles?: string[];
  dependsOn?: string[];
  completionPhrase?: string;
  outputFormat?: string;
  successCriteria?: string;
  workingDir?: string;
}): string {
  const lines: string[] = ['---'];

  lines.push(`agentId: ${params.agentId}`);
  lines.push(`name: ${params.name}`);

  if (params.type) lines.push(`type: ${params.type}`);
  if (params.priority) lines.push(`priority: ${params.priority}`);
  if (params.maxTokens != null) lines.push(`maxTokens: ${params.maxTokens}`);
  if (params.maxCost != null) lines.push(`maxCost: ${params.maxCost}`);
  if (params.timeoutMinutes != null) lines.push(`timeoutMinutes: ${params.timeoutMinutes}`);
  if (params.canModifyParentFiles != null) lines.push(`canModifyParentFiles: ${params.canModifyParentFiles}`);
  if (params.completionPhrase) lines.push(`completionPhrase: ${params.completionPhrase}`);
  if (params.outputFormat) lines.push(`outputFormat: ${params.outputFormat}`);
  if (params.successCriteria) lines.push(`successCriteria: "${params.successCriteria.replace(/"/g, '\\"')}"`);
  if (params.workingDir) lines.push(`workingDir: ${params.workingDir}`);

  if (params.contextFiles && params.contextFiles.length > 0) {
    lines.push(`contextFiles: [${params.contextFiles.join(', ')}]`);
  }

  if (params.dependsOn && params.dependsOn.length > 0) {
    lines.push(`dependsOn: [${params.dependsOn.join(', ')}]`);
  }

  lines.push('---');
  lines.push('');
  lines.push(params.instructions);

  return lines.join('\n');
}

// ========== MCP Server Setup ==========

const server = new McpServer({
  name: 'claudeman-spawn',
  version: '1.0.0',
});

// ---- spawn_agent ----

server.tool(
  'spawn_agent',
  'Spawn a new autonomous Claude agent to handle a subtask. The agent runs in its own session with full capabilities.',
  {
    agentId: z.string().describe('Unique identifier for the agent (e.g., "research-auth-001")'),
    name: z.string().describe('Human-readable name for the agent'),
    instructions: z.string().describe('Detailed task instructions for the agent (markdown)'),
    type: z.enum(['explore', 'implement', 'test', 'review', 'refactor', 'research', 'generate', 'fix', 'general']).optional().describe('Task type/category'),
    priority: z.enum(['low', 'normal', 'high', 'critical']).optional().describe('Priority for queue ordering'),
    maxTokens: z.number().optional().describe('Maximum token budget (input + output combined)'),
    maxCost: z.number().optional().describe('Maximum cost in USD'),
    timeoutMinutes: z.number().optional().describe('Maximum runtime in minutes (max: 120)'),
    canModifyParentFiles: z.boolean().optional().describe('Whether agent can modify files in parent project directory'),
    contextFiles: z.array(z.string()).optional().describe('Files to symlink into agent workspace as context'),
    dependsOn: z.array(z.string()).optional().describe('Agent IDs that must complete before this one starts'),
    completionPhrase: z.string().optional().describe('Phrase agent outputs when finished (default: auto-generated)'),
    outputFormat: z.enum(['markdown', 'json', 'code', 'structured', 'freeform']).optional().describe('Expected output format'),
    successCriteria: z.string().optional().describe('Success criteria included in agent instructions'),
    workingDir: z.string().optional().describe('Working directory (relative to parent, or absolute)'),
  },
  async (params) => {
    if (!SESSION_ID) {
      return {
        content: [{ type: 'text', text: 'Error: CLAUDEMAN_SESSION_ID not set. This tool must be run within a Claudeman-managed session.' }],
        isError: true,
      };
    }

    const taskSpec = buildTaskSpec(params);

    try {
      const { status, data } = await apiRequest('POST', '/api/spawn/trigger', {
        parentSessionId: SESSION_ID,
        taskContent: taskSpec,
      });

      if (status >= 400) {
        const errorData = data as { error?: { code?: string; details?: string } };
        const errorMsg = errorData.error?.details || errorData.error?.code || 'Unknown error';
        return {
          content: [{ type: 'text', text: `Error spawning agent: ${errorMsg}` }],
          isError: true,
        };
      }

      const result = data as { success: boolean; data?: { agentId: string } };
      const agentId = result.data?.agentId || params.agentId;
      return {
        content: [{ type: 'text', text: `Agent spawned successfully.\n\nAgent ID: ${agentId}` }],
      };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Could not connect to Claudeman API at ${API_URL}. Is the web server running?\n\n${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---- list_agents ----

server.tool(
  'list_agents',
  'List all spawn agents (active, queued, and completed).',
  {},
  async () => {
    try {
      const { status, data } = await apiRequest('GET', '/api/spawn/agents');

      if (status >= 400) {
        return {
          content: [{ type: 'text', text: `Error listing agents: ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      const agents = data as Array<{ agentId: string; name: string; status: string; type: string; priority: string }>;
      if (agents.length === 0) {
        return { content: [{ type: 'text', text: 'No agents found.' }] };
      }

      const summary = agents.map(a => `- ${a.agentId} (${a.name}): ${a.status} [${a.type}, ${a.priority}]`).join('\n');
      return { content: [{ type: 'text', text: `Agents (${agents.length}):\n\n${summary}` }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Could not connect to Claudeman API at ${API_URL}.\n\n${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---- get_agent_status ----

server.tool(
  'get_agent_status',
  'Get detailed status and progress of a specific agent.',
  {
    agentId: z.string().describe('The agent ID to query'),
  },
  async ({ agentId }) => {
    try {
      const { status, data } = await apiRequest('GET', `/api/spawn/agents/${encodeURIComponent(agentId)}`);

      if (status === 404) {
        return {
          content: [{ type: 'text', text: `Agent not found: ${agentId}` }],
          isError: true,
        };
      }

      if (status >= 400) {
        return {
          content: [{ type: 'text', text: `Error getting agent status: ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: JSON.stringify(data, null, 2) }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Could not connect to Claudeman API at ${API_URL}.\n\n${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---- get_agent_result ----

server.tool(
  'get_agent_result',
  'Read the result of a completed agent. Returns the agent\'s output and metadata.',
  {
    agentId: z.string().describe('The agent ID whose result to read'),
  },
  async ({ agentId }) => {
    try {
      const { status, data } = await apiRequest('GET', `/api/spawn/agents/${encodeURIComponent(agentId)}/result`);

      if (status === 404) {
        return {
          content: [{ type: 'text', text: `Agent or result not found: ${agentId}. The agent may not have completed yet.` }],
          isError: true,
        };
      }

      if (status >= 400) {
        return {
          content: [{ type: 'text', text: `Error getting agent result: ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      // Result could be a string (raw markdown) or an object
      const resultText = typeof data === 'string' ? data : JSON.stringify(data, null, 2);
      return { content: [{ type: 'text', text: resultText }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Could not connect to Claudeman API at ${API_URL}.\n\n${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---- send_agent_message ----

server.tool(
  'send_agent_message',
  'Send a message to a running agent. The message is written to the agent\'s communication channel.',
  {
    agentId: z.string().describe('The agent ID to message'),
    message: z.string().describe('The message content (markdown)'),
  },
  async ({ agentId, message }) => {
    try {
      const { status, data } = await apiRequest('POST', `/api/spawn/agents/${encodeURIComponent(agentId)}/message`, {
        content: message,
        sender: 'parent',
      });

      if (status === 404) {
        return {
          content: [{ type: 'text', text: `Agent not found: ${agentId}` }],
          isError: true,
        };
      }

      if (status >= 400) {
        return {
          content: [{ type: 'text', text: `Error sending message: ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: `Message sent to agent ${agentId}.` }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Could not connect to Claudeman API at ${API_URL}.\n\n${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ---- cancel_agent ----

server.tool(
  'cancel_agent',
  'Cancel a running agent. Sends a graceful shutdown signal.',
  {
    agentId: z.string().describe('The agent ID to cancel'),
    reason: z.string().optional().describe('Reason for cancellation'),
  },
  async ({ agentId, reason }) => {
    try {
      const { status, data } = await apiRequest('POST', `/api/spawn/agents/${encodeURIComponent(agentId)}/cancel`, {
        reason: reason || 'Cancelled by parent session',
      });

      if (status === 404) {
        return {
          content: [{ type: 'text', text: `Agent not found: ${agentId}` }],
          isError: true,
        };
      }

      if (status >= 400) {
        return {
          content: [{ type: 'text', text: `Error cancelling agent: ${JSON.stringify(data)}` }],
          isError: true,
        };
      }

      return { content: [{ type: 'text', text: `Agent ${agentId} cancel request sent.` }] };
    } catch (err) {
      return {
        content: [{ type: 'text', text: `Error: Could not connect to Claudeman API at ${API_URL}.\n\n${err instanceof Error ? err.message : String(err)}` }],
        isError: true,
      };
    }
  }
);

// ========== Start Server ==========

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

main().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
