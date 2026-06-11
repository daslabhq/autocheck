/**
 * autocheck — CEL with gap.
 *
 * A check is a CEL predicate string. Evaluate it against any scene (or
 * structured state) to get `{ pass, gap, why }` — `gap` is the distance from
 * satisfaction (the gradient CEL itself doesn't give you). Agents are fluent in
 * CEL; there is no bespoke op-tree to author or serialize. The syntax is CEL,
 * the gap is ours.
 *
 *   import { runCheck } from "autocheck";
 *   runCheck(scene, "totalCost.amount <= 60000");
 *   runCheck(scene, "jobs.filter(j, j.status == 'failed').size() == 0");
 *   // → { pass, gap, why }
 *
 * Only the predicate subset with a computable gap is supported; anything else
 * throws CelError (route that criterion to an LLM judge instead).
 */

export type { CheckResult, CheckMeta, AnchorRef, Reference } from "./check.js";
export { runCheck, isGapable, validateCel, CelError } from "./cel.js";
export { resolve, lookup } from "./path.js";
