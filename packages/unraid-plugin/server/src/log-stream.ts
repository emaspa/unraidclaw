import { writeSync } from "node:fs";
import { Writable } from "node:stream";

/**
 * Log destination that cannot take the service down.
 *
 * Fastify's default pino destination turns a failed write, such as ENOSPC when
 * /var/log is full, into an uncaught exception, and its exit flush then retries
 * the same write forever with a blocking sleep. The service stayed listening
 * but never answered a request or a SIGTERM (#18). This stream writes each line
 * synchronously and drops it when the write fails, so the request log is the
 * only thing that stops.
 */
export function createLogStream(fd = 1): Writable {
  return new Writable({
    write(chunk: Buffer | string, _encoding, callback) {
      const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      try {
        let offset = 0;
        while (offset < buf.length) {
          offset += writeSync(fd, buf, offset, buf.length - offset);
        }
      } catch {
        // Log space is gone or the descriptor is unusable. Keep serving.
      }
      callback();
    },
  });
}
