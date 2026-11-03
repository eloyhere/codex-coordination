/** Typed host boundary for the independently bundled, verbatim upstream source. */
export function leanParameters(schema: unknown): Record<string, any>
export function createCoordination(options: Record<string, any>): {
  definitions: { name: string; description: string; inputSchema: Record<string, any> }[]
  call(name: string, args: Record<string, unknown>, session: string): Promise<any>
  drain(session: string): unknown
  metrics(): unknown
  knowledge(): { path: string; title?: string; note?: string; tags: string[]; updated: number }[]
  close(): Promise<void>
}
