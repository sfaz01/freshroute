/**
 * Thin, environment-agnostic wrapper around HiGHS (WebAssembly build).
 * The engine only depends on this interface, so it runs unchanged in the
 * browser, in Node (CLI evaluation) and under the test runner.
 */

export type SolveStatus = 'optimal' | 'feasible' | 'infeasible' | 'error';

export interface SolveResult {
  status: SolveStatus;
  rawStatus: string;
  objective: number;
  /** Primal value by column name. */
  primal: Map<string, number>;
  /** Reduced cost by column name (LP only). */
  reducedCost: Map<string, number>;
  /** Row dual by row name (LP only). */
  rowDual: Map<string, number>;
  ms: number;
}

export interface SolveOptions {
  timeLimitSec?: number;
  relGap?: number;
}

export interface LpSolver {
  name: string;
  solve(lp: string, options?: SolveOptions): SolveResult;
}

interface HighsLike {
  solve(problem: string, options?: Record<string, unknown>): {
    Status: string;
    ObjectiveValue: number;
    Columns: Record<string, { Name?: string; Primal?: number; Dual?: number }>;
    Rows: { Name?: string; Dual?: number }[];
  };
}

/** Relative optimality gap at which a MIP solve is reported as proven optimal (0.01 %). */
export const MIP_REL_GAP = 1e-4;

const now = () => (typeof performance !== 'undefined' ? performance.now() : Date.now());

export function wrapHighs(highs: HighsLike, name = 'HiGHS'): LpSolver {
  return {
    name,
    solve(lp, options = {}) {
      const t0 = now();
      const empty = (status: SolveStatus, rawStatus: string): SolveResult => ({
        status,
        rawStatus,
        objective: NaN,
        primal: new Map(),
        reducedCost: new Map(),
        rowDual: new Map(),
        ms: now() - t0,
      });
      let res;
      try {
        res = highs.solve(lp, {
          output_flag: false,
          time_limit: options.timeLimitSec ?? 20,
          mip_rel_gap: options.relGap ?? MIP_REL_GAP,
          // The formulation is tight enough that the root node usually proves optimality;
          // restarts and sub-MIP heuristics only add fixed overhead in the Wasm build.
          mip_allow_restart: false,
          mip_heuristic_run_rins: false,
          mip_heuristic_run_rens: false,
          mip_heuristic_run_root_reduced_cost: false,
        });
      } catch (err) {
        return empty('error', err instanceof Error ? err.message : String(err));
      }
      if (res.Status === 'Infeasible' || res.Status === 'Primal infeasible or unbounded') {
        return empty('infeasible', res.Status);
      }
      const hasSolution = res.Status === 'Optimal' || res.Status === 'Time limit reached';
      if (!hasSolution) return empty('error', res.Status);
      const primal = new Map<string, number>();
      const reducedCost = new Map<string, number>();
      for (const [key, col] of Object.entries(res.Columns)) {
        if (typeof col.Primal !== 'number') return empty('error', `${res.Status} (no primal solution)`);
        primal.set(key, col.Primal);
        if (typeof col.Dual === 'number') reducedCost.set(key, col.Dual);
      }
      const rowDual = new Map<string, number>();
      for (const row of res.Rows) {
        if (row.Name && typeof row.Dual === 'number') rowDual.set(row.Name, row.Dual);
      }
      return {
        status: res.Status === 'Optimal' ? 'optimal' : 'feasible',
        rawStatus: res.Status,
        objective: res.ObjectiveValue,
        primal,
        reducedCost,
        rowDual,
        ms: now() - t0,
      };
    },
  };
}
