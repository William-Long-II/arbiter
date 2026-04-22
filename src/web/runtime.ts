/**
 * Shared state the web routes inspect. The loop writes to `status`; the server reads.
 * Decoupled so routes don't import the loop directly.
 */
export type Runtime = {
  startedAt: string;
  lastTickStart: string | null;
  lastTickEnd: string | null;
  lastTickError: string | null;
  bootstrappedFromYaml: boolean;
};

export function createRuntime(bootstrappedFromYaml: boolean): Runtime {
  return {
    startedAt: new Date().toISOString(),
    lastTickStart: null,
    lastTickEnd: null,
    lastTickError: null,
    bootstrappedFromYaml,
  };
}
