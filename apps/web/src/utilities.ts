import type { Utility } from "@platform/utility-kit";
import weight from "@platform/utility-weight";

/**
 * The registry. This is the only file you edit to add a utility: install the
 * package, import it, add it to the array.
 *
 * The same array both mounts the routes and renders the directory, so the
 * listing can never drift from what is actually reachable.
 */
export const utilities: readonly Utility[] = [weight];
