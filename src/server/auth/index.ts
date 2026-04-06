import { assertServerOnly } from "@/server/runtime/assert-server-only";
import { authOptions } from "@/server/auth/auth.config";

assertServerOnly("server/auth/index");

export { authOptions };
