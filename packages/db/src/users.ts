import type { UserModel } from "../prisma/generated/models.ts";
import { db } from "./client.ts";

/**
 * Finds the signed-in person, creating their row the first time they appear.
 *
 * Read carefully where this is *not* called: nowhere in the login flow. Who may
 * sign in is decided by the environment allowlist, so authentication still
 * issues zero queries and the public surface cannot wake the database. This runs
 * only once a request is already past the session gate, which means the caller
 * is someone the allowlist already vouched for — a row here records a person the
 * platform has met, it does not decide whether to let them in.
 */
export async function resolveUser(githubId: string): Promise<UserModel> {
  const existing = await db().user.findUnique({ where: { githubId } });
  if (existing) return existing;

  try {
    return await db().user.create({ data: { githubId } });
  } catch (error) {
    // Two first-requests in flight at once can both miss the read and then race
    // the insert. The unique index means one loses; re-reading is the recovery,
    // and it is the only correct one — retrying the insert would just lose again.
    if (!isUniqueViolation(error)) throw error;

    const raced = await db().user.findUnique({ where: { githubId } });
    if (!raced) throw error;
    return raced;
  }
}

/** Prisma's unique-constraint failure. Duck-typed to avoid importing the error class. */
function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: unknown }).code === "P2002"
  );
}
