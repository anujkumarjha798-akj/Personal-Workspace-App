// Test-only: registers the .css loader stub. See scripts/test-format-painter.ts.
import { register } from 'node:module';
register('./css-stub.mjs', import.meta.url);
