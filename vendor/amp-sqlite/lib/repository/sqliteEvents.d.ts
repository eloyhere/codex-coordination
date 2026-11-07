import type { EventRecord } from "../entity/types.js";
import type { SqlDriver } from "../sql/types.js";
export type EventInput = Omit<EventRecord, "sequence"> & {
    readonly sequence?: number;
};
export interface ReadEventsOptions {
    readonly kind?: string;
    readonly limit?: number;
}
/** Appends one event and returns it with the database-assigned sequence. */
export declare function appendEvent(driver: SqlDriver, event: EventInput): EventRecord;
/** Reads events in append order, optionally narrowed by kind and limit. */
export declare function readEvents(driver: SqlDriver, options?: ReadEventsOptions): readonly EventRecord[];
