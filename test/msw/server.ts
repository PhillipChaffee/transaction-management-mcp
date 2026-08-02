import { setupServer } from "msw/node";

import { allHandlers } from "./handlers.ts";

export const mswServer = setupServer(...allHandlers);
