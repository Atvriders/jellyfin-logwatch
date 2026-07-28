import { Router, type Request, type Response } from 'express';
import type { Snapshot } from '../../shared/types.js';
import type { EntryBuffer } from '../entryBuffer.js';
import type { Pipeline } from '../pipeline.js';
import { requireAuth } from '../sessionAuth.js';
import type { SseHub } from '../sseHub.js';
import type { StatsEngine } from '../statsEngine.js';

export function logRoutes(deps: {
  buffer: EntryBuffer;
  stats: StatsEngine;
  hub: SseHub;
  pipeline: Pick<Pipeline, 'source'>;
}): Router {
  const router = Router();
  const { buffer, stats, hub, pipeline } = deps;

  router.get('/snapshot', requireAuth, (req: Request, res: Response) => {
    const raw = Number(req.query.limit);
    const limit = Number.isInteger(raw) && raw > 0 ? raw : undefined;
    const snapshot: Snapshot = {
      entries: buffer.snapshot(limit),
      stats: stats.snapshot(),
      source: pipeline.source(),
      lastSeq: buffer.lastSeq,
    };
    res.json(snapshot);
  });

  router.get('/stream', requireAuth, (req: Request, res: Response) => {
    hub.addClient(res);
    const lastEventId = Number(req.headers['last-event-id']);
    if (Number.isInteger(lastEventId) && lastEventId > 0) {
      const missed = buffer.since(lastEventId);
      if (missed === null) {
        res.write('event: resnapshot\ndata: {}\n\n');
      } else if (missed.length > 0) {
        res.write(`event: entries\nid: ${missed[missed.length - 1]!.seq}\ndata: ${JSON.stringify(missed)}\n\n`);
      }
    }
    res.write(`event: stats\ndata: ${JSON.stringify(stats.snapshot())}\n\n`);
  });

  return router;
}
