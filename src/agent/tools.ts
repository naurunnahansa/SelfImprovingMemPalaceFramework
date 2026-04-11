import { tool } from "ai";
import { z } from "zod";
import { sql } from "drizzle-orm";
import { hybridSearch } from "../palace/search.js";
import { storeDrawer, listWings, listRooms } from "../palace/store.js";
import {
  queryTriples,
  findEntity,
  upsertEntity,
  addTriple,
} from "../palace/graph.js";
import { searchWeb } from "../search/exa.js";
import { db } from "../db/client.js";

export const agentTools = {
  searchMemory: tool({
    description:
      "Search the memory palace for relevant memories. Use this to recall past conversations, facts, or context.",
    inputSchema: z.object({
      query: z.string().describe("What to search for"),
      wing: z.string().optional().describe("Filter by wing (person/project)"),
      hall: z.string().optional().describe("Filter by hall (memory type)"),
      room: z.string().optional().describe("Filter by room (topic)"),
    }),
    execute: async ({ query, wing, hall, room }) => {
      const results = await hybridSearch(query, {
        wing,
        hall,
        room,
        limit: 5,
      });
      return results.map((r) => ({
        wing: r.wing,
        room: r.room,
        content: r.content.slice(0, 500),
        score: r.score,
      }));
    },
  }),

  storeMemory: tool({
    description:
      "Store a new memory in the palace. Use this when learning something important that should be remembered.",
    inputSchema: z.object({
      wing: z
        .string()
        .describe("Wing category (e.g., 'user:alice', 'project:myapp')"),
      hall: z
        .string()
        .describe("Hall type (e.g., 'facts', 'preferences', 'decisions')"),
      room: z.string().describe("Topic room (e.g., 'typescript', 'career')"),
      content: z.string().describe("The content to remember"),
      source: z.string().optional().describe("Where this came from"),
    }),
    execute: async ({ wing, hall, room, content, source }) => {
      const drawer = await storeDrawer({ wing, hall, room, content, source });
      return { id: drawer.id, stored: true };
    },
  }),

  exaSearch: tool({
    description:
      "Search the web via Exa for real-time, up-to-date information. Use this to verify facts, check recent events, ground claims with evidence, or find information beyond your training data. Always prefer this over guessing about current events or recent changes.",
    inputSchema: z.object({
      query: z.string().describe("Search query — be specific for better results"),
      numResults: z
        .number()
        .optional()
        .default(5)
        .describe("Number of results to return"),
    }),
    execute: async ({ query, numResults }) => {
      const results = await searchWeb(query, { numResults });
      return results.map((r) => ({
        title: r.title,
        url: r.url,
        highlights: r.highlights,
        text: r.text.slice(0, 300),
      }));
    },
  }),

  queryKnowledge: tool({
    description:
      "Query the knowledge graph for facts about an entity and its relationships.",
    inputSchema: z.object({
      entity: z.string().describe("Entity name to query"),
      predicate: z
        .string()
        .optional()
        .describe("Filter by relationship type"),
    }),
    execute: async ({ entity, predicate }) => {
      const found = await findEntity(entity);
      if (!found) return { found: false as const, entity, triples: [] };

      const triplesResult = await queryTriples(found.id, { predicate });
      return {
        found: true as const,
        entity: {
          name: found.name,
          type: found.entityType,
          attributes: found.attributes,
        },
        triples: triplesResult.map((t) => ({
          predicate: t.predicate,
          objectId: t.objectId,
          objectValue: t.objectValue,
          confidence: t.confidence,
          validFrom: t.validFrom.toISOString(),
          validTo: t.validTo?.toISOString() ?? null,
        })),
      };
    },
  }),

  listPalace: tool({
    description: "List the structure of the memory palace — wings and rooms.",
    inputSchema: z.object({
      wing: z.string().optional().describe("List rooms in a specific wing"),
    }),
    execute: async ({ wing }) => {
      if (wing) {
        const rooms = await listRooms(wing);
        return { wing, rooms };
      }
      const wings = await listWings();
      return { wings };
    },
  }),

  storeKnowledge: tool({
    description:
      "Store a new fact in the knowledge graph. Creates entities and a relationship between them.",
    inputSchema: z.object({
      subjectName: z.string().describe("Subject entity name"),
      subjectType: z
        .string()
        .describe("Subject entity type (person, project, concept, etc.)"),
      predicate: z
        .string()
        .describe(
          "Relationship type (e.g., 'works_at', 'knows', 'created')"
        ),
      objectName: z.string().describe("Object entity name"),
      objectType: z.string().describe("Object entity type"),
    }),
    execute: async ({
      subjectName,
      subjectType,
      predicate,
      objectName,
      objectType,
    }) => {
      const subject = await upsertEntity(subjectName, subjectType);
      const object = await upsertEntity(objectName, objectType);
      const triple = await addTriple({
        subjectId: subject.id,
        predicate,
        objectId: object.id,
        source: "conversation",
      });
      return { stored: true, tripleId: triple.id };
    },
  }),

  recallConversations: tool({
    description:
      "Recall past conversations. Use this when the user asks about previous conversations, what you've discussed before, or your most recent conversation. Returns chronologically ordered conversation summaries.",
    inputSchema: z.object({
      query: z
        .string()
        .optional()
        .describe("Optional search query to find specific conversations. Leave empty for most recent."),
      limit: z
        .number()
        .optional()
        .default(5)
        .describe("Number of past conversations to return"),
    }),
    execute: async ({ query, limit }) => {
      if (query) {
        // Search for conversations matching the query
        const results = await hybridSearch(query, {
          wing: "conversations",
          hall: "summaries",
          limit,
        });
        return results.map((r) => ({
          conversationId: r.room,
          summary: r.content,
          lastAccessed: r.accessedAt,
        }));
      }

      // Return most recent conversations
      const results = await db.execute(sql`
        SELECT room as conversation_id, content as summary, accessed_at, metadata
        FROM drawers
        WHERE wing = 'conversations' AND hall = 'summaries'
        ORDER BY accessed_at DESC
        LIMIT ${limit}
      `);

      return (
        results.rows as Array<{
          conversation_id: string;
          summary: string;
          accessed_at: string;
          metadata: Record<string, unknown> | null;
        }>
      ).map((r) => ({
        conversationId: r.conversation_id,
        summary: r.summary,
        lastAccessed: r.accessed_at,
        startedAt: r.metadata?.startedAt ?? null,
      }));
    },
  }),
};
