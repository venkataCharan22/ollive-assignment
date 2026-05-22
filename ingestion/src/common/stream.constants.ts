/** Redis Stream that carries inference logs from API to worker. */
export const INFERENCE_STREAM = "ollive:inference-logs";
/** Consumer group name. One group = at-most-once delivery across N consumers. */
export const INFERENCE_GROUP = "ingestion-workers";
/** Consumer name for this process. Use hostname + pid so two replicas don't collide. */
export const INFERENCE_CONSUMER = `consumer-${process.env.HOSTNAME ?? "local"}-${process.pid}`;
