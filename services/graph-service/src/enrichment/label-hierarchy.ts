import type { Driver } from 'neo4j-driver';
import type { DiscogsClient } from '../ingestion/discogs-client.js';
import type { Logger } from '../ingestion/discogs-client.js';
import {
  getUnenrichedLabels,
  setLabelParent,
  setLabelHierarchyFetched,
  type LabelParent,
  type UnenrichedLabel,
} from '../db/label-hierarchy-repository.js';
import { runEnrichment, type EnrichmentStage, type EnrichmentSummary } from './run.js';
import { NOOP_PROGRESS, type ProgressReporter } from './progress.js';

export type LabelHierarchyEnrichmentSummary = EnrichmentSummary;

/**
 * Enrich Label nodes with their parent from the Discogs label API (issue #332).
 * Fetches GET /labels/{discogsId} for each collection label whose last attempt has aged past the
 * staleness window (see getUnenrichedLabels) and writes a single `(child)-[:PARENT_LABEL]->(parent)`
 * edge. setLabelHierarchyFetched stamps labelHierarchyFetchedAt on every attempt so a parentless
 * label is retried at most once per window rather than every run.
 *
 * Only `parent_label` is consumed — `sublabels[]` is intentionally ignored. Because every collection
 * label points up to its parent, the upward edges alone connect all collection labels in a family
 * via their shared ancestor (the explore roll-up traverses PARENT_LABEL in both directions).
 * Rate limiting is handled by DiscogsClient internally; per-label errors are caught and counted.
 */
export async function enrichLabelHierarchy(
  client: DiscogsClient,
  driver: Driver,
  logger?: Logger,
  onProgress: ProgressReporter = NOOP_PROGRESS,
): Promise<LabelHierarchyEnrichmentSummary> {
  const log: Logger = logger ?? console;

  const stage: EnrichmentStage<UnenrichedLabel, LabelParent> = {
    name: 'label-hierarchy',
    selectCandidates: (d) => getUnenrichedLabels(d),
    async resolve(label) {
      const detail = await client.getLabel(label.discogsId);
      const parent = detail.parent_label;
      // No parent, an unkeyable parent id, or a self-reference → markAttempted (stamp only).
      if (!parent || parent.id == null || parent.id === 0 || parent.id === label.discogsId) {
        return null;
      }
      const name = parent.name?.trim();
      if (!name) return null;
      return { discogsId: parent.id, name };
    },
    write: (d, label, resolved) => setLabelParent(d, label.discogsId, resolved),
    markAttempted: (d, label) => setLabelHierarchyFetched(d, label.discogsId),
    describeItem: (label) => `label ${label.discogsId}`,
  };

  return runEnrichment(driver, stage, { logger: log, onProgress });
}
