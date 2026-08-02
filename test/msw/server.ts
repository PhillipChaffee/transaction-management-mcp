import { setupServer } from "msw/node";

import { binderHandlers } from "./handlers.ts";

export const mswServer = setupServer(...binderHandlers);
