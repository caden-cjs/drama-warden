import { loadConfiguration } from '../backend/config.mjs';

loadConfiguration();
await import('../backend/server.mjs');
