/**
 * Prisma 7 names the row types `<Model>Model` in its barrel export, so that
 * they do not collide with the delegates. Aliasing them here keeps the generated
 * spelling from spreading through every consumer.
 */

// Enums are generated as a const object plus a matching type, so the enum name
// has to be re-exported as both to be usable as a value and as a type.
export {
  type AgentPromptKind,
  type AgentSummaryKind,
  WeightUnit,
} from "../prisma/generated/enums.ts";
export type {
  AgentChannelModel as AgentChannel,
  AgentPromptModel as AgentPrompt,
  AgentSummaryModel as AgentSummary,
  AgentViewModel as AgentView,
  UserModel as User,
  WeightEntryModel as WeightEntry,
  WeightSettingsModel as WeightSettings,
} from "../prisma/generated/models.ts";
export * from "../prisma/generated/models.ts";
export { adapterFor, db, disconnect } from "./client.ts";
export { resolveUser } from "./users.ts";
