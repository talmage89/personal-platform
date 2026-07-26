import type { PrismaConfig } from "prisma";

export default {
  schema: "prisma/schema",
  migrations: {
    path: "prisma/migrations",
  },
  datasource: {
    // Read at CLI time only (generate, migrate). The running application never
    // uses this — it supplies the URL through a driver adapter instead.
    url: process.env.DB_URL ?? "",
  },
} satisfies PrismaConfig;
