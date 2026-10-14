import highsLoader from 'highs';
import { wrapHighs, type LpSolver } from './solver';

/** Loads the HiGHS WebAssembly build from node_modules (Node, CLI and tests). */
export async function loadNodeSolver(): Promise<LpSolver> {
  const highs = await highsLoader();
  const v = (highs as unknown as { version?: { major: number; minor: number; patch: number } }).version;
  return wrapHighs(highs as never, v ? `HiGHS ${v.major}.${v.minor}.${v.patch}` : 'HiGHS');
}
