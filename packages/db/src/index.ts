/**
 * Prisma 7 names the row types `<Model>Model` in its barrel export, so that
 * they do not collide with the delegates. Aliasing them here keeps the generated
 * spelling from spreading through every consumer.
 */
export type {
  UserModel as User,
  WeightEntryModel as WeightEntry,
  WeightSettingsModel as WeightSettings,
} from "../prisma/generated/models.ts";
export * from "../prisma/generated/models.ts";
export { adapterFor, db, disconnect } from "./client.ts";
export { resolveUser } from "./users.ts";
