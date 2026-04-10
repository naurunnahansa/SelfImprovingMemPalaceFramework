import { setup, assign, fromPromise } from "xstate";
import { classifyMessage, type MessageClassification } from "../agent/classifier.js";
import { listRooms } from "../palace/store.js";

// ─── Types ───────────────────────────────────────────────────────────────────

export interface ActiveRoom {
  wing: string;
  hall: string;
  room: string;
  relevance: number;
  loadedAt: number;
  tokenCount: number;
}

interface ContextMachineContext {
  userId: string;
  activeRooms: ActiveRoom[];
  totalTokenBudget: number;
  usedTokens: number;
  currentTopics: Array<{ wing: string; room: string }>;
  decayRate: number;
  relevanceThreshold: number;
  lastClassification: MessageClassification | null;
}

// ─── Actors ──────────────────────────────────────────────────────────────────

const classifyMessageActor = fromPromise(
  async ({ input }: { input: { message: string } }) => {
    return classifyMessage(input.message);
  }
);

const loadRoomDataActor = fromPromise(
  async ({
    input,
  }: {
    input: { topics: Array<{ wing: string; room: string }> };
  }) => {
    const roomData: Array<{
      wing: string;
      hall: string;
      room: string;
      tokenCount: number;
    }> = [];

    for (const topic of input.topics) {
      // Check if drawers exist for this topic
      const rooms = await listRooms(topic.wing);
      const match = rooms.find((r) => r.room === topic.room);

      if (match) {
        roomData.push({
          wing: match.wing,
          hall: match.hall,
          room: match.room,
          tokenCount: Math.min(match.count * 50, 500),
        });
      } else {
        // Room doesn't exist yet — create a placeholder so the context
        // machine tracks it. Content will fill in as conversation proceeds.
        roomData.push({
          wing: topic.wing,
          hall: "conversations",
          room: topic.room,
          tokenCount: 0, // No drawers yet
        });
      }
    }

    return roomData;
  }
);

// ─── Machine ─────────────────────────────────────────────────────────────────

export const contextMachine = setup({
  types: {
    context: {} as ContextMachineContext,
    events: {} as
      | { type: "MESSAGE_RECEIVED"; message: string }
      | { type: "RESET" },
    input: {} as { userId: string },
  },
  actors: {
    classifyMessage: classifyMessageActor,
    loadRoomData: loadRoomDataActor,
  },
  actions: {
    boostMatchingRooms: assign({
      activeRooms: ({ context }) => {
        return context.activeRooms.map((room) => {
          const isRelevant = context.currentTopics.some(
            (t) =>
              t.room === room.room ||
              t.wing === room.wing
          );
          if (isRelevant) {
            return { ...room, relevance: Math.min(1.0, room.relevance + 0.3) };
          }
          return room;
        });
      },
    }),

    decayOtherRooms: assign({
      activeRooms: ({ context }) => {
        return context.activeRooms.map((room) => {
          const isRelevant = context.currentTopics.some(
            (t) =>
              t.room === room.room ||
              t.wing === room.wing
          );
          if (!isRelevant) {
            return {
              ...room,
              relevance: room.relevance * (1 - context.decayRate),
            };
          }
          return room;
        });
      },
    }),

    removeStaleRooms: assign({
      activeRooms: ({ context }) => {
        return context.activeRooms.filter(
          (r) => r.relevance >= context.relevanceThreshold
        );
      },
    }),

    enforceTokenBudget: assign({
      activeRooms: ({ context }) => {
        const sorted = [...context.activeRooms].sort(
          (a, b) => a.relevance - b.relevance
        );
        let totalTokens = sorted.reduce((sum, r) => sum + r.tokenCount, 0);
        const result = [...sorted];

        while (totalTokens > context.totalTokenBudget && result.length > 0) {
          const removed = result.shift()!;
          totalTokens -= removed.tokenCount;
        }

        return result;
      },
      usedTokens: ({ context }) => {
        return context.activeRooms.reduce(
          (sum, r) => sum + r.tokenCount,
          0
        );
      },
    }),

    recalculateTokens: assign({
      usedTokens: ({ context }) => {
        return context.activeRooms.reduce(
          (sum, r) => sum + r.tokenCount,
          0
        );
      },
    }),
  },
}).createMachine({
  id: "contextManager",
  initial: "idle",
  context: ({ input }) => ({
    userId: input.userId,
    activeRooms: [],
    totalTokenBudget: 2000, // L2 budget
    usedTokens: 0,
    currentTopics: [],
    decayRate: 0.15,
    relevanceThreshold: 0.2,
    lastClassification: null,
  }),

  states: {
    idle: {
      on: {
        MESSAGE_RECEIVED: { target: "analyzing" },
        RESET: {
          actions: assign({
            activeRooms: [],
            usedTokens: 0,
            currentTopics: [],
            lastClassification: null,
          }),
        },
      },
    },

    analyzing: {
      invoke: {
        src: "classifyMessage",
        input: ({ event }) => {
          if (event.type === "MESSAGE_RECEIVED") {
            return { message: event.message };
          }
          return { message: "" };
        },
        onDone: {
          target: "loading",
          actions: assign({
            lastClassification: ({ event }) => event.output,
            currentTopics: ({ event }) =>
              event.output.topics.map((t: { wing: string; room: string }) => ({
                wing: t.wing,
                room: t.room,
              })),
          }),
        },
        onError: { target: "idle" },
      },
    },

    loading: {
      entry: ["boostMatchingRooms", "decayOtherRooms"],
      invoke: {
        src: "loadRoomData",
        input: ({ context }) => {
          // Only load rooms not already active
          const activeRoomKeys = new Set(
            context.activeRooms.map((r) => `${r.wing}/${r.room}`)
          );
          const newTopics = context.currentTopics.filter(
            (t) => !activeRoomKeys.has(`${t.wing}/${t.room}`)
          );
          return { topics: newTopics };
        },
        onDone: {
          target: "active",
          actions: assign({
            activeRooms: ({ context, event }) => {
              const newRooms: ActiveRoom[] = event.output.map(
                (r: {
                  wing: string;
                  hall: string;
                  room: string;
                  tokenCount: number;
                }) => ({
                  wing: r.wing,
                  hall: r.hall,
                  room: r.room,
                  relevance: 0.8,
                  loadedAt: Date.now(),
                  tokenCount: r.tokenCount,
                })
              );
              return [...context.activeRooms, ...newRooms];
            },
          }),
        },
        onError: { target: "active" },
      },
    },

    active: {
      entry: ["removeStaleRooms", "enforceTokenBudget", "recalculateTokens"],
      always: { target: "idle" },
    },
  },
});
