import 'fake-indexeddb/auto';
import { beforeEach } from 'vitest';
import { resetDBForTest } from '../src/lib/db';

beforeEach(async () => {
  await resetDBForTest();
});
