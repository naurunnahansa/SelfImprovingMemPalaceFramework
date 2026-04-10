import { tool } from "ai";
import { z } from "zod";
import { hybridSearch } from "../palace/search.js";
import { storeDrawer, listWings, listRooms } from "../palace/store.js";
import {
  queryTriples,
  findEntity,
  upsertEntity,
  addTriple,
} from "../palace/graph.js";
import { searchWeb } from "../search/exa.js";

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

  searchWebTool: tool({
    description:
      "Search the web using Exa for current information. Use this to verify facts or find up-to-date information.",
    inputSchema: z.object({
      query: z.string().describe("Search query"),
      numResults: z
        .number()
        .optional()
        .default(5)
        .describe("Number of results"),
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
};
