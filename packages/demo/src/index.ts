export {
  DEFAULT_DEMO_OPERATOR_ID,
  DEFAULT_DEMO_ROOM_ID,
  DEFAULT_DEMO_TARGET_ID,
  DEMO_SCHEMA_VERSION,
  INITIAL_DEMO_STATE,
  demoReducer,
} from "./shared.js";
export type { DemoDomainState } from "./shared.js";
export { startDemoServer } from "./server.js";
export type { DemoServer, DemoServerOptions } from "./server.js";
